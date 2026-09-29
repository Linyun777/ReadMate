import { describe, expect, it } from 'vitest';

import { CACHE_KEY_PREFIX } from '@/shared/constants';
import type { CacheContext } from '@/shared/types';

import {
  cacheKey,
  cacheKeySource,
  hashCacheKey,
  type StorageLike,
  TranslationCache,
} from './translation-cache';

const CONTEXT: CacheContext = {
  provider: 'openai_compatible',
  model: 'deepseek-chat',
  promptVersion: 'v1',
};

const PAYLOAD = {
  source_language: 'auto',
  target_language: 'zh-CN',
  style: 'natural' as const,
};

/** 内存存储替身。 */
function makeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };

  const storage: StorageLike & { data: Record<string, unknown> } = {
    data,
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

function makeCache(
  options: {
    storage?: ReturnType<typeof makeStorage>;
    maxEntries?: number;
    ttlDays?: number;
    now?: () => number;
    withContext?: boolean;
  } = {},
) {
  const storage = options.storage ?? makeStorage();
  const cache = new TranslationCache({
    storage,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.ttlDays === undefined ? {} : { ttlDays: options.ttlDays }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (options.withContext !== false) {
    cache.setContext(CONTEXT);
  }

  return { cache, storage };
}

describe('cacheKey — 键的构成（方案第 86.8 节）', () => {
  it('含全部要素，且以固定前缀开头', () => {
    const key = cacheKey(PAYLOAD, CONTEXT, 'Hello world.');

    expect(key.startsWith(CACHE_KEY_PREFIX)).toBe(true);
  });

  it('同一输入得到同一键', () => {
    expect(cacheKey(PAYLOAD, CONTEXT, 'Hello.')).toBe(cacheKey(PAYLOAD, CONTEXT, 'Hello.'));
  });

  it('文本不同则键不同', () => {
    expect(cacheKey(PAYLOAD, CONTEXT, 'Hello.')).not.toBe(
      cacheKey(PAYLOAD, CONTEXT, 'Hello there.'),
    );
  });

  it('源语言不同则键不同', () => {
    expect(cacheKey(PAYLOAD, CONTEXT, 'Hello.')).not.toBe(
      cacheKey({ ...PAYLOAD, source_language: 'en' }, CONTEXT, 'Hello.'),
    );
  });

  it('目标语言不同则键不同', () => {
    expect(cacheKey(PAYLOAD, CONTEXT, 'Hello.')).not.toBe(
      cacheKey({ ...PAYLOAD, target_language: 'ja' }, CONTEXT, 'Hello.'),
    );
  });

  it('风格不同则键不同', () => {
    expect(cacheKey(PAYLOAD, CONTEXT, 'Hello.')).not.toBe(
      cacheKey({ ...PAYLOAD, style: 'academic' }, CONTEXT, 'Hello.'),
    );
  });

  it('provider 不同则键不同——避免切换 Provider 后复用不兼容译文', () => {
    const left = cacheKey(PAYLOAD, CONTEXT, 'Hello.');
    const right = cacheKey(PAYLOAD, { ...CONTEXT, provider: 'mock' }, 'Hello.');

    expect(left).not.toBe(right);
  });

  it('promptVersion 不同则键不同——改 Prompt 后旧缓存自动失效', () => {
    const left = cacheKey(PAYLOAD, CONTEXT, 'Hello.');
    const right = cacheKey(PAYLOAD, { ...CONTEXT, promptVersion: 'v2' }, 'Hello.');

    expect(left).not.toBe(right);
  });

  it('model 不同则键不同', () => {
    const left = cacheKey(PAYLOAD, CONTEXT, 'Hello.');
    const right = cacheKey(PAYLOAD, { ...CONTEXT, model: 'gpt-4o' }, 'Hello.');

    expect(left).not.toBe(right);
  });

  it('键是定长哈希，不含原文', () => {
    const text = 'A very long paragraph that should not appear in the key.';
    const key = cacheKey(PAYLOAD, CONTEXT, text);

    expect(key).not.toContain('paragraph');
    expect(key.length).toBeLessThan(40);
  });

  it('键不含 API Key 的位置——上下文里根本没有这个字段', () => {
    // 类型层面就没有 apiKey；这里用运行时检查兜底，防止将来有人加进去
    const source = cacheKeySource(PAYLOAD, CONTEXT, 'Hello.');

    expect(source).not.toMatch(/sk-/);
    expect(Object.keys(CONTEXT)).toEqual(['provider', 'model', 'promptVersion']);
  });

  it('哈希对相近输入有区分度', () => {
    expect(hashCacheKey('a')).not.toBe(hashCacheKey('b'));
    expect(hashCacheKey('a\u0000b')).not.toBe(hashCacheKey('a') + hashCacheKey('b'));
  });
});

describe('TranslationCache · 读写', () => {
  it('未设置上下文时全部视为未命中，且不读存储', async () => {
    const storage = makeStorage();
    let reads = 0;
    const counting: StorageLike = {
      get: async (keys) => {
        reads += 1;
        return await storage.get(keys);
      },
      set: storage.set,
      remove: storage.remove,
    };

    const cache = new TranslationCache({ storage: counting });
    const result = await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }]);

    expect(cache.enabled).toBe(false);
    expect(result.hits.size).toBe(0);
    expect(result.misses).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it('写入后可以命中', async () => {
    const { cache } = makeCache();

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Hello.', translation: '你好。' }]);
    const result = await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }]);

    expect(result.hits.get('b1')).toBe('你好。');
    expect(result.misses).toHaveLength(0);
  });

  it('未写入的条目是未命中', async () => {
    const { cache } = makeCache();

    const result = await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Never seen.' }]);

    expect(result.hits.size).toBe(0);
    expect(result.misses).toEqual([{ id: 'b1', text: 'Never seen.' }]);
  });

  it('部分命中时只把未命中的算作 miss', async () => {
    const { cache } = makeCache();

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Known.', translation: '已知。' }]);
    const result = await cache.lookup(PAYLOAD, [
      { id: 'b1', text: 'Known.' },
      { id: 'b2', text: 'Unknown.' },
    ]);

    expect([...result.hits.keys()]).toEqual(['b1']);
    expect(result.misses.map((item) => item.id)).toEqual(['b2']);
  });

  it('空译文不写入', async () => {
    const { cache } = makeCache();

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Hello.', translation: '   ' }]);
    const result = await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }]);

    expect(result.hits.size).toBe(0);
  });

  it('命中会刷新 lastUsedAt（LRU 依据）', async () => {
    const times = [1000, 2000];
    const { cache, storage } = makeCache({
      now: () => times.shift() ?? 3000,
    });

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Hello.', translation: '你好。' }]);
    await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }]);

    const entries = Object.values(storage.data);
    expect(entries).toHaveLength(1);
    expect((entries[0] as { lastUsedAt: number }).lastUsedAt).toBe(2000);
  });

  it('provider 变化后旧缓存不再命中', async () => {
    const { cache } = makeCache();

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Hello.', translation: '你好。' }]);
    cache.setContext({ ...CONTEXT, provider: 'mock' });

    const result = await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }]);
    expect(result.hits.size).toBe(0);
  });
});

