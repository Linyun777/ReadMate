/**
 * 流式翻译的 content script 侧客户端（方案第 86.9 节）。
 *
 * 与 `core/messaging/client.ts` 的区别：那里是「一问一答」，
 * 这里需要 background **持续回传**，因此走长连接 Port。
 *
 * 为什么 content script 不直接 fetch 流式接口：它运行在页面 origin 下，
 * 受页面 CSP 的 `connect-src` 限制，在多数网站会被直接阻断
 * （方案第 86.7 节）。
 */

import { STREAM_PORT_NAME } from '@/shared/constants';
import type {
  StreamTranslationRequest,
  TranslationStreamEvent,
  TranslationStreamSink,
} from '@/shared/types';

/** 校验 background 回传的事件结构。非法时返回 null。 */
function parseEvent(message: unknown): TranslationStreamEvent | null {
  if (typeof message !== 'object' || message === null) {
    return null;
  }

  const record = message as Record<string, unknown>;

  if (record.type === 'item') {
    if (
      typeof record.id === 'string' &&
      typeof record.source === 'string' &&
      typeof record.translation === 'string'
    ) {
      return {
        type: 'item',
        id: record.id,
        source: record.source,
        translation: record.translation,
      };
    }
    return null;
  }

  if (record.type === 'done') {
    return {
      type: 'done',
      prompt_version: typeof record.prompt_version === 'string' ? record.prompt_version : '',
      model: typeof record.model === 'string' ? record.model : '',
    };
  }

  if (record.type === 'error') {
    return {
      type: 'error',
      reason: typeof record.reason === 'string' ? record.reason : '未给出原因',
    };
  }

  return null;
}

/**
 * 发起一次流式翻译。
 *
 * 事件边到边交给 `sink`；返回的句柄可用来取消（断开 Port）。
 */
export const streamTranslationViaBackground: StreamTranslationRequest = (
  payload,
  sink: TranslationStreamSink,
) => {
  const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });

  port.onMessage.addListener((message: unknown) => {
    const event = parseEvent(message);
    if (event === null) {
      return;
    }

    if (event.type === 'item') {
      sink.onItem({ id: event.id, source: event.source, translation: event.translation });
      return;
    }

    if (event.type === 'done') {
      sink.onDone({ promptVersion: event.prompt_version, model: event.model });
      return;
    }

    sink.onError(event.reason);
  });

  port.postMessage({ payload });

  return {
    cancel(): void {
      try {
        port.disconnect();
      } catch {
        // 端口已断开，无需处理
      }
    },
  };
};
