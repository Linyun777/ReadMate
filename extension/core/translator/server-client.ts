/**
 * 本地 FastAPI 服务的 HTTP 客户端。
 *
 * ⚠️ **只能由 background 调用**（方案第 86.7 节）。
 * content script 运行在页面 origin 下，受页面 CSP 的 `connect-src` 限制，
 * 直接请求本地服务会在多数站点被阻断。
 */

import { API_BASE_PATH, DEFAULT_SERVER_URL } from '@/shared/constants';
import type {
  HealthResponse,
  TranslationStreamEvent,
  WireConfigResponse,
  WireConfigUpdate,
  WireExplainRequest,
  WireExplainResponse,
  WireNoteRequest,
  WireNoteResponse,
  WireSummaryRequest,
  WireSummaryResponse,
  WireUsageResponse,
} from '@/shared/types';

import {
  isWireTranslateResponse,
  type WireTranslateRequest,
  type WireTranslateResponse,
} from './wire';

/** 默认请求超时。翻译长文时可能较慢，给足时间。 */
const DEFAULT_TIMEOUT_MS = 120_000;

export class ServerError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ServerClientOptions {
  /** 服务地址，默认 `http://127.0.0.1:8000` */
  serverUrl?: string;
  timeoutMs?: number;
}

function buildUrl(serverUrl: string | undefined, path: string): string {
  const base = (serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
  return `${base}${API_BASE_PATH}${path}`;
}

/**
 * 判断 HTTP 状态码是否值得重试（方案第 73 节）。
 *
 * 429 与 5xx 可重试；**503 除外**——本项目里 503 只用于表示服务端配置缺失
 * （缺少 API Key / Base URL / Model），那是需要用户改配置的确定性错误，
 * 重试没有意义。
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 503);
}

/** 从错误响应里取出可读的 detail。 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const detail = (body as Record<string, unknown>).detail;
      if (typeof detail === 'string') {
        return detail;
      }
    }
  } catch {
    // 响应体不是 JSON，退回状态码说明
  }
  return `服务端返回 ${response.status}`;
}

/** 探测服务是否在线（方案第 16.1 节）。 */
export async function requestHealth(options: ServerClientOptions = {}): Promise<HealthResponse> {
  const url = buildUrl(options.serverUrl, '/health');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? error.message : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(await readErrorDetail(response), response.status, response.status >= 500);
  }

  return (await response.json()) as HealthResponse;
}

/**
 * 发起一次批量翻译请求。
 *
 * 失败时抛 `ServerError`。`retryable` 标明是否值得重试
 * （网络错误 / 429 / 5xx 为真，方案第 73 节）。
 */
export async function requestTranslation(
  payload: WireTranslateRequest,
  options: ServerClientOptions = {},
): Promise<WireTranslateResponse> {
  const url = buildUrl(options.serverUrl, '/translate');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (!isWireTranslateResponse(body)) {
    throw new ServerError('服务端返回的结构不符合约定', response.status, true);
  }

  return body;
}

/* ------------------------------------------------------------------ *
 * 解释（方案第 41 节）
 * ------------------------------------------------------------------ */

/**
 * 请求解释一段文字。
 *
 * 与翻译的差别：解释是自由文本，没有结构可校验，
 * 因此这里只做「响应非空」的判断。
 */
export async function requestExplain(
  payload: WireExplainRequest,
  options: ServerClientOptions = {},
): Promise<WireExplainResponse> {
  const url = buildUrl(options.serverUrl, '/explain');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { explanation?: unknown }).explanation !== 'string'
  ) {
    throw new ServerError('服务端返回的解释结构不符合约定', response.status, true);
  }

  return body as WireExplainResponse;
}

/* ------------------------------------------------------------------ *
 * 总结（方案第 32 节）
 * ------------------------------------------------------------------ */

/**
 * 请求总结一篇文章。
 *
 * 与翻译、解释一样只做「响应结构符合约定」的判断——
 * 业务语义（gist 是否为空、points 是否合法）由服务端负责。
 */
export async function requestSummary(
  payload: WireSummaryRequest,
  options: ServerClientOptions = {},
): Promise<WireSummaryResponse> {
  const url = buildUrl(options.serverUrl, '/summary');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { gist?: unknown }).gist !== 'string'
  ) {
    throw new ServerError('服务端返回的总结结构不符合约定', response.status, true);
  }

  return body as WireSummaryResponse;
}

/* ------------------------------------------------------------------ *
 * 学习笔记（方案第 32 节）
 * ------------------------------------------------------------------ */

