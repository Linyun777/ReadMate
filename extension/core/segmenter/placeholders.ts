/**
 * 占位符构建（方案第 86.1 节）。
 *
 * 核心思路：在拼接 Block 文本时，把不可翻译或需要保留结构的位置替换为占位符；
 * 模型被要求原样保留占位符；Renderer 按占位符切分并回填到原始 DOM。
 *
 * 占位符格式：
 *
 *   成对（包裹可翻译文本的 inline 元素）   `<0> ... </0>`
 *   原子（不可翻译的独立结构）            `<0/>`
 *
 * 索引在**同一个 Block 内唯一**，从 0 开始，成对与原子共用同一索引空间。
 *
 * 不需要保护：被页面 CSS 折叠的空白。这类空白在译文中保持折叠即可，
 * 加占位符只会引入噪声。
 */

import type { PlaceholderBinding } from '@/shared/types';
import { ATOMIC_TAGS, BLOCK_TAGS, PRESERVE_NEWLINE_WHITESPACE } from './constants';
import { isIgnoredElement } from './filters';

export interface PlaceholderResult {
  /** 含占位符的文本，提交给模型 */
  text: string;
  /** 不含占位符的纯文本，用于缓存键、长度统计与文本过滤判定 */
  plainText: string;
  placeholders: PlaceholderBinding[];
}

/** 容器是否保留换行（`white-space: pre-wrap` 等）。 */
function preservesNewlines(element: Element): boolean {
  if (typeof getComputedStyle !== 'function') {
    return false;
  }
  return PRESERVE_NEWLINE_WHITESPACE.has(getComputedStyle(element).whiteSpace);
}

/** 折叠连续空格并去掉首尾空白。占位符语法不含空格，不会被破坏。 */
function collapseSpaces(text: string): string {
  return text.replace(/ {2,}/g, ' ').trim();
}

/**
 * 为容器的直接内容构建占位符文本。
 *
 * 只处理容器的**直接文本节点与内联后代**；遇到块级后代时跳过——
 * 它们属于各自的 Block。
 *
 * `nodes` 用于**拆大块**：只处理这一段子节点。省略即处理整个容器。
 */
export function buildPlaceholderText(
  container: Element,
  nodes?: readonly Node[],
): PlaceholderResult {
  const placeholders: PlaceholderBinding[] = [];
  const withPlaceholders: string[] = [];
  const plain: string[] = [];

  const keepNewlines = preservesNewlines(container);
  let nextIndex = 0;

  const addText = (raw: string): void => {
    if (!keepNewlines) {
      const normalized = raw.replace(/\s+/g, ' ');
      withPlaceholders.push(normalized);
      plain.push(normalized);
      return;
    }

    // 保留换行：每个换行变成一个原子占位符，其余空白照常折叠
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) {
        const index = nextIndex;
        nextIndex += 1;
        placeholders.push({
          index,
          kind: 'atom',
          node: container.ownerDocument.createTextNode('\n'),
        });
        withPlaceholders.push(`<${index}/>`);
      }
      const segment = (lines[i] ?? '').replace(/[^\S\n]+/g, ' ');
      withPlaceholders.push(segment);
      plain.push(segment);
    }
  };

  /** 处理一个节点（文本 / 原子 / 成对）。递归用 `walkChildren`。 */
  const visit = (child: Node): void => {
    if (child.nodeType === Node.TEXT_NODE) {
      addText(child.textContent ?? '');
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = child as Element;

    // 块级后代属于各自的 Block，不纳入本块
    if (BLOCK_TAGS.has(element.tagName)) {
      return;
    }

    // 整块丢弃的标签（SCRIPT / PRE / SVG …）、交互控件、原子标签：
    // 元素原样保留，但内容不发给模型。
    //
    // ⚠️ 这里必须与分段阶段的判定（`isIgnoredElement`）一致，
    // 否则会出现「分段时说这块不翻译、拼文本时却把它发了出去」——
    // 历史上 `<svg><style>` 的 CSS 就是这样被当正文翻译的。
    if (isIgnoredElement(element) || ATOMIC_TAGS.has(element.tagName)) {
      const index = nextIndex;
      nextIndex += 1;
      placeholders.push({ index, kind: 'atom', node: element });
      withPlaceholders.push(`<${index}/>`);
      return;
    }

    // 可翻译的内联元素：成对占位符，递归处理其内容
    const index = nextIndex;
    nextIndex += 1;
    placeholders.push({ index, kind: 'pair', element });
    withPlaceholders.push(`<${index}>`);
    walkChildren(element);
    withPlaceholders.push(`</${index}>`);
  };

  const walkChildren = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      visit(child);
    }
  };

  if (nodes === undefined) {
    walkChildren(container);
  } else {
    // 拆大块：只走这一段，其余段归别的 Block
    for (const node of nodes) {
      visit(node);
    }
  }

  return {
    text: collapseSpaces(withPlaceholders.join('')),
    plainText: collapseSpaces(plain.join('')),
    placeholders,
  };
}

