import { beforeEach, describe, expect, it } from 'vitest';

import type { TranslationBlock } from '@/shared/types';

import {
  type ObserverEntryLike,
  type ObserverFactory,
  type ObserverLike,
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
