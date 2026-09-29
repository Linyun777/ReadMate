/**
 * 跨模块共享常量。
 *
 * 数值依据：方案第 86.6 节（Batch 预算）、第 86.7 节（并发）、第 86.2 节（双语节点标记）。
 */

import type { DisplayMode, TranslationStyle } from './types';

/* ------------------------------------------------------------------ *
 * 服务端
 * ------------------------------------------------------------------ */

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
export const API_BASE_PATH = '/api/v1';

/* ------------------------------------------------------------------ *
 * 默认配置
 * ------------------------------------------------------------------ */

export const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
export const DEFAULT_SOURCE_LANGUAGE = 'auto';
export const DEFAULT_STYLE: TranslationStyle = 'natural';
export const DEFAULT_DISPLAY_MODE: DisplayMode = 'bilingual';

/* ------------------------------------------------------------------ *
 * Batch 与并发（方案第 86.6、86.7 节）
 * ------------------------------------------------------------------ */

/** 单批次字符上限。以字符预算为主导 */
export const MAX_CHARS_PER_BATCH = 24000;

/** 单批次条目上限。仅作兜底，防止大量极短 Block 抬高 JSON 信封开销 */
export const MAX_ITEMS_PER_BATCH = 30;

/** 每个条目的 JSON 信封开销，用于权重计算 */
export const ITEM_ENVELOPE_OVERHEAD = 64;

/* ------------------------------------------------------------------ *
 * 调度（方案第 86.7 节：唯一调度点在 content script 的 core/queue）
 * ------------------------------------------------------------------ */

/** 默认并发请求数。云端 API 可承受更高，但需保留对 429 的退避空间 */
export const DEFAULT_CONCURRENCY = 3;

/** 并发数下限与上限（方案第 86.7 节：范围 1–5） */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 5;

/**
 * 批次级重试次数上限（方案第 73 节：最多 1~2 次，禁止无限重试）。
 *
 * 降级为单条重试时也使用同一上限。
 */
export const DEFAULT_MAX_RETRIES = 2;

/** 重试退避基数（毫秒）。按 2 的幂增长：500ms、1000ms */
export const RETRY_BASE_DELAY_MS = 500;

/** 超过此长度的文章，上下文按章节切分而非全篇共享 */
export const MAX_ARTICLE_CONTEXT_CHARS = 8000;

/* ------------------------------------------------------------------ *
 * 阅读模式（方案第 62 节）
 * ------------------------------------------------------------------ */

/** `chrome.storage.session` 中存放待渲染正文的键 */
export const READER_STORAGE_KEY = 'readerPayload';

/* ------------------------------------------------------------------ *
 * 设置（方案第 39 节）
 * ------------------------------------------------------------------ */

/** `chrome.storage.local` 中设置的存储键 */
export const SETTINGS_STORAGE_KEY = 'settings';

/* ------------------------------------------------------------------ *
 * 缓存（方案第 86.8 节）
 * ------------------------------------------------------------------ */

/** 缓存条目上限。5000 条按平均 200 字符估算约 1 MB，在 storage.local 配额内 */
export const CACHE_MAX_ENTRIES = 5000;

/** 缓存过期天数 */
export const CACHE_TTL_DAYS = 30;

/** `chrome.storage.local` 中缓存键的前缀 */
export const CACHE_KEY_PREFIX = 'tc:';

/** 导出文件格式版本 */
export const CACHE_DUMP_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 消息
 * ------------------------------------------------------------------ */

/**
 * 扩展内部消息的来源标识。
 *
 * 用于把扩展自身的消息与页面脚本可能发来的任意消息区分开。
 * 类型定义见 `shared/types.ts` 的 `BaseMessage.source`。
 */
export const MESSAGE_SOURCE = 'ai-web-translator';

/**
 * 流式翻译使用的长连接 Port 名（方案第 86.9 节）。
 *
 * 消息通道是「一问一答」，承载不了「服务端持续下发」，因此单独走 Port。
 * content script 与 background 必须用同一个名字。
 */
export const STREAM_PORT_NAME = 'ai-web-translator:translate-stream';

/* ------------------------------------------------------------------ *
 * DOM 标记
 * ------------------------------------------------------------------ */

/** 插件自身插入的节点统一带此属性，供 MutationObserver 忽略（方案第 13.2 节） */
export const PLUGIN_NODE_ATTR = 'data-ai-translator';

/** content script 注入后写入的探测标记，供 E2E 断言 */
export const CONTENT_SCRIPT_FLAG = '__AI_TRANSLATOR_LOADED__';

/**
 * 被忽略、不参与翻译的标签（方案第 9.3 节）。
 *
 * ⚠️ **`CODE` / `KBD` / `SAMP` 刻意不在这个表里。**
 *
 * 它们装的是**行内**的标识符与代码（`useState()`、`npm i`），
 * 属于所在句子的一部分。放进忽略表会让它们变成**原子占位符 `<0/>`**——
 * 元素保住了，但**内容不发给模型**，模型看到的是一个空占位符，
 * 于是经常直接丢掉它，译文里就少了那个函数名。
 *
 * 现在的处理：
 *   - 行内 → 当普通内联元素，用**成对占位符** `<0>useState()</0>`
 *     （模型看得到内容，能自然放置，也不会丢）
 *   - 块级 → `isCodeContainer()`（等宽 + 块级）整体跳过
 *
 * `PRE` 仍然在表里：预格式化文本永远不该翻译，无论行内还是块级。
 */
export const IGNORED_TAGS: readonly string[] = [
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'CANVAS',
  'PRE',
];