describe('TranslationCache · 过期与淘汰', () => {
  it('超过 TTL 的条目不命中', async () => {
    const now = { value: 0 };
    const { cache } = makeCache({ ttlDays: 1, now: () => now.value });

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Hello.', translation: '你好。' }]);

    now.value = 2 * 24 * 60 * 60 * 1000;

    const result = await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }]);
    expect(result.hits.size).toBe(0);
  });

  it('prune 清掉过期条目', async () => {
    const now = { value: 0 };
    const { cache, storage } = makeCache({ ttlDays: 1, now: () => now.value });

    await cache.store(PAYLOAD, [
      { id: 'b1', text: 'One.', translation: '一。' },
      { id: 'b2', text: 'Two.', translation: '二。' },
    ]);

    now.value = 2 * 24 * 60 * 60 * 1000;
    const removed = await cache.prune();

    expect(removed).toBe(2);
    expect(Object.keys(storage.data)).toHaveLength(0);
  });

  it('超过上限时按 LRU 淘汰最久未用的', async () => {
    const now = { value: 1000 };
    const { cache, storage } = makeCache({ maxEntries: 2, now: () => now.value });

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'One.', translation: '一。' }]);
    now.value = 2000;
    await cache.store(PAYLOAD, [{ id: 'b2', text: 'Two.', translation: '二。' }]);
    now.value = 3000;
    // 命中 b1，让它变「新」
    await cache.lookup(PAYLOAD, [{ id: 'b1', text: 'One.' }]);

    now.value = 4000;
    await cache.store(PAYLOAD, [{ id: 'b3', text: 'Three.', translation: '三。' }]);

    // b2 最久未用，被淘汰
    const result = await cache.lookup(PAYLOAD, [
      { id: 'b1', text: 'One.' },
      { id: 'b2', text: 'Two.' },
      { id: 'b3', text: 'Three.' },
    ]);

    expect([...result.hits.keys()].sort()).toEqual(['b1', 'b3']);
    expect(Object.keys(storage.data)).toHaveLength(2);
  });

  it('未超上限时不淘汰', async () => {
    const { cache, storage } = makeCache({ maxEntries: 10 });

    await cache.store(PAYLOAD, [
      { id: 'b1', text: 'One.', translation: '一。' },
      { id: 'b2', text: 'Two.', translation: '二。' },
    ]);

    expect(Object.keys(storage.data)).toHaveLength(2);
  });
});

