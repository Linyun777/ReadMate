import { describe, expect, it } from 'vitest';

import type { StorageLike } from '@/core/cache';
import {
  DEFAULT_DISPLAY_MODE,
  DEFAULT_SERVER_URL,
  DEFAULT_STYLE,
  DEFAULT_TARGET_LANGUAGE,
  SETTINGS_STORAGE_KEY,
} from '@/shared/constants';

import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  resetSettings,
  saveSettings,
} from './settings-store';

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

describe('DEFAULT_SETTINGS', () => {
  it('与 shared/constants 里的默认值一致', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      serverUrl: DEFAULT_SERVER_URL,
      targetLanguage: DEFAULT_TARGET_LANGUAGE,
      style: DEFAULT_STYLE,
      displayMode: DEFAULT_DISPLAY_MODE,
      // 0 表示不估算成本——不预设价格
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
    });
  });

  it('不含 API Key 字段', () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain('apiKey');
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toMatch(/sk-/);
  });
});

describe('normalizeSettings', () => {
  it('空对象全部回落默认', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('非对象输入回落默认', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('去掉 serverUrl 的尾部斜杠', () => {
    expect(normalizeSettings({ serverUrl: 'http://127.0.0.1:8000///' }).serverUrl).toBe(
      'http://127.0.0.1:8000',
    );
  });

  it('非 http(s) 协议的 serverUrl 回落默认', () => {
    expect(normalizeSettings({ serverUrl: 'ftp://example.com' }).serverUrl).toBe(
      DEFAULT_SERVER_URL,
    );
    expect(normalizeSettings({ serverUrl: 'javascript:alert(1)' }).serverUrl).toBe(
      DEFAULT_SERVER_URL,
    );
  });

  it('不是合法 URL 的 serverUrl 回落默认', () => {
    expect(normalizeSettings({ serverUrl: 'not a url' }).serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(normalizeSettings({ serverUrl: '   ' }).serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(normalizeSettings({ serverUrl: 123 }).serverUrl).toBe(DEFAULT_SERVER_URL);
  });

  it('空的 targetLanguage 回落默认', () => {
    expect(normalizeSettings({ targetLanguage: '  ' }).targetLanguage).toBe(
      DEFAULT_TARGET_LANGUAGE,
    );
  });

  it('非法 style / displayMode 回落默认', () => {
    expect(normalizeSettings({ style: 'poetic' }).style).toBe(DEFAULT_STYLE);
    expect(normalizeSettings({ displayMode: 'klingon' }).displayMode).toBe(DEFAULT_DISPLAY_MODE);
  });

  it('合法值原样保留', () => {
    const settings = normalizeSettings({
      serverUrl: 'http://localhost:9000',
      targetLanguage: 'ja',
      style: 'academic',
      displayMode: 'chinese',
    });

    expect(settings).toEqual({
      serverUrl: 'http://localhost:9000',
      targetLanguage: 'ja',
      style: 'academic',
      displayMode: 'chinese',
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
    });
  });
});

describe('loadSettings / saveSettings', () => {
  it('存储为空时返回默认值', async () => {
    expect(await loadSettings(makeStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('保存后能读回', async () => {
    const storage = makeStorage();

    await saveSettings({ targetLanguage: 'ja' }, storage);

    expect((await loadSettings(storage)).targetLanguage).toBe('ja');
  });

  it('部分更新保留其他字段', async () => {
    const storage = makeStorage();

    await saveSettings({ targetLanguage: 'ja', style: 'academic' }, storage);
    await saveSettings({ displayMode: 'chinese' }, storage);

    const settings = await loadSettings(storage);

    expect(settings.targetLanguage).toBe('ja');
    expect(settings.style).toBe('academic');
    expect(settings.displayMode).toBe('chinese');
  });

  it('写入前会规范化', async () => {
    const storage = makeStorage();

    const saved = await saveSettings(
      { serverUrl: 'http://127.0.0.1:8000/', style: 'nonsense' as never },
      storage,
    );

    expect(saved.serverUrl).toBe('http://127.0.0.1:8000');
    expect(saved.style).toBe(DEFAULT_STYLE);
  });

  it('存储里的脏数据被规范化后读出', async () => {
    const storage = makeStorage({
      [SETTINGS_STORAGE_KEY]: { serverUrl: 'ftp://bad', style: 'poetic', extra: 'ignored' },
    });

    const settings = await loadSettings(storage);

    expect(settings.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(settings.style).toBe(DEFAULT_STYLE);
    expect(settings).not.toHaveProperty('extra');
  });

  it('用固定的存储键', async () => {
    const storage = makeStorage();

    await saveSettings({ targetLanguage: 'ja' }, storage);

    expect(Object.keys(storage.data)).toEqual([SETTINGS_STORAGE_KEY]);
  });

  it('写入的内容不含 API Key', async () => {
    const storage = makeStorage();

    await saveSettings({ targetLanguage: 'ja' }, storage);

    expect(JSON.stringify(storage.data)).not.toMatch(/sk-|api[_-]?key/i);
  });
});

describe('resetSettings', () => {
  it('恢复默认值', async () => {
    const storage = makeStorage();

    await saveSettings({ targetLanguage: 'ja', style: 'academic' }, storage);
    const restored = await resetSettings(storage);

    expect(restored).toEqual(DEFAULT_SETTINGS);
    expect(await loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('单价规范化', () => {
  it('合法单价原样保留', () => {
    const settings = normalizeSettings({ inputPricePerMillion: 1, outputPricePerMillion: 4 });

    expect(settings.inputPricePerMillion).toBe(1);
    expect(settings.outputPricePerMillion).toBe(4);
  });

  it('未填时为 0（表示不估算成本）', () => {
    const settings = normalizeSettings({});

    expect(settings.inputPricePerMillion).toBe(0);
    expect(settings.outputPricePerMillion).toBe(0);
  });

  it.each([
    ['负数', -1],
    ['非数字', 'abc'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['对象', {}],
  ])('%s 回落为 0', (_label, value) => {
    const settings = normalizeSettings({ inputPricePerMillion: value });

    expect(settings.inputPricePerMillion).toBe(0);
  });

  it('0 是合法值，不会被当成非法', () => {
    const settings = normalizeSettings({ inputPricePerMillion: 0 });

    expect(settings.inputPricePerMillion).toBe(0);
  });
});
