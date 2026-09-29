/**
 * Popup。
 *
 * 职责（方案第 8.1 节）：**只发送命令，不直接操作 DOM**。
 * 命令交给 background 转发给 content script，结果回显到状态栏。
 *
 * 业务逻辑在 `core/panel`——与 Side Panel 共用。两个面板功能高度重叠，
 * 各自实现必然走形（Phase 16 的 `get_llm_client` 刚踩过同一个坑）。
 *
 * 三种显示模式的切换不产生网络请求——content script 侧只是重新渲染
 * （译文一直在 `PageStore` 里），详见 `core/controller`。
 */

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
import type { ContentScriptState, ExtractReaderMessage } from '@/shared/types';

const translateButton = document.querySelector<HTMLButtonElement>('#translate');
const restoreButton = document.querySelector<HTMLButtonElement>('#restore');
const optionsButton = document.querySelector<HTMLButtonElement>('#open-options');
const readerButton = document.querySelector<HTMLButtonElement>('#open-reader');
const sidebarButton = document.querySelector<HTMLButtonElement>('#open-sidebar');
const statusEl = document.querySelector<HTMLParagraphElement>('#status');
const modeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'));

/**
 * 状态轮询间隔。
 *
 * Popup 原先只在打开时查一次状态，于是**翻译中按钮永远停在「翻译当前页面」**——
 * 用户找不到取消入口（这正是实际使用中报上来的问题）。
 * 与侧边栏用同一个节奏。
 */
const POLL_INTERVAL_MS = 1000;

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

/** 把 content script 报回的页面状态渲染到 UI。 */
function applyState(state: ContentScriptState): void {
  for (const input of modeInputs) {
    input.checked = input.value === state.mode;
  }

  setStatus(describeState(state));

  if (translateButton) {
    translateButton.disabled = isBusy(state);
  }
  if (restoreButton) {
    restoreButton.disabled = !hasTranslation(state);
  }
}

async function queryState(): Promise<void> {
  const result = await queryPageState();

  if (result.ok && result.state !== undefined) {
    applyState(result.state);
    return;
  }

  setStatus('尚未翻译当前页面');

  if (translateButton) {
    translateButton.disabled = false;
  }
}

/**
 * 进入阅读模式。
 *
 * 提取必须在页面里做（background 拿不到 DOM），所以先让 content script 干活，
 * 由它把正文交给 background 打开阅读视图。
 *
 * 这条命令会**按需注入** content script——阅读模式与是否翻译过无关。
 */
readerButton?.addEventListener('click', () => {
  const button = readerButton;
  button.disabled = true;
  setStatus('正在提取正文…');

  void (async () => {
    try {
      const response = await sendToBackground(
        createMessage<ExtractReaderMessage>({ type: 'EXTRACT_READER' }),
      );

      setStatus(response.ok ? '已打开阅读视图' : `失败：${response.error ?? '未知错误'}`);
    } catch (error) {
      setStatus(`失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = false;
    }
  })();
});

/**
 * 打开侧边栏。
 *
 * `sidePanel.open()` 要求**用户手势**——所以只能由按钮点击触发，
 * 不能自动打开。需要当前窗口 ID，因此先查一次。
 */
sidebarButton?.addEventListener('click', () => {
  void (async () => {
    // `chrome.sidePanel` 需要 Chrome 114+。低版本上它是 `undefined`，
    // 直接调用会抛 "Cannot read properties of undefined" ——
    // 那种报错对用户毫无意义，不如明确说清楚。
    if (chrome.sidePanel === undefined) {
      setStatus('当前浏览器不支持侧边栏（需要 Chrome 114 及以上）');
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.windowId !== 'number') {
        setStatus('找不到当前窗口');
        return;
      }

      await chrome.sidePanel.open({ windowId: tab.windowId });
      // 侧边栏打开后 Popup 通常会自动关闭；没关时给个反馈
      setStatus('已打开侧边栏');
    } catch (error) {
      setStatus(`失败：${error instanceof Error ? error.message : String(error)}`);
    }
  })();
});

optionsButton?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
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
        setStatus('切换失败：当前页面尚未注入翻译脚本');
      }
    });
  });
}

/**
 * 恢复原文。
 *
 * ⚠️ 这个 handler 曾经**漏掉过**——按钮加进了 HTML、禁用状态也在 `applyState`
 * 里维护，就是没绑点击事件。用户点下去毫无反应，报上来的是「点了恢复原文没有用」。
 *
 * 教训：`core/panel` 共享的是**逻辑**，DOM 接线仍在各面板里，
 * 而接线漏掉不会让任何单测失败——只有真实点击的 E2E 能发现。
 */
restoreButton?.addEventListener('click', () => {
  const button = restoreButton;
  button.disabled = true;
  setStatus('正在恢复原文…');

  void requestRestore().then(
    (result) => {
      if (result.ok && result.state !== undefined) {
        applyState(result.state);
      } else {
        setStatus(`失败：${result.error ?? '未知错误'}`);
      }
      button.disabled = false;
    },
    (error: unknown) => {
      setStatus(`失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

translateButton?.addEventListener('click', () => {
  const button = translateButton;
  button.disabled = true;
  setStatus('正在翻译…');

  void requestTranslate().then(
    (result) => {
      if (result.ok && result.state !== undefined) {
        applyState(result.state);
      } else {
        setStatus(`失败：${result.error ?? '未知错误'}`);
      }
      button.disabled = false;
    },
    (error: unknown) => {
      setStatus(`失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

// 打开时同步一次，之后按秒轮询——这样进度文案是活的
void queryState();

setInterval(() => {
  // 只刷新状态文案（进度会一直变）。
  // **不要在这里碰按钮的禁用状态**——那由动作的返回值负责，
  // 两边都改会互相打架，表现为按钮闪烁。
  void queryState();
}, POLL_INTERVAL_MS);
