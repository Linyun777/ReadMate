/**
 * 阅读模式（方案第 62 节）。
 *
 * 用 Mozilla Readability 提取正文，渲染到**独立阅读视图**——
 * 原页面 DOM 一个节点都不动。
 */

export {
  DEFAULT_MIN_TEXT_LENGTH,
  type ExtractedArticle,
  type ExtractOptions,
  extractArticle,
} from './extract-article';
export {
  clearReaderPayload,
  loadReaderPayload,
  type SessionStorageLike,
  storeReaderPayload,
} from './reader-store';
export { mountArticle, sanitizeArticle } from './sanitize';
