/**
 * Options 设置页（方案第 39 节）。
 *
 * 职责：
 *   - 读写扩展设置（`chrome.storage.local`，**刷新浏览器后仍在**）
 *   - 显示缓存用量，支持清除 / 导出 / 导入（方案第 86.8 节的「附带能力」）
 *
 * **不含 API Key 字段**：Key 只存在于服务端 `.env`（方案第 52 节原则三）。
 */

import { TranslationCache } from '@/core/cache';
import { loadSettings, resetSettings, saveSettings } from '@/core/settings';
import {
  requestConfig,
  requestHealth,
  requestUsage,
  updateConfig,
} from '@/core/translator/server-client';
import { estimateCost, formatCost, formatTimestamp, formatTokens, hasPricing } from '@/core/usage';
import type {
  DisplayMode,
  TranslationStyle,
  WireConfigResponse,
  WireUsageResponse,
} from '@/shared/types';

function pick<T extends HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`#${id}`);
}

const serverUrlInput = pick<HTMLInputElement>('server-url');
const targetLanguageInput = pick<HTMLInputElement>('target-language');
const styleSelect = pick<HTMLSelectElement>('style');
const displayModeSelect = pick<HTMLSelectElement>('display-mode');

const saveButton = pick<HTMLButtonElement>('save');
const resetButton = pick<HTMLButtonElement>('reset');
const statusEl = pick<HTMLSpanElement>('status');

const testButton = pick<HTMLButtonElement>('test-connection');
const connectionStatusEl = pick<HTMLSpanElement>('connection-status');

const cacheCountEl = pick<HTMLElement>('cache-count');
const cacheBytesEl = pick<HTMLElement>('cache-bytes');
const cacheLimitEl = pick<HTMLElement>('cache-limit');
const clearCacheButton = pick<HTMLButtonElement>('clear-cache');
const exportCacheButton = pick<HTMLButtonElement>('export-cache');
const importCacheButton = pick<HTMLButtonElement>('import-cache');
const importFileInput = pick<HTMLInputElement>('import-file');

const appVersionEl = pick<HTMLElement>('app-version');

const llmBaseUrlInput = pick<HTMLInputElement>('llm-base-url');
const llmModelInput = pick<HTMLInputElement>('llm-model');
const llmSummaryModelInput = pick<HTMLInputElement>('llm-summary-model');
const llmApiKeyInput = pick<HTMLInputElement>('llm-api-key');
const llmKeyStatusEl = pick<HTMLElement>('llm-key-status');
const llmStatusEl = pick<HTMLSpanElement>('llm-status');
const saveLlmButton = pick<HTMLButtonElement>('save-llm');
const reloadLlmButton = pick<HTMLButtonElement>('reload-llm');

const inputPriceInput = pick<HTMLInputElement>('input-price');
const outputPriceInput = pick<HTMLInputElement>('output-price');

const usageCallsEl = pick<HTMLElement>('usage-calls');
const usagePromptEl = pick<HTMLElement>('usage-prompt');
const usageCompletionEl = pick<HTMLElement>('usage-completion');
const usageCostEl = pick<HTMLElement>('usage-cost');
const usageRangeEl = pick<HTMLElement>('usage-range');
const refreshUsageButton = pick<HTMLButtonElement>('refresh-usage');
const clearUsageButton = pick<HTMLButtonElement>('clear-usage');

const cache = new TranslationCache();

function setText(element: HTMLElement | null, text: string): void {
  if (element) {
    element.textContent = text;
  }
}

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  setText(statusEl, text);
  statusEl?.classList.toggle('inline-status--error', kind === 'error');
}

function toStyle(value: string): TranslationStyle {
  return value === 'technical' || value === 'academic' || value === 'literal' ? value : 'natural';
}

function toDisplayMode(value: string): DisplayMode {
  return value === 'original' || value === 'chinese' ? value : 'bilingual';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

async function renderSettings(): Promise<void> {
  const settings = await loadSettings();

  if (serverUrlInput) {
    serverUrlInput.value = settings.serverUrl;
  }
  if (targetLanguageInput) {
    targetLanguageInput.value = settings.targetLanguage;
  }
  if (styleSelect) {
    styleSelect.value = settings.style;
  }
  if (displayModeSelect) {
    displayModeSelect.value = settings.displayMode;
  }
  if (inputPriceInput) {
    // 0 显示成空，避免让人以为「必须填 0」
    inputPriceInput.value =
      settings.inputPricePerMillion === 0 ? '' : String(settings.inputPricePerMillion);
  }
  if (outputPriceInput) {
    outputPriceInput.value =
      settings.outputPricePerMillion === 0 ? '' : String(settings.outputPricePerMillion);
  }
}

function toPrice(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? '').trim());

  // 空串 / 非法值 / 负数都当作「不填」——saveSettings 还会再规范化一次
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function collectForm(): {
  serverUrl: string;
  targetLanguage: string;
  style: TranslationStyle;
  displayMode: DisplayMode;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
} {
  return {
    serverUrl: serverUrlInput?.value ?? '',
    targetLanguage: targetLanguageInput?.value ?? '',
    style: toStyle(styleSelect?.value ?? ''),
    displayMode: toDisplayMode(displayModeSelect?.value ?? ''),
    inputPricePerMillion: toPrice(inputPriceInput?.value),
    outputPricePerMillion: toPrice(outputPriceInput?.value),
  };
}

