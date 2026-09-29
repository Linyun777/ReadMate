/**
 * Segmenter 内部常量。
 */

import { IGNORED_TAGS } from '@/shared/constants';

/** `IGNORED_TAGS` 的 Set 形式，用于 O(1) 判定。 */
export const IGNORED_TAG_SET: ReadonlySet<string> = new Set(IGNORED_TAGS);

/**
 * 块级元素白名单。
 *
 * 用途：把文本节点按「最近的块级祖先」分组，一个祖先对应一个 `TranslationBlock`。
 *
 * 两点说明：
 *
 * 1. **刻意不含 `BODY` / `HTML`。** 若某段文本的最近块级祖先是 body，
 *    说明它是裸露文本，此时退化为以直接父元素为容器（见 `blocks.ts`）。
 * 2. **刻意不含纯容器标签**（`TABLE` / `TBODY` / `TR` / `UL` / `OL` / `DL` / `FORM` / `FIELDSET`）。
 *    它们几乎不直接包含文本；排除后划分更精确。
 * 3. **用标签名白名单而非 `getComputedStyle().display`。** 这样划分结果可预测，
 *    也能在 jsdom 中测试。
 */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'LI',
  'MAIN',
  'NAV',
  'P',
  'SECTION',
  'SUMMARY',
  'TD',
  'TH',
]);

/**
 * 原子占位符标签。
 *
 * 这些元素本身没有可翻译文本，但占据文档中的一个位置，必须原样保留。
 * 与 `IGNORED_TAGS` 的区别：`IGNORED_TAGS` 是「内容不翻译」，
 * 这里是「没有内容但结构要留」。
 */
export const ATOMIC_TAGS: ReadonlySet<string> = new Set([
  'AUDIO',
  'BR',
  'EMBED',
  'HR',
  'IFRAME',
  'IMG',
  'INPUT',
  'OBJECT',
  'PICTURE',
  'SOURCE',
  'TRACK',
  'VIDEO',
  'WBR',
]);

/** 需要保留 CSS 换行语义的 `white-space` 取值。 */
export const PRESERVE_NEWLINE_WHITESPACE: ReadonlySet<string> = new Set([
  'pre',
  'pre-wrap',
  'pre-line',
  'break-spaces',
]);

/**
 * 按标签名判定 Block 类型（方案第 56 节的 `blockType`）。
 *
 * 该字段决定双语模式下如何渲染（方案第 86.2 节）：
 * `heading` / `paragraph` / `list` 追加兄弟节点，`table` 写入单元格，
 * `inline` 不渲染双语。
 */
export function classifyBlock(
  tagName: string,
): 'heading' | 'paragraph' | 'list' | 'table' | 'inline' {
  if (/^H[1-6]$/.test(tagName)) {
    return 'heading';
  }
  if (tagName === 'LI' || tagName === 'DT' || tagName === 'DD') {
    return 'list';
  }
  if (tagName === 'TD' || tagName === 'TH' || tagName === 'CAPTION') {
    return 'table';
  }
  return 'paragraph';
}