/** 请求把一篇文章做成学习笔记。 */
export async function requestNote(
  payload: WireNoteRequest,
  options: ServerClientOptions = {},
): Promise<WireNoteResponse> {
  const url = buildUrl(options.serverUrl, '/note');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { positioning?: unknown }).positioning !== 'string'
  ) {
    throw new ServerError('服务端返回的笔记结构不符合约定', response.status, true);
  }

  return body as WireNoteResponse;
}

/* ------------------------------------------------------------------ *
 * 运行时配置（模型服务）
 * ------------------------------------------------------------------ */

/**
 * 读取服务端当前生效的 LLM 配置。
 *
 * **响应里没有 API Key** —— 只有一个 `hasApiKey` 布尔值。
 * 这个接口存在的意义是「让用户不用手工编辑 .env」，
 * 不是「让浏览器读取密钥」（铁律 1）。
 */
export async function requestConfig(
  options: ServerClientOptions = {},
): Promise<WireConfigResponse> {
  const url = buildUrl(options.serverUrl, '/config');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { baseUrl?: unknown }).baseUrl !== 'string'
  ) {
    throw new ServerError('服务端返回的配置结构不符合约定', response.status, true);
  }

  return body as WireConfigResponse;
}

/**
 * 更新服务端的 LLM 配置。
 *
 * 写的是服务端的 `.env`，**改完立即生效，无需重启服务**。
 * `apiKey` 留空表示不修改——用户可以只换地址和模型，不必重新粘贴密钥。
 */
export async function updateConfig(
  payload: WireConfigUpdate,
  options: ServerClientOptions = {},
): Promise<WireConfigResponse> {
  const url = buildUrl(options.serverUrl, '/config');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { baseUrl?: unknown }).baseUrl !== 'string'
  ) {
    throw new ServerError('服务端返回的配置结构不符合约定', response.status, true);
  }

  return body as WireConfigResponse;
}

/* ------------------------------------------------------------------ *
 * 用量（成本可见性）
 * ------------------------------------------------------------------ */

/**
 * 读取服务端的累计用量。
 *
 * 返回的是 **token 数，不是金额**——金额由调用方按自己掌握的单价算。
 */
export async function requestUsage(options: ServerClientOptions = {}): Promise<WireUsageResponse> {
  const url = buildUrl(options.serverUrl, '/usage');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { total_tokens?: unknown }).total_tokens !== 'number'
  ) {
    throw new ServerError('服务端返回的用量结构不符合约定', response.status, true);
  }

  return body as WireUsageResponse;
}

/* ------------------------------------------------------------------ *
 * 流式翻译（方案第 86.9 节）
 * ------------------------------------------------------------------ */

/** 校验并解析一行 NDJSON。非法行返回 null。 */
function parseStreamLine(line: string): TranslationStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

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
      reason: typeof record.reason === 'string' ? record.reason : '服务端未给出原因',
    };
  }

  return null;
}

/**
 * 发起流式翻译，**逐行**把事件交给 `onEvent`。
 *
 * 后端以 NDJSON 下发，这里按行切分。`TextDecoder` 用 `stream: true`，
 * 避免把一个多字节字符切在两个 chunk 之间时被解成乱码。
 *
 * 失败时抛 `ServerError`（保留 `retryable`）。已经回调过的事件不会撤回。
 */
export async function streamTranslation(
  payload: WireTranslateRequest,
  onEvent: (event: TranslationStreamEvent) => void,
  options: ServerClientOptions = {},
): Promise<void> {
  const url = buildUrl(options.serverUrl, '/translate/stream');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `无法连接本地服务：${error.message}` : '无法连接本地服务',
      undefined,
      true,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      await readErrorDetail(response),
      response.status,
      isRetryableStatus(response.status),
    );
  }

  const body = response.body;
  if (body === null) {
    throw new ServerError('服务端未返回流式响应体', response.status, true);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushLines = (): void => {
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);

      if (line !== '') {
        const event = parseStreamLine(line);
        if (event !== null) {
          onEvent(event);
        }
      }

      index = buffer.indexOf('\n');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      flushLines();
    }
  } catch (error) {
    throw new ServerError(
      error instanceof Error ? `流式传输中断：${error.message}` : '流式传输中断',
      undefined,
      true,
    );
  }

  // 末尾可能没有换行
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail !== '') {
    const event = parseStreamLine(tail);
    if (event !== null) {
      onEvent(event);
    }
  }
}
