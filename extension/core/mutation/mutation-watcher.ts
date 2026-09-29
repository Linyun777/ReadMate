/**
 * DOM 变动监听（方案第 13、13.1、13.2 节）。
 *
 * 用于两类动态内容：
 *   - 滚动 / 分页后**新加载**的节点（`childList`）
 *   - SPA **原地更新**的文本（`characterData`）
 *
 * 只输出「该重新分段哪几片 DOM」（块级容器），不自己做分段与翻译——
 * 那是 `core/segmenter` 与 `core/queue` 的职责。
 *
 * ## 防止无限循环（方案第 13.2 节）
 *
 * 插件自己插入译文时也会触发 Observer，必须屏蔽。这里用两层：
 *
 *   1. **渲染期间 pause + resume 时 `takeRecords()` 丢弃**
 *      渲染是同步的，`takeRecords()` 同步调用时观察器的微任务还没跑，
 *      所以丢弃的只会是我们自己产生的记录。
 *      中文模式是就地改写文本，节点上没有标记，这一层是唯一可靠的手段。
 *   2. **节点标记过滤**——`[data-ai-translator]` 及其后代直接跳过。
 *      这是方案第 13.2 节规定的方式，作为第二道防线。
 */

import { findBlockContainer } from '@/core/segmenter';
import { PLUGIN_NODE_ATTR } from '@/shared/constants';

export interface MutationRecordLike {
  type: string;
  target: Node;
  addedNodes: ArrayLike<Node>;
}

export interface MutationObserverLike {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
  takeRecords(): MutationRecordLike[];
}

export type MutationObserverFactory = (
  callback: (records: MutationRecordLike[]) => void,
) => MutationObserverLike;

export interface MutationWatcherOptions {
  /** 合并窗口（毫秒）。DOM 变动往往成串到来，逐条处理会产生大量碎请求 */
  flushDelayMs?: number;
  createObserver?: MutationObserverFactory;
  /** 观察根。默认 `document.body` */
  getRoot?: () => Node | null;
  /** 判定节点是否属于插件自身。默认查 `[data-ai-translator]` 祖先 */
  isPluginNode?: (node: Node) => boolean;
}

/** 默认合并窗口 */
export const DEFAULT_MUTATION_FLUSH_MS = 300;

function defaultRoot(): Node | null {
  return globalThis.document?.body ?? null;
}

function defaultIsPluginNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (element === null) {
    return false;
  }
  return element.closest(`[${PLUGIN_NODE_ATTR}]`) !== null;
}

function defaultObserverFactory(
  callback: (records: MutationRecordLike[]) => void,
): MutationObserverLike {
  return new MutationObserver((records) => {
    callback(records as unknown as MutationRecordLike[]);
  });
}

/** 去掉被其他根包含的根，避免对同一片 DOM 重复分段。 */
function dropNestedRoots(roots: readonly Element[]): Element[] {
  return roots.filter(
    (candidate) => !roots.some((other) => other !== candidate && other.contains(candidate)),
  );
}

export class MutationWatcher {
  readonly #flushDelayMs: number;
  readonly #createObserver: MutationObserverFactory;
  readonly #getRoot: () => Node | null;
  readonly #isPluginNode: (node: Node) => boolean;

  #observer: MutationObserverLike | null = null;
  #onChange: ((roots: Element[]) => void) | null = null;
  #pending: Element[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #paused = false;

  constructor(options: MutationWatcherOptions = {}) {
    this.#flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_MUTATION_FLUSH_MS);
    this.#createObserver = options.createObserver ?? defaultObserverFactory;
    this.#getRoot = options.getRoot ?? defaultRoot;
    this.#isPluginNode = options.isPluginNode ?? defaultIsPluginNode;
  }

  get running(): boolean {
    return this.#observer !== null;
  }

  /** 开始监听。重复调用会先停掉上一次。 */
  start(onChange: (roots: Element[]) => void): void {
    this.stop();

    const root = this.#getRoot();
    if (root === null) {
      return;
    }

    this.#onChange = onChange;
    this.#paused = false;
    this.#observer = this.#createObserver((records) => this.#handle(records));
    this.#observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  stop(): void {
    this.#cancelFlush();

    this.#observer?.disconnect();
    this.#observer = null;
    this.#onChange = null;
    this.#pending = [];
    this.#paused = false;
  }

  /**
   * 暂停：渲染译文期间调用。
   *
   * `resume()` 会丢弃这期间积累的记录——那都是我们自己造成的变动。
   */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    // 渲染是同步的，此刻观察器的微任务还没跑，takeRecords 丢掉的只会是自己的记录
    this.#observer?.takeRecords();
  }

  /** 是否处于暂停状态（测试用）。 */
  get paused(): boolean {
    return this.#paused;
  }

  #handle(records: readonly MutationRecordLike[]): void {
    if (this.#paused || this.#onChange === null) {
      return;
    }

    const roots = this.#resolveRoots(records);
    if (roots.length === 0) {
      return;
    }

    this.#pending.push(...roots);
    this.#scheduleFlush();
  }

  /** 把变动记录归到「该重新分段的块级容器」。 */
  #resolveRoots(records: readonly MutationRecordLike[]): Element[] {
    const roots: Element[] = [];
    const seen = new Set<Element>();

    const consider = (node: Node): void => {
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (element === null || this.#isPluginNode(element)) {
        return;
      }

      const root = findBlockContainer(element);
      if (seen.has(root)) {
        return;
      }

      seen.add(root);
      roots.push(root);
    };

    for (const record of records) {
      if (record.type === 'characterData') {
        consider(record.target);
        continue;
      }

      for (const node of Array.from(record.addedNodes)) {
        consider(node);
      }
    }

    return dropNestedRoots(roots);
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) {
      return;
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, this.#flushDelayMs);
  }

  #cancelFlush(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  #flush(): void {
    const roots = dropNestedRoots(this.#pending);
    this.#pending = [];

    if (roots.length === 0) {
      return;
    }

    this.#onChange?.(roots);
  }
}
