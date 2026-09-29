/**
 * 读取当前选区与它的上下文（方案第 41 节）。
 *
 * ## 为什么需要「上下文」
 *
 * 同一个词在不同语境里意思可能完全不同。`high-agency` 单独看像是「高代理」，
 * 放在招聘文案里才是「主动推进」。只把选中的三个词发给模型，解释质量会差很多。
 *
 * 所以这里顺带取出**选区所在块级容器的整段文字**作为上下文——
 * 复用分段器的 `findBlockContainer`，与翻译链路判断「一段」的口径保持一致。
 */

import { findBlockContainer } from '@/core/segmenter';

export interface SelectionInfo {
  /** 选中的文字（已 trim） */
  selection: string;
  /** 选区所在段落 / 标题 / 列表项的完整文字。取不到时为空串 */
  context: string;
  /** 选区的视口坐标，供浮层定位 */
  rect: DOMRect;
}

export interface ReadSelectionOptions {
  /** 站点适配器补充的块级标签，与分段口径保持一致 */
  extraBlockTags?: readonly string[];
}

/** 选中文字超过此长度就认为用户想要的是「总结」而不是「解释」。 */
export const MAX_SELECTION_LENGTH = 2000;

function anchorElement(document: Document): Element | null {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;

  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function contextOf(element: Element | null, extraBlockTags?: readonly string[]): string {
  if (element === null) {
    return '';
  }

  const container = findBlockContainer(element, undefined, extraBlockTags);
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 退化用的空矩形（浮层会落到左上角）。 */
const ZERO_RECT = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

/**
 * 取选区的视口矩形。
 *
 * 三级退化：`Range.getBoundingClientRect` → 锚点元素的矩形 → 空矩形。
 *
 * 需要退化是因为：jsdom **没有实现** `Range.getBoundingClientRect`；
 * 真实浏览器里选区跨折叠元素时也可能返回全 0 的矩形。
 * 没有这一层，浮层在测试环境里会直接抛错。
 */
function rectOf(range: Range, element: Element | null): DOMRect {
  if (typeof range.getBoundingClientRect === 'function') {
    const fromRange = range.getBoundingClientRect();
    if (fromRange.width > 0 || fromRange.height > 0) {
      return fromRange;
    }
  }

  const fromElement = element?.getBoundingClientRect();
  if (fromElement !== undefined && (fromElement.width > 0 || fromElement.height > 0)) {
    return fromElement;
  }

  return ZERO_RECT;
}

/**
 * 读取选区。
 *
 * 没有选中内容、或选区跨过了浮层自身时返回 `null`——
 * 后者是必要的：浮层带 `data-ai-translator` 标记，不该被当成用户选中的正文。
 */
export function readSelection(
  document: Document,
  options: ReadSelectionOptions = {},
): SelectionInfo | null {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed) {
    return null;
  }

  const text = (selection.toString() ?? '').trim();
  if (text === '' || text.length > MAX_SELECTION_LENGTH) {
    return null;
  }

  const element = anchorElement(document);

  // 选中的是插件自己插入的节点（浮层 / 译文）——不算用户内容
  if (element?.closest('[data-ai-translator]') != null) {
    return null;
  }

  const range = selection.getRangeAt(0);

  return {
    selection: text,
    context: contextOf(element, options.extraBlockTags),
    rect: rectOf(range, element),
  };
}
