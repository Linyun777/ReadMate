import { PageController } from '@/core/controller';
import { ExplainOverlay, readSelection } from '@/core/explain';
import { sendToBackground } from '@/core/messaging/client';
import { createMessage, isExtensionMessage } from '@/core/messaging/protocol';
import { extractArticle } from '@/core/reader';
import { loadSettings } from '@/core/settings';
import { downloadMarkdown } from '@/core/summary';
import { CONTENT_SCRIPT_FLAG } from '@/shared/constants';
import { CONTEXT_INVALIDATED_MESSAGE, isExtensionContextValid } from '@/shared/extension-context';
import type {
  ContentScriptState,
  ExtensionMessage,
  FetchExplainMessage,
  FetchSummaryMessage,
  MessageResponse,
  OpenReaderMessage,
  WireExplainResponse,
  WireSummaryResponse,
} from '@/shared/types';

/**
 * Content Script。
 *
 * 采用**运行时注册**（见 `wxt.config.ts` 的 `registration: 'runtime'`）：
 * WXT 不会把它写进 manifest，因此无需申请 `<all_urls>` 权限（方案第 22 节）。
 *
 * 注入方式（由 `entrypoints/background.ts` 执行）：
 *
 *   chrome.scripting.executeScript({
 *     target: { tabId },
 *     files: ['content-scripts/content.js'],
 *   });
 *
 * 使用 `executeScript` + `activeTab`，**不要**用 `registerContentScripts`——
 * 后者要求 host 权限，会破坏最小权限原则。
 *
 * 本文件是**组合根**：把消息翻译成 `PageController` 的调用，本身不含业务算法。
 * 分段 / 翻译 / 渲染的编排在 `core/controller`。
 */

function describe(controller: PageController): ContentScriptState {
  const snapshot = controller.snapshot();
  return {
    state: snapshot.state,
    title: document.title,
    mode: snapshot.mode,
    stats: snapshot.stats,
  };
}

/**
 * 用设置构造控制器（方案第 39 节）。
 *
 * `serverUrl` 不在这里用——翻译请求由 background 发出，
 * 它自己会读设置。content script 只需要语言与风格。
 */
/** 设置读一次就够了，解释请求要用到目标语言。 */
let cachedSettings: Awaited<ReturnType<typeof loadSettings>> | null = null;

/** 浮层单例：同一时刻只该有一个解释面板。 */
let overlay: ExplainOverlay | null = null;

function getOverlay(): ExplainOverlay {
  overlay ??= new ExplainOverlay();
  return overlay;
}

async function createController(): Promise<PageController> {
  const settings = await loadSettings();
  cachedSettings = settings;

  const controller = new PageController({
    targetLanguage: settings.targetLanguage,
    style: settings.style,
  });

  controller.setMode(settings.displayMode);

  return controller;
}

/**
 * content script 可能回两种数据：
 *   - 页面状态（绝大多数命令）
 *   - 总结结果（ 要把结构化数据交回给调用方）
 */
type ContentScriptResponse = MessageResponse<ContentScriptState | WireSummaryResponse>;

async function handleMessage(
  controller: PageController,
  message: ExtensionMessage,
  sendResponse: (response: ContentScriptResponse) => void,
): Promise<void> {
  const okWithState = (): void => {
    sendResponse({ ok: true, data: describe(controller) });
  };

  switch (message.type) {
    case 'GET_PAGE_STATE':
      okWithState();
      return;

    case 'SET_DISPLAY_MODE':
      controller.setMode(message.mode);
      okWithState();
      return;

    case 'RESTORE_PAGE':
      controller.restore();
      okWithState();
      return;

    case 'TRANSLATE_PAGE':
      await controller.translate();
      okWithState();
      return;

    case 'EXPLAIN_SELECTION': {
      // 选区与上下文只有页面上下文能读到
      const info = readSelection(document, {
        ...(controller.adapter.extraBlockTags === undefined
          ? {}
          : { extraBlockTags: controller.adapter.extraBlockTags }),
      });

      if (info === null) {
        sendResponse({ ok: false, error: '没有选中可解释的文字' });
        return;
      }

      const panel = getOverlay();
      panel.open(info.rect);

      const response = await sendToBackground<WireExplainResponse>(
        createMessage<FetchExplainMessage>({
          type: 'FETCH_EXPLAIN',
          payload: {
            selection: info.selection,
            context: info.context,
            language: cachedSettings?.targetLanguage ?? 'zh-CN',
            url: document.location.href,
          },
        }),
      );

      if (response.ok && response.data !== undefined) {
        panel.fill(response.data.explanation);
        sendResponse({ ok: true });
      } else {
        const reason = response.error ?? '未知错误';
        panel.fail(reason);
        sendResponse({ ok: false, error: reason });
      }
      return;
    }

    case 'SUMMARIZE_SELECTION': {
      // 与「总结整页」共用服务端与 Prompt，差别只在**取哪段文字**：
      // 这里用用户选中的部分，不碰 Readability。
      const info = readSelection(document);

      if (info === null) {
        sendResponse({ ok: false, error: '没有选中可总结的内容' });
        return;
      }

      const panel = getOverlay();
      panel.open(info.rect);
      panel.fill('正在总结…');

      const summary = await sendToBackground<WireSummaryResponse>(
        createMessage<FetchSummaryMessage>({
          type: 'FETCH_SUMMARY',
          payload: {
            // 只发选中的部分——用户要的是「总结这条推文」，
            // 不是「总结这页里和推文有关的东西」
            text: info.selection,
            title: document.title.trim(),
            language: cachedSettings?.targetLanguage ?? 'zh-CN',
            url: document.location.href,
          },
        }),
      );

      if (summary.ok && summary.data !== undefined) {
        const data = summary.data;

        panel.showSummary({ gist: data.gist, points: data.points }, () => {
          const filename = downloadMarkdown(
            {
              gist: data.gist,
              points: data.points,
              source: info.selection,
              url: document.location.href,
              title: document.title.trim() || '页面总结',
              model: data.model,
              exportedAt: new Date().toISOString(),
            },
            document,
          );

          panel.note(`已导出 ${filename}`);
        });

        sendResponse({ ok: true, data });
      } else {
        const reason = summary.error ?? '总结失败';
        panel.fail(reason);
        sendResponse({ ok: false, error: reason });
      }
      return;
    }

    case 'SUMMARIZE_PAGE': {
      // 与阅读模式一样：正文只有页面上下文能提取，服务端不接触 DOM
      const article = extractArticle(document);

      if (article === null) {
        sendResponse({ ok: false, error: '这个页面没有提取到可总结的正文' });
        return;
      }

      const summary = await sendToBackground<WireSummaryResponse>(
        createMessage<FetchSummaryMessage>({
          type: 'FETCH_SUMMARY',
          payload: {
            text: article.text,
            title: article.title,
            language: cachedSettings?.targetLanguage ?? 'zh-CN',
            url: article.url,
          },
        }),
      );

      if (summary.ok && summary.data !== undefined) {
        sendResponse({ ok: true, data: summary.data });
      } else {
        sendResponse({ ok: false, error: summary.error ?? '总结失败' });
      }
      return;
    }

    case 'EXTRACT_READER': {
      // 阅读模式必须在页面里提取——background 拿不到 DOM。
      // 提取在克隆文档上跑，原页面一个节点都不动（方案第 62 节）。
      const article = extractArticle(document);

      if (article === null) {
        sendResponse({ ok: false, error: '这个页面没有提取到可读的正文' });
        return;
      }

      const opened = await sendToBackground(
        createMessage<OpenReaderMessage>({
          type: 'OPEN_READER_MODE',
          payload: {
            title: article.title,
            content: article.content,
            text: article.text,
            url: article.url,
          },
        }),
      );

      sendResponse(
        opened.ok ? { ok: true } : { ok: false, error: opened.error ?? '打开阅读视图失败' },
      );
      return;
    }

    default:
      sendResponse({ ok: false, error: `content script 不支持的消息：${message.type}` });
  }
}

