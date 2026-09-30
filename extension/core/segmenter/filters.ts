/**
 * 节点与文本过滤规则。
 *
 * 依据：
 *   - 方案第 9.3 节（忽略节点）
 *   - 方案第 9.4 节（忽略特殊文本）
 *   - 参考研究结论（目标语言检测、脚本感知长度规则、可编辑字段）
 */

import { IGNORED_TAG_SET, INTERACTIVE_ROLES } from './constants';

/* ------------------------------------------------------------------ *
 * 元素级过滤
 * ------------------------------------------------------------------ */

/**
 * 元素是否不可见。
 *
 * 同时检查 `hidden` 属性、`aria-hidden` 与计算样式。
 * 计算样式不可用时（如极简 DOM 环境）只依赖前两项。
 */
export function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) {
    return true;
  }
  if (element.getAttribute('aria-hidden') === 'true') {
    return true;
  }

  if (typeof getComputedStyle !== 'function') {
    return false;
  }

  const style = getComputedStyle(element);
  return style.display === 'none' || style.visibility === 'hidden';
}

/* ------------------------------------------------------------------ *
 * 代码容器识别
 * ------------------------------------------------------------------ */

/**
 * 字体族里是否含等宽字体。
 *
 * 覆盖常见写法：通用的 `monospace`，以及各平台/编辑器的具体字体名。
 */
const MONOSPACE_FONT =
  /monospace|\bmono\b|menlo|consolas|courier|sfmono|sf mono|fira ?code|jetbrains|roboto ?mono|source ?code|ubuntu ?mono|inconsolata|hack|iosevka/i;

/**
 * 元素是否为**代码容器**（应整体跳过）。
 *
 * ## 为什么不能只认 `PRE` / `CODE`
 *
 * React 官方文档这类站点用 **Sandpack** 渲染代码：不是 `<pre><code>`，
 * 而是每行一个 `<div>`、每个 token 一个 `<span>`，靠 CSS 高亮。
 * 只认标签的话它们**完全绕过**跳过规则 → 一行代码一个 Block →
 * 整页几千条，而且都在翻译 `const` / `return` 这种词。
 *
 * ## 判据：等宽字体 + 块级显示
 *
 * - **等宽**是代码的排版特征，与用什么标签、什么框架无关
 * - **块级**这一条是必须的：行内等宽是 `<p>用 <code>x</code> 表示变量</p>`
 *   里的 `x`，它属于正文的一部分。整段跳过会把正常段落也误杀
 *
 * ## 为什么用 WeakMap 缓存
 *
 * `hasIgnoredAncestor` 会对**每个文本节点**沿祖先链走一遍，
 * 每个祖先都调一次 `getComputedStyle` 是 O(n·depth) 次样式计算——
 * 在 React 文档那种页面上会明显卡顿。同一元素的结果缓存一次即可。
 */
const codeContainerCache = new WeakMap<Element, boolean>();

export function isCodeContainer(element: Element): boolean {
  const cached = codeContainerCache.get(element);
  if (cached !== undefined) {
    return cached;
  }

  let result = false;

  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(element);
    // 行内元素不算容器——它可能是正文里的一个变量名
    result = style.display !== 'inline' && MONOSPACE_FONT.test(style.fontFamily);
  }

  codeContainerCache.set(element, result);
  return result;
}