saveButton?.addEventListener('click', () => {
  void (async () => {
    // 走 saveSettings 而非直接写：它会做规范化并把非法值回落默认
    const saved = await saveSettings(collectForm());
    await renderSettings();

    setStatus(`已保存 · ${saved.serverUrl}`);
  })();
});

resetButton?.addEventListener('click', () => {
  void (async () => {
    await resetSettings();
    await renderSettings();
    setStatus('已恢复默认设置');
  })();
});

testButton?.addEventListener('click', () => {
  const button = testButton;
  button.disabled = true;
  setText(connectionStatusEl, '连接中…');

  void (async () => {
    try {
      // 先落盘再测，避免「测试的地址」与「保存的地址」不是同一个
      const saved = await saveSettings(collectForm());
      await renderSettings();

      const health = await requestHealth({ serverUrl: saved.serverUrl });
      // 两个模型都显示——「分别指定」这件事得能当场验证
      const models =
        health.summaryModel && health.summaryModel !== health.model
          ? `${health.model} · 总结用 ${health.summaryModel}`
          : health.model;
      setText(connectionStatusEl, `已连接 · ${health.provider} / ${models}`);
      connectionStatusEl?.classList.remove('inline-status--error');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setText(connectionStatusEl, `连接失败：${reason}`);
      connectionStatusEl?.classList.add('inline-status--error');
    } finally {
      button.disabled = false;
    }
  })();
});

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

async function renderCacheStats(): Promise<void> {
  const stats = await cache.stats();

  setText(cacheCountEl, `${stats.count} 条`);
  setText(cacheBytesEl, formatBytes(stats.bytes));
  setText(cacheLimitEl, `${stats.maxEntries} 条 / ${stats.ttlDays} 天`);
}

clearCacheButton?.addEventListener('click', () => {
  void (async () => {
    const removed = await cache.clear();
    await renderCacheStats();
    setStatus(`已清除 ${removed} 条缓存`);
  })();
});

exportCacheButton?.addEventListener('click', () => {
  void (async () => {
    const dump = await cache.exportAll();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-web-translator-cache-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();

    URL.revokeObjectURL(url);
    setStatus(`已导出 ${Object.keys(dump.entries).length} 条缓存`);
  })();
});

importCacheButton?.addEventListener('click', () => {
  importFileInput?.click();
});

importFileInput?.addEventListener('change', () => {
  const input = importFileInput;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  void (async () => {
    try {
      const text = await file.text();
      const imported = await cache.importAll(JSON.parse(text) as unknown);
      await renderCacheStats();
      setStatus(imported > 0 ? `已导入 ${imported} 条缓存` : '文件里没有可导入的缓存');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStatus(`导入失败：${reason}`, 'error');
    } finally {
      // 清空选择，否则选同一个文件不会再触发 change
      input.value = '';
    }
  })();
});

/* ------------------------------------------------------------------ *
 * 模型服务
 * ------------------------------------------------------------------ */

/**
 * 把服务端返回的配置填进表单。
 *
 * ⚠️ **API Key 那一栏永远不填值。** 服务端只返回 `hasApiKey`，
 * 浏览器里也就不该有密钥——见铁律 1。用户想换 Key 时自己粘贴。
 */
function fillLlmForm(config: WireConfigResponse): void {
  if (llmBaseUrlInput) {
    llmBaseUrlInput.value = config.baseUrl;
  }
  if (llmModelInput) {
    llmModelInput.value = config.model;
  }
  if (llmSummaryModelInput) {
    llmSummaryModelInput.value = config.summaryModel;
  }
  if (llmApiKeyInput) {
    llmApiKeyInput.value = '';
    llmApiKeyInput.placeholder = config.hasApiKey ? '已配置 · 留空表示不修改' : '尚未配置';
  }

  setText(
    llmKeyStatusEl,
    config.hasApiKey
      ? '密钥已保存在服务端。出于安全考虑，浏览器不会读取它的值。'
      : '还没有配置密钥——填一个再保存。',
  );
}

