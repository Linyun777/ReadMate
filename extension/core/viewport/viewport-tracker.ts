/**
 * 视口追踪（方案第 65、66 节）。
 *
 * 决定「**哪些 Block 现在值得翻译**」：
 *
 * ```text
 * 当前视口        → 最高优先级，立即翻译
 * 附近区域        → 中优先级，与视口内的一起翻译（由 lookahead 控制）
 * 远处内容        → 暂不请求，等滚动进入时再加入
 * ```
 *
 * 为什么要 lazy：大型页面一次翻整页会拉长首屏等待、抬高 token 成本。
 * 只翻「看得见 + 即将看得见」的部分，首屏更快、成本更低。
 *
 * 前瞻区（lookahead）的存在理由：只翻严格视口内的内容会让首屏下方一屏
 * 保持英文，滚动时一屏一屏地跳，体验很差。提前一屏一起翻就平滑了。
 */

import type { TranslationBlock } from '@/shared/types';

/** IntersectionObserver 的最小接口，便于测试注入替身。 */
export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface ObserverEntryLike {
  target: Element;
  isIntersecting: boolean;
}

export type ObserverFactory = (
  callback: (entries: ObserverEntryLike[]) => void,
  options: { rootMargin: string },
) => ObserverLike;

export interface ViewportTrackerOptions {
  /** 视口之外再提前多少屏开始翻译。默认 1 */
  lookaheadScreens?: number;
  /** 收集窗口（毫秒）。滚动时合并成批，避免每个回调都发一次请求 */
  flushDelayMs?: number;
  /** 视口高度。默认读 `globalThis.innerHeight`，测试可注入 */
  getViewportHeight?: () => number;
  /** 观察器工厂。默认用真实 `IntersectionObserver` */
  createObserver?: ObserverFactory;
}

/** 默认前瞻屏数（方案第 65 节的「附近区域」） */
export const DEFAULT_LOOKAHEAD_SCREENS = 1;

/** 默认收集窗口。滚动时的 IntersectionObserver 回调很碎，需要合并 */
export const DEFAULT_FLUSH_DELAY_MS = 150;

const FALLBACK_VIEWPORT_HEIGHT = 800;

function defaultViewportHeight(): number {
  const height = globalThis.innerHeight;
  return typeof height === 'number' && height > 0 ? height : FALLBACK_VIEWPORT_HEIGHT;
}

function defaultObserverFactory(
  callback: (entries: ObserverEntryLike[]) => void,
  options: { rootMargin: string },
): ObserverLike {
  // 环境不支持时退化为「不追踪」：首屏的几何筛选不依赖观察器，
  // 仍然可用，只是后续滚动不会自动补翻。jsdom 就是这种情况。
  if (typeof IntersectionObserver === 'undefined') {
    return { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      callback(
        entries.map((entry) => ({
          target: entry.target,
          isIntersecting: entry.isIntersecting,
        })),
      );
    },
    { rootMargin: options.rootMargin },
  );

  return observer;
}

export class ViewportTracker {
  readonly #lookaheadPx: number;
  readonly #flushDelayMs: number;
  readonly #getViewportHeight: () => number;
  readonly #createObserver: ObserverFactory;

  #observer: ObserverLike | null = null;
  #onEnter: ((blocks: TranslationBlock[]) => void) | null = null;
  /**
   * 容器元素 → 该容器下的 Block 列表。
   *
   * 用**列表**而不是单个 Block：拆大块后同一个容器下有多个 Block，
   * 只留最后一个会让其余段永远等不到回调（既不翻译，也不报错）。
   * 观察器只能观察元素，所以由容器代表它这一组。
   */
  #byElement = new Map<Element, TranslationBlock[]>();
  /** 用 Map 去重：同一个元素可能被观察器重复回调 */
  #pending = new Map<string, TranslationBlock>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ViewportTrackerOptions = {}) {
    this.#getViewportHeight = options.getViewportHeight ?? defaultViewportHeight;
    this.#lookaheadPx =
      this.#getViewportHeight() * (options.lookaheadScreens ?? DEFAULT_LOOKAHEAD_SCREENS);
    this.#flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
    this.#createObserver = options.createObserver ?? defaultObserverFactory;
  }

  /** 前瞻区高度（像素）。视口内 + 这之外的 `lookaheadPx` 都算「附近」 */
  get lookaheadPx(): number {
    return this.#lookaheadPx;
  }

  /** 元素是否落在「视口 + 前瞻区」内。 */
  isInRange(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const viewportHeight = this.#getViewportHeight();

    // 上方：元素底边 >= 0 即还没完全滚过去（已滚过的内容也补翻）
    return rect.bottom >= 0 && rect.top <= viewportHeight + this.#lookaheadPx;
  }

  /** 从一批 Block 中筛出当前值得翻译的（视口 + 前瞻区）。 */
  filterInRange(blocks: readonly TranslationBlock[]): TranslationBlock[] {
    return blocks.filter((block) => this.isInRange(block.element));
  }

  /**
   * 开始追踪。进入范围的元素会被**批量**回调（受 `flushDelayMs` 控制）。
   *
   * 重复调用会先停掉上一次追踪。
   */
  start(blocks: readonly TranslationBlock[], onEnter: (blocks: TranslationBlock[]) => void): void {
    this.stop();

    if (blocks.length === 0) {
      return;
    }

    this.#onEnter = onEnter;
    this.#byElement = new Map();
    for (const block of blocks) {
      const group = this.#byElement.get(block.element) ?? [];
      group.push(block);
      this.#byElement.set(block.element, group);
    }
    this.#observer = this.#createObserver((entries) => this.#handleEntries(entries), {
      // 下方扩展前瞻区；上方也给一点余量，让刚滚过去的 Block 仍能补翻
      rootMargin: `0px 0px ${this.#lookaheadPx}px 0px`,
    });

    for (const element of this.#byElement.keys()) {
      this.#observer.observe(element);
    }
  }

  /** 停止追踪并清掉待发缓冲。 */
  stop(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }

    this.#observer?.disconnect();
    this.#observer = null;
    this.#onEnter = null;
    this.#byElement.clear();
    this.#pending.clear();
  }

  /** 不再追踪某个 Block（翻译完成后调用，省掉无意义的回调）。 */
  release(block: TranslationBlock): void {
    const group = this.#byElement.get(block.element);
    if (group === undefined) {
      return;
    }

    const remaining = group.filter((item) => item.id !== block.id);

    // 该容器下没有待翻的段了才停止观察
    if (remaining.length === 0) {
      this.#observer?.unobserve(block.element);
      this.#byElement.delete(block.element);
      return;
    }

    this.#byElement.set(block.element, remaining);
  }

  #handleEntries(entries: readonly ObserverEntryLike[]): void {
    let added = false;

    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      const group = this.#byElement.get(entry.target);
      if (group === undefined) {
        continue;
      }

      for (const block of group) {
        this.#pending.set(block.id, block);
        added = true;
      }
    }

    if (added) {
      this.#scheduleFlush();
    }
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

  #flush(): void {
    const blocks = [...this.#pending.values()];
    this.#pending.clear();

    if (blocks.length === 0) {
      return;
    }

    this.#onEnter?.(blocks);
  }
}
