/**
 * 译文缓存：`chrome.storage.local` 持久化 + LRU + 过期（方案第 86.8 节）。
 *
 * 键必须含 `provider` 与 `promptVersion`；**绝不含 API Key**。
 */

export {
  type CacheItem,
  type CacheLookupResult,
  cacheKey,
  cacheKeySource,
  hashCacheKey,
  type StorageLike,
  TranslationCache,
  type TranslationCacheOptions,
} from './translation-cache';
