/**
 * 页面级编排。
 *
 * 把 Segmenter / PageStore / Translator / Queue / Renderer 串成完整链路，
 * 并管理**显示模式切换**与**恢复原文**。
 *
 * 职责边界：这是**组合根**，本身不含业务算法。
 * 并发、重试与降级归 `core/queue`（方案第 86.7 节的唯一调度点）。
 *
 * 关于「切换不触发重新请求」（Phase 7 验收标准）：
 * 译文在首次翻译后一直留在 `PageStore` 里，切换模式只是**重新渲染**，
 * 不经过 `core/translator` 与 `core/queue`，因此不会产生任何网络请求。
 */

import { type SiteAdapter, selectAdapter } from '@/adapters';
import { TranslationCache } from '@/core/cache';
import { streamTranslationViaBackground } from '@/core/messaging/stream-client';
import { MutationWatcher, type MutationWatcherOptions } from '@/core/mutation';
import {
  countTranslated,
  type QueueRunResult,
  TranslationQueue,
  type TranslationQueueOptions,
} from '@/core/queue';
import { Renderer } from '@/core/renderer';
import { RouteWatcher, type RouteWatcherOptions } from '@/core/route';
import { type SegmentOptions, segmentElement } from '@/core/segmenter';
import { blockAnchor, PageStore } from '@/core/store';
import {
  buildTasks,
  fetchHealthViaBackground,
  planTranslation,
  type TranslatorOptions,
} from '@/core/translator';
import { ViewportTracker, type ViewportTrackerOptions } from '@/core/viewport';
import { DEFAULT_DISPLAY_MODE, DEFAULT_TARGET_LANGUAGE } from '@/shared/constants';
import type {
  BlockStats,
  DisplayMode,
  HealthResponse,
  PageState,
  SendTranslationRequest,
  StreamTranslationRequest,
  TranslationBlock,
  TranslationStreamItem,
  TranslationStyle,
  WireTranslateRequest,
} from '@/shared/types';

export interface PageControllerOptions {
  targetLanguage?: string;
  sourceLanguage?: string;
  style?: TranslationStyle;
  /** 注入**非流式**请求实现；测试可传替身以避免真实网络 */
  send?: SendTranslationRequest;
  /** 注入流式实现；默认走 background 的 Port 中继 */
  stream?: StreamTranslationRequest;
  /** 并发请求数（默认 3，会被夹到 1–5） */
  concurrency?: number;
  /** 单次任务的最大重试次数（不含首次尝试） */
  maxRetries?: number;
  viewportHeight?: number;
  measure?: (element: Element) => { top: number; bottom: number };
  document?: Document;
  /** 视口之外再提前多少屏开始翻译（默认 1，见方案第 65 节「附近区域」） */
  lookaheadScreens?: number;
  /** 视口追踪的收集窗口（毫秒），合并滚动产生的碎回调 */
  flushDelayMs?: number;
  /** 视口高度提供者（测试用） */
  getViewportHeight?: () => number;
  /** IntersectionObserver 工厂（测试用） */
  createObserver?: ViewportTrackerOptions['createObserver'];
  /** 直接注入追踪器（测试用） */
  tracker?: ViewportTracker;
  /** 是否监听动态内容（Phase 10）。默认开启 */
  watchMutations?: boolean;
  /** DOM 变动的合并窗口（毫秒） */
  mutationFlushDelayMs?: number;
  /** MutationObserver 工厂（测试用） */
  createMutationObserver?: MutationWatcherOptions['createObserver'];
  /** 是否监听 SPA 路由变化（Phase 11）。默认开启 */
  watchRoute?: boolean;
  /** 路由轮询间隔（毫秒） */
  routePollIntervalMs?: number;
  /** 取当前 URL（测试用） */
  getLocationHref?: () => string;
  /** 直接注入路由监听器（测试用） */
  routeWatcher?: RouteWatcher;
  /** 是否启用译文缓存（方案第 86.8 节）。默认开启 */
  enableCache?: boolean;
  /** 直接注入缓存实例（测试用） */
  cache?: TranslationCache;
  /** 直接注入站点适配器（测试用）。默认按 url 选 */
  adapter?: SiteAdapter;
  /** 用于选择适配器的 URL。默认读 location.href */
  url?: URL;
  /** 探测本地服务的实现（测试用） */
  requestHealth?: () => Promise<HealthResponse>;
}

