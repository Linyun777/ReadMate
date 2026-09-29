import { sendToTab } from '@/core/messaging/client';
import { createMessage, isExtensionMessage } from '@/core/messaging/protocol';
import { storeReaderPayload } from '@/core/reader';
import { loadSettings } from '@/core/settings';
import {
  requestExplain,
  requestHealth,
  requestNote,
  requestSummary,
  requestTranslation,
  requestUsage,
  ServerError,
  streamTranslation,
} from '@/core/translator/server-client';
import { isExtensionContextValid } from '@/shared/extension-context';
import type {
  ExplainSelectionMessage,
  ExtensionMessage,
  HealthResponse,
  MessageResponse,
  ReaderPayload,
  SummarizeSelectionMessage,
  TranslationStreamEvent,
  WireExplainRequest,
  WireExplainResponse,
  WireNoteRequest,
  WireNoteResponse,
  WireSummaryRequest,
  WireSummaryResponse,
  WireTranslateRequest,
  WireTranslateResponse,
  WireUsageResponse,
} from '@/shared/types';

/**
 * Background Service Worker。
 *
 * 职责边界（方案第 86.7 节）：**无状态的请求转发层**。
 * 不持有队列、不做并发控制——调度唯一存在于 content script 的 `core/queue`。
 *
 * 之所以由 background 发起 HTTP 请求，是因为 content script 受页面 CSP 的
 * `connect-src` 限制，无法直接访问本地 FastAPI。
 *
 * 本模块只做两件事：
 *   1. 按需把 content script 注入当前标签页，并转发 `TRANSLATE_PAGE`
 *   2. 把 `FETCH_TRANSLATION` 的 payload 原样发给 FastAPI，回传响应
 *
 * **不做 camelCase ↔ snake_case 映射**——那是翻译语义，属于 content script。
 */

/**
 * Content script 在构建产物中的路径。
 *
 * 由 WXT 生成，实测产物为 `content-scripts/content.js`。
 * **该路径会随 WXT 版本变化**——升级 WXT 后需重新确认（升级后需重新确认）。
 */
const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';

/** 判断错误是否为「接收端不存在」，即 content script 尚未注入。 */
function isNoReceiverError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/i.test(text);
}

/**
 * 发送消息，必要时先注入 content script。
 *
 * 用 `sendMessage` 探测而非 `executeScript` 探测：已注入是常见路径，
 * 这样只需一次往返。
 */
async function sendWithLazyInject<T>(
  tabId: number,
  message: ExtensionMessage,
): Promise<MessageResponse<T>> {
  try {
    return await sendToTab<T>(tabId, message);
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE],
  });

  return await sendToTab<T>(tabId, message);
}

/**
 * 需要转发到当前标签页 content script 的消息类型。
 *
 * 这些都是「页面级操作」，background 只做无状态转发（方案第 86.7 节）。
 */
const TAB_MESSAGES: ReadonlySet<string> = new Set([
  'TRANSLATE_PAGE',
  'GET_PAGE_STATE',
  'SET_DISPLAY_MODE',
  'RESTORE_PAGE',
  'EXTRACT_READER',
  'EXPLAIN_SELECTION',
  'SUMMARIZE_PAGE',
  'SUMMARIZE_SELECTION',
]);

/**
 * 需要「按需注入」的消息类型。
 *
 * 这两条都需要页面里有 content script 才能干活：
 *   - `TRANSLATE_PAGE` —— 用户点「翻译当前页面」时页面可能还没注入过
 *   - `EXTRACT_READER` —— 阅读模式要在页面里跑 Readability，与是否翻译过无关
 *   - `EXPLAIN_SELECTION` —— 解释要在页面里读选区与上下文
 *
 * 其余命令若没有 content script，说明页面本来就没翻译过，直接报错更诚实，
 * 不该为了查个状态就注入脚本。
 */
const INJECTING_MESSAGES: ReadonlySet<string> = new Set([
  'TRANSLATE_PAGE',
  'EXTRACT_READER',
  'EXPLAIN_SELECTION',
  'SUMMARIZE_PAGE',
  'SUMMARIZE_SELECTION',
]);

/** 右键菜单项 ID（方案第 41 节）。 */
const EXPLAIN_MENU_ID = 'ai-web-translator-explain';

/** 总结选中内容的菜单项 ID（方案第 32 节第一层）。 */
const SUMMARIZE_MENU_ID = 'ai-web-translator-summarize';