/** 读取服务端配置并填表。 */
async function renderLlmConfig(): Promise<void> {
  const { serverUrl } = collectForm();

  try {
    fillLlmForm(await requestConfig({ serverUrl: serverUrl || (await loadSettings()).serverUrl }));
    setText(llmStatusEl, '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setText(llmStatusEl, `读取失败：${reason}`);
    llmStatusEl?.classList.add('inline-status--error');
  }
}

/**
 * 保存到服务端。
 *
 * 只提交**确实改过**的字段——未改的不传，服务端就不动它们。
 * 这样用户可以只换接口地址，不必重新粘贴密钥。
 */
async function saveLlmConfig(): Promise<void> {
  const { serverUrl } = collectForm();
  const current = await requestConfig({
    serverUrl: serverUrl || (await loadSettings()).serverUrl,
  });

  const payload: Record<string, string> = {};

  const baseUrl = llmBaseUrlInput?.value.trim() ?? '';
  if (baseUrl !== '' && baseUrl !== current.baseUrl) {
    payload.baseUrl = baseUrl;
  }

  const model = llmModelInput?.value.trim() ?? '';
  if (model !== '' && model !== current.model) {
    payload.model = model;
  }

  const summaryModel = llmSummaryModelInput?.value.trim() ?? '';
  if (summaryModel !== current.summaryModel) {
    payload.summaryModel = summaryModel;
  }

  // 空 = 不修改。清空密钥会让服务直接不可用，不该是一个空输入框的副作用
  const apiKey = llmApiKeyInput?.value.trim() ?? '';
  if (apiKey !== '') {
    payload.apiKey = apiKey;
  }

  if (Object.keys(payload).length === 0) {
    setStatus('没有改动');
    return;
  }

  const updated = await updateConfig(payload, {
    serverUrl: serverUrl || (await loadSettings()).serverUrl,
  });

  fillLlmForm(updated);

  // 保存后立刻清掉输入框里的密钥——它已经进服务端了，留在 DOM 里没有理由
  if (llmApiKeyInput) {
    llmApiKeyInput.value = '';
  }

  setStatus('已保存到服务端，立即生效');
}

saveLlmButton?.addEventListener('click', () => {
  const button = saveLlmButton;
  button.disabled = true;
  setText(llmStatusEl, '保存中…');
  llmStatusEl?.classList.remove('inline-status--error');

  void (async () => {
    try {
      await saveLlmConfig();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setText(llmStatusEl, `保存失败：${reason}`);
      llmStatusEl?.classList.add('inline-status--error');
    } finally {
      button.disabled = false;
    }
  })();
});

reloadLlmButton?.addEventListener('click', () => {
  void (async () => {
    await renderLlmConfig();
    setStatus('已重新读取服务端配置');
  })();
});

/* ------------------------------------------------------------------ *
 * 用量
 * ------------------------------------------------------------------ */

/**
 * 刷新累计用量。
 *
 * 服务端只报 token；金额按**当前表单里的单价**算，而不是已保存的——
 * 这样改了单价点「刷新用量」就能立刻看到新金额，不用先保存。
 */
async function renderUsage(): Promise<void> {
  const settings = await loadSettings();
  const { serverUrl } = collectForm();

  let usage: WireUsageResponse;
  try {
    usage = await requestUsage({ serverUrl: serverUrl || settings.serverUrl });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setText(usageCallsEl, '读取失败');
    setText(usagePromptEl, '—');
    setText(usageCompletionEl, '—');
    setText(usageCostEl, '—');
    setText(usageRangeEl, reason);
    return;
  }

  setText(usageCallsEl, `${usage.calls} 次`);
  setText(usagePromptEl, formatTokens(usage.prompt_tokens));
  setText(usageCompletionEl, formatTokens(usage.completion_tokens));

  const prices = {
    inputPricePerMillion: toPrice(inputPriceInput?.value),
    outputPricePerMillion: toPrice(outputPriceInput?.value),
  };

  if (!hasPricing(prices)) {
    setText(usageCostEl, '未设单价');
  } else {
    const estimate = estimateCost(usage, prices);
    setText(usageCostEl, estimate.cost === null ? '—' : formatCost(estimate.cost));
  }

  setText(
    usageRangeEl,
    usage.calls === 0
      ? '还没有记录到用量。'
      : `记录区间：${formatTimestamp(usage.first_at)} → ${formatTimestamp(usage.last_at)}`,
  );
}

refreshUsageButton?.addEventListener('click', () => {
  void (async () => {
    await renderUsage();
    setStatus('用量已刷新');
  })();
});

clearUsageButton?.addEventListener('click', () => {
  void (async () => {
    try {
      const settings = await loadSettings();
      const response = await fetch(new URL('/api/v1/usage', settings.serverUrl).toString(), {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await renderUsage();
      setStatus('已清空用量记录');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStatus(`清空失败：${reason}`, 'error');
    }
  })();
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/**
 * 显示扩展版本。
 *
 * 从 manifest 读，而不是写死——两处版本号迟早会不一致。
 * 报 bug 时这个数字比什么都有用。
 */
function renderVersion(): void {
  setText(appVersionEl, `v${chrome.runtime.getManifest().version}`);
}

void (async () => {
  renderVersion();
  await renderSettings();
  await renderCacheStats();
  await renderUsage();
  await renderLlmConfig();
})();
