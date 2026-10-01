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
 *
 * ## 滚到底续翻（第 66 节的补充）
 *
 * `IntersectionObserver` 只对**真正相交过**的元素回调。用户按 `End`
 * 或拖滚动条一次到底时，中间十几屏从未相交——实测一篇长文（整页 219 段、
 * 首屏 72 段、页面高 20 屏）：**一次跳到底只多翻 7 段，剩下 140 段（64%）
 * 永远不翻**。而「滚到底」本身就是用户在说「我要看完」。
 *
 * 所以到达底部时把剩余内容一次性交给 `onEnter`——**不自己发请求**，
 * 调度仍然只有 `core/queue` 一个点（铁律 6）。
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

/**
 * 滚动位置指标。
 *
 * 抽成可注入的，是因为 jsdom 不做布局——`scrollTop` / `scrollHeight` 全是 0，
 * 靠真实环境测不出「到底」这件事。
 */
export interface ScrollMetrics {
  /** 已滚过的距离 */
  scrollTop: number;
  viewportHeight: number;
  /** 文档总高 */
  scrollHeight: number;
}

export interface ViewportTrackerOptions {
  /** 视口之外再提前多少屏开始翻译。默认 1 */
  lookaheadScreens?: number;
  /** 收集窗口（毫秒）。滚动时合并成批，避免每个回调都发一次请求 */
  flushDelayMs?: number;
  /** 视口高度。默认读 `globalThis.innerHeight`，测试可注入 */
  getViewportHeight?: () => number;
  /** 观察器工厂。默认用真实 `IntersectionObserver` */
  createObserver?: ObserverFactory;
  /**
   * 滚到页面底部时，把**剩余未翻译的内容一次性排队**。默认开启。
   *
   * 关掉它 = 退回「只翻相交过的内容」，即用户必须逐屏滚过整页。
   */
  continueAtBottom?: boolean;
  /** 距底部多少像素内算「到底」。默认取前瞻区一屏 */
  bottomThresholdPx?: number;
  /** 读滚动指标。默认读真实 `document`；测试注入 */
  getScrollMetrics?: () => ScrollMetrics;
}

/** 默认前瞻屏数（方案第 65 节的「附近区域」） */
export const DEFAULT_LOOKAHEAD_SCREENS = 1;

/** 默认收集窗口。滚动时的 IntersectionObserver 回调很碎，需要合并 */
export const DEFAULT_FLUSH_DELAY_MS = 150;

/** 默认开启「滚到底续翻」 */
export const DEFAULT_CONTINUE_AT_BOTTOM = true;

/**
 * 内部滚动条至少要有视口这么多比例的高度，才当成「正文滚动区」。
 *
 * 矮滚动条（代码块、下拉列表、侧边小面板）的「已经在底部」是天然成立的，
 * 不加这条就会因为它们而误触发整页续翻——那是真金白银。
 */
const INNER_SCROLLER_MIN_RATIO = 0.5;

const FALLBACK_VIEWPORT_HEIGHT = 800;

function defaultViewportHeight(): number {
  const height = globalThis.innerHeight;
  return typeof height === 'number' && height > 0 ? height : FALLBACK_VIEWPORT_HEIGHT;
}

