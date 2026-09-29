/**
 * 译文缓存（方案第 86.8 节）。
 *
 * V1 采用 **`chrome.storage.local` 持久化**，而非纯内存 Map——
 * 纯内存在页面刷新或 service worker 回收后即失效，无法支撑
 * 「重访页面即时恢复」这一核心体验。
 *
 * ## 缓存键
 *
 * ```text
 * sourceText + sourceLanguage + targetLanguage + style
 *   + provider + model + promptVersion
 * ```
 *
 * `provider` 与 `promptVersion` 是必须项：前者避免切换 Provider 后复用不兼容的
 * 译文，后者保证修改 Prompt 后旧缓存自动失效。
 *
 * **缓存键绝不包含 API Key。**
 *
 * ## 容量与淘汰
 *
 * 条目上限 5000、LRU 淘汰、30 天过期。5000 条按平均 200 字符估算约 1 MB，
 * 在 `storage.local` 默认配额内。
 *
 * ## 上下文从哪来
 *
 * `provider` / `model` / `promptVersion` 由 `/api/v1/health` 提供。
 * **拿不到上下文时缓存整体停用**——宁可不用缓存，也不冒着用错键的风险。
 */

import {
  CACHE_DUMP_VERSION,
  CACHE_KEY_PREFIX,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_DAYS,
} from '@/shared/constants';
import type {
  CacheContext,
  CacheDump,
  CacheEntry,
  CacheStats,
  WireTranslateRequest,
} from '@/shared/types';

/** `chrome.storage.local` 的最小接口，便于测试注入替身。 */
export interface StorageLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** 参与缓存的最小条目形状（`WireTranslateRequest.items` 的元素）。 */
export interface CacheItem {
  id: string;
  text: string;
}

export interface CacheLookupResult {
  /** 命中：Block ID → 译文 */
  hits: Map<string, string>;
  /** 未命中，需要真正发请求的条目 */
  misses: CacheItem[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 键各段之间的分隔符。正文里不可能出现 NUL，因此不会产生歧义拼接 */
const SEGMENT_SEPARATOR = '\u0000';

/**
 * 64 位哈希（两个独立 32 位变体拼接），把缓存键压到定长。
 *
 * 直接用原文当键会让 5000 条缓存光键就占掉数 MB；单用 32 位哈希又存在
 * 可观的碰撞概率（5000 条约 0.3%）。两个变体拼起来约 64 位，碰撞可忽略。
 */
export function hashCacheKey(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return (first >>> 0).toString(36) + (second >>> 0).toString(36);
}

/** 缓存键的原文（未哈希），便于调试与测试对照。 */
export function cacheKeySource(
  payload: Pick<WireTranslateRequest, 'source_language' | 'target_language' | 'style'>,
  context: CacheContext,
  text: string,
): string {
  return [
    context.provider,
    context.model,
    context.promptVersion,
    payload.source_language,
    payload.target_language,
    payload.style,
    text,
  ].join(SEGMENT_SEPARATOR);
}

/** 生成存储键。 */
export function cacheKey(
  payload: Pick<WireTranslateRequest, 'source_language' | 'target_language' | 'style'>,
  context: CacheContext,
  text: string,
): string {
  return CACHE_KEY_PREFIX + hashCacheKey(cacheKeySource(payload, context, text));
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.translation === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.lastUsedAt === 'number'
  );
}

export interface TranslationCacheOptions {
  /** 存储实现。默认 `chrome.storage.local`（懒取，便于在无 chrome 的环境导入本模块） */
  storage?: StorageLike;
  maxEntries?: number;
  ttlDays?: number;
  /** 时间源，测试可注入 */
  now?: () => number;
}

export class TranslationCache {
  readonly #storage: StorageLike | undefined;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  #context: CacheContext | null = null;
  /** 已知条目数。`null` 表示未知，下次需要时重新统计 */
  #size: number | null = null;