/** 元素是否为可编辑字段。 */
export function isEditable(element: Element): boolean {
  if (element.hasAttribute('contenteditable')) {
    const value = element.getAttribute('contenteditable');
    return value !== 'false';
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 「内容不翻译」的统一判定
 * ------------------------------------------------------------------ */

/**
 * 元素是否为交互控件（`role="button"` / `role="tab"` 等）。
 *
 * `<button>` 标签不走这里——它在 `IGNORED_TAGS` 里。
 * 这一条补的是用 `role` 表达的自定义控件（文档站、组件库常见）。
 */
export function isInteractiveControl(element: Element): boolean {
  const role = element.getAttribute('role');
  return role !== null && INTERACTIVE_ROLES.has(role.trim().toLowerCase());
}

/**
 * 元素是否属于「内容不翻译」的一类：忽略标签 ∪ 交互控件。
 *
 * ⚠️ **三处判定必须用同一个函数**，否则规则会在某条路径上静默失效：
 *
 *   1. `hasIgnoredAncestor` / `shouldSkipElement` —— 分段阶段，决定要不要建 Block
 *   2. `isDroppedOnPath`（`blocks.ts`）—— 分段阶段，决定 Block 里还剩不剩文本
 *   3. `buildPlaceholderText`（`placeholders.ts`）—— 拼文本阶段，决定内容发不发给模型
 *
 * 第 3 条最容易被漏掉：它不查路径，只按**直接子元素**判定。
 * 历史事故：那里漏了大小写归一化，于是容器里混排的 `<svg><style>` 子树
 * （`tagName` 是小写）没被当成忽略内容，几千字符 CSS 被当正文发了出去。
 *
 * **归一化大小写**：SVG 命名空间的 `tagName` 是小写（`style` / `svg`），
 * HTML 元素才是大写（`STYLE`）。忽略表存的是大写，不归一化就会漏。
 */
export function isIgnoredElement(element: Element): boolean {
  return IGNORED_TAG_SET.has(element.tagName.toUpperCase()) || isInteractiveControl(element);
}

/**
 * 元素自身或任一祖先（直到 `stopAt`，不含）是否属于被忽略标签。
 *
 * `stopAt` 通常是当前 Block 的容器——容器自身属于块级标签，
 * 不应因它而判定内部节点被忽略。
 */
export function hasIgnoredAncestor(
  element: Element,
  stopAt?: Element | null,
  shouldIgnore?: (element: Element) => boolean,
): boolean {
  let current: Element | null = element;
  while (current && current !== stopAt) {
    // 忽略标签 / 交互控件（`isIgnoredElement` 内含大小写归一化与原因说明）
    if (isIgnoredElement(current)) {
      return true;
    }
    // 代码容器：整块跳过，见 `isCodeContainer` 的说明
    if (isCodeContainer(current)) {
      return true;
    }
    // 站点适配的额外规则（方案第 64 节）——同样要沿祖先链生效，
    // 否则容器内部的子节点仍会被分段
    if (shouldIgnore?.(current) === true) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * 元素是否应整体跳过（不参与分段）。
 *
 * 与「作为原子占位符保留」不同——这里返回 true 表示连结构都不需要，
 * 直接不进入 Block。
 */
export function shouldSkipElement(
  element: Element,
  shouldIgnore?: (element: Element) => boolean,
): boolean {
  if (isIgnoredElement(element)) {
    return true;
  }
  if (isHidden(element) || isEditable(element)) {
    return true;
  }
  if (isCodeContainer(element)) {
    return true;
  }
  return hasIgnoredAncestor(element, null, shouldIgnore);
}

/* ------------------------------------------------------------------ *
 * 文本级过滤
 * ------------------------------------------------------------------ */

/** 纯数字与数字符号（含千分位、百分比、区间、货币符号）。 */
const NUMERIC_ONLY = /^[\d\s.,:%+\-–—/()¥$€£]+$/;

/** URL。 */
const URL_LIKE = /^(?:https?:\/\/|www\.)\S+$/i;

/** 邮箱。 */
const EMAIL_LIKE = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;

/** 纯符号 / Emoji / 标点。 */
const SYMBOL_ONLY = /^[\p{S}\p{P}\p{Z}\p{Emoji_Presentation}]+$/u;

/** 表意文字（中日韩）。 */
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 汉字。 */
const HAN = /[\p{Script=Han}]/gu;

/** 任意字母。 */
const LETTER = /[\p{L}]/gu;

/**
 * 脚本感知的长度规则。
 *
 * 参考研究建议 8：**不能按字符数一刀切**。
 * 拉丁文本里 1 个字符多为标识符或缩写，无翻译意义；
 * 而表意文字单字即可承载语义（如「情報」），不应被过短规则误杀。
 */
export function isTooShort(text: string): boolean {
  if (IDEOGRAPHIC.test(text)) {
    return false;
  }
  return text.replace(/\s+/g, '').length < 2;
}

/**
 * 文本是否已经像目标语言。
 *
 * 仅对中文目标实现——双语页面下避免把已有中文再翻一遍。
 * 其他目标语言返回 false（暂不检测）。
 */
export function looksLikeTargetLanguage(text: string, targetLanguage: string): boolean {
  if (!targetLanguage.startsWith('zh')) {
    return false;
  }
  const letters = (text.match(LETTER) ?? []).length;
  if (letters === 0) {
    return false;
  }
  const han = (text.match(HAN) ?? []).length;
  return han / letters >= 0.5;
}

/** 单个 token 是否无需翻译。 */
function isNonTranslatableToken(token: string): boolean {
  return (
    NUMERIC_ONLY.test(token) ||
    URL_LIKE.test(token) ||
    EMAIL_LIKE.test(token) ||
    SYMBOL_ONLY.test(token)
  );
}

/**
 * 该段文本是否值得送去翻译。
 *
 * 判定方式是**逐 token 剔除无需翻译的部分**，再看是否还剩东西：
 *
 *   - `"2026"` → 剩空 → 跳过
 *   - `"2026 https://example.com hello@example.com 42 → +"` → 剩空 → 跳过
 *   - `"Hello → world"` → 剩 `"Hello world"` → 翻译
 *
 * 之所以不是「整段恰好是数字/URL 才跳过」，是因为真实页面里这类内容经常
 * 混在一段里（版权行、页脚、元信息），逐 token 判定才能正确识别。
 */
export function shouldTranslateText(raw: string, targetLanguage: string): boolean {
  const text = raw.trim();
  if (text.length === 0) {
    return false;
  }

  const meaningful = text.split(/\s+/).filter((token) => !isNonTranslatableToken(token));
  if (meaningful.length === 0) {
    return false;
  }

  const remainder = meaningful.join(' ');
  if (isTooShort(remainder)) {
    return false;
  }
  if (looksLikeTargetLanguage(remainder, targetLanguage)) {
    return false;
  }

  return true;
}
