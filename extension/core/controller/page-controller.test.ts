import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redditAdapter, twitterAdapter } from '@/adapters';
import { type StorageLike, TranslationCache } from '@/core/cache';
import type {
  SendTranslationRequest,
  WireTranslateRequest,
  WireTranslateResponse,
} from '@/shared/types';

import { PageController, type PageControllerOptions } from './page-controller';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/pages',
);

/** 按 payload 原样回译的替身，记录每次调用。 */
function makeStubSend() {
  const calls: WireTranslateRequest[] = [];

  const send = async (payload: WireTranslateRequest): Promise<WireTranslateResponse> => {
    calls.push(payload);
    return {
      context_id: payload.context_id ?? null,
      prompt_version: 'v1',
      model: 'stub',
      items: payload.items.map((item) => ({
        id: item.id,
        source: item.text,
        translation: `【译】${item.text}`,
      })),
    };
  };

  return { send, calls };
}

/** 统计页面上插件插入的双语节点数量。 */
function countPluginNodes(): number {
  return document.querySelectorAll('[data-ai-translator="true"]').length;
}

/**
 * 已创建的控制器。
 *
 * 每个控制器都会在 `document.body` 上启动 MutationObserver，且不会自动停止。
 * 不统一清理的话，后续用例的 DOM 变动会唤醒前面用例的控制器，产生额外请求。
 */
const liveControllers: PageController[] = [];

function createController(options: PageControllerOptions): PageController {
  const controller = new PageController(options);
  liveControllers.push(controller);
  return controller;
}