describe('TranslationCache · 统计与维护', () => {
  it('stats 报告条目数与估算体积', async () => {
    const { cache } = makeCache();

    await cache.store(PAYLOAD, [
      { id: 'b1', text: 'One.', translation: '一。' },
      { id: 'b2', text: 'Two.', translation: '二。' },
    ]);

    const stats = await cache.stats();

    expect(stats.count).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.maxEntries).toBe(5000);
    expect(stats.ttlDays).toBe(30);
  });

  it('clear 清空全部缓存', async () => {
    const { cache, storage } = makeCache();

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'One.', translation: '一。' }]);
    const removed = await cache.clear();

    expect(removed).toBe(1);
    expect(Object.keys(storage.data)).toHaveLength(0);
  });

  it('clear 不碰非缓存键', async () => {
    const storage = makeStorage({ 'settings:targetLanguage': 'zh-CN' });
    const { cache } = makeCache({ storage });

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'One.', translation: '一。' }]);
    await cache.clear();

    expect(storage.data['settings:targetLanguage']).toBe('zh-CN');
  });

  it('stats 忽略非缓存键', async () => {
    const storage = makeStorage({ 'settings:targetLanguage': 'zh-CN' });
    const { cache } = makeCache({ storage });

    await cache.store(PAYLOAD, [{ id: 'b1', text: 'One.', translation: '一。' }]);

    expect((await cache.stats()).count).toBe(1);
  });
});

describe('TranslationCache · 导出与导入', () => {
  it('导出后可以导入到新实例', async () => {
    const { cache } = makeCache();
    await cache.store(PAYLOAD, [{ id: 'b1', text: 'Hello.', translation: '你好。' }]);

    const dump = await cache.exportAll();
    expect(dump.version).toBe(1);
    expect(Object.keys(dump.entries)).toHaveLength(1);

    const { cache: restored } = makeCache();
    const imported = await restored.importAll(dump);

    expect(imported).toBe(1);
    expect((await restored.lookup(PAYLOAD, [{ id: 'b1', text: 'Hello.' }])).hits.get('b1')).toBe(
      '你好。',
    );
  });

  it('拒绝结构非法的导入数据', async () => {
    const { cache } = makeCache();

    expect(await cache.importAll(null)).toBe(0);
    expect(await cache.importAll('nonsense')).toBe(0);
    expect(await cache.importAll({ entries: { 'bad-key': { translation: 'x' } } })).toBe(0);
  });

  it('导入时过滤掉非缓存前缀的键', async () => {
    const { cache } = makeCache();

    const imported = await cache.importAll({
      entries: {
        [`${CACHE_KEY_PREFIX}abc`]: { translation: '好', createdAt: 1, lastUsedAt: 1 },
        'other:key': { translation: '坏', createdAt: 1, lastUsedAt: 1 },
      },
    });

    expect(imported).toBe(1);
  });
});
