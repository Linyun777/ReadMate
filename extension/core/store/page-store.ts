/**
 * 页面级状态存储（方案第 11、75 节）。
 *
 * 职责：
 *   - 持有当前页面的全部 `BlockEntry`（Block + DOM 绑定 + 状态）
 *   - 维护页面级状态机（`IDLE / SCANNING / TRANSLATING / ACTIVE / PAUSED / RESTORED`）
 *   - 提供按状态检索与进度统计
 *
 * **不负责**：分段（`segmenter`）、请求（`translator` / `queue`）、写 DOM（`renderer`）。
 *
 * 生命周期：只存在于 content script 内。页面在则状态在，页面刷新即丢失——
 * 这正是想要的，因为 `BlockEntry` 持有的 DOM 引用在刷新后本来就失效了。
 */

import type {
  BlockEntry,
  BlockStats,
  PageState,
  TranslationBlock,
  TranslationStatus,
} from '@/shared/types';

/** `upsert` 的结果。 */
export type UpsertResult = 'added' | 'replaced' | 'unchanged';

/**
 * Block 的身份锚点。
 *
 * - 未拆段的 Block：**容器元素**（与历史行为一致）
 * - 拆段的 Block：**本段的首个子节点**（同一容器下有多个 Block，
 *   容器本身不再能区分它们）
 *
 * ⚠️ 为什么身份必须是 DOM 对象而不是 ID：ID 由分段器按局部序号生成，
 * 对同一片 DOM 重新分段会得到冲突的 ID（见 AGENTS.md 第 5.3 节）。
 */
export function blockAnchor(block: TranslationBlock): Node {
  return block.range?.nodes[0] ?? block.element;
}

export class PageStore {
  readonly #entries = new Map<string, BlockEntry>();
  /**
   * 锚点（见 `blockAnchor`）→ Block ID。
   *
   * 存在的理由：**Block ID 由分段器按局部序号生成**（`block-001`），
   * 对同一片 DOM 重新分段会得到与已有 Block 冲突的 ID。
   * 用 DOM 对象身份做真正的锚点，就能判断「这一块我是不是已经登记过」。
   *
   * 用 `WeakMap` 而非 `Map`：元素被页面移除后不该阻止其被回收。
   * 代价是没法 `clear()`，所以 `clear()` 里直接换一个新实例。
   */
  #byAnchor = new WeakMap<Node, string>();
  #pageState: PageState = 'IDLE';

  /* ---------------------------------------------------------------- *
   * 页面级状态
   * ---------------------------------------------------------------- */

  get pageState(): PageState {
    return this.#pageState;
  }

  setPageState(state: PageState): void {
    this.#pageState = state;
  }

  /* ---------------------------------------------------------------- *
   * 注册与检索
   * ---------------------------------------------------------------- */

  get size(): number {
    return this.#entries.size;
  }

  /**
   * 注册一个 Block。
   *
   * **幂等**：同 ID 已存在时返回既有条目、不覆盖状态。
   * 这样重复扫描同一片区域时不会把进度重置。
   */
  register(block: TranslationBlock): BlockEntry {
    const existing = this.#entries.get(block.id);
    if (existing) {
      return existing;
    }

    const entry: BlockEntry = { block, status: 'UNTRANSLATED' };
    this.#entries.set(block.id, entry);
    this.#byAnchor.set(blockAnchor(block), block.id);
    return entry;
  }

  registerAll(blocks: readonly TranslationBlock[]): BlockEntry[] {
    return blocks.map((block) => this.register(block));
  }

  /** 用新的分段结果整体替换（初次扫描、SPA 路由变化）。 */
  replaceAll(blocks: readonly TranslationBlock[]): BlockEntry[] {
    this.clear();
    return this.registerAll(blocks);
  }

  get(blockId: string): BlockEntry | undefined {
    return this.#entries.get(blockId);
  }

  has(blockId: string): boolean {
    return this.#entries.has(blockId);
  }

  /** 按容器元素反查 Block。未拆段时等价于 `findByAnchor(容器)`。 */
  findByElement(element: Element): BlockEntry | undefined {
    return this.findByAnchor(element);
  }

  /** 按锚点反查 Block（动态内容去重用）。 */
  findByAnchor(anchor: Node): BlockEntry | undefined {
    const blockId = this.#byAnchor.get(anchor);
    return blockId === undefined ? undefined : this.#entries.get(blockId);
  }

  /** 删掉单个条目（容器已脱离文档时用）。 */
  remove(blockId: string): boolean {
    const entry = this.#entries.get(blockId);
    if (entry === undefined) {
      return false;
    }

    this.#entries.delete(blockId);
    this.#byAnchor.delete(blockAnchor(entry.block));
    return true;
  }

  /**
   * 按元素身份登记或更新一个 Block。
   *
   * 三种结果：
   *   - `added`     —— 该容器此前未登记过
   *   - `replaced`  —— 容器相同但文本变了，旧译文已失效，**重置为 UNTRANSLATED**
   *   - `unchanged` —— 容器与文本都没变，**保持原状态**（不会把已翻译的推回未翻译）
   *
   * 后两种的区分是必要的：MutationObserver 会反复看到同一片 DOM，
   * 若每次都当新内容处理，已完成的翻译会被无限重置。
   */
  upsert(block: TranslationBlock): UpsertResult {
    const anchor = blockAnchor(block);
    const existingId = this.#byAnchor.get(anchor);
    const existing = existingId === undefined ? undefined : this.#entries.get(existingId);

    if (existing === undefined) {
      this.#entries.set(block.id, { block, status: 'UNTRANSLATED' });
      this.#byAnchor.set(anchor, block.id);
      return 'added';
    }

    if (existing.block.text === block.text) {
      return 'unchanged';
    }

    // 文本变了：旧译文与旧占位符绑定都已失效，整条换掉
    this.#entries.delete(existing.block.id);
    this.#entries.set(block.id, { block, status: 'UNTRANSLATED' });
    this.#byAnchor.set(anchor, block.id);
    return 'replaced';
  }

