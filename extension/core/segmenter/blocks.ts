/**
 * Block 划分（方案第 56、57、59 节）。
 *
 * 划分规则：把每个文本节点归到**最近的块级祖先**，同一个祖先下的文本节点
 * 合成一个 `TranslationBlock`。这样：
 *
 *   - `<p>Hello <strong>world</strong></p>` → 一个 Block（`<strong>` 不是块级）
 *   - `<li><p>a</p>tail</li>` → 两个 Block（`<p>` 与 `<li>` 各一个）
 *
 * 找不到块级祖先时（裸露文本）退化为以直接父元素为容器，`blockType` 记为 `inline`。
 */

import type { TranslationBlock } from '@/shared/types';

import {
  ATOMIC_TAGS,
  BLOCK_CHUNK_TARGET_CHARS,
  BLOCK_TAGS,
  classifyBlock,
  SPLIT_BLOCK_THRESHOLD_CHARS,
} from './constants';
import { isIgnoredElement, shouldSkipElement, shouldTranslateText } from './filters';
import { buildPlaceholderText } from './placeholders';

export interface SegmentOptions {
  /** 目标语言，用于「文本已是目标语言」检测 */
  targetLanguage: string;
  /** Block ID 前缀，便于在日志中区分来源 */
  idPrefix?: string;
  /**
   * 额外的块级标签（方案第 64 节）。
   *
   * 站点用自定义元素承载正文时（如 Reddit 的 `shreddit-post`），
   * 通用块级标签表认不出来，只能由适配器补上。
   */
  extraBlockTags?: readonly string[];
  /** 站点适配的额外忽略规则。返回 true 表示该元素整体跳过 */
  shouldIgnore?: (element: Element) => boolean;
}

/**
 * 向上找到最近的块级祖先；找不到则返回起点自身。
 *
 * 导出给动态内容处理用（Phase 10）：MutationObserver 拿到的变动节点
 * 需要先归到某个块级容器，才知道该对哪一片 DOM 重新分段。
 */
export function findBlockContainer(
  start: Element,
  root?: Element,
  extraBlockTags?: readonly string[],
): Element {
  let current: Element | null = start;
  while (current) {
    if (BLOCK_TAGS.has(current.tagName) || extraBlockTags?.includes(current.tagName) === true) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = current.parentElement;
  }
  return start;
}

/**
 * 遍历根元素，输出可翻译的 Block 列表。
 *
 * 输出顺序即文档顺序。
 */

/** 一个容器下收集到的文本节点（ID 与节点都要留，拆大块时要按段分配）。 */
interface ContainerGroup {
  nodeIds: string[];
  members: { node: Node; id: string }[];
}

/**
 * 一个直接子节点在译文里的「分量」（字符数）。
 *
 * 口径必须与 `buildPlaceholderText` 一致，否则切出来的段长短会与预期不符：
 *   - 文本节点 → 原文长度（内容会发给模型）
 *   - 块级后代 → 0（属于别的 Block，不参与本块）
 *   - 被忽略的标签 / 交互控件 / 原子标签 → 1（只产出一个占位符）
 *   - 其余内联元素 → 其文本长度（成对占位符，内容发给模型）
 */
function nodeWeight(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').length;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return 0;
  }

  const element = node as Element;
  if (BLOCK_TAGS.has(element.tagName)) {
    return 0;
  }
  if (isIgnoredElement(element) || ATOMIC_TAGS.has(element.tagName)) {
    return 1;
  }
  return (element.textContent ?? '').length;
}

/**
 * 把一个「过长」的容器切成若干段（拆大块，方案第 57 节）。
 *
 * 返回长度 1 表示不切。**切点只在子节点之间**——绝不切开文本节点，
 * 否则原文无法逐字节恢复（铁律 4）。因此有两类容器不切：
 *
 *   - **有嵌套块级后代**：那些后代属于别的 Block，切出来的段在容器里
 *     就不连续了，恢复位置会错位
 *   - **表格单元格**（`TD` / `TH` / `CAPTION`）与 **inline 容器**：
 *     它们的渲染路径与段级渲染不是一套，别动
 *
 * 单个节点自身就超过目标长度时（例如一个 5000 字符的文本节点），
 * 它自成一整段——切不开，只能接受。
 */
