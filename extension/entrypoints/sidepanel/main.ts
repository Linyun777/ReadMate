/**
 * Side Panel：常驻控制台（方案第 83 节）。
 *
 * ## 它解决什么问题
 *
 * Popup 一被点击就关闭——改个显示模式、看眼进度、再点一次翻译，
 * 得反复开合。侧边栏常驻在窗口一侧，浏览时一直可见。
 *
 * ## 与 Popup 的关系
 *
 * **共存，不替代**。Popup 是「随手一点」，侧边栏是「盯着看」。
 * 两者的业务逻辑共用 `core/panel`，避免两份各自演化。
 *
 * ## 为什么轮询而不是推送
 *
 * 侧边栏要反映的是**当前活动标签页**的状态，而活动标签页随时会变。
 * 轮询天然跟随这个变化，也不需要 content script 与侧边栏之间建立长连接。
 * 1 秒一次的消息往返代价可以忽略。
 */

import { TranslationCache } from '@/core/cache';
import { sendToBackground } from '@/core/messaging/client';
import { createMessage } from '@/core/messaging/protocol';
import {
  describeState,
  hasTranslation,
  isBusy,
  queryPageState,
  requestRestore,
  requestSetMode,
  requestTranslate,
  toDisplayMode,
} from '@/core/panel';
import { loadSettings } from '@/core/settings';
import { estimateCost, formatCost, formatTokens, hasPricing } from '@/core/usage';
import type {
  ContentScriptState,
  ExtractReaderMessage,
  FetchUsageMessage,
  SummarizePageMessage,
  WireSummaryResponse,
  WireUsageResponse,
} from '@/shared/types';

/** 状态轮询间隔。1 秒足够跟上翻译进度，代价可忽略。 */
const POLL_INTERVAL_MS = 1000;

function pick<T extends HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`#${id}`);
}

const pageTitleEl = pick<HTMLElement>('page-title');
const statusEl = pick<HTMLElement>('status');
const translateButton = pick<HTMLButtonElement>('translate');
const restoreButton = pick<HTMLButtonElement>('restore');
const summarizeButton = pick<HTMLButtonElement>('summarize');
const summaryEl = pick<HTMLElement>('summary');
const summaryGistEl = pick<HTMLElement>('summary-gist');
const summaryPointsEl = pick<HTMLElement>('summary-points');
const readerButton = pick<HTMLButtonElement>('reader');
const optionsButton = pick<HTMLButtonElement>('options');
const clearCacheButton = pick<HTMLButtonElement>('clear-cache');
const cacheSummaryEl = pick<HTMLElement>('cache-summary');
const usageSummaryEl = pick<HTMLElement>('usage-summary');
const usageCostEl = pick<HTMLElement>('usage-cost');
const modeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'));

const cache = new TranslationCache();

