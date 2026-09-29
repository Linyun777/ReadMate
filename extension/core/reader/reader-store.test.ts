import { describe, expect, it } from 'vitest';

import { READER_STORAGE_KEY } from '@/shared/constants';

import {
  clearReaderPayload,
  loadReaderPayload,
  type SessionStorageLike,
  storeReaderPayload,
} from './reader-store';

function makeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };

  const storage: SessionStorageLike & { data: Record<string, unknown> } = {
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

const PAYLOAD = {
  title: '示例文章',
  content: '<p>正文</p>',
  text: '正文',
  url: 'https://example.com/article',
};

describe('阅读载荷存取', () => {
  it('写入后能读回', async () => {
    const storage = makeStorage();

    await storeReaderPayload(PAYLOAD, storage);

    expect(await loadReaderPayload(storage)).toEqual(PAYLOAD);
  });

  it('用固定的存储键', async () => {
    const storage = makeStorage();

    await storeReaderPayload(PAYLOAD, storage);

    expect(Object.keys(storage.data)).toEqual([READER_STORAGE_KEY]);
  });

  it('没写过时返回 null', async () => {
    expect(await loadReaderPayload(makeStorage())).toBeNull();
  });

  it('结构不对时返回 null（不把坏数据当正文渲染）', async () => {
    const storage = makeStorage({ [READER_STORAGE_KEY]: { title: '只有标题' } });

    expect(await loadReaderPayload(storage)).toBeNull();
  });

  it('存的是字符串而不是对象时返回 null', async () => {
    const storage = makeStorage({ [READER_STORAGE_KEY]: '<p>裸 HTML</p>' });

    expect(await loadReaderPayload(storage)).toBeNull();
  });

  it('clear 之后读不到', async () => {
    const storage = makeStorage();

    await storeReaderPayload(PAYLOAD, storage);
    await clearReaderPayload(storage);

    expect(await loadReaderPayload(storage)).toBeNull();
  });

  it('覆盖写入只保留最新一篇', async () => {
    const storage = makeStorage();

    await storeReaderPayload(PAYLOAD, storage);
    await storeReaderPayload({ ...PAYLOAD, title: '第二篇' }, storage);

    expect((await loadReaderPayload(storage))?.title).toBe('第二篇');
  });
});