export interface PageSnapshot {
  state: PageState;
  mode: DisplayMode;
  stats: BlockStats;
  /** 一条失败原因（给 Popup / 侧边栏讲清「为什么失败」），没有失败时为 null */
  failureReason: string | null;
}

export interface TranslatePageResult {
  /** 计划执行的批次数 */
  batches: number;
  succeeded: number;
  failed: number;
  translatedItems: number;
  /** 因批次失败而降级为单条重试的批次数 */
  degraded: number;
  /** 实际发出的请求总数（含重试与降级） */
  attempts: number;
  /** 本次分页得到（或复用的）Block 总数 */
  blocks: number;
}

const EMPTY_QUEUE_RESULT: QueueRunResult = {
  tasks: 0,
  succeeded: 0,
  failed: 0,
  translatedItems: 0,
  degraded: 0,
  cancelled: false,
  attempts: 0,
};

function toPageResult(result: QueueRunResult, blocks: number): TranslatePageResult {
  return {
    batches: result.tasks,
    succeeded: result.succeeded,
    failed: result.failed,
    translatedItems: result.translatedItems,
    degraded: result.degraded,
    attempts: result.attempts,
    blocks,
  };
}

export class PageController {
  readonly #store = new PageStore();
  readonly #renderer = new Renderer();
  readonly #options: PageControllerOptions;
  readonly #tracker: ViewportTracker;
  readonly #watcher: MutationWatcher;
  readonly #routeWatcher: RouteWatcher;
  readonly #cache: TranslationCache;
  readonly #adapter: SiteAdapter;
  /**
   * 当前正在跑的队列。
   *
   * 取消必须能拿到「正在跑的那一个」——每次 `#runBlocks` 都新建队列，
   * 所以这里要留引用。同时只能有一个：翻译是串行触发的。
   */
  #activeQueue: TranslationQueue | null = null;

  /**
   * 运行代次。`cancel()` / `restore()` / `reset()` 会让它自增。
   *
   * 用来拦住「异步流程走完之后才发现用户已经取消」的情况。
   * 典型症状：`translate()` 结尾无条件调 `#renderTranslated()`，
   * 用户中途点了「恢复原文」，页面又被整页渲染回译文——
   * 这正是实际使用中报上来的问题。
   *
   * 只在 `await` 之后检查：`await` 之前是同步的，代次不会变。
   */
  #generation = 0;
  #mode: DisplayMode = DEFAULT_DISPLAY_MODE;
  /** 等待翻译的 Block（滚动进入视口后累积），按 id 去重 */
  #pending = new Map<string, TranslationBlock>();
  /** 是否有一次懒加载翻译正在进行 */
  #draining = false;
  /** 动态分段的 ID 前缀计数，保证每次重新分段的 Block ID 不与已有的冲突 */
  #dynamicRound = 0;

