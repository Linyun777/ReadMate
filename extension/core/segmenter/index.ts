/**
 * DOM Segmenter：DOM → TranslationBlock（方案第 55、56 节）。
 *
 * 职责边界：
 *   - 本模块**只读** DOM，不做任何写入
 *   - 输出 `TranslationBlock[]`，交给 `core/translator` 打包成 Batch
 *
 * 占位符方案见方案第 86.1 节；过滤规则见方案第 9.3、9.4 节与
 * 参考研究结论。
 */

export {
  findBlockContainer,
  type SegmentOptions,
  segmentDocument,
  segmentElement,
} from './blocks';
export {
  ATOMIC_TAGS,
  BLOCK_TAGS,
  classifyBlock,
  IGNORED_TAG_SET,
  PRESERVE_NEWLINE_WHITESPACE,
} from './constants';
export {
  hasIgnoredAncestor,
  isCodeContainer,
  isEditable,
  isHidden,
  isIgnoredElement,
  isInteractiveControl,
  isTooShort,
  looksLikeTargetLanguage,
  shouldSkipElement,
  shouldTranslateText,
} from './filters';
export { buildPlaceholderText, type PlaceholderResult, validatePlaceholders } from './placeholders';