/** 转发消息到当前活动标签页的 content script。 */
async function forwardToActiveTab<T>(message: ExtensionMessage): Promise<MessageResponse<T>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== 'number') {
    return { ok: false, error: '找不到活动标签页' };
  }

  if (INJECTING_MESSAGES.has(message.type)) {
    return await sendWithLazyInject<T>(tab.id, message);
  }

  try {
    return await sendToTab<T>(tab.id, message);
  } catch (error) {
    if (isNoReceiverError(error)) {
      return { ok: false, error: '当前页面尚未注入翻译脚本' };
    }
    throw error;
  }
}

/**
 * 处理 `FETCH_TRANSLATION`：把 payload 原样发给 FastAPI。
 *
 * 服务地址目前用默认值；Phase 13（Options）接入 `chrome.storage.local` 后改为可配置。
 */
async function handleFetchTranslation(
  payload: unknown,
): Promise<MessageResponse<WireTranslateResponse>> {
  try {
    const { serverUrl } = await loadSettings();
    const data = await requestTranslation(payload as Parameters<typeof requestTranslation>[0], {
      serverUrl,
    });
    return { ok: true, data };
  } catch (error) {
    const failure: MessageResponse<WireTranslateResponse> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };

    // 必须把 retryable 一并回传：core/queue 据此决定是否重试（方案第 73 节）。
    // 丢了它，网络错误与 429 都会被当成确定性失败而放弃重试。
    if (error instanceof ServerError) {
      failure.retryable = error.retryable;
    }

    return failure;
  }
}

/**
 * 流式翻译的 Port 名。
 *
 * **为什么用 Port 而不是 `sendMessage`**：消息通道是「一问一答」的语义，
 * 承载不了「服务端持续下发」；长连接 Port 可以多次 `postMessage`。
 * 方案第 86.9 节要求逐段下发，因此必须走 Port。
 */
const STREAM_PORT_NAME = 'ai-web-translator:translate-stream';

/**
 * 流式翻译中继：content script 连上后发一次 `{ payload }`，
 * background 逐条把后端事件 postMessage 回去。
 *
 * background 仍然**不做任何调度**（方案第 86.7 节）——
 * 它只负责把一条 HTTP 流搬过消息边界。
 */
