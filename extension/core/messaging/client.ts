/**
 * 消息发送封装。
 *
 * 依据方案第 86.7 节的职责划分：
 *
 *   - **content script 是唯一调度点**（并发、排队、重试）
 *   - **background 是无状态转发层**——它不排队、不做并发控制，
 *     只负责「把请求发出去」与「把 content script 注入进去」
 *
 * 注意：真正的 HTTP 请求只能由 background 发出。content script 运行在页面 origin 下，
 * 受页面 CSP 的 `connect-src` 限制，直接访问本地 FastAPI 会在多数站点被阻断。
 */

import type { ExtensionMessage, MessageResponse } from '@/shared/types';

/** 发往 background。Popup 与 Content Script 均可使用。 */
export async function sendToBackground<T = unknown>(
  message: ExtensionMessage,
): Promise<MessageResponse<T>> {
  return (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
}

/** 发往指定标签页的 content script。仅 background 使用。 */
export async function sendToTab<T = unknown>(
  tabId: number,
  message: ExtensionMessage,
): Promise<MessageResponse<T>> {
  return (await chrome.tabs.sendMessage(tabId, message)) as MessageResponse<T>;
}