/**
 * 上下文已失效时的处理。
 *
 * 失效后 `chrome.storage` 是 `undefined`，WXT 的 storage 适配器会抛一条
 * **极具误导性**的报错（"You must add the 'storage' permission"），
 * 让人以为是 manifest 配错了。所以在碰任何存储之前先自查。
 */
function bailIfContextInvalidated(): boolean {
  if (isExtensionContextValid()) {
    return false;
  }

  console.warn(`[ReadMate] ${CONTEXT_INVALIDATED_MESSAGE}`);
  return true;
}

export default defineContentScript({
  /**
   * 刻意留空。
   *
   * 本脚本通过 `activeTab` + `scripting.executeScript` 按需注入，
   * **不预先声明任何页面匹配范围**（方案第 22 节：避免申请 `<all_urls>`）。
   *
   * 注意：WXT 会把 `matches` 合并进 manifest 的 `host_permissions`。
   * 若此处填 `['<all_urls>']`，构建产物会带上 `<all_urls>` 主机权限，
   * 破坏最小权限原则。置空即可避免——注入能力由 `activeTab` 提供，
   * 与 `matches` 无关。
   */
  matches: [],
  registration: 'runtime',
  main() {
    // 上下文可能已经失效（扩展刚被重新加载，而这个页面还开着）。
    // 此时碰任何存储都会抛一条误导性的报错，先自查。
    if (bailIfContextInvalidated()) {
      return;
    }

    // ⚠️ **同一个页面可能被注入两次**，必须自己挡住第二次。
    //
    // 注入是「按需」的（`sendWithLazyInject`）：两条消息同时发现接收端不存在，
    // 就会各注入一次；用户重复点「翻译当前页面」也可能落到这一步。
    // 没有这个保护会同时跑起**两个 PageController**——各自有自己的 store、
    // renderer 与 MutationObserver，一条 `TRANSLATE_PAGE` 两个实例都处理，
    // 于是每个容器渲染出两份译文：用户看到的就是「同一段被翻了两遍」
    // （实测在 Mintlify 文档站上稳定复现，见 `OPEN_ISSUES.md`）。
    //
    // 标记在**隔离世界**里，扩展重新加载后随世界一起消失，所以不会误挡新实例。
    const globalScope = globalThis as unknown as Record<string, unknown>;
    if (globalScope[CONTENT_SCRIPT_FLAG] === true) {
      console.info('[ReadMate] content script 已在运行，跳过重复注入');
      return;
    }
    globalScope[CONTENT_SCRIPT_FLAG] = true;

    // 设置是异步读取的，但消息监听必须**同步注册**——
    // 注入与随后的 TRANSLATE_PAGE 之间没有等待的余地。
    // 因此先把控制器包成一个 Promise，各处理器 await 它。
    const ready = createController();

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isExtensionMessage(message)) {
        return false;
      }

      // 注入时上下文是好的，但处理消息时可能已经失效（用户中途刷新了扩展）。
      // 这里回一个能看懂的提示，而不是让它抛 WXT 那条误导性报错。
      if (bailIfContextInvalidated()) {
        sendResponse({ ok: false, error: CONTEXT_INVALIDATED_MESSAGE });
        return false;
      }

      void ready
        .then((controller) => handleMessage(controller, message, sendResponse))
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      // 保持消息通道开启，等待异步响应
      return true;
    });

    console.info('[ReadMate] content script ready');
  },
});
