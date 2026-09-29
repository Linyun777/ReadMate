import { describe, expect, it } from 'vitest';

import {
  ITEM_ENVELOPE_OVERHEAD,
  MAX_CHARS_PER_BATCH,
  MAX_ITEMS_PER_BATCH,
} from '@/shared/constants';
import type { TranslationBlock } from '@/shared/types';

import { itemWeight, planBatches } from './batching';

function makeBlock(id: string, textLength = 200): TranslationBlock {
  const text = 'x'.repeat(textLength);

  return {
    id,
    nodeIds: [`${id}-node-0`],
    text,
    plainText: text,
    tagName: 'P',
    blockType: 'paragraph',
    placeholders: [],
    element: document.createElement('p'),
  };
}

function makeBlocks(count: number, textLength = 200): TranslationBlock[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeBlock(`block-${String(index + 1).padStart(3, '0')}`, textLength),
  );
}

describe('itemWeight — 权重含 JSON 信封开销', () => {
  it('等于文本长度 + id 长度 + 固定开销', () => {
    const block = makeBlock('block-001', 100);

    expect(itemWeight(block)).toBe(100 + 'block-001'.length + ITEM_ENVELOPE_OVERHEAD);
  });
});

describe('planBatches — 预算', () => {
  it('空输入返回空数组', () => {
    expect(planBatches([])).toEqual([]);
  });

  it('少量短 Block 只产生一批', () => {
    const batches = planBatches(makeBlocks(3, 50));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.items).toHaveLength(3);
  });

  it('100 个段落产生远低于 100 的批次数（Phase 5 验收标准）', () => {
    const batches = planBatches(makeBlocks(100));

    expect(batches.length).toBeLessThanOrEqual(5);
    expect(batches.reduce((sum, batch) => sum + batch.items.length, 0)).toBe(100);
  });

  it('条目数预算生效', () => {
    // 每块很短，字符预算不会触发，应由 maxItems 驱动
    const batches = planBatches(makeBlocks(120, 10));

    expect(batches.length).toBe(Math.ceil(120 / MAX_ITEMS_PER_BATCH));
    for (const batch of batches) {
      expect(batch.items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_BATCH);
    }
  });

  it('字符预算生效', () => {
    // 每块 2000 字符 → 单批最多 12 块（24000 / 2000）
    const batches = planBatches(makeBlocks(24, 2000));

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      // 允许单个 Block 本身超预算时独占一批，这里 2000 远小于 24000
      expect(batch.chars).toBeLessThanOrEqual(MAX_CHARS_PER_BATCH);
    }
  });

  it('单个超预算的 Block 独占一批（Block 是原子单位，不可再切分）', () => {
    const blocks = [makeBlock('block-001', 30000), makeBlock('block-002', 100)];

    const batches = planBatches(blocks);

    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]?.items[0]?.id).toBe('block-001');
  });

  it('可自定义预算', () => {
    const batches = planBatches(makeBlocks(10, 100), { maxItems: 2 });

    expect(batches.length).toBe(5);
    for (const batch of batches) {
      expect(batch.items.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('planBatches — 均衡划分', () => {
  it('各批次权重接近（不出现拖尾）', () => {
    const batches = planBatches(makeBlocks(100));

    const weights = batches.map((batch) => batch.chars);
    const max = Math.max(...weights);
    const min = Math.min(...weights);

    // 100 个等长块分 4 组，每组 25 个 → 完全相等
    expect(max - min).toBe(0);
  });

  it('长度不均时各批次仍尽量接近', () => {
    const blocks = [
      makeBlock('block-001', 5000),
      makeBlock('block-002', 100),
      makeBlock('block-003', 100),
      makeBlock('block-004', 100),
      makeBlock('block-005', 5000),
      makeBlock('block-006', 100),
    ];

    const batches = planBatches(blocks, { maxChars: 6000 });
    const weights = batches.map((batch) => batch.chars);
    const max = Math.max(...weights);
    const min = Math.min(...weights);

    // 最大批不超过最小批的 3 倍（贪心顺序切分会差得多）
    expect(max).toBeLessThanOrEqual(min * 3);
  });

  it('每个批次都非空', () => {
    for (const batch of planBatches(makeBlocks(50))) {
      expect(batch.items.length).toBeGreaterThan(0);
    }
  });
});

describe('planBatches — 输出结构', () => {
  it('index 从 0 递增，total 等于批次数', () => {
    const batches = planBatches(makeBlocks(100));

    expect(batches.map((batch) => batch.index)).toEqual(batches.map((_b, index) => index));
    for (const batch of batches) {
      expect(batch.total).toBe(batches.length);
    }
  });

  it('items 只含 id 与 text，且保留原顺序', () => {
    const blocks = makeBlocks(3, 20);
    const batches = planBatches(blocks);

    expect(batches[0]?.items).toEqual([
      { id: 'block-001', text: 'x'.repeat(20) },
      { id: 'block-002', text: 'x'.repeat(20) },
      { id: 'block-003', text: 'x'.repeat(20) },
    ]);
  });

  it('全部 Block 恰好出现一次', () => {
    const blocks = makeBlocks(77);
    const ids = planBatches(blocks).flatMap((batch) => batch.items.map((item) => item.id));

    expect(ids).toHaveLength(77);
    expect(new Set(ids).size).toBe(77);
  });
});