/**
 * 轮询等待条件成立。
 *
 * MutationObserver、路由轮询、队列都是异步的，断言前必须等它们跑完。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();

  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('等待超时');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const controller of liveControllers) {
    controller.reset();
  }
  liveControllers.length = 0;
});

describe('PageController · 完整链路', () => {
  it('translate 完成 分段 → 请求 → 渲染', async () => {
    document.body.innerHTML = '<h1>Title</h1><p>Body text.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    const result = await controller.translate();

    expect(result.blocks).toBe(2);
    expect(result.translatedItems).toBe(2);
    expect(calls.length).toBeGreaterThan(0);
    expect(controller.state).toBe('ACTIVE');
    expect(controller.store.stats().translated).toBe(2);
  });

  it('默认按双语模式渲染', async () => {
    document.body.innerHTML = '<p>Read the <strong>docs</strong> now.</p>';
    const { send } = makeStubSend();

    await createController({ send, viewportHeight: 800 }).translate();

    expect(document.querySelector('p')?.textContent).toBe('Read the docs now.');
    expect(countPluginNodes()).toBe(1);
  });

  it('scan 只分段不请求', () => {
    document.body.innerHTML = '<h1>Title</h1><p>Body text.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    expect(controller.scan()).toBe(2);
    expect(calls).toHaveLength(0);
    expect(controller.store.size).toBe(2);
  });

  it('空页面不产生请求', async () => {
    document.body.innerHTML = '<p>2026</p>';
    const { send, calls } = makeStubSend();

    const result = await createController({ send, viewportHeight: 800 }).translate();

    expect(result.blocks).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('已翻译的 Block 不会重复请求', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    const afterFirst = calls.length;
    await controller.translate();

    expect(calls.length).toBe(afterFirst);
  });
});

describe('PageController · 模式切换（Phase 7 验收标准）', () => {
  it('切换显示模式不触发任何请求', async () => {
    document.body.innerHTML = '<h1>Title</h1><p>Read the <strong>docs</strong> now.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    const afterTranslate = calls.length;
    expect(afterTranslate).toBeGreaterThan(0);

    controller.setMode('chinese');
    controller.setMode('original');
    controller.setMode('bilingual');
    controller.setMode('chinese');

    expect(calls.length).toBe(afterTranslate);
  });

  it('双语 → 中文：原文被译文替换，插件节点消失', async () => {
    document.body.innerHTML = '<p>Read the <strong>docs</strong> now.</p>';
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    expect(countPluginNodes()).toBe(1);

    controller.setMode('chinese');

    expect(document.querySelector('p')?.textContent).toBe('【译】Read the docs now.');
    expect(countPluginNodes()).toBe(0);
    // inline 元素对象被复用
    expect(document.querySelector('p strong')?.textContent).toBe('docs');
  });

  it('中文 → 双语：原文恢复且追加译文', async () => {
    document.body.innerHTML = '<p>Read the <strong>docs</strong> now.</p>';
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    controller.setMode('chinese');
    controller.setMode('bilingual');

    expect(document.querySelector('p')?.textContent).toBe('Read the docs now.');
    expect(countPluginNodes()).toBe(1);
  });

  it('切回原文时插件节点被完全移除，DOM 与翻译前一致', async () => {
    document.body.innerHTML =
      '<h1>Title</h1><p>Read the <strong>docs</strong> now.</p><ul><li>First item.</li></ul>';
    const before = document.body.innerHTML;
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    expect(countPluginNodes()).toBeGreaterThan(0);

    controller.setMode('original');

    expect(countPluginNodes()).toBe(0);
    expect(document.body.innerHTML).toBe(before);
  });

  it('中文模式下切回原文同样完全恢复', async () => {
    document.body.innerHTML = '<p>Read the <strong>docs</strong> now.</p>';
    const before = document.body.innerHTML;
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    controller.setMode('chinese');
    expect(document.body.innerHTML).not.toBe(before);

    controller.setMode('original');

    expect(document.body.innerHTML).toBe(before);
  });

  it('切换到相同模式是空操作', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    const snapshot = document.body.innerHTML;

    controller.setMode('bilingual');

    expect(document.body.innerHTML).toBe(snapshot);
  });
});

describe('PageController · 状态与生命周期', () => {
  it('状态随生命周期变化', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    expect(controller.state).toBe('IDLE');

    await controller.translate();
    expect(controller.state).toBe('ACTIVE');

    controller.setMode('original');
    expect(controller.state).toBe('RESTORED');

    controller.setMode('bilingual');
    expect(controller.state).toBe('ACTIVE');
  });

  it('snapshot 反映当前状态', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    const snapshot = controller.snapshot();

    expect(snapshot.mode).toBe('bilingual');
    expect(snapshot.state).toBe('ACTIVE');
    expect(snapshot.stats.translated).toBe(1);
    expect(snapshot.stats.total).toBe(1);
  });

  it('restore 恢复原文但保留译文', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const before = document.body.innerHTML;
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    controller.restore();

    expect(document.body.innerHTML).toBe(before);
    expect(controller.state).toBe('RESTORED');
    // 译文仍在 store 中，切回中文无需重新请求
    expect(controller.store.byStatus('TRANSLATED')).toHaveLength(1);
  });

  it('reset 清空全部状态', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    controller.reset();

    expect(controller.store.size).toBe(0);
    expect(controller.state).toBe('IDLE');
    expect(countPluginNodes()).toBe(0);
  });

  it('全部批次失败时状态回到 IDLE，Block 标记为 FAILED', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const controller = createController({
      send: async () => {
        throw new Error('无法连接本地服务');
      },
      viewportHeight: 800,
    });

    const result = await controller.translate();

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(controller.state).toBe('IDLE');
    expect(controller.store.byStatus('FAILED')).toHaveLength(1);
  });
});

describe('PageController · 动态内容（Phase 10）', () => {
  function makeController(send: SendTranslationRequest): PageController {
    return createController({ send, viewportHeight: 800, mutationFlushDelayMs: 0 });
  }

  it('新加载的内容被自动翻译', async () => {
    document.body.innerHTML = '<p id="first">First paragraph.</p>';
    const { send, calls } = makeStubSend();
    const controller = makeController(send);

    await controller.translate();
    expect(controller.store.size).toBe(1);
    const afterInitial = calls.length;

    // 模拟滚动 / 分页加载：页面插入新段落
    const loaded = document.createElement('p');
    loaded.textContent = 'Loaded later by the page.';
    document.body.append(loaded);

    await waitFor(() => controller.store.findByElement(loaded)?.status === 'TRANSLATED');

    expect(controller.store.size).toBe(2);
    expect(calls.length).toBeGreaterThan(afterInitial);
  });

  it('SPA 原地更新文本被捕获并重新翻译', async () => {
    document.body.innerHTML = '<p id="live">Original text.</p>';
    const { send } = makeStubSend();
    const controller = makeController(send);

    await controller.translate();
    const paragraph = document.querySelector('#live');
    if (paragraph === null) {
      throw new Error('缺少测试节点');
    }
    expect(controller.store.findByElement(paragraph)?.status).toBe('TRANSLATED');

    // SPA 原地改写文本（characterData）
    const textNode = paragraph.firstChild;
    if (textNode === null) {
      throw new Error('缺少文本节点');
    }
    textNode.textContent = 'Updated text from the SPA.';

    await waitFor(
      () =>
        controller.store.findByElement(paragraph)?.status === 'TRANSLATED' &&
        controller.store.findByElement(paragraph)?.block.text === 'Updated text from the SPA.',
    );

    expect(controller.store.size).toBe(1);
  });

  it('插件自身插入的双语节点不会触发循环', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send, calls } = makeStubSend();
    const controller = makeController(send);

    await controller.translate();
    const afterTranslate = calls.length;
    expect(afterTranslate).toBeGreaterThan(0);

    // 渲染出的双语节点会触发 MutationObserver；等足够久看是否产生新请求
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(calls.length).toBe(afterTranslate);
    expect(controller.store.size).toBe(1);
  });

  it('中文模式下渲染也不会触发循环（就地改写文本，节点上没有标记）', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send, calls } = makeStubSend();
    const controller = makeController(send);

    await controller.translate();
    controller.setMode('chinese');

    const afterSwitch = calls.length;
    expect(document.querySelector('p')?.textContent).toBe('【译】Hello world.');

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    // 没有暂停机制的话，这里会把译文当成新内容再翻一遍，请求数会持续增长
    expect(calls.length).toBe(afterSwitch);
    expect(controller.store.size).toBe(1);
  });

  it('动态内容同样受视口规则约束（不在范围内不发请求）', async () => {
    document.body.innerHTML = '<p id="first">First paragraph.</p>';
    const { send } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      mutationFlushDelayMs: 0,
      // 视口外的一切都不在范围内
      getViewportHeight: () => 0,
      lookaheadScreens: 0,
    });

    await controller.translate();

    const farAway = document.createElement('p');
    farAway.textContent = 'Added far below the fold.';
    farAway.getBoundingClientRect = () =>
      ({
        top: 5000,
        bottom: 5100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 5000,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.append(farAway);

    await waitFor(() => controller.store.findByElement(farAway) !== undefined);

    // 已登记但未翻译——它在视口外，等滚动到才翻
    expect(controller.store.findByElement(farAway)?.status).toBe('UNTRANSLATED');
  });
});

describe('PageController · SPA 路由变化（Phase 11）', () => {
  /** 可变的 location 桩。 */
  function makeLocationStub(initial: string) {
    const state = { value: initial };
    return {
      state,
      getHref: () => state.value,
      go: (url: string) => {
        state.value = url;
      },
    };
  }

  it('路由变化后清理旧状态并重新分段、继续翻译', async () => {
    document.body.innerHTML = '<p>Page one content here.</p>';
    const location = makeLocationStub('https://example.com/one');
    const { send } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      mutationFlushDelayMs: 0,
      routePollIntervalMs: 10,
      getLocationHref: location.getHref,
    });

    await controller.translate();
    expect(controller.store.size).toBe(1);

    // 用元素身份判断「旧 Block 是否被清理」——ID 会被新扫描复用（都从 block-001 开始）
    const oldElement = document.querySelector('p');
    if (oldElement === null) {
      throw new Error('缺少测试节点');
    }

    // SPA 路由切换：URL 变 + DOM 换
    location.go('https://example.com/two');
    document.body.innerHTML = '<h1>Page two</h1><p>Different content here.</p>';

    const newElement = document.querySelector('p');
    if (newElement === null) {
      throw new Error('缺少测试节点');
    }

    // ⚠️ 不能等「新段落已翻译」——MutationObserver 会先处理新内容，
    // 那个条件在路由处理**之前**就成立了。要等的是旧状态被清掉。
    await waitFor(() => controller.store.findByElement(oldElement) === undefined);
    await waitFor(() => controller.store.findByElement(newElement)?.status === 'TRANSLATED');

    expect(controller.store.size).toBe(2);
    expect(controller.store.byStatus('TRANSLATED')).toHaveLength(2);
  });

  it('路由变化后旧译文节点被清除', async () => {
    document.body.innerHTML = '<p>Page one content here.</p>';
    const location = makeLocationStub('https://example.com/one');
    const { send } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      mutationFlushDelayMs: 0,
      routePollIntervalMs: 10,
      getLocationHref: location.getHref,
    });

    await controller.translate();
    expect(countPluginNodes()).toBe(1);

    const oldElement = document.querySelector('p');
    if (oldElement === null) {
      throw new Error('缺少测试节点');
    }

    location.go('https://example.com/two');
    document.body.innerHTML = '<p>Page two content here.</p>';

    // 先等旧状态被清掉，再等新内容渲染完——
    // 只等后者的话，MutationObserver 会先满足它，测不到路由处理
    await waitFor(() => controller.store.findByElement(oldElement) === undefined);
    await waitFor(
      () =>
        document.querySelector('p')?.nextElementSibling?.getAttribute('data-ai-translator') ===
        'true',
    );

    // 新页面只有自己的那一个译文节点，旧的没有残留
    expect(countPluginNodes()).toBe(1);
    expect(document.body.textContent).toContain('Page two content here.');
  });

  it('未调用 translate 时不监听路由', () => {
    const controller = createController({
      send: async () => {
        throw new Error('不应被调用');
      },
      viewportHeight: 800,
    });

    expect(controller.routeWatcher.running).toBe(false);
  });

  it('reset 之后不再监听路由', async () => {
    document.body.innerHTML = '<p>Page one content here.</p>';
    const { send } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      routePollIntervalMs: 10,
      getLocationHref: () => 'https://example.com/one',
    });

    await controller.translate();
    expect(controller.routeWatcher.running).toBe(true);

    controller.reset();
    expect(controller.routeWatcher.running).toBe(false);
  });
});