  all(): BlockEntry[] {
    return [...this.#entries.values()];
  }

  /**
   * 用一次重新分段的结果对账：删掉 `root` 范围内**这次没有再次产出**的条目。
   *
   * 为什么必须有这一步：拆段后块的身份是「容器 + 首个子节点」。页面原地改写
   * 一旦让切点移动，新旧锚点就对不上，`upsert` 只能把它当成新块加进来——
   * 旧条目会**留在 store 里变成幽灵**：进度数虚高，还可能被再翻译一次。
   * 只按锚点去重收不干净，必须按容器范围对账。
   *
   * @param root 本次重新分段的根
   * @param keptIds 这次确实产出的条目 ID
   * @returns 被删掉的 ID（供调用方记日志）
   */
  reconcile(root: Element, keptIds: readonly string[]): string[] {
    const kept = new Set(keptIds);
    const removed: string[] = [];

    for (const entry of this.#entries.values()) {
      const { element } = entry.block;
      if (element !== root && !root.contains(element)) {
        continue;
      }
      if (kept.has(entry.block.id)) {
        continue;
      }

      this.#entries.delete(entry.block.id);
      this.#byAnchor.delete(blockAnchor(entry.block));
      removed.push(entry.block.id);
    }

    return removed;
  }

  byStatus(status: TranslationStatus): BlockEntry[] {
    return this.all().filter((entry) => entry.status === status);
  }

  byStatuses(statuses: readonly TranslationStatus[]): BlockEntry[] {
    const wanted = new Set(statuses);
    return this.all().filter((entry) => wanted.has(entry.status));
  }

  /* ---------------------------------------------------------------- *
   * 状态迁移
   * ---------------------------------------------------------------- */

  /** 通用状态迁移。ID 不存在时返回 `undefined`，不抛错。 */
  setStatus(
    blockId: string,
    status: TranslationStatus,
    patch?: Partial<Pick<BlockEntry, 'translation' | 'error'>>,
  ): BlockEntry | undefined {
    const entry = this.#entries.get(blockId);
    if (!entry) {
      return undefined;
    }

    entry.status = status;
    if (patch?.translation !== undefined) {
      entry.translation = patch.translation;
    }
    if (patch?.error !== undefined) {
      entry.error = patch.error;
    }
    return entry;
  }

  markQueued(blockId: string): BlockEntry | undefined {
    return this.setStatus(blockId, 'QUEUED');
  }

  markTranslating(blockId: string): BlockEntry | undefined {
    return this.setStatus(blockId, 'TRANSLATING');
  }

  markTranslated(blockId: string, translation: string): BlockEntry | undefined {
    return this.setStatus(blockId, 'TRANSLATED', { translation });
  }

  markFailed(blockId: string, error: string): BlockEntry | undefined {
    return this.setStatus(blockId, 'FAILED', { error });
  }

  /** 把多个 Block 一起置为同一状态（Batch 级操作）。 */
  markMany(blockIds: readonly string[], status: TranslationStatus): void {
    for (const blockId of blockIds) {
      this.setStatus(blockId, status);
    }
  }

  /**
   * 把 FAILED 条目重置为 UNTRANSLATED，返回被重置的 ID 列表。
   *
   * 供「重新翻译失败内容」使用（方案第 24.2 节）。
   */
  resetFailed(): string[] {
    const ids: string[] = [];

    for (const entry of this.#entries.values()) {
      if (entry.status === 'FAILED') {
        entry.status = 'UNTRANSLATED';
        entry.error = undefined;
        ids.push(entry.block.id);
      }
    }

    return ids;
  }

  /* ---------------------------------------------------------------- *
   * 统计与清理
   * ---------------------------------------------------------------- */

  /**
   * 一条失败原因（给界面用），没有失败时返回 null。
   *
   * 只取**一条**：`stats.failed` 回答「几段失败」，而用户想知道的是「为什么失败」。
   * 同一轮的失败原因通常一样（服务没起来 / Key 不对 / 限流），逐条列出只会把
   * 状态栏塞满、反而看不出重点。
   */
  failureReason(): string | null {
    for (const entry of this.#entries.values()) {
      if (entry.status === 'FAILED' && entry.error !== undefined && entry.error !== '') {
        return entry.error;
      }
    }

    return null;
  }

  stats(): BlockStats {
    const counts: Record<TranslationStatus, number> = {
      UNTRANSLATED: 0,
      QUEUED: 0,
      TRANSLATING: 0,
      TRANSLATED: 0,
      FAILED: 0,
    };

    for (const entry of this.#entries.values()) {
      counts[entry.status] += 1;
    }

    const total = this.#entries.size;
    const settled = counts.TRANSLATED + counts.FAILED;

    return {
      total,
      untranslated: counts.UNTRANSLATED,
      queued: counts.QUEUED,
      translating: counts.TRANSLATING,
      translated: counts.TRANSLATED,
      failed: counts.FAILED,
      progress: total === 0 ? 0 : settled / total,
    };
  }

  clear(): void {
    this.#entries.clear();
    // WeakMap 无法清空，直接换一个新实例
    this.#byAnchor = new WeakMap<Node, string>();
    this.#pageState = 'IDLE';
  }
}

let sharedStore: PageStore | null = null;

/** 取 content script 内的共享实例。 */
export function getPageStore(): PageStore {
  sharedStore ??= new PageStore();
  return sharedStore;
}

/** 丢弃共享实例（页面重置或测试用）。 */
export function resetPageStore(): void {
  sharedStore = null;
}