/**
 * 校验译文中的占位符是否与请求一致（方案第 86.1 节的校验规则）。
 *
 * 两条规则：
 *   1. 索引集合完全一致（不缺失、不多余、不重复）
 *   2. 成对占位符开闭数量相等且配对正确（不交叉嵌套）
 *
 * **刻意不校验顺序。** 实测（`server/scripts/check_placeholder_retention.py`）
 * 发现模型会为了符合目标语言语序而重排占位符，例如：
 *
 *     The <0>LLM</0> returns a <1>JSON</1> payload over <2>HTTP</2>.
 *     → <0>LLM</0>通过<2>HTTP</2>返回一个<1>JSON</1>负载。
 *
 * 这是**正确行为**——强制保持顺序会逼出别扭的译文。重排对 DOM 也是安全的：
 * 元素仍包裹各自的译文，只是块内位置变化，Renderer 按译文顺序重建即可。
 *
 * 检查顺序是刻意的：**先查索引集合、再查配对**。反过来会让
 * 「译文多出一个占位符」被误报成「配对错误」，掩盖真正的原因。
 *
 * ⚠️ 服务端 `app/services/validation.py` 是同一套规则的另一份实现，改动时请同步。
 */
export function validatePlaceholders(
  translation: string,
  expected: readonly PlaceholderBinding[],
): { ok: true } | { ok: false; reason: string } {
  const expectedIndices = expected.map((item) => item.index);
  const expectedPairs = new Set(
    expected.filter((item) => item.kind === 'pair').map((item) => item.index),
  );

  // 第一遍：收集译文中的占位符索引（不含闭合标签）
  const found: number[] = [];
  const openingPattern = /<(\d+)(\/?)>/g;
  let opening = openingPattern.exec(translation);

  while (opening !== null) {
    found.push(Number(opening[1]));
    opening = openingPattern.exec(translation);
  }

  // 第二遍：索引集合与顺序
  const foundUnique = new Set(found);
  if (foundUnique.size !== found.length) {
    return { ok: false, reason: '占位符索引出现重复' };
  }

  const missing = expectedIndices.filter((index) => !foundUnique.has(index)).sort((a, b) => a - b);
  const extra = [...foundUnique]
    .filter((index) => !expectedIndices.includes(index))
    .sort((a, b) => a - b);

  if (missing.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0) {
      details.push(`缺少 ${missing.map((index) => `<${index}>`).join('、')}`);
    }
    if (extra.length > 0) {
      details.push(`多出 ${extra.map((index) => `<${index}>`).join('、')}`);
    }
    return { ok: false, reason: `占位符索引不一致：${details.join('；')}` };
  }

  // 第三遍：成对占位符的配对（用栈检测交叉嵌套）
  const stack: number[] = [];
  const tokenPattern = /<(\d+)(\/?)>|<\/(\d+)>/g;
  let token = tokenPattern.exec(translation);

  while (token !== null) {
    const openIndex = token[1] !== undefined ? Number(token[1]) : undefined;
    const selfClosing = token[2] === '/';
    const closeIndex = token[3] !== undefined ? Number(token[3]) : undefined;

    if (closeIndex !== undefined) {
      if (stack.pop() !== closeIndex) {
        return { ok: false, reason: `成对占位符 </${closeIndex}> 配对错误` };
      }
    } else if (openIndex !== undefined && !selfClosing && expectedPairs.has(openIndex)) {
      stack.push(openIndex);
    }

    token = tokenPattern.exec(translation);
  }

  if (stack.length > 0) {
    return { ok: false, reason: `成对占位符未闭合：${stack.map((i) => `<${i}>`).join('、')}` };
  }

  return { ok: true };
}