describe('PageController · 译文缓存（Phase 12）', () => {
  /** 内存存储替身，跨控制器复用即模拟「刷新后仍有缓存」。 */
  function makeStorage() {
    const data: Record<string, unknown> = {};

    const storage: StorageLike = {
      get: async (keys) => {
        if (keys === null) {
          return { ...data };
        }
        const list = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const key of list) {
          if (key in data) {
            result[key] = data[key];
          }
        }
        return result;
      },
      set: async (items) => {
        Object.assign(data, items);
      },
      remove: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete data[key];
        }
      },
    };

    return storage;
  }

  const healthStub = async () => ({
    status: 'ok',
    provider: 'mock',
    model: 'mock',
    promptVersion: 'v1',
  });

  it('同一段文字再次出现时不产生新请求', async () => {
    document.body.innerHTML = '<p>Cacheable text.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      mutationFlushDelayMs: 0,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage: makeStorage() }),
    });

    await controller.translate();
    expect(calls).toHaveLength(1);

    // 同一文本以新段落出现（动态加载 / 重复内容）
    const again = document.createElement('p');
    again.textContent = 'Cacheable text.';
    document.body.append(again);

    await waitFor(() => controller.store.findByElement(again)?.status === 'TRANSLATED');

    expect(calls).toHaveLength(1);
  });

  it('刷新页面后缓存仍命中（新控制器、同一份存储）', async () => {
    const storage = makeStorage();

    document.body.innerHTML = '<p>Cacheable text.</p>';
    const first = makeStubSend();
    const original = createController({
      send: first.send,
      viewportHeight: 800,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage }),
    });

    await original.translate();
    expect(first.calls).toHaveLength(1);
    original.reset();

    // 模拟页面刷新：DOM 重置、控制器重建，但存储还在
    document.body.innerHTML = '<p>Cacheable text.</p>';
    const second = makeStubSend();
    const reloaded = createController({
      send: second.send,
      viewportHeight: 800,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage }),
    });

    await reloaded.translate();

    expect(second.calls).toHaveLength(0);
    expect(reloaded.store.byStatus('TRANSLATED')).toHaveLength(1);
  });

  it('拿不到健康检查时停用缓存，但翻译照常进行', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      requestHealth: async () => {
        throw new Error('服务不可达');
      },
      cache: new TranslationCache({ storage: makeStorage() }),
    });

    await controller.translate();

    expect(controller.cache.enabled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(controller.store.byStatus('TRANSLATED')).toHaveLength(1);
  });

  it('显式关闭缓存时不读存储、每次都发请求', async () => {
    document.body.innerHTML = '<p>Hello world.</p>';
    const { send, calls } = makeStubSend();
    const controller = createController({
      send,
      viewportHeight: 800,
      enableCache: false,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage: makeStorage() }),
    });

    await controller.translate();
    controller.reset();
    document.body.innerHTML = '<p>Hello world.</p>';

    const again = createController({
      send,
      viewportHeight: 800,
      enableCache: false,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage: makeStorage() }),
    });
    await again.translate();

    expect(calls).toHaveLength(2);
  });

  it('缓存命中的条目计入 translatedItems', async () => {
    const storage = makeStorage();
    const { send } = makeStubSend();

    document.body.innerHTML = '<p>Cacheable text.</p>';
    const first = createController({
      send,
      viewportHeight: 800,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage }),
    });
    await first.translate();
    first.reset();

    document.body.innerHTML = '<p>Cacheable text.</p>';
    const second = createController({
      send,
      viewportHeight: 800,
      requestHealth: healthStub,
      cache: new TranslationCache({ storage }),
    });
    const result = await second.translate();

    expect(result.translatedItems).toBe(1);
    expect(result.batches).toBe(1);
  });
});

