/**
 * 阅读视图的数据传递（方案第 62 节）。
 *
 * content script 在页面里提取正文，background 负责打开阅读视图页——
 * 两边需要一个中转。用 `chrome.storage.session`：
 *
 *   - **自动随浏览器会话清理**，不会像 `storage.local` 那样留下过期文章
 *   - 内容可能很大（整篇正文 HTML），不适合塞进消息里反复传递
 *
 * 写入方是 background（受信上下文），因此不需要调整 `storage.session`
 * 的访问级别——content script 默认访问不了它，这是有意为之。
 */

import { READER_STORAGE_KEY } from '@/shared/constants';
import type { ReaderPayload } from '@/shared/types';

/** `chrome.storage.session` 的最小接口，便于测试注入替身。 */
export interface SessionStorageLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function defaultStorage(): SessionStorageLike {
  return {
    get: (keys) => chrome.storage.session.get(keys),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}

function isReaderPayload(value: unknown): value is ReaderPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.title === 'string' &&
    typeof record.content === 'string' &&
    typeof record.text === 'string' &&
    typeof record.url === 'string'
  );
}

export async function storeReaderPayload(
  payload: ReaderPayload,
  storage?: SessionStorageLike,
): Promise<void> {
  const store = storage ?? defaultStorage();
  await store.set({ [READER_STORAGE_KEY]: payload });
}

/** 读取正文。没有、或结构不对时返回 null。 */
export async function loadReaderPayload(
  storage?: SessionStorageLike,
): Promise<ReaderPayload | null> {
  const store = storage ?? defaultStorage();
  const raw = await store.get(READER_STORAGE_KEY);
  const value = raw[READER_STORAGE_KEY];

  return isReaderPayload(value) ? value : null;
}

export async function clearReaderPayload(storage?: SessionStorageLike): Promise<void> {
  const store = storage ?? defaultStorage();
  await store.remove(READER_STORAGE_KEY);
}
