/**
 * 视口优先级排序（方案第 65、86.6 节）。
 *
 * 排序键依次为：
 *
 *   1. **视口距离**——元素在视口内 = 0，否则为到视口的距离
 *   2. **导航块优先**——导航块排在同距离的其他块之前
 *   3. **文档顺序**
 *
 * 第 2 项的作用是避免「正文译完了但侧边导航仍是英文」的割裂感。
 *
 * 排序在**划分批次之前**执行，因此批次本身即按优先级排列。
 */

import type { TranslationBlock } from '@/shared/types';

export interface Rect {
  top: number;
  bottom: number;
}

export interface PriorityOptions {
  viewportHeight: number;
  /**
   * 测量元素位置。默认用 `getBoundingClientRect`（返回视口相对坐标）。
   * 提供注入点是为了让测试可以在 jsdom（所有 rect 都是 0）之外验证排序逻辑。
   */
  measure?: (element: Element) => Rect;
}

function defaultMeasure(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/**
 * 元素到视口的距离。
 *
 * - 在视口内 → 0
 * - 在视口下方 → 元素顶边到视口底边的距离
 * - 在视口上方 → 元素底边到视口顶边的距离
 *
 * 三个分支都返回**非负值**，因此升序排序即「越靠近视口越靠前」，
 * 不会出现「已滚过的内容被优先翻译」。
 */
export function viewportDistance(element: Element, options: PriorityOptions): number {
  const { top, bottom } = (options.measure ?? defaultMeasure)(element);

  if (bottom >= 0 && top <= options.viewportHeight) {
    return 0;
  }
  return top > options.viewportHeight ? top - options.viewportHeight : -bottom;
}

/** 是否为导航块（自身或祖先中有 `<nav>`）。 */
export function isNavigationBlock(block: TranslationBlock): boolean {
  try {
    return block.element.closest('nav') !== null;
  } catch {
    // 极端情况下元素可能已脱离文档，视为非导航
    return false;
  }
}

/**
 * 按优先级排序。
 *
 * 只关心 Block 本身，不关心它在 store 里的状态——因此入参是 `TranslationBlock[]`
 * 而不是 `BlockEntry[]`。
 *
 * 返回新数组，不修改入参。
 */
export function sortByPriority(
  blocks: readonly TranslationBlock[],
  options: PriorityOptions,
): TranslationBlock[] {
  return blocks
    .map((block, documentIndex) => ({
      block,
      documentIndex,
      distance: viewportDistance(block.element, options),
      navigationRank: isNavigationBlock(block) ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.navigationRank - b.navigationRank ||
        a.documentIndex - b.documentIndex,
    )
    .map((item) => item.block);
}