describe('PageController · 站点适配（Phase 14）', () => {
  /** 把 fixture 加载到当前文档。 */
  function loadFixture(name: string): void {
    const html = readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
  }

  function textsOf(controller: PageController): string[] {
    return controller.store.all().map((entry) => entry.block.plainText);
  }

  it('按适配器的根分段，不碰根之外的区域', async () => {
    loadFixture('twitter-timeline.html');
    const { send } = makeStubSend();

    const controller = createController({
      send,
      viewportHeight: 800,
      adapter: twitterAdapter,
    });

    await controller.translate();

    const found = textsOf(controller);

    expect(found.some((text) => text.includes('streaming translation pipeline'))).toBe(true);
    expect(found.some((text) => text.includes('Trends'))).toBe(false);
    expect(found.some((text) => text.includes('Explore'))).toBe(false);
  });

  it('Reddit 的自定义元素各自成块', async () => {
    loadFixture('reddit-thread.html');
    const { send } = makeStubSend();

    const controller = createController({
      send,
      viewportHeight: 800,
      adapter: redditAdapter,
    });

    await controller.translate();

    const found = textsOf(controller);

    expect(found.some((text) => text.includes('treat custom elements as inline'))).toBe(true);
    expect(found.some((text) => text.includes('extraBlockTags fixes it'))).toBe(true);
    expect(found.some((text) => text.includes('Related communities'))).toBe(false);
    expect(found.some((text) => text.includes('Vote'))).toBe(false);
  });

  it('默认按 URL 选适配器', () => {
    const makeOne = (url: string) =>
      createController({
        send: async () => {
          throw new Error('不应被调用');
        },
        viewportHeight: 800,
        url: new URL(url),
      });

    expect(makeOne('https://x.com/home').adapter.name).toBe('twitter');
    expect(makeOne('https://www.reddit.com/r/x').adapter.name).toBe('reddit');
    expect(makeOne('https://github.com/a/b').adapter.name).toBe('github');
    expect(makeOne('https://example.com/').adapter.name).toBe('default');
  });

  it('动态插入的内容同样走适配器规则', async () => {
    loadFixture('reddit-thread.html');
    const { send } = makeStubSend();

    const controller = createController({
      send,
      viewportHeight: 800,
      mutationFlushDelayMs: 0,
      adapter: redditAdapter,
    });

    await controller.translate();

    // 新增一条评论——应当被分段并翻译
    const comment = document.createElement('shreddit-comment');
    const body = document.createElement('shreddit-text-body');
    body.textContent = 'A newly loaded comment that should also be translated.';
    comment.append(body);
    document.querySelector('main')?.append(comment);

    await waitFor(
      () =>
        controller.store.findByElement(body)?.status === 'TRANSLATED' &&
        controller.store.findByElement(body)?.block.plainText.includes('newly loaded') === true,
    );

    // 新增的侧栏内容不该被分段
    const sidebar = document.createElement('shreddit-sidebar');
    sidebar.textContent = 'Should not be segmented at all.';
    document.querySelector('main')?.append(sidebar);

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(textsOf(controller).some((text) => text.includes('Should not be segmented'))).toBe(
      false,
    );
  });
});

