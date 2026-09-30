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

/**
 * 交互控件的 ARIA `role` 取值。
 *
 * `BUTTON` 标签由 `IGNORED_TAGS` 覆盖；这里补的是**属性**判定，
 * 用来命中 `<div role="button">Copy page</div>` 这类自定义控件——
 * 文档站与组件库大量使用它们，标签名看不出是控件。
 *
 * ## 为什么整类跳过，而不是「只有短文本才跳过」
 *
 * 交互控件里的文字是**操作标签**（`Copy page` / `Sign in` / tab 名），
 * 不是正文。用长度阈值（如「短于 N 字符才跳过」）会引入一个新的、
 * 无法预测的误杀边界：多一个字就可能从「跳过」变成「翻译」。
 * 按控件类型判定，行为是确定的。
 *
 * ⚠️ **刻意不含 `link`**：`<a>` / `role="link"` 是正文的一部分
 * （「读一下<a>文档</a>」），必须照常翻译。
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'checkbox',
  'radio',
  'option',
  'combobox',
]);

/** 需要保留 CSS 换行语义的 `white-space` 取值。 */
export const PRESERVE_NEWLINE_WHITESPACE: ReadonlySet<string> = new Set([
  'pre',
  'pre-wrap',
  'pre-line',
  'break-spaces',
]);

/* ------------------------------------------------------------------ *
 * 拆大块（方案第 57 节）
 * ------------------------------------------------------------------ */

/**
 * 容器文本超过这个长度就拆成多段。
 *
 * ## 为什么必须拆
 *
 * 实测（docs.langchain.com）：一个 3128 字符的 `<div>`（42 个行内占位符）
 * 会生成约 1500 字符译文 ≈ 1000+ output token。Block 是**原子单位**，
 * 整块一次性到达——用户盯着空白等 40–50 秒才看到第一段。
 * 拆段后每段译文短，**先到的先渲染**。
 *
 * ## 为什么是 1000
 *
 * 文档站的正常段落多在 200–600 字符。1000 是「明显过长」的量级；
 * 低于它的容器不该被无谓地切开（多切一段就多一份请求开销与上下文重复）。
 */
export const SPLIT_BLOCK_THRESHOLD_CHARS = 1000;

/**
 * 拆块后每段的目标字符数。
 *
 * 越短首屏越快，代价是请求条数变多、每段都要重复带一遍上下文。
 * 500 字符 ≈「几秒出结果」的量级。
 */
export const BLOCK_CHUNK_TARGET_CHARS = 500;

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
