import { beforeEach, describe, expect, it } from 'vitest';

import type { TranslationBlock } from '@/shared/types';

import {
  type ObserverEntryLike,
  type ObserverFactory,
  type ObserverLike,
  type ScrollMetrics,
  ViewportTracker,
} from './viewport-tracker';

const VIEWPORT_HEIGHT = 800;

function makeBlock(id: string): TranslationBlock {
  const element = document.createElement('p');
  document.body.append(element);

  return {
    id,
    nodeIds: [],
    text: id,
    plainText: id,
    tagName: 'P',
    blockType: 'paragraph',
    placeholders: [],
    element,
  };
}

/** jsdom 的 getBoundingClientRect 全是 0，需要按用例打桩。 */
function stubRect(element: Element, top: number, height = 100): void {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** 假的 IntersectionObserver，可手动触发回调。 */
function makeFakeObserver() {
  const observed: Element[] = [];
  const unobserved: Element[] = [];
  const state = { disconnected: false, rootMargin: '' };
  let trigger: ((entries: ObserverEntryLike[]) => void) | null = null;

  const factory: ObserverFactory = (callback, options) => {
    trigger = callback;
    state.rootMargin = options.rootMargin;

    const observer: ObserverLike = {
      observe: (target) => {
        observed.push(target);
      },
      unobserve: (target) => {
        unobserved.push(target);
      },
      disconnect: () => {
        state.disconnected = true;
      },
    };

    return observer;
  };

  return {
    factory,
    observed,
    unobserved,
    state,
    fire: (entries: ObserverEntryLike[]) => trigger?.(entries),
  };
}

function makeTracker(
  fake: ReturnType<typeof makeFakeObserver>,
  overrides: { lookaheadScreens?: number; flushDelayMs?: number } = {},
): ViewportTracker {
  return new ViewportTracker({
    getViewportHeight: () => VIEWPORT_HEIGHT,
    createObserver: fake.factory,
    flushDelayMs: overrides.flushDelayMs ?? 0,
    ...(overrides.lookaheadScreens === undefined
      ? {}
      : { lookaheadScreens: overrides.lookaheadScreens }),
  });
}

/** 等一次 setTimeout(0)，让收集窗口落盘。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('ViewportTracker · 范围判定', () => {
  it('默认前瞻区为一屏', () => {
    const fake = makeFakeObserver();
    const tracker = makeTracker(fake);

    expect(tracker.lookaheadPx).toBe(VIEWPORT_HEIGHT);
  });

  it('前瞻屏数可配置', () => {
    const fake = makeFakeObserver();
    const tracker = makeTracker(fake, { lookaheadScreens: 2 });

    expect(tracker.lookaheadPx).toBe(VIEWPORT_HEIGHT * 2);
  });

  it('视口内的元素在范围内', () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    stubRect(block.element, 100);

    expect(makeTracker(fake).isInRange(block.element)).toBe(true);
  });

  it('前瞻区内的元素在范围内', () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    stubRect(block.element, VIEWPORT_HEIGHT + 400);

    expect(makeTracker(fake).isInRange(block.element)).toBe(true);
  });

  it('超出前瞻区的元素不在范围内', () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    stubRect(block.element, VIEWPORT_HEIGHT + 900);

    expect(makeTracker(fake).isInRange(block.element)).toBe(false);
  });

  it('跨越视口上边界的元素仍在范围内（允许补翻）', () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    // top=-50, height=100 → bottom=50，还有一半露在视口里
    stubRect(block.element, -50, 100);

    expect(makeTracker(fake).isInRange(block.element)).toBe(true);
  });

  it('完全滚过视口上方的元素不在范围内', () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    stubRect(block.element, -300, 100);

    expect(makeTracker(fake).isInRange(block.element)).toBe(false);
  });

  it('filterInRange 只留下范围内的', () => {
    const fake = makeFakeObserver();
    const near = makeBlock('near');
    const far = makeBlock('far');
    stubRect(near.element, 100);
    stubRect(far.element, VIEWPORT_HEIGHT + 2000);

    const result = makeTracker(fake).filterInRange([near, far]);

    expect(result.map((block) => block.id)).toEqual(['near']);
  });
});

describe('ViewportTracker · 追踪与回调', () => {
  it('start 会 observe 全部元素，并设置前瞻 rootMargin', () => {
    const fake = makeFakeObserver();
    const blocks = [makeBlock('b1'), makeBlock('b2')];

    makeTracker(fake).start(blocks, () => {});

    expect(fake.observed).toEqual(blocks.map((block) => block.element));
    expect(fake.state.rootMargin).toBe(`0px 0px ${VIEWPORT_HEIGHT}px 0px`);
  });

  it('进入视口的元素被回调', async () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    const received: string[][] = [];

    makeTracker(fake).start([block], (blocks) => {
      received.push(blocks.map((item) => item.id));
    });

    fake.fire([{ target: block.element, isIntersecting: true }]);
    await settle();

    expect(received).toEqual([['b1']]);
  });

  it('非 intersecting 的条目被忽略', async () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    const received: string[][] = [];

    makeTracker(fake).start([block], (blocks) => {
      received.push(blocks.map((item) => item.id));
    });

    fake.fire([{ target: block.element, isIntersecting: false }]);
    await settle();

    expect(received).toEqual([]);
  });

  it('未追踪的元素被忽略', async () => {
    const fake = makeFakeObserver();
    const tracked = makeBlock('tracked');
    const stranger = makeBlock('stranger');
    const received: string[][] = [];

    makeTracker(fake).start([tracked], (blocks) => {
      received.push(blocks.map((item) => item.id));
    });

    fake.fire([{ target: stranger.element, isIntersecting: true }]);
    await settle();

    expect(received).toEqual([]);
  });

  it('收集窗口内的多次回调合并成一批', async () => {
    const fake = makeFakeObserver();
    const a = makeBlock('a');
    const b = makeBlock('b');
    const received: string[][] = [];

    makeTracker(fake, { flushDelayMs: 10 }).start([a, b], (blocks) => {
      received.push(blocks.map((item) => item.id));
    });

    fake.fire([{ target: a.element, isIntersecting: true }]);
    fake.fire([{ target: b.element, isIntersecting: true }]);
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(received).toEqual([['a', 'b']]);
  });

  it('同一元素重复回调只上报一次', async () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    const received: string[][] = [];

    makeTracker(fake).start([block], (blocks) => {
      received.push(blocks.map((item) => item.id));
    });

    fake.fire([{ target: block.element, isIntersecting: true }]);
    fake.fire([{ target: block.element, isIntersecting: true }]);
    await settle();

    expect(received).toEqual([['b1']]);
  });

  it('stop 会断开观察器并丢弃待发缓冲', async () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');
    const received: string[][] = [];
    const tracker = makeTracker(fake, { flushDelayMs: 10 });

    tracker.start([block], (blocks) => {
      received.push(blocks.map((item) => item.id));
    });

    fake.fire([{ target: block.element, isIntersecting: true }]);
    tracker.stop();
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(fake.state.disconnected).toBe(true);
    expect(received).toEqual([]);
  });

  it('release 会 unobserve 该元素', () => {
    const fake = makeFakeObserver();
    const block = makeBlock('b1');

    const tracker = makeTracker(fake);
    tracker.start([block], () => {});
    tracker.release(block);

    expect(fake.unobserved).toEqual([block.element]);
  });

  it('start 空数组不创建观察器', () => {
    const fake = makeFakeObserver();
    const tracker = makeTracker(fake);

    tracker.start([], () => {});

    expect(fake.observed).toEqual([]);
  });

  it('重复 start 会先停掉上一次', () => {
    const fake = makeFakeObserver();
    const tracker = makeTracker(fake);

    tracker.start([makeBlock('b1')], () => {});
    tracker.start([makeBlock('b2')], () => {});

    expect(fake.state.disconnected).toBe(true);
  });
});

/**
 * 拆大块：同一个容器下有多个 Block（方案第 57 节）。
 *
 * `IntersectionObserver` 只能观察元素，所以由容器代表它这一组——
 * 但**组里的每一段都要被回调**，否则后面的段永远不会被翻译。
 */
describe('ViewportTracker · 拆大块（一个容器多个 Block）', () => {
  it('⭐ 同一容器下的多段都会随容器进入范围而被回调', async () => {
    const fake = makeFakeObserver();
    const tracker = makeTracker(fake);

    const element = document.createElement('p');
    document.body.append(element);
    stubRect(element, 10);

    const blockA: TranslationBlock = { ...makeBlock('a-001'), element };
    const blockB: TranslationBlock = { ...makeBlock('b-001'), element };

    const received: string[] = [];
    tracker.start([blockA, blockB], (blocks) => {
      received.push(...blocks.map((block) => block.id));
    });

    // 容器只观察一次——它代表整组
    expect(fake.observed).toEqual([element]);

    fake.fire([{ target: element, isIntersecting: true }]);

    await settle();

    expect(received.sort()).toEqual(['a-001', 'b-001']);
  });

  it('release 只摘掉这一段；组里还有别的段时容器继续被观察', () => {
    const fake = makeFakeObserver();
    const tracker = makeTracker(fake);

    const element = document.createElement('p');
    document.body.append(element);

    const blockA: TranslationBlock = { ...makeBlock('a-001'), element };
    const blockB: TranslationBlock = { ...makeBlock('b-001'), element };

    tracker.start([blockA, blockB], () => {});

    tracker.release(blockA);
    expect(fake.unobserved).toEqual([]);

    tracker.release(blockB);
    expect(fake.unobserved).toEqual([element]);
  });
});

describe('ViewportTracker · 滚到底续翻', () => {
  /** 可变滚动状态：测试里改 `state` 再派发 scroll 事件。 */
  function makeScroller(overrides: Partial<ScrollMetrics> = {}) {
    const state: ScrollMetrics = {
      scrollTop: 0,
      viewportHeight: VIEWPORT_HEIGHT,
      // 20 屏高——和实测那篇长文的量级一致（14297px / 720px）
      scrollHeight: VIEWPORT_HEIGHT * 20,
      ...overrides,
    };

    return { state, read: (): ScrollMetrics => ({ ...state }) };
  }

  function makeBottomTracker(
    fake: ReturnType<typeof makeFakeObserver>,
    scroller: ReturnType<typeof makeScroller>,
    overrides: { continueAtBottom?: boolean; bottomThresholdPx?: number } = {},
  ): ViewportTracker {
    return new ViewportTracker({
      getViewportHeight: () => VIEWPORT_HEIGHT,
      createObserver: fake.factory,
      flushDelayMs: 0,
      getScrollMetrics: scroller.read,
      ...overrides,
    });
  }

  /** 监听挂在 `globalThis` 上，所以这里派发真实事件。 */
  function scrollEvent(): void {
    globalThis.dispatchEvent(new Event('scroll'));
  }

  /** 滚到「贴底」。 */
  function toBottom(scroller: ReturnType<typeof makeScroller>): void {
    scroller.state.scrollTop = scroller.state.scrollHeight - VIEWPORT_HEIGHT;
    scrollEvent();
  }

  function collect(): { calls: string[][]; onEnter: (blocks: { id: string }[]) => void } {
    const calls: string[][] = [];
    return {
      calls,
      onEnter: (blocks) => {
        calls.push(blocks.map((block) => block.id));
      },
    };
  }

  it('还没到底时，没进过范围的 Block 不会被排', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1'), makeBlock('b2')], onEnter);
    scrollEvent();
    await settle();

    expect(calls).toEqual([]);
    tracker.stop();
  });

  it('⭐ 滚到页面底部后，没进过范围的 Block 也一并排队', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1'), makeBlock('b2')], onEnter);
    toBottom(scroller);
    await settle();

    expect(calls.flat().sort()).toEqual(['b1', 'b2']);
    tracker.stop();
  });

  it('⭐ 文档还很矮时不当作「已到底」——那等于整页翻译', async () => {
    const fake = makeFakeObserver();
    // 懒加载的图片与区块还没把高度撑起来：文档只有一屏高。
    // 此时 scrollTop 恒为 0——包括 macOS 橡皮筋滚动发来的那种「假 scroll」。
    const scroller = makeScroller({ scrollHeight: VIEWPORT_HEIGHT });
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1'), makeBlock('b2')], onEnter);
    scrollEvent();
    await settle();

    expect(calls).toEqual([]);
    tracker.stop();
  });

  it('停在底部时反复滚动只续翻一次', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1')], onEnter);
    toBottom(scroller);
    await settle();
    scrollEvent();
    await settle();

    expect(calls).toHaveLength(1);
    tracker.stop();
  });

  it('离开底部后重新武装：页面又长长了还能再续翻一次', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1')], onEnter);
    toBottom(scroller);
    await settle();

    // 页面动态加载出新内容 —— 用户不再处于底部
    scroller.state.scrollHeight = VIEWPORT_HEIGHT * 30;
    scrollEvent();
    await settle();

    toBottom(scroller);
    await settle();

    expect(calls).toHaveLength(2);
    tracker.stop();
  });

  it('已经 release 掉的 Block 不会再被排一次', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();
    const [b1, b2] = [makeBlock('b1'), makeBlock('b2')];

    tracker.start([b1, b2], onEnter);
    tracker.release(b1);
    toBottom(scroller);
    await settle();

    expect(calls.flat()).toEqual(['b2']);
    tracker.stop();
  });

  it('距底部一屏内即算「到底」（阈值默认取前瞻区）', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller({ scrollTop: VIEWPORT_HEIGHT * 18 });
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1')], onEnter);
    scrollEvent();
    await settle();

    expect(calls.flat()).toEqual(['b1']);
    tracker.stop();
  });

  it('阈值可配置', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller({ scrollTop: VIEWPORT_HEIGHT * 18 });
    const tracker = makeBottomTracker(fake, scroller, { bottomThresholdPx: 10 });
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1')], onEnter);
    scrollEvent();
    await settle();

    expect(calls).toEqual([]);
    tracker.stop();
  });

  it('关掉开关就退回「只翻相交过的内容」', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller, { continueAtBottom: false });
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1')], onEnter);
    toBottom(scroller);
    await settle();

    expect(calls).toEqual([]);
    tracker.stop();
  });

  it('stop 之后滚到底不再续翻（监听已摘掉）', async () => {
    const fake = makeFakeObserver();
    const scroller = makeScroller();
    const tracker = makeBottomTracker(fake, scroller);
    const { calls, onEnter } = collect();

    tracker.start([makeBlock('b1')], onEnter);
    tracker.stop();

    toBottom(scroller);
    await settle();

    expect(calls).toEqual([]);
  });

  /** jsdom 不做布局：`clientHeight` / `scrollHeight` 恒为 0，`scrollTop` 也设不进去。 */
  function stubScrollBox(
    element: Element,
    metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
  ): void {
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(element, key, { value, configurable: true, writable: true });
    }
  }

  /** 造一个「正文滚在内部容器里」的场景，返回容器与其中的 Block。 */
  function makeInnerPane(textHeight = VIEWPORT_HEIGHT * 6) {
    const pane = document.createElement('div');
    document.body.append(pane);
    const block = makeBlock('b1');
    pane.append(block.element);
    stubScrollBox(pane, {
      scrollTop: 0,
      clientHeight: VIEWPORT_HEIGHT,
      scrollHeight: textHeight,
    });

    return {
      pane,
      block,
      /** 把它滚到底（并把新的 scrollTop 反映到桩上） */
      scrollToBottom(): void {
        stubScrollBox(pane, {
          scrollTop: textHeight - VIEWPORT_HEIGHT,
          clientHeight: VIEWPORT_HEIGHT,
          scrollHeight: textHeight,
        });
        // ⚠️ 派发到 pane 上、而不是 window：`scroll` 事件**不冒泡**，
        // 能收到就说明监听确实挂在捕获阶段
        pane.dispatchEvent(new Event('scroll'));
      },
    };
  }

  it('⭐ 内容滚在内部容器里时，滚到它的底部也会续翻（靠捕获阶段才收得到）', async () => {
    const fake = makeFakeObserver();
    const tracker = makeBottomTracker(fake, makeScroller());
    const { calls, onEnter } = collect();
    const { pane, block, scrollToBottom } = makeInnerPane();

    tracker.start([block], onEnter);
    scrollToBottom();
    await settle();

    expect(calls.flat()).toEqual(['b1']);
    expect(pane.contains(block.element)).toBe(true);
    tracker.stop();
  });

  it('矮滚动条（代码块、下拉列表那种）不触发——它们天然「已在底部」', async () => {
    const fake = makeFakeObserver();
    const tracker = makeBottomTracker(fake, makeScroller());
    const { calls, onEnter } = collect();
    const { block, scrollToBottom } = makeInnerPane(VIEWPORT_HEIGHT * 0.2);

    tracker.start([block], onEnter);
    scrollToBottom();
    await settle();

    expect(calls).toEqual([]);
    tracker.stop();
  });

  it('不含正文的滚动容器滚到底也不触发', async () => {
    const fake = makeFakeObserver();
    const tracker = makeBottomTracker(fake, makeScroller());
    const { calls, onEnter } = collect();
    // 这个容器够高，但里面没有我们的 Block
    const outside = document.createElement('div');
    document.body.append(outside);
    stubScrollBox(outside, {
      scrollTop: VIEWPORT_HEIGHT * 5,
      clientHeight: VIEWPORT_HEIGHT,
      scrollHeight: VIEWPORT_HEIGHT * 6,
    });

    tracker.start([makeBlock('b1')], onEnter);
    outside.dispatchEvent(new Event('scroll'));
    await settle();

    expect(calls).toEqual([]);
    tracker.stop();
  });
});