function setText(element: HTMLElement | null, text: string): void {
  if (element) {
    element.textContent = text;
  }
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

/** 把页面状态渲染到面板。 */
function applyState(state: ContentScriptState): void {
  for (const input of modeInputs) {
    input.checked = input.value === state.mode;
  }

  setText(pageTitleEl, state.title);
  setText(statusEl, describeState(state));

  if (translateButton) {
    translateButton.disabled = isBusy(state);
  }

  if (restoreButton) {
    restoreButton.disabled = !hasTranslation(state);
  }
}

/**
 * 渲染总结结果。
 *
 * 全部走 `textContent` —— 总结来自模型，属于不可信输入（铁律 2）。
 * 要点用 `createElement` 逐个建，不拼 HTML 字符串。
 */
function renderSummary(summary: WireSummaryResponse): void {
  setText(summaryGistEl, summary.gist);

  if (summaryPointsEl) {
    summaryPointsEl.replaceChildren();

    for (const point of summary.points) {
      const item = document.createElement('li');
      item.textContent = point;
      summaryPointsEl.append(item);
    }
  }

  summaryEl?.removeAttribute('hidden');
}

function clearSummary(): void {
  summaryEl?.setAttribute('hidden', '');
}

/**
 * 页面还没有 content script 时的降级展示。
 *
 * ⚠️ **翻译按钮必须保持可用**。首次翻译前页面本来就没有 content script，
 * 状态查询必然失败——但这正是「需要翻译」的正常状态，`TRANSLATE_PAGE`
 * 会按需注入。把它禁掉会让侧边栏永远卡死。
 *
 * 「恢复原文」则可以禁用：没有 content script 就没有译文可恢复。
 */
function applyUntranslated(): void {
  setText(pageTitleEl, '');
  setText(statusEl, '尚未翻译当前页面');

  // 首次翻译前页面没有 content script，状态查询必然失败——
  // 但那正是「需要翻译」的正常状态，按钮必须保持可用（点击会按需注入）
  if (translateButton) {
    translateButton.disabled = false;
  }

  if (restoreButton) {
    restoreButton.disabled = true;
  }
}

async function refresh(): Promise<void> {
  const result = await queryPageState();

  if (result.ok && result.state !== undefined) {
    applyState(result.state);
    return;
  }

  applyUntranslated();
}

/**
 * 刷新累计用量。
 *
 * 服务端只报 token；金额按**设置里填的单价**在这里算。
 * 没填单价就只显示 token——预设一个过时的价格比不显示更糟。
 */
async function refreshUsage(): Promise<void> {
  const response = await sendToBackground<WireUsageResponse>(
    createMessage<FetchUsageMessage>({ type: 'FETCH_USAGE' }),
  );

  if (!response.ok || response.data === undefined) {
    setText(usageSummaryEl, '用量读取失败');
    setText(usageCostEl, '');
    return;
  }

  const usage: WireUsageResponse = response.data;
  setText(usageSummaryEl, `${usage.calls} 次调用 · ${formatTokens(usage.total_tokens)} token`);

  const settings = await loadSettings();
  if (!hasPricing(settings)) {
    setText(usageCostEl, '未设单价，只显示 token（去设置页填单价可估算金额）');
    return;
  }

  const estimate = estimateCost(usage, settings);
  setText(usageCostEl, estimate.cost === null ? '' : `估算成本 ${formatCost(estimate.cost)}`);
}

async function refreshCache(): Promise<void> {
  const stats = await cache.stats();
  setText(cacheSummaryEl, `${stats.count} 条 · ${formatBytes(stats.bytes)}`);
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

translateButton?.addEventListener('click', () => {
  const button = translateButton;
  button.disabled = true;
  setText(statusEl, '正在翻译…');

  void requestTranslate().then(
    (result) => {
      if (result.ok && result.state !== undefined) {
        applyState(result.state);
      } else {
        setText(statusEl, `失败：${result.error ?? '未知错误'}`);
      }
      button.disabled = false;
      void refreshCache();
      void refreshUsage();
    },
    (error: unknown) => {
      setText(statusEl, `失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

restoreButton?.addEventListener('click', () => {
  void requestRestore().then((result) => {
    if (result.ok && result.state !== undefined) {
      applyState(result.state);
    } else {
      setText(statusEl, `失败：${result.error ?? '未知错误'}`);
    }
  });
});

for (const input of modeInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) {
      return;
    }

    const mode = toDisplayMode(input.value);
    if (mode === null) {
      return;
    }

    void requestSetMode(mode).then((result) => {
      if (result.ok && result.state !== undefined) {
        applyState(result.state);
      } else {
        setText(statusEl, '切换失败：当前页面尚未注入翻译脚本');
      }
    });
  });
}

summarizeButton?.addEventListener('click', () => {
  const button = summarizeButton;
  button.disabled = true;
  setText(statusEl, '正在提取正文…');
  clearSummary();

  void sendToBackground<WireSummaryResponse>(
    createMessage<SummarizePageMessage>({ type: 'SUMMARIZE_PAGE' }),
  ).then(
    (response) => {
      if (response.ok && response.data !== undefined) {
        renderSummary(response.data);
        setText(statusEl, '总结完成');
      } else {
        setText(statusEl, `总结失败：${response.error ?? '未知错误'}`);
      }
      button.disabled = false;
    },
    (error: unknown) => {
      setText(statusEl, `总结失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

readerButton?.addEventListener('click', () => {
  const button = readerButton;
  button.disabled = true;
  setText(statusEl, '正在提取正文…');

  void sendToBackground(createMessage<ExtractReaderMessage>({ type: 'EXTRACT_READER' })).then(
    (response) => {
      setText(statusEl, response.ok ? '已打开阅读视图' : `失败：${response.error ?? '未知错误'}`);
      button.disabled = false;
    },
    (error: unknown) => {
      setText(statusEl, `失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

optionsButton?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

clearCacheButton?.addEventListener('click', () => {
  void cache.clear().then((removed) => {
    void refreshCache();
    setText(statusEl, `已清除 ${removed} 条缓存`);
  });
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

void refresh();
void refreshCache();
void refreshUsage();

setInterval(() => {
  void refresh();
}, POLL_INTERVAL_MS);
