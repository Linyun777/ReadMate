/**
 * 与 FastAPI 的线上格式（方案第 16.2、86.5 节）。
 *
 * 职责：
 *   1. 定义线上格式的类型（**snake_case**）
 *   2. 在扩展内部的 camelCase 与线上 snake_case 之间转换
 *
 * 为什么要有这一层：线上格式遵循方案第 16.2 / 86.5 节的示例（snake_case），
 * 而 TS 侧按惯例用 camelCase。把映射集中在这里，而不是让两侧各猜一半。
 *
 * 本文件是**纯函数**，不发请求——I/O 在 `server-client.ts`。
 */

import type {
  TranslationItem,
  TranslationRequest,
  TranslationResponse,
  TranslationResult,
  WireTranslateRequest,
  WireTranslateResponse,
  WireTranslationItem,
  WireTranslationResult,
} from '@/shared/types';

// 类型定义在 shared/types.ts（需同时被 content script 与 background 使用），
// 这里再导出一次，让本模块的消费者只需 import 一处。
export type {
  WireTranslateRequest,
  WireTranslateResponse,
  WireTranslationItem,
  WireTranslationResult,
};

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

export function toWireItem(item: TranslationItem): WireTranslationItem {
  return { id: item.id, text: item.text };
}

export function toWireRequest(request: TranslationRequest): WireTranslateRequest {
  const wire: WireTranslateRequest = {
    source_language: request.sourceLanguage,
    target_language: request.targetLanguage,
    style: request.style,
    items: request.items.map(toWireItem),
  };

  // 只在有值时带上，避免把 undefined 序列化成 null
  if (request.contextId !== undefined) {
    wire.context_id = request.contextId;
  }
  if (request.context !== undefined) {
    wire.context = request.context;
  }

  return wire;
}

export function fromWireResult(result: WireTranslationResult): TranslationResult {
  return { id: result.id, source: result.source, translation: result.translation };
}

export function fromWireResponse(response: WireTranslateResponse): TranslationResponse {
  const mapped: TranslationResponse = {
    promptVersion: response.prompt_version,
    model: response.model,
    items: response.items.map(fromWireResult),
  };

  if (response.context_id !== null) {
    mapped.contextId = response.context_id;
  }

  return mapped;
}

/* ------------------------------------------------------------------ *
 * 防御性解析
 * ------------------------------------------------------------------ */

/**
 * 校验从服务端拿到的响应结构。
 *
 * 服务端已经做过校验，但这是扩展侧的最后一道防线——
 * 拿不到 `items` 数组时宁可明确失败，也不要让后续代码拿到 undefined。
 */
export function isWireTranslateResponse(value: unknown): value is WireTranslateResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.items)) {
    return false;
  }
  if (typeof candidate.prompt_version !== 'string' || typeof candidate.model !== 'string') {
    return false;
  }

  return candidate.items.every((item) => {
    if (typeof item !== 'object' || item === null) {
      return false;
    }
    const entry = item as Record<string, unknown>;
    return (
      typeof entry.id === 'string' &&
      typeof entry.source === 'string' &&
      typeof entry.translation === 'string'
    );
  });
}