function handleStreamPort(port: chrome.runtime.Port): void {
  let started = false;

  port.onMessage.addListener((message: unknown) => {
    // 只接受首条请求，避免同一个 Port 被重复使用导致并发流
    if (started || typeof message !== 'object' || message === null) {
      return;
    }

    const payload = (message as { payload?: unknown }).payload;
    if (payload === undefined) {
      return;
    }
    started = true;

    const post = (event: TranslationStreamEvent): void => {
      try {
        port.postMessage(event);
      } catch {
        // 端口已断开（content script 被卸载或页面跳走），丢弃即可
      }
    };

    void (async () => {
      // serverUrl 由设置决定，因此由 background 读取（它有 storage 访问权）
      const { serverUrl } = await loadSettings();
      await streamTranslation(payload as WireTranslateRequest, post, { serverUrl });
    })().catch((error: unknown) => {
      post({
        type: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

/**
 * 处理 `FETCH_HEALTH`：探测本地服务。
 *
 * content script 需要 `provider` / `model` / `promptVersion` 来算缓存键
 * （方案第 86.8 节），但它不能直接 fetch，所以同样经这里转发。
 */
async function handleFetchHealth(): Promise<MessageResponse<HealthResponse>> {
  try {
    const { serverUrl } = await loadSettings();
    return { ok: true, data: await requestHealth({ serverUrl }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 处理 `OPEN_READER_MODE`：存下正文并打开阅读视图页（方案第 62 节）。
 *
 * 正文由 content script 提取——background 拿不到页面 DOM。
 * 这里只做两件事：存载荷、开页面。
 */
async function handleOpenReader(payload: ReaderPayload): Promise<MessageResponse> {
  try {
    await storeReaderPayload(payload);
    await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html') });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 处理 `FETCH_EXPLAIN`：把解释请求转发给 FastAPI（方案第 41 节）。
 *
 * 与翻译一样，`retryable` 要一并回传——解释失败同样值得区分
 * 「网络抖动」与「参数不对」。
 */
async function handleFetchExplain(
  payload: WireExplainRequest,
): Promise<MessageResponse<WireExplainResponse>> {
  try {
    const { serverUrl } = await loadSettings();
    return { ok: true, data: await requestExplain(payload, { serverUrl }) };
  } catch (error) {
    const failure: MessageResponse<WireExplainResponse> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };

    if (error instanceof ServerError) {
      failure.retryable = error.retryable;
    }

    return failure;
  }
}

/**
 * 注册右键菜单（方案第 41 节）。
 *
 * 只在选中文字时出现（`contexts: ['selection']`）——没选中时菜单项没有意义。
 * 先 `removeAll` 再 `create`：扩展重载后旧菜单项会残留，不清理会出现重复项。
 */
function setupContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: EXPLAIN_MENU_ID,
      title: '用 AI 解释「%s」',
      contexts: ['selection'],
    });

    // 两个菜单项都只在选中文字时出现——没选中时它们都没有意义
    chrome.contextMenus.create({
      id: SUMMARIZE_MENU_ID,
      title: '总结选中的内容',
      contexts: ['selection'],
    });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (typeof tab?.id !== 'number') {
      return;
    }

    // 选区只有 content script 能读到，因此把活儿交给它
    if (info.menuItemId === EXPLAIN_MENU_ID) {
      void sendWithLazyInject(
        tab.id,
        createMessage<ExplainSelectionMessage>({ type: 'EXPLAIN_SELECTION' }),
      );
      return;
    }

    if (info.menuItemId === SUMMARIZE_MENU_ID) {
      void sendWithLazyInject(
        tab.id,
        createMessage<SummarizeSelectionMessage>({ type: 'SUMMARIZE_SELECTION' }),
      );
    }
  });
}

/**
 * 处理 `FETCH_SUMMARY`：把总结请求转发给 FastAPI（方案第 32 节）。
 *
 * 正文由 content script 用 Readability 提取后送来——服务端不接触页面 DOM。
 */
async function handleFetchSummary(
  payload: WireSummaryRequest,
): Promise<MessageResponse<WireSummaryResponse>> {
  try {
    const { serverUrl } = await loadSettings();
    return { ok: true, data: await requestSummary(payload, { serverUrl }) };
  } catch (error) {
    const failure: MessageResponse<WireSummaryResponse> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };

    if (error instanceof ServerError) {
      failure.retryable = error.retryable;
    }

    return failure;
  }
}

/**
 * 处理 `FETCH_NOTE`：把笔记请求转发给 FastAPI（方案第 32 节）。
 *
 * 与总结走同一条通道形态，只是端点与响应结构不同。
 */
async function handleFetchNote(
  payload: WireNoteRequest,
): Promise<MessageResponse<WireNoteResponse>> {
  // 与 content script 同理：上下文失效时碰存储会抛一条误导性的
  // "You must add the 'storage' permission" 报错，先自查。
  if (!isExtensionContextValid()) {
    return { ok: false, error: '扩展上下文已失效，请刷新页面后重试' };
  }

  try {
    const { serverUrl } = await loadSettings();
    return { ok: true, data: await requestNote(payload, { serverUrl }) };
  } catch (error) {
    const failure: MessageResponse<WireNoteResponse> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };

    if (error instanceof ServerError) {
      failure.retryable = error.retryable;
    }

    return failure;
  }
}

/**
 * 处理 `FETCH_USAGE`：读取服务端的累计用量（成本可见性）。
 *
 * 返回 token 数；金额由面板按用户填的单价算。
 */
async function handleFetchUsage(): Promise<MessageResponse<WireUsageResponse>> {
  try {
    const { serverUrl } = await loadSettings();
    return { ok: true, data: await requestUsage({ serverUrl }) };
  } catch (error) {
    const failure: MessageResponse<WireUsageResponse> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };

    if (error instanceof ServerError) {
      failure.retryable = error.retryable;
    }

    return failure;
  }
}

export default defineBackground(() => {
  console.info('[ReadMate] background service worker ready');

  setupContextMenus();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === STREAM_PORT_NAME) {
      handleStreamPort(port);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isExtensionMessage(message)) {
      return false;
    }

    if (TAB_MESSAGES.has(message.type)) {
      void forwardToActiveTab(message).then(sendResponse, (error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // 返回 true 保持消息通道开启，等待异步响应
      return true;
    }

    if (message.type === 'FETCH_TRANSLATION') {
      void handleFetchTranslation(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'FETCH_HEALTH') {
      void handleFetchHealth().then(sendResponse);
      return true;
    }

    if (message.type === 'OPEN_READER_MODE') {
      void handleOpenReader(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'FETCH_EXPLAIN') {
      void handleFetchExplain(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'FETCH_SUMMARY') {
      void handleFetchSummary(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'FETCH_NOTE') {
      void handleFetchNote(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'FETCH_USAGE') {
      void handleFetchUsage().then(sendResponse);
      return true;
    }

    return false;
  });
});
