/**
 * 扩展设置（方案第 39 节）。
 *
 * 持久化在 `chrome.storage.local`——**刷新浏览器后仍在**，这是本模块的全部意义。
 *
 * ## 两条硬约束
 *
 * 1. **不含 API Key**。Key 只存在于服务端 `.env`（方案第 52 节原则三）。
 * 2. **读到脏数据不能让扩展崩掉**。存储里的值可能来自旧版本或被手工改过，
 *    因此每一项都单独校验并回落默认值，而不是整块 JSON 反序列化。
 */

import type { StorageLike } from '@/core/cache';
import {
  DEFAULT_DISPLAY_MODE,
  DEFAULT_SERVER_URL,
  DEFAULT_STYLE,
  DEFAULT_TARGET_LANGUAGE,
  SETTINGS_STORAGE_KEY,
} from '@/shared/constants';
import type { DisplayMode, ExtensionSettings, TranslationStyle } from '@/shared/types';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  style: DEFAULT_STYLE,
  displayMode: DEFAULT_DISPLAY_MODE,
  // 0 表示不估算成本——不预设价格，避免给出一个过时的数字
  inputPricePerMillion: 0,
  outputPricePerMillion: 0,
};

const STYLES: readonly TranslationStyle[] = ['natural', 'technical', 'academic', 'literal'];
const DISPLAY_MODES: readonly DisplayMode[] = ['original', 'bilingual', 'chinese'];

function isStyle(value: unknown): value is TranslationStyle {
  return typeof value === 'string' && (STYLES as readonly string[]).includes(value);
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as readonly string[]).includes(value);
}

/**
 * 规范化服务地址。
 *
 * 非法值回落默认；去掉尾部斜杠，避免拼出 `http://host//api/v1/...`。
 */
function normalizeServerUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_SETTINGS.serverUrl;
  }

  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return DEFAULT_SETTINGS.serverUrl;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return DEFAULT_SETTINGS.serverUrl;
    }
  } catch {
    return DEFAULT_SETTINGS.serverUrl;
  }

  return trimmed;
}

function normalizeTargetLanguage(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_SETTINGS.targetLanguage;
  }

  const trimmed = value.trim();
  return trimmed === '' ? DEFAULT_SETTINGS.targetLanguage : trimmed;
}

/** 单价：非负有限数，否则回落 0。 */
function normalizePrice(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

/** 把任意来源的对象整理成合法设置。缺项与非法项都回落默认值。 */
export function normalizeSettings(raw: unknown): ExtensionSettings {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  return {
    serverUrl: normalizeServerUrl(record.serverUrl),
    targetLanguage: normalizeTargetLanguage(record.targetLanguage),
    style: isStyle(record.style) ? record.style : DEFAULT_SETTINGS.style,
    displayMode: isDisplayMode(record.displayMode)
      ? record.displayMode
      : DEFAULT_SETTINGS.displayMode,
    inputPricePerMillion: normalizePrice(record.inputPricePerMillion),
    outputPricePerMillion: normalizePrice(record.outputPricePerMillion),
  };
}

function defaultStorage(): StorageLike {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}

/** 读取设置。存储为空或损坏时返回默认值。 */
export async function loadSettings(storage?: StorageLike): Promise<ExtensionSettings> {
  const store = storage ?? defaultStorage();
  const raw = await store.get(SETTINGS_STORAGE_KEY);

  return normalizeSettings(raw[SETTINGS_STORAGE_KEY]);
}

/** 合并写入设置，返回写入后的完整设置。 */
export async function saveSettings(
  patch: Partial<ExtensionSettings>,
  storage?: StorageLike,
): Promise<ExtensionSettings> {
  const store = storage ?? defaultStorage();
  const current = await loadSettings(store);
  const next = normalizeSettings({ ...current, ...patch });

  await store.set({ [SETTINGS_STORAGE_KEY]: next });

  return next;
}

/** 恢复默认设置。 */
export async function resetSettings(storage?: StorageLike): Promise<ExtensionSettings> {
  return await saveSettings(DEFAULT_SETTINGS, storage);
}