function readScrollMetrics(viewportHeight: () => number): ScrollMetrics {
  // `scrollingElement` 在标准模式下就是 `html`；老实现里是 `body`
  const scroller = document.scrollingElement ?? document.documentElement;

  return {
    scrollTop: scroller.scrollTop,
    viewportHeight: viewportHeight(),
    scrollHeight: scroller.scrollHeight,
  };
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
  readonly #continueAtBottom: boolean;
  readonly #bottomThresholdPx: number;
  readonly #getScrollMetrics: (() => ScrollMetrics) | null;

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

  /** 到底续翻是否处于「已武装」状态（离开底部后重新武装） */
  #armedForBottom = true;
  #scrollHandler: ((event: Event) => void) | null = null;

  constructor(options: ViewportTrackerOptions = {}) {
    this.#getViewportHeight = options.getViewportHeight ?? defaultViewportHeight;
    this.#lookaheadPx =
      this.#getViewportHeight() * (options.lookaheadScreens ?? DEFAULT_LOOKAHEAD_SCREENS);
    this.#flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
    this.#createObserver = options.createObserver ?? defaultObserverFactory;
    this.#continueAtBottom = options.continueAtBottom ?? DEFAULT_CONTINUE_AT_BOTTOM;
    this.#getScrollMetrics = options.getScrollMetrics ?? null;
    // 阈值取前瞻区一屏：下方一屏内已经没有任何内容了，就算到底
    this.#bottomThresholdPx = options.bottomThresholdPx ?? this.#lookaheadPx;
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

    this.#watchBottom();
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
    this.#unwatchBottom();
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

  /**
   * 开始监听「滚到底」。
   *
   * 装好后**立刻查一次**：用户可能本来就停在底部（上一轮已经翻到底、
   * 页面又刚好长高了一点），那就不必等他再滚一下。
   * 首次加载时这次查询会被 `#checkBottom` 的 `scrollTop` 判据挡掉。
   */
  #watchBottom(): void {
    if (!this.#continueAtBottom) {
      return;
    }

    if (this.#scrollHandler === null) {
      // ⚠️ 必须挂在**捕获**阶段：`scroll` 事件**不冒泡**，内容滚在
      // `overflow: auto` 的 div 里时事件停在那个 div 上，window 的冒泡
      // 监听永远收不到——表现为「内部滚动容器的页面续翻不生效」。
      // 捕获阶段能看到所有后代发出的 scroll，`event.target` 就是真正的滚动元素。
      this.#scrollHandler = (event) => {
        this.#checkBottom(event.target);
      };
      globalThis.addEventListener('scroll', this.#scrollHandler, {
        passive: true,
        capture: true,
      });
    }

    this.#checkBottom(null);
  }

  #unwatchBottom(): void {
    if (this.#scrollHandler !== null) {
      globalThis.removeEventListener('scroll', this.#scrollHandler, { capture: true });
      this.#scrollHandler = null;
    }

    // 重新武装：下一次 start（多半是 DOM 变动触发的重建）还能再续翻一轮
    this.#armedForBottom = true;
  }

  /**
   * 已经滚到页面底部的话，把**剩余全部**交给 `onEnter`。
   *
   * 边沿触发：到底排一次；离开底部（多半是页面又长长了）才重新武装。
   * 重复排不会造成重复请求——调度是 `core/queue` 的事，而
   * `PageController.#handleEnter` 只收状态仍是 `UNTRANSLATED` 的 Block
   * （铁律 6：这里不自带任何并发）。
   */
  #checkBottom(target: EventTarget | null): void {
    const metrics = this.#metricsFor(target);
    if (metrics === null) {
      return;
    }

    const { scrollTop, viewportHeight, scrollHeight } = metrics;

    // `scrollTop > 0` 一句话挡掉两件事，所以不需要额外的「用户滚动过没有」状态：
    //   1. 页面刚打开、懒加载的图与区块还没把高度撑起来——此时
    //      「已经在底部」天然成立，据此全排就等于整页翻译，lazy 的收益全丢
    //   2. macOS 橡皮筋滚动这类「事件发了但其实没滚动」的情况
    // 真滚到底时 scrollTop 必然远大于 0，不受影响。
    if (scrollTop <= 0) {
      return;
    }

    const atBottom = scrollTop >= scrollHeight - viewportHeight - this.#bottomThresholdPx;

    if (!atBottom) {
      this.#armedForBottom = true;
      return;
    }

    if (!this.#armedForBottom) {
      return;
    }
    this.#armedForBottom = false;

    for (const group of this.#byElement.values()) {
      for (const block of group) {
        this.#pending.set(block.id, block);
      }
    }

    if (this.#pending.size > 0) {
      this.#scheduleFlush();
    }
  }

  /**
   * 这次滚动该用哪组指标。返回 `null` = 与我们无关，忽略。
   */
  #metricsFor(target: EventTarget | null): ScrollMetrics | null {
    // 文档级滚动：真实浏览器把 viewport 的 scroll 事件派给 `document`，
    // jsdom 里测试派发到 `window` 上——两者都不是 Element，一并归这里。
    // `<html>` / `<body>` 也走这条（标准模式下 `scrollingElement` 就是它们）。
    const scroller =
      target instanceof Element && target !== document.documentElement && target !== document.body
        ? target
        : null;

    if (scroller === null) {
      return this.#getScrollMetrics?.() ?? readScrollMetrics(this.#getViewportHeight);
    }

    // ⚠️ 两条判据缺一不可——内部滚动条很容易「天然已在底部」，
    // 照单全收就会误触发整页续翻（真金白银）。
    //
    //   ① 它得够高：正文滚动区通常占大半屏；代码块那种矮滚动条不算
    //   ② 它得真的在滚我们翻译的内容
    if (scroller.clientHeight < this.#getViewportHeight() * INNER_SCROLLER_MIN_RATIO) {
      return null;
    }
    if (!this.#scrollsOurContent(scroller)) {
      return null;
    }

    return {
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    };
  }

  /** 该滚动容器里是否装着至少一个还没翻的 Block。 */
  #scrollsOurContent(scroller: Element): boolean {
    for (const element of this.#byElement.keys()) {
      if (scroller.contains(element)) {
        return true;
      }
    }

    return false;
  }
}
