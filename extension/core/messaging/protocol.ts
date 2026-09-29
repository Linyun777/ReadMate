/**
 * 消息协议。
 *
 * 依据：方案第 8.1 节（Popup 只发命令）、第 55 节（messaging 模块）、第 86.7 节（单一调度点）。
 *
 * 约定：
 *   - 所有消息带 `source` 字段，用于把扩展内部消息与页面自身的 postMessage 区分开
 *     （与方案第 13.2 节用 `data-ai-translator` 标记插件节点的思路一致）
 *   - 所有消息带 `requestId`，便于后续做请求追踪与去重
 *   - 消息类型定义集中在 `shared/types.ts`，本文件只负责构造与校验，不重复定义
 */

import { MESSAGE_SOURCE } from '@/shared/constants';
import type { ExtensionMessage } from '@/shared/types';

let fallbackCounter = 0;

/**
 * 生成请求 ID。
 *
 * 优先使用 `crypto.randomUUID`；在不提供该 API 的上下文（如某些 file:// 页面）
 * 退化为「时间戳 + 计数器」。
 */
function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `req-${Date.now().toString(36)}-${fallbackCounter}`;
}

/**
 * 构造一条扩展消息。
 *
 * 用法：
 *
 *   const message = createMessage<TranslatePageMessage>({ type: 'TRANSLATE_PAGE' });
 */
export function createMessage<T extends ExtensionMessage>(
  message: Omit<T, 'source' | 'requestId'>,
): T {
  return {
    ...message,
    source: MESSAGE_SOURCE,
    requestId: createRequestId(),
  } as T;
}

/**
 * 校验来源是否为本扩展的消息。
 *
 * 用于消息监听器的第一道过滤——页面脚本可能向扩展发送任意消息，
 * 只处理带正确 `source` 的。
 */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.source === MESSAGE_SOURCE &&
    typeof candidate.type === 'string' &&
    typeof candidate.requestId === 'string'
  );
}