function planChunks(container: Element, extraBlockTags?: readonly string[]): Node[][] {
  const children = Array.from(container.childNodes);

  if (!BLOCK_TAGS.has(container.tagName) || classifyBlock(container.tagName) === 'table') {
    return [children];
  }

  const isBlockLevel = (node: Node): boolean =>
    node.nodeType === Node.ELEMENT_NODE &&
    (BLOCK_TAGS.has((node as Element).tagName) ||
      extraBlockTags?.includes((node as Element).tagName) === true);

  if (children.some(isBlockLevel)) {
    return [children];
  }

  const total = children.reduce((sum, node) => sum + nodeWeight(node), 0);
  if (total <= SPLIT_BLOCK_THRESHOLD_CHARS) {
    return [children];
  }

  const chunks: Node[][] = [];
  let current: Node[] = [];
  let weight = 0;

  for (const node of children) {
    const size = nodeWeight(node);

    // 只在子节点之间切：加上这个节点会超预算、且当前段非空 → 收口
    if (current.length > 0 && weight + size > BLOCK_CHUNK_TARGET_CHARS) {
      chunks.push(current);
      current = [];
      weight = 0;
    }

    current.push(node);
    weight += size;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 1 ? chunks : [children];
}

/**
 * 文本节点到容器之间是否命中了「整段丢弃」的规则。
 *
 * 两类规则都必须**沿路径**生效，只检查容器是不够的：
 *
 *   - 适配器的 `shouldIgnore`（如 Reddit 的操作栏）。不查路径的话，
 *     它只有在被忽略元素**恰好就是容器**时才生效——操作栏在 `shreddit-post`
 *     内部、容器是 post 本身，于是「Vote」「Reply」会被并进帖子正文。
 *   - `isIgnoredElement`（忽略标签表 + 交互控件）。判定必须与
 *     `hasIgnoredAncestor` / `buildPlaceholderText` 用同一个函数。
 *
 * ⚠️ **`IGNORED_TAG_SET` 为什么必须查路径**：容器是块级元素，被忽略的标签
 * 几乎总是在它**内部**。Mintlify 的 mermaid 图表是
 * `<div class="mermaid"><svg><style>…几千字符 CSS…</style></svg></div>`——
 * 容器是 `DIV`，`shouldSkipElement(容器)` 不会命中，于是整段 CSS 被当成正文
 * 送去翻译。这正是「翻译结果里冒出 `#mermaid-xxx{font-family:inherit…}`」的原因。
 *
 * ## 为什么不影响 `<code>`
 *
 * `<code>` 既不在 `IGNORED_TAG_SET` 也不在 `ATOMIC_TAGS`——它走的是
 * 「**成对占位符** `<0>…</0>`」路径：模型看得见内容、能自然放置，但不改它。
 * 语义与「整段丢弃」不同，所以这里加入 `IGNORED_TAG_SET` 不会波及行内代码。
 *
 * ⚠️ 另外注意 **SVG 命名空间里 `tagName` 是小写**（`style` / `svg`），
 * 大小写归一化收在 `isIgnoredElement` 里。
 */
function isDroppedOnPath(
  start: Element,
  stopAt: Element,
  shouldIgnore?: (element: Element) => boolean,
): boolean {
  let current: Element | null = start;
  while (current && current !== stopAt) {
    if (isIgnoredElement(current)) {
      return true;
    }
    if (shouldIgnore?.(current) === true) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

export function segmentElement(root: Element, options: SegmentOptions): TranslationBlock[] {
  const { targetLanguage, idPrefix = 'block', extraBlockTags, shouldIgnore } = options;
  const document = root.ownerDocument;

  // 第一遍：把文本节点按容器分组，同时分配节点 ID
  const grouped = new Map<Element, ContainerGroup>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let counter = 0;
  let textNode = walker.nextNode();

  while (textNode !== null) {
    const parent = textNode.parentElement;
    const hasContent = (textNode.textContent ?? '').trim().length > 0;

    if (parent && hasContent) {
      const container = findBlockContainer(parent, root, extraBlockTags);
      const skipped =
        shouldSkipElement(container, shouldIgnore) ||
        isDroppedOnPath(parent, container, shouldIgnore);

      if (!skipped) {
        const group = grouped.get(container) ?? { nodeIds: [], members: [] };
        const nodeId = `${idPrefix}-node-${counter}`;
        counter += 1;
        group.nodeIds.push(nodeId);
        group.members.push({ node: textNode, id: nodeId });
        grouped.set(container, group);
      }
    }

    textNode = walker.nextNode();
  }

  // 第二遍：为每个容器构建占位符文本，过滤后产出 Block
  // 过长的容器先切成多段，每段一个 Block——见 `planChunks`
  const blocks: TranslationBlock[] = [];
  let blockIndex = 0;

  for (const [container, group] of grouped) {
    const chunks = planChunks(container, extraBlockTags);
    const split = chunks.length > 1;
    const isBlockContainer = BLOCK_TAGS.has(container.tagName);

    for (const chunk of chunks) {
      const { text, plainText, placeholders } = buildPlaceholderText(
        container,
        split ? chunk : undefined,
      );

      if (plainText.length === 0) {
        continue;
      }
      if (!shouldTranslateText(plainText, targetLanguage)) {
        continue;
      }

      blockIndex += 1;
      const chunkNodes = new Set(chunk);

      blocks.push({
        id: `${idPrefix}-${String(blockIndex).padStart(3, '0')}`,
        // 拆段后每段只认自己那部分文本节点的 ID
        nodeIds: split
          ? group.members.filter((member) => chunkNodes.has(member.node)).map((m) => m.id)
          : group.nodeIds,
        text,
        plainText,
        tagName: container.tagName,
        blockType: isBlockContainer ? classifyBlock(container.tagName) : 'inline',
        placeholders,
        element: container,
        ...(split ? { range: { nodes: chunk } } : {}),
      });
    }
  }

  return blocks;
}

/** 对整个文档正文分段。 */
export function segmentDocument(
  options: SegmentOptions,
  document: Document = globalThis.document,
): TranslationBlock[] {
  const root = document.body;
  if (!root) {
    return [];
  }
  return segmentElement(root, options);
}
