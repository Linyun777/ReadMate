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

import { BLOCK_TAGS, classifyBlock } from './constants';
import { shouldSkipElement, shouldTranslateText } from './filters';
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
/**
 * 文本节点到容器之间是否命中了适配器的忽略规则。
 *
 * **只看适配器的规则，不看 `IGNORED_TAG_SET`**——后者是「作为原子占位符保留」
 * 的语义（如段落里的 `<code>`），不是「整段丢弃」。两者混在一起会改变既有行为。
 *
 * 不查路径的话，适配器的规则只有在被忽略元素**恰好就是容器**时才生效：
 * 例如 Reddit 的操作栏在 `shreddit-post` 内部，容器是 post 本身，
 * 于是「Vote」「Reply」会被并进帖子正文。
 */
function isAdapterIgnoredOnPath(
  start: Element,
  stopAt: Element,
  shouldIgnore?: (element: Element) => boolean,
): boolean {
  if (shouldIgnore === undefined) {
    return false;
  }

  let current: Element | null = start;
  while (current && current !== stopAt) {
    if (shouldIgnore(current)) {
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
  const grouped = new Map<Element, string[]>();
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
        isAdapterIgnoredOnPath(parent, container, shouldIgnore);

      if (!skipped) {
        const nodeIds = grouped.get(container) ?? [];
        nodeIds.push(`${idPrefix}-node-${counter}`);
        counter += 1;
        grouped.set(container, nodeIds);
      }
    }

    textNode = walker.nextNode();
  }

  // 第二遍：为每个容器构建占位符文本，过滤后产出 Block
  const blocks: TranslationBlock[] = [];
  let blockIndex = 0;

  for (const [container, nodeIds] of grouped) {
    const { text, plainText, placeholders } = buildPlaceholderText(container);

    if (plainText.length === 0) {
      continue;
    }
    if (!shouldTranslateText(plainText, targetLanguage)) {
      continue;
    }

    blockIndex += 1;
    const isBlockContainer = BLOCK_TAGS.has(container.tagName);

    blocks.push({
      id: `${idPrefix}-${String(blockIndex).padStart(3, '0')}`,
      nodeIds,
      text,
      plainText,
      tagName: container.tagName,
      blockType: isBlockContainer ? classifyBlock(container.tagName) : 'inline',
      placeholders,
      element: container,
    });
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
