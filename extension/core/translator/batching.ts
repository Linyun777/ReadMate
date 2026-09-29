/**
 * Batch 预算与均衡划分（方案第 86.6 节）。
 *
 * 预算：
 *   - `maxChars` 默认 24000（以字符为主导）
 *   - `maxItems` 默认 30（仅作兜底，防止大量极短 Block 抬高 JSON 信封开销）
 *
 * 划分方式是**按权重均衡分配**，而不是顺序贪心填满：
 * 目标是各批次权重尽量接近，避免「最后一个批次特别大、特别慢」的拖尾。
 */

import {
  ITEM_ENVELOPE_OVERHEAD,
  MAX_CHARS_PER_BATCH,
  MAX_ITEMS_PER_BATCH,
} from '@/shared/constants';
import type { TranslationBlock, TranslationItem } from '@/shared/types';

export interface TranslationBatch {
  index: number;
  total: number;
  items: TranslationItem[];
  /** 本批含占位符文本的总长度，用于日志与测试断言 */
  chars: number;
}

export interface BatchOptions {
  maxChars?: number;
  maxItems?: number;
}

/**
 * 单个 Block 在请求中的权重。
 *
 * 除文本本身外，还要算上 id 与 JSON 信封（`{"id":"...","text":"..."}`）的开销，
 * 否则「大量极短 Block」的批次会显著超出预期体积。
 */
export function itemWeight(block: TranslationBlock): number {
  return block.text.length + block.id.length + ITEM_ENVELOPE_OVERHEAD;
}

/**
 * 按权重把条目均衡分成 `count` 组。
 *
 * 逐组分配：以「剩余权重 / 剩余组数」为目标，取最接近目标的切分点。
 * 每组至少保留一个条目给后续组。
 */
function partitionBalanced<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  count: number,
): T[][] {
  if (count <= 1) {
    return [items.slice()];
  }

  const groups: T[][] = [];
  let cursor = 0;
  let remainingWeight = items.reduce((sum, item) => sum + weightOf(item), 0);

  for (let groupIndex = 0; groupIndex < count; groupIndex += 1) {
    const remainingGroups = count - groupIndex;

    if (remainingGroups === 1) {
      groups.push(items.slice(cursor));
      break;
    }

    const target = remainingWeight / remainingGroups;
    // 给后续每组至少留一个条目
    const maxCursor = items.length - (remainingGroups - 1);

    const group: T[] = [];
    let groupWeight = 0;

    while (cursor < maxCursor) {
      const item = items[cursor];
      if (item === undefined) {
        break;
      }

      const weight = weightOf(item);
      const distanceNow = Math.abs(target - groupWeight);
      const distanceAfter = Math.abs(target - (groupWeight + weight));

      // 已经凑够目标、且再加入反而更远 → 在当前位置切分
      if (group.length > 0 && groupWeight < target && distanceNow <= distanceAfter) {
        break;
      }

      group.push(item);
      groupWeight += weight;
      cursor += 1;

      if (groupWeight >= target) {
        break;
      }
    }

    groups.push(group);
    remainingWeight -= groupWeight;
  }

  return groups;
}

/**
 * 规划批次。
 *
 * 批次数量由两个预算共同驱动：
 *
 *     requiredByChars = ceil(totalWeight / maxChars)   字符预算要求的最少批次
 *     requiredByItems = ceil(blocks.length / maxItems) 条目预算要求的最少批次
 *     desiredCount    = min(blocks.length, max(1, requiredByChars, requiredByItems))
 *
 * ⚠️ 这里取 **max** 而不是 min：两个预算各自给出的是「最少需要几批」，
 * 必须同时满足，所以取较大者。若取 min，会出现「120 个极短 Block 被塞进 1 批」——
 * 字符预算满足了，条目预算被无视。
 *
 * 不设固定批次数上限。
 *
 * 注意：单个 Block 的体积若超过 `maxChars`，它仍会独占一批——
 * Block 是原子单位，不可再切分。
 */
export function planBatches(
  blocks: readonly TranslationBlock[],
  options: BatchOptions = {},
): TranslationBatch[] {
  if (blocks.length === 0) {
    return [];
  }

  const maxChars = options.maxChars ?? MAX_CHARS_PER_BATCH;
  const maxItems = options.maxItems ?? MAX_ITEMS_PER_BATCH;

  const totalWeight = blocks.reduce((sum, block) => sum + itemWeight(block), 0);

  const requiredByChars = Math.ceil(totalWeight / maxChars);
  const requiredByItems = Math.ceil(blocks.length / maxItems);
  const desiredCount = Math.min(blocks.length, Math.max(1, requiredByChars, requiredByItems));

  const grouped = partitionBalanced(blocks, itemWeight, desiredCount);

  return grouped.map((group, index) => ({
    index,
    total: grouped.length,
    items: group.map((block) => ({ id: block.id, text: block.text })),
    chars: group.reduce((sum, block) => sum + block.text.length, 0),
  }));
}