  constructor(options: TranslationCacheOptions = {}) {
    this.#storage = options.storage;
    this.#maxEntries = Math.max(1, options.maxEntries ?? CACHE_MAX_ENTRIES);
    this.#ttlMs = Math.max(1, options.ttlDays ?? CACHE_TTL_DAYS) * MS_PER_DAY;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 设置缓存上下文。传 `null` 即停用缓存。 */
  setContext(context: CacheContext | null): void {
    this.#context = context;
  }

  get context(): CacheContext | null {
    return this.#context;
  }

  get enabled(): boolean {
    return this.#context !== null;
  }

  /**
   * 查一批条目。
   *
   * 命中会顺带刷新 `lastUsedAt`（LRU 依据）。
   * **未设置上下文时全部视为未命中**，不会去读存储。
   */
  async lookup(
    payload: Pick<WireTranslateRequest, 'source_language' | 'target_language' | 'style'>,
    items: readonly CacheItem[],
  ): Promise<CacheLookupResult> {
    const context = this.#context;
    if (context === null || items.length === 0) {
      return { hits: new Map(), misses: [...items] };
    }

    const keys = items.map((item) => cacheKey(payload, context, item.text));
    const raw = await this.#getStorage().get(keys);
    const now = this.#now();

    const hits = new Map<string, string>();
    const misses: CacheItem[] = [];
    const touched: Record<string, CacheEntry> = {};

    items.forEach((item, index) => {
      const key = keys[index];
      const entry = key === undefined ? undefined : raw[key];

      if (!isCacheEntry(entry) || this.#isExpired(entry, now)) {
        misses.push(item);
        return;
      }

      hits.set(item.id, entry.translation);
      touched[key as string] = { ...entry, lastUsedAt: now };
    });

    if (Object.keys(touched).length > 0) {
      await this.#getStorage().set(touched);
    }

    return { hits, misses };
  }

  /** 回写一批译文。空译文与未设置上下文时不写。 */
  async store(
    payload: Pick<WireTranslateRequest, 'source_language' | 'target_language' | 'style'>,
    items: readonly (CacheItem & { translation: string })[],
  ): Promise<void> {
    const context = this.#context;
    if (context === null || items.length === 0) {
      return;
    }

    const now = this.#now();
    const records: Record<string, CacheEntry> = {};

    for (const item of items) {
      if (item.translation.trim() === '') {
        continue;
      }

      records[cacheKey(payload, context, item.text)] = {
        translation: item.translation,
        createdAt: now,
        lastUsedAt: now,
      };
    }

    const added = Object.keys(records).length;
    if (added === 0) {
      return;
    }

    await this.#getStorage().set(records);

    this.#size = (this.#size ?? (await this.#count())) + added;
    if (this.#size > this.#maxEntries) {
      await this.prune();
    }
  }

  /** 淘汰过期条目；仍超量时按 LRU 删到上限。返回删除数。 */
  async prune(): Promise<number> {
    const now = this.#now();
    const all = await this.#readAll();
    const keys = Object.keys(all);

    const doomed = new Set<string>();
    for (const key of keys) {
      const entry = all[key];
      if (entry !== undefined && this.#isExpired(entry, now)) {
        doomed.add(key);
      }
    }

    const survivors = keys.filter((key) => !doomed.has(key));
    if (survivors.length > this.#maxEntries) {
      const excess = survivors.length - this.#maxEntries;
      const oldest = survivors
        .sort((a, b) => (all[a]?.lastUsedAt ?? 0) - (all[b]?.lastUsedAt ?? 0))
        .slice(0, excess);

      for (const key of oldest) {
        doomed.add(key);
      }
    }

    if (doomed.size > 0) {
      await this.#getStorage().remove([...doomed]);
    }

    this.#size = keys.length - doomed.size;
    return doomed.size;
  }

  async stats(): Promise<CacheStats> {
    const raw = await this.#getStorage().get(null);
    const entries = Object.entries(raw).filter(([key]) => key.startsWith(CACHE_KEY_PREFIX));

    const bytes = entries.reduce(
      (sum, [key, value]) => sum + key.length + JSON.stringify(value ?? '').length,
      0,
    );

    this.#size = entries.length;

    return {
      count: entries.length,
      bytes,
      maxEntries: this.#maxEntries,
      ttlDays: this.#ttlMs / MS_PER_DAY,
    };
  }

  /** 清空全部缓存，返回删除数。 */
  async clear(): Promise<number> {
    const raw = await this.#getStorage().get(null);
    const keys = Object.keys(raw).filter((key) => key.startsWith(CACHE_KEY_PREFIX));

    if (keys.length > 0) {
      await this.#getStorage().remove(keys);
    }

    this.#size = 0;
    return keys.length;
  }

  /** 导出全部条目（方案第 86.8 节的「附带能力」）。 */
  async exportAll(): Promise<CacheDump> {
    return {
      version: CACHE_DUMP_VERSION,
      exportedAt: this.#now(),
      entries: await this.#readAll(),
    };
  }

  /** 导入条目。只接受结构合法的记录，返回导入数。 */
  async importAll(dump: unknown): Promise<number> {
    if (typeof dump !== 'object' || dump === null) {
      return 0;
    }

    const raw = (dump as { entries?: unknown }).entries;
    if (typeof raw !== 'object' || raw === null) {
      return 0;
    }

    const records: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith(CACHE_KEY_PREFIX) && isCacheEntry(value)) {
        records[key] = value;
      }
    }

    const added = Object.keys(records).length;
    if (added === 0) {
      return 0;
    }

    await this.#getStorage().set(records);

    this.#size = null;
    await this.prune();

    return added;
  }

  #getStorage(): StorageLike {
    if (this.#storage !== undefined) {
      return this.#storage;
    }

    // 懒取：在没有 chrome 的环境（如单测）导入本模块不应报错
    return {
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
      remove: (keys) => chrome.storage.local.remove(keys),
    };
  }

  async #readAll(): Promise<Record<string, CacheEntry>> {
    const raw = await this.#getStorage().get(null);
    const entries: Record<string, CacheEntry> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith(CACHE_KEY_PREFIX) && isCacheEntry(value)) {
        entries[key] = value;
      }
    }

    return entries;
  }

  async #count(): Promise<number> {
    const raw = await this.#getStorage().get(null);
    return Object.keys(raw).filter((key) => key.startsWith(CACHE_KEY_PREFIX)).length;
  }

  #isExpired(entry: CacheEntry, now: number): boolean {
    return now - entry.createdAt > this.#ttlMs;
  }
}
