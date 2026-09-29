import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RouteWatcher, type RouteWatcherOptions } from './route-watcher';

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 可变 URL 桩。 */
function makeUrlStub(initial = 'https://example.com/') {
  const state = { url: initial };
  return {
    state,
    getUrl: () => state.url,
    go: (url: string) => {
      state.url = url;
    },
  };
}

const watchers: RouteWatcher[] = [];

/** 统一记录实例，避免用例之间残留定时器互相干扰。 */
function makeWatcher(options: RouteWatcherOptions): RouteWatcher {
  const watcher = new RouteWatcher(options);
  watchers.push(watcher);
  return watcher;
}

beforeEach(() => {
  watchers.length = 0;
});

afterEach(() => {
  for (const watcher of watchers) {
    watcher.stop();
  }
});

describe('RouteWatcher', () => {
  it('start 记录初始 URL，不立即回调', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];

    makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0 }).start((url) => {
      seen.push(url);
    });
    await settle();

    expect(seen).toEqual([]);
  });

  it('checkNow 检测到变化后回调', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0 });

    watcher.start((url) => {
      seen.push(url);
    });

    stub.go('https://example.com/page-2');
    watcher.checkNow();
    await settle();

    expect(seen).toEqual(['https://example.com/page-2']);
  });

  it('URL 没变时不回调', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0 });

    watcher.start((url) => {
      seen.push(url);
    });

    watcher.checkNow();
    watcher.checkNow();
    await settle();

    expect(seen).toEqual([]);
  });

  it('同一 URL 重复检查只回调一次', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0 });

    watcher.start((url) => {
      seen.push(url);
    });

    stub.go('https://example.com/page-2');
    watcher.checkNow();
    watcher.checkNow();
    watcher.checkNow();
    await settle();

    expect(seen).toEqual(['https://example.com/page-2']);
  });

  it('合并窗口内的多次变化只回调最后一次', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 10 });

    watcher.start((url) => {
      seen.push(url);
    });

    stub.go('https://example.com/a');
    watcher.checkNow();
    stub.go('https://example.com/b');
    watcher.checkNow();
    await settle(40);

    expect(seen).toEqual(['https://example.com/b']);
  });

  it('轮询会定期检查', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0, pollIntervalMs: 10 });

    watcher.start((url) => {
      seen.push(url);
    });

    stub.go('https://example.com/page-2');
    await settle(50);

    expect(seen).toEqual(['https://example.com/page-2']);
  });

  it('popstate 会立即触发检查', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    // 轮询间隔设得很大，确保回调只可能来自 popstate
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0, pollIntervalMs: 60_000 });

    watcher.start((url) => {
      seen.push(url);
    });

    stub.go('https://example.com/back');
    globalThis.dispatchEvent(new Event('popstate'));
    await settle();

    expect(seen).toEqual(['https://example.com/back']);
  });

  it('stop 之后不再回调', async () => {
    const stub = makeUrlStub();
    const seen: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0 });

    watcher.start((url) => {
      seen.push(url);
    });
    watcher.stop();

    stub.go('https://example.com/page-2');
    watcher.checkNow();
    await settle();

    expect(seen).toEqual([]);
    expect(watcher.running).toBe(false);
  });

  it('重复 start 会先停掉上一次', async () => {
    const stub = makeUrlStub();
    const first: string[] = [];
    const second: string[] = [];
    const watcher = makeWatcher({ getUrl: stub.getUrl, flushDelayMs: 0 });

    watcher.start((url) => {
      first.push(url);
    });
    watcher.start((url) => {
      second.push(url);
    });

    stub.go('https://example.com/page-2');
    watcher.checkNow();
    await settle();

    expect(first).toEqual([]);
    expect(second).toEqual(['https://example.com/page-2']);
  });

  it('running 反映监听状态', () => {
    const stub = makeUrlStub();
    const watcher = makeWatcher({ getUrl: stub.getUrl });

    expect(watcher.running).toBe(false);
    watcher.start(() => {});
    expect(watcher.running).toBe(true);
    watcher.stop();
    expect(watcher.running).toBe(false);
  });
});