  constructor(options: PageControllerOptions = {}) {
    this.#options = options;

    const trackerOptions: ViewportTrackerOptions = {};
    if (options.lookaheadScreens !== undefined) {
      trackerOptions.lookaheadScreens = options.lookaheadScreens;
    }
    if (options.flushDelayMs !== undefined) {
      trackerOptions.flushDelayMs = options.flushDelayMs;
    }
    if (options.getViewportHeight !== undefined) {
      trackerOptions.getViewportHeight = options.getViewportHeight;
    }
    if (options.createObserver !== undefined) {
      trackerOptions.createObserver = options.createObserver;
    }

    this.#tracker = options.tracker ?? new ViewportTracker(trackerOptions);

    const watcherOptions: MutationWatcherOptions = {};
    if (options.mutationFlushDelayMs !== undefined) {
      watcherOptions.flushDelayMs = options.mutationFlushDelayMs;
    }
    if (options.createMutationObserver !== undefined) {
      watcherOptions.createObserver = options.createMutationObserver;
    }

    const routeOptions: RouteWatcherOptions = {};
    if (options.routePollIntervalMs !== undefined) {
      routeOptions.pollIntervalMs = options.routePollIntervalMs;
    }
    if (options.getLocationHref !== undefined) {
      routeOptions.getUrl = options.getLocationHref;
    }

    this.#routeWatcher = options.routeWatcher ?? new RouteWatcher(routeOptions);

    this.#cache = options.cache ?? new TranslationCache();

    // 适配器按 URL 选（方案第 64 节）。核心代码不做域名判断——
    // 域名只出现在 adapters/ 里，见 adapters/no-domain-in-core.test.ts。
    this.#adapter =
      options.adapter ??
      selectAdapter(options.url ?? new URL(globalThis.location?.href ?? 'http://localhost/'));

    this.#watcher = new MutationWatcher({
      ...watcherOptions,
      getRoot: () => this.#adapter.getRoot(this.#document),
    });
  }

  get mode(): DisplayMode {
    return this.#mode;
  }

  get state(): PageState {
    return this.#store.pageState;
  }

  get store(): PageStore {
    return this.#store;
  }

  get renderer(): Renderer {
    return this.#renderer;
  }

  get tracker(): ViewportTracker {
    return this.#tracker;
  }

  get watcher(): MutationWatcher {
    return this.#watcher;
  }

  get routeWatcher(): RouteWatcher {
    return this.#routeWatcher;
  }

  get cache(): TranslationCache {
    return this.#cache;
  }

  get adapter(): SiteAdapter {
    return this.#adapter;
  }

  snapshot(): PageSnapshot {
    return {
      state: this.#store.pageState,
      mode: this.#mode,
      stats: this.#store.stats(),
      failureReason: this.#store.failureReason(),
    };
  }

  /**
   * 扫描页面：分段并登记到 store。**不发起任何请求。**
   *
   * 返回 Block 数。
   */
  scan(): number {
    this.#store.setPageState('SCANNING');

    // 分段根由适配器决定（方案第 64 节）：Twitter 只翻主列，
    // 默认适配器返回 document.body
    const root = this.#adapter.getRoot(this.#document) ?? this.#document.body;
    const blocks = root === null ? [] : segmentElement(root, this.#segmentOptions());

    this.#store.replaceAll(blocks);
    this.#syncState();
    return blocks.length;
  }

  /**
   * 翻译当前页面。
   *
   * **Viewport-first + Lazy**（方案第 65、66 节）：
   *   1. 先翻「视口 + 前瞻区」内的 Block——首屏最快出结果
   *   2. 之后滚动进入该范围的 Block 由 `ViewportTracker` 自动追加
   *
   * **未进入视口的内容不产生请求**（Phase 9 验收标准）。
   *
   * 并发、重试与降级由 `TranslationQueue` 负责。
   */
  async translate(): Promise<TranslatePageResult> {
    if (this.#store.size === 0) {
      this.scan();
    }

    if (this.#store.size === 0) {
      this.#store.setPageState('IDLE');
      return toPageResult(EMPTY_QUEUE_RESULT, 0);
    }

    this.#store.setPageState('TRANSLATING');

    // 缓存键需要 provider / model / promptVersion（方案第 86.8 节）
    await this.#refreshCacheContext();

    // 首屏（视口 + 前瞻区）优先。这里不用等 IntersectionObserver 的异步回调，
    // 直接按几何位置筛选，首屏请求可以立刻发出。
    const initial = this.#tracker.filterInRange(
      this.#store.byStatus('UNTRANSLATED').map((entry) => entry.block),
    );

    // ⭐ 观察器必须在**发请求之前**装上。
    //
    // `#runBlocks` 要等整批跑完才返回——真实模型下是几十秒（实测 35–70s）。
    // 这期间页面自己在改 DOM（实测 Mintlify 文档站加载后前 10 秒有约 300 次
    // 节点新增、100 次移除），晚装的观察器会把它们**全部漏掉**：
    // 表现就是「进度条在涨、页面上却没有译文」，以及滚动时新内容不翻译。
    //
    // 先把 `initial` 标成 QUEUED：否则视口追踪会把同一批再排一次（重复请求）。
    this.#store.markMany(
      initial.map((block) => block.id),
      'QUEUED',
    );
    // 后续滚动进入视口的 Block 自动追加
    this.#startTracking();
    // 新加载 / 原地更新的内容自动接入（Phase 10）
    this.#startWatching();
    // SPA 路由变化后清理旧状态并重新分段（Phase 11）
    this.#startRouteWatching();

    const generation = this.#generation;
    const result = await this.#runBlocks(initial);

    // 期间用户可能点了「取消」或「恢复原文」——那就什么都不做。
    // 不检查的话，这里的 `#renderTranslated()` 会把整页重新渲染成译文，
    // 用户看到的就是「点了恢复原文没用」。
    if (generation !== this.#generation) {
      return toPageResult(result, this.#store.size);
    }

    this.#syncState();
    this.#renderTranslated();

    // 重新收集一次：这一轮跑完后还有没翻到的（视口外 / 失败后重试过的）
    this.#startTracking();

    return toPageResult(result, this.#store.size);
  }

  /**
   * 切换显示模式。
   *
   * **不发起任何请求**——译文已在 store 中，这里只重新渲染。
   */
  setMode(mode: DisplayMode): void {
    if (mode === this.#mode) {
      return;
    }

    this.#mode = mode;

    // ⭐ 切到「原文」= 停止翻译。
    //
    // 这是用户指定的停止方式。曾经试过在面板上加「取消翻译 / 重新翻译」
    // 三态按钮，但那让界面和心智都变复杂，而且状态同步容易出 bug。
    // 「我不想看译文了」和「别翻了」本来就是同一件事——用模式表达最自然。
    //
    // 注意是 `cancel()` 而不是 `restore()`：已经翻好的保留在 store 里，
    // 切回双语时不必重新花钱。
    if (mode === 'original') {
      this.cancel();
    }

    this.#renderTranslated();
    this.#syncState();
  }

  /**
   * 恢复原文，并清空渲染记录。
   *
   * **必须先取消在跑的翻译**——否则在途请求返回时会把译文又写回 DOM，
   * 用户看到的现象就是「点了恢复原文没用」。
   */
  restore(): void {
    this.cancel();
    this.#stopTracking();
    this.#watcher.stop();
    this.#routeWatcher.stop();
    this.#renderer.restoreAll();
    this.#store.setPageState(this.#store.size > 0 ? 'RESTORED' : 'IDLE');
  }

  /**
   * 取消正在进行的翻译。
   *
   * 把「排队中 / 翻译中」的 Block 退回 `UNTRANSLATED`——它们没有拿到译文，
   * 留在中间态会让下次翻译漏掉它们。**已翻译的不动**：那些是已经花过钱的结果。
   */
  cancel(): void {
    this.#generation += 1;
    this.#activeQueue?.cancel();
    this.#activeQueue = null;

    this.#stopTracking();

    const pending = this.#store
      .byStatus('QUEUED')
      .concat(this.#store.byStatus('TRANSLATING'))
      .map((entry) => entry.block.id);

    if (pending.length > 0) {
      this.#store.markMany(pending, 'UNTRANSLATED');
    }

    this.#syncState();
  }

  /** 丢弃全部状态（页面导航后调用）。 */
  reset(): void {
    this.#generation += 1;
    this.#stopTracking();
    this.#watcher.stop();
    this.#routeWatcher.stop();
    this.#renderer.restoreAll();
    this.#store.clear();
    this.#dynamicRound = 0;
  }

  /** 手动触发一次「视口内待翻译内容」的处理（测试与调试用）。 */
  async translateVisible(): Promise<QueueRunResult> {
    const blocks = this.#tracker.filterInRange(
      this.#store.byStatus('UNTRANSLATED').map((entry) => entry.block),
    );

    const generation = this.#generation;
    const result = await this.#runBlocks(blocks);

    if (generation !== this.#generation) {
      return result;
    }

    this.#renderTranslated();
    this.#syncState();
    return result;
  }

  /**
   * 组装分段选项，把适配器的规则一并带上（方案第 64 节）。
   *
   * 三条路径共用：初次扫描、动态重新分段、以及未来的其它入口——
   * 分开组装迟早会漏掉其中一处，表现为「首次翻译正确、动态内容错乱」。
   */
  #segmentOptions(idPrefix?: string): SegmentOptions {
    const options: SegmentOptions = { targetLanguage: this.#targetLanguage };

    if (idPrefix !== undefined) {
      options.idPrefix = idPrefix;
    }
    if (this.#adapter.extraBlockTags !== undefined) {
      options.extraBlockTags = this.#adapter.extraBlockTags;
    }
    if (this.#adapter.shouldIgnore !== undefined) {
      options.shouldIgnore = this.#adapter.shouldIgnore;
    }

    return options;
  }

  get #document(): Document {
    return this.#options.document ?? globalThis.document;
  }

  get #targetLanguage(): string {
    return this.#options.targetLanguage ?? DEFAULT_TARGET_LANGUAGE;
  }

  /**
   * 把一批 Block 交给队列执行，中间经过缓存（方案第 86.8 节）。
   *
   * 计划 → 查缓存 → 命中的直接落库并渲染（**不发请求**）
   *                → 未命中的进队列
   *                → 队列返回后回写缓存
   */
  async #runBlocks(blocks: readonly TranslationBlock[]): Promise<QueueRunResult> {
    if (blocks.length === 0) {
      return EMPTY_QUEUE_RESULT;
    }

    const options = this.#translateOptions();
    const plan = planTranslation(blocks, options);
    const tasks = buildTasks(plan, options);

    const pending = await this.#applyCache(tasks);

    let result: QueueRunResult = EMPTY_QUEUE_RESULT;

    if (pending.length > 0) {
      const queue = this.#createQueue();
      // 留引用：取消要能拿到「正在跑的那一个」
      this.#activeQueue = queue;

      try {
        result = await queue.run(pending, this.#store);
      } finally {
        // 只清掉自己那一个——期间可能已被后续调用替换
        if (this.#activeQueue === queue) {
          this.#activeQueue = null;
        }
      }
    }

    await this.#fillCache(tasks);

    // 缓存命中的条目不在队列结果里，所以从 store 重新统计
    return {
      ...result,
      tasks: tasks.length,
      translatedItems: countTranslated(tasks, this.#store),
    };
  }

  /** 查缓存：命中的直接落库并渲染，返回需要真正发请求的任务。 */
  async #applyCache(tasks: readonly WireTranslateRequest[]): Promise<WireTranslateRequest[]> {
    if (!this.#cache.enabled) {
      return [...tasks];
    }

    const pending: WireTranslateRequest[] = [];

    for (const task of tasks) {
      const { hits, misses } = await this.#cache.lookup(task, task.items);

      for (const [id, translation] of hits) {
        this.#store.markTranslated(id, translation);

        const entry = this.#store.get(id);
        this.#renderItem({ id, source: entry?.block.text ?? '', translation });
      }

      if (misses.length > 0) {
        pending.push({ ...task, items: misses });
      }
    }

    return pending;
  }

  /** 把本批已拿到的译文回写缓存。 */
  async #fillCache(tasks: readonly WireTranslateRequest[]): Promise<void> {
    if (!this.#cache.enabled) {
      return;
    }

    for (const task of tasks) {
      const items = task.items.flatMap((item) => {
        const entry = this.#store.get(item.id);
        if (entry?.status !== 'TRANSLATED' || entry.translation === undefined) {
          return [];
        }
        return [{ id: item.id, text: item.text, translation: entry.translation }];
      });

      if (items.length > 0) {
        await this.#cache.store(task, items);
      }
    }
  }

  /**
   * 从 `/api/v1/health` 取缓存上下文（provider / model / promptVersion）。
   *
   * **拿不到就停用缓存**——宁可不用，也不冒着用错键的风险。
   */
  async #refreshCacheContext(): Promise<void> {
    if (this.#options.enableCache === false) {
      this.#cache.setContext(null);
      return;
    }

    try {
      const health = await (this.#options.requestHealth ?? fetchHealthViaBackground)();
      this.#cache.setContext({
        provider: health.provider,
        model: health.model,
        promptVersion: health.promptVersion,
      });
    } catch {
      this.#cache.setContext(null);
    }
  }

  /**
   * 开始追踪后续滚动。
   *
   * 只追踪**尚未翻译**的 Block——已翻好的再回调一次毫无意义。
   */
  #startTracking(): void {
    const pending = this.#store.byStatus('UNTRANSLATED').map((entry) => entry.block);

    if (pending.length === 0) {
      return;
    }

    this.#tracker.start(pending, (blocks) => {
      this.#handleEnter(blocks);
    });
  }

  #stopTracking(): void {
    this.#tracker.stop();
    this.#pending.clear();
  }

  /**
   * 开始监听 DOM 变动（方案第 13.1 节）。
   *
   * 变动 → 归到块级容器 → 恢复该范围内的已渲染 Block → 重新分段
   * → `upsert` 去重 → 交给视口追踪（进入范围才翻译）。
   */
  #startWatching(): void {
    if (this.#options.watchMutations === false) {
      return;
    }

    this.#watcher.start((roots) => {
      void this.#handleMutations(roots);
    });
  }

  async #handleMutations(roots: readonly Element[]): Promise<void> {
    const fresh: TranslationBlock[] = [];

    // 页面可能把容器**换成等价的新节点**——那条旧条目永远等不到重新分段
    this.#sweepDetached();

    for (const root of roots) {
      // 重新分段前必须先把范围内的已渲染 Block 恢复原文——
      // 中文模式是就地改写文本，不恢复的话会把**译文**当成原文再翻一遍
      this.#restoreRenderedWithin(root);

      this.#dynamicRound += 1;
      // 每次重新分段换一个前缀：Block ID 按局部序号生成，
      // 沿用同一个前缀会与已有的 ID 冲突
      const blocks = segmentElement(root, this.#segmentOptions(`dyn${this.#dynamicRound}`));
      const produced: string[] = [];

      for (const block of blocks) {
        const result = this.#store.upsert(block);

        // `upsert` 命中旧锚点时保留旧 ID，所以要以 store 里的为准
        const entry = this.#store.findByAnchor(blockAnchor(block));
        if (entry === undefined) {
          continue;
        }

        produced.push(entry.block.id);

        if (result !== 'unchanged') {
          fresh.push(entry.block);
        }
      }

      // 对账：这次没再产出的条目（切点移动后锚点对不上、或内容已不值得翻译）
      // 必须删掉，否则会留在 store 里变成幽灵
      this.#store.reconcile(root, produced);
    }

    // 恢复过原文的 Block 需要按当前模式重绘
    this.#renderTranslated();
    this.#syncState();

    if (fresh.length === 0) {
      return;
    }

    // 新内容同样受视口规则约束：只有进入范围才翻译
    for (const block of this.#tracker.filterInRange(fresh)) {
      this.#pending.set(block.id, block);
    }

    // 重建追踪，把新内容也纳入观察
    this.#startTracking();

    await this.#drain();
  }

  /**
   * 清理「容器已经不在文档里」的条目。
   *
   * ## 为什么必须有
   *
   * 页面把某个容器**换成等价的新节点**时（React 客户端渲染的常见形状），
   * 我们的锚点指向的是**旧节点**：
   *
   *   - `upsert` 认不出它（锚点不同）→ 只会再登记一条新条目
   *   - 旧条目的容器不在重新分段的根里 → `reconcile` 也收不到它
   *   - 旧译文节点是容器的**兄弟**，容器被换掉后它仍留在页面上
   *
   * 结果是新译文与旧译文同时出现——「同一段被翻了两遍」——成本也重复计。
   * 判据很直接：容器不在文档里，这条就不可能再被渲染。
   */
  #sweepDetached(): void {
    for (const entry of this.#store.all()) {
      if (entry.block.element.isConnected) {
        continue;
      }

      // 先摘掉可能还挂在页面上的译文节点，再从 store 里删掉
      this.#renderer.restore(entry.block.id);
      this.#store.remove(entry.block.id);
    }
  }

  /**
   * 把某个容器范围内已渲染的 Block 恢复原文。
   *
   * ⚠️ 走渲染器自己的记录（`restoreWithin`），**不要**再用 `PageStore` 反查：
   * 条目被对账删掉之后记录还在，那样会留下孤儿译文节点，
   * 新译文一到就变成「同一段被翻了两遍」。
   */
  #restoreRenderedWithin(root: Element): void {
    this.#renderer.restoreWithin(root);
  }

  /**
   * 开始监听 SPA 路由变化（方案第 74 节）。
   *
   * 只在调用过 `translate()` 之后才启动——没翻译过的页面不需要跟着路由跑。
   */
  #startRouteWatching(): void {
    if (this.#options.watchRoute === false) {
      return;
    }

    this.#routeWatcher.start(() => {
      void this.#handleRouteChange();
    });
  }

  /**
   * 路由变化：清理旧状态 → 重新分段 → 必要时继续翻译。
   *
   * 「继续翻译」的判定是「切换前页面上有译文」——
   * 用户既然打开了翻译，新页面也该是翻译状态，不该要求他再点一次。
   */
  async #handleRouteChange(): Promise<void> {
    const wasTranslating = this.#store.stats().translated > 0;

    this.#stopTracking();
    this.#watcher.stop();
    this.#renderer.restoreAll();
    this.#store.clear();
    this.#dynamicRound = 0;

    this.scan();

    if (wasTranslating) {
      await this.translate();
      return;
    }

    this.#startRouteWatching();
  }

  /** 滚动进入视口：累积待翻集合，再触发一次排空。 */
  #handleEnter(blocks: readonly TranslationBlock[]): void {
    for (const block of blocks) {
      // 过滤掉刚被别的路径翻掉的
      if (this.#store.get(block.id)?.status === 'UNTRANSLATED') {
        this.#pending.set(block.id, block);
      }
    }

    void this.#drain();
  }

  /**
   * 排空待翻集合。
   *
   * 用 `#draining` 保证同一时刻只有一次懒加载翻译在跑；
   * 期间新进入视口的 Block 会留在 `#pending`，由循环的下一轮取走——
   * 既不会丢，也不会重叠。
   */
  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }

    this.#draining = true;

    try {
      while (this.#pending.size > 0) {
        const blocks = [...this.#pending.values()];
        this.#pending.clear();

        this.#store.setPageState('TRANSLATING');
        await this.#runBlocks(blocks);
        this.#renderTranslated();
        this.#syncState();

        for (const block of blocks) {
          this.#tracker.release(block);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #translateOptions(): TranslatorOptions {
    const options: TranslatorOptions = {
      targetLanguage: this.#targetLanguage,
    };

    if (this.#options.sourceLanguage !== undefined) {
      options.sourceLanguage = this.#options.sourceLanguage;
    }
    if (this.#options.style !== undefined) {
      options.style = this.#options.style;
    }
    if (this.#options.viewportHeight !== undefined) {
      options.viewportHeight = this.#options.viewportHeight;
    }
    if (this.#options.measure !== undefined) {
      options.measure = this.#options.measure;
    }

    return options;
  }

  /**
   * 构造队列。
   *
   * 默认走**流式**（方案第 86.9 节）：条目一到就渲染，不必等整批返回。
   * 注入了 `send` 替身时改用非流式——测试不需要真的拉一条流。
   */
  #createQueue(): TranslationQueue {
    const queueOptions: TranslationQueueOptions = {};

    if (this.#options.send !== undefined) {
      queueOptions.send = this.#options.send;
    } else {
      queueOptions.stream = this.#options.stream ?? streamTranslationViaBackground;
      queueOptions.onItem = (item) => {
        this.#renderItem(item);
      };
    }

    if (this.#options.concurrency !== undefined) {
      queueOptions.concurrency = this.#options.concurrency;
    }
    if (this.#options.maxRetries !== undefined) {
      queueOptions.maxRetries = this.#options.maxRetries;
    }

    return new TranslationQueue(queueOptions);
  }

  /**
   * 流式：单个条目一到就渲染。
   *
   * 不调用 `#renderTranslated()`——那会把整页重绘一遍，
   * 每来一个条目做一次就成了 O(n²)。
   */
  #renderItem(item: TranslationStreamItem): void {
    if (this.#mode === 'original') {
      return;
    }

    const entry = this.#store.get(item.id);
    if (entry === undefined) {
      return;
    }

    this.#watcher.pause();
    try {
      this.#renderer.render(entry.block, item.translation, this.#mode);
    } finally {
      this.#watcher.resume();
    }
  }

  /** 按当前模式重新渲染全部已翻译的 Block。 */
  /**
   * 按当前模式重新渲染全部已翻译的 Block。
   *
   * 全程 `pause()` 住 MutationObserver：渲染会大量改动 DOM，
   * 不屏蔽就会把自己的写入当成「页面新内容」反复处理（方案第 13.2 节）。
   * `resume()` 内部会 `takeRecords()` 丢弃这期间积累的记录。
   */
  #renderTranslated(): void {
    this.#sweepDetached();
    this.#watcher.pause();

    try {
      this.#renderer.restoreAll();

      if (this.#mode === 'original') {
        return;
      }

      for (const entry of this.#store.byStatus('TRANSLATED')) {
        if (entry.translation === undefined) {
          continue;
        }
        this.#renderer.render(entry.block, entry.translation, this.#mode);
      }
    } finally {
      this.#watcher.resume();
    }
  }

  /** 根据「是否有译文」与「当前模式」推导页面状态。 */
  #syncState(): void {
    if (this.#store.size === 0 || this.#store.stats().translated === 0) {
      this.#store.setPageState('IDLE');
      return;
    }
    this.#store.setPageState(this.#mode === 'original' ? 'RESTORED' : 'ACTIVE');
  }
}