describe('PageController · 停止翻译（Phase 17）', () => {
  it('取消后不再发新请求', async () => {
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_unused, index) => `<p>Paragraph number ${index} with enough text to be translated.</p>`,
    ).join('');

    const calls: WireTranslateRequest[] = [];
    let controller: PageController;

    const send = async (payload: WireTranslateRequest): Promise<WireTranslateResponse> => {
      calls.push(payload);
      // 第一个批次一回来就取消
      controller.cancel();
      return {
        context_id: payload.context_id ?? null,
        prompt_version: 'v1',
        model: 'stub',
        items: payload.items.map((item) => ({
          id: item.id,
          source: item.text,
          translation: `【译】${item.text}`,
        })),
      };
    };

    controller = createController({
      send,
      viewportHeight: 10_000,
      concurrency: 1,
      // 关掉滚动/动态接入，避免它们在取消后又发起请求
      lookaheadScreens: 0,
    });

    await controller.translate();
    const afterFirst = calls.length;

    // 再等一会儿，确认没有后续请求
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(calls.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });

  it('取消把「排队中 / 翻译中」的 Block 退回未翻译', async () => {
    document.body.innerHTML = '<p>Only paragraph with enough text to be translated here.</p>';

    const controller = createController({
      send: async () => {
        throw new Error('不应被调用');
      },
      viewportHeight: 800,
    });

    controller.scan();
    const ids = controller.store.all().map((entry) => entry.block.id);
    controller.store.markMany(ids, 'QUEUED');

    controller.cancel();

    for (const id of ids) {
      expect(controller.store.get(id)?.status).toBe('UNTRANSLATED');
    }
  });

  it('取消不碰已翻译的 Block', async () => {
    document.body.innerHTML = '<p>Only paragraph with enough text to be translated here.</p>';

    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    expect(controller.store.all()[0]?.status).toBe('TRANSLATED');

    controller.cancel();

    // 已翻好的是花过钱的，取消不该把它丢掉
    expect(controller.store.all()[0]?.status).toBe('TRANSLATED');
  });

  it('⭐ 翻译中途「恢复原文」不会被迟到的译文覆盖', async () => {
    document.body.innerHTML = Array.from(
      { length: 8 },
      (_unused, index) => `<p>Paragraph number ${index} with enough text to be translated.</p>`,
    ).join('');

    // 用一个可控的 send：第一批返回后暂停，等我们恢复原文再放行第二批
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;

    const controller = createController({
      send: async (payload: WireTranslateRequest) => {
        callCount += 1;
        if (callCount === 2) {
          await gate;
        }
        return {
          context_id: payload.context_id ?? null,
          prompt_version: 'v1',
          model: 'stub',
          items: payload.items.map((item) => ({
            id: item.id,
            source: item.text,
            translation: `【译】${item.text}`,
          })),
        };
      },
      viewportHeight: 10_000,
      concurrency: 1,
      lookaheadScreens: 0,
    });

    const translating = controller.translate();

    // 等第一批渲染出来
    await waitFor(() => countPluginNodes() > 0);

    // 中途恢复原文——这正是用户报的「点了恢复原文没有用」
    controller.restore();

    // 放行在途请求
    release();
    await translating;

    // ⭐ 用户看得见的部分：页面必须保持原文，迟到的译文不能再写进来
    expect(countPluginNodes()).toBe(0);
    expect(controller.store.pageState).toBe('RESTORED');

    // 注意这里**不**断言「store 里没有译文」：
    // 取消/恢复的语义是「别再往下翻了」，不是「把已经翻好的扔掉」——
    // 已经返回的批次是花过钱的，下次点翻译应当直接复用。
  });
});

describe('PageController · 切到「原文」即停止翻译', () => {
  it('翻译中切到原文模式会停掉队列', async () => {
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_unused, index) => `<p>Paragraph number ${index} with enough text to be translated.</p>`,
    ).join('');

    const calls: WireTranslateRequest[] = [];
    let controller: PageController;

    const send = async (payload: WireTranslateRequest): Promise<WireTranslateResponse> => {
      calls.push(payload);
      // 第一批回来时切到「原文」——这就是用户要的停止方式
      controller.setMode('original');
      return {
        context_id: payload.context_id ?? null,
        prompt_version: 'v1',
        model: 'stub',
        items: payload.items.map((item) => ({
          id: item.id,
          source: item.text,
          translation: `【译】${item.text}`,
        })),
      };
    };

    controller = createController({
      send,
      viewportHeight: 10_000,
      concurrency: 1,
      lookaheadScreens: 0,
    });

    await controller.translate();
    const afterFirst = calls.length;

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(calls.length).toBe(afterFirst);
    expect(controller.mode).toBe('original');
  });

  it('切回双语不重新请求——已翻好的在 store 里', async () => {
    document.body.innerHTML = '<p>Only paragraph with enough text to be translated here.</p>';

    const { send, calls } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    const afterTranslate = calls.length;

    controller.setMode('original');
    controller.setMode('bilingual');

    expect(calls.length).toBe(afterTranslate);
    expect(countPluginNodes()).toBeGreaterThan(0);
  });

  it('切到原文不丢已翻译的内容', async () => {
    document.body.innerHTML = '<p>Only paragraph with enough text to be translated here.</p>';

    const { send } = makeStubSend();
    const controller = createController({ send, viewportHeight: 800 });

    await controller.translate();
    controller.setMode('original');

    // 与「恢复原文」不同：这里只停止并隐藏，store 里的译文保留
    expect(controller.store.all()[0]?.status).toBe('TRANSLATED');
    expect(countPluginNodes()).toBe(0);
  });
});
