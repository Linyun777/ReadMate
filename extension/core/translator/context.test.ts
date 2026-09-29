import { describe, expect, it } from 'vitest';

import type { BlockType, TranslationBlock } from '@/shared/types';

import { buildContextGroups, indexContextByBlock } from './context';

function makeBlock(id: string, text: string, blockType: BlockType = 'paragraph'): TranslationBlock {
  return {
    id,
    nodeIds: [`${id}-node-0`],
    text,
    plainText: text,
    tagName: blockType === 'heading' ? 'H2' : 'P',
    blockType,
    placeholders: [],
    element: document.createElement('p'),
  };
}

describe('buildContextGroups — 共享上下文分组', () => {
  it('空输入返回空数组', () => {
    expect(buildContextGroups([])).toEqual([]);
  });

  it('短文章归为一组，context 为各 Block 拼接', () => {
    const groups = buildContextGroups([
      makeBlock('block-001', 'First paragraph.'),
      makeBlock('block-002', 'Second paragraph.'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.context).toBe('First paragraph.\nSecond paragraph.');
    expect(groups[0]?.blockIds).toEqual(['block-001', 'block-002']);
  });

  it('heading 作为章节边界开启新组', () => {
    const groups = buildContextGroups([
      makeBlock('block-001', 'Intro text.', 'heading'),
      makeBlock('block-002', 'Body text.'),
      makeBlock('block-003', 'Next section.', 'heading'),
      makeBlock('block-004', 'More body.'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.blockIds).toEqual(['block-001', 'block-002']);
    expect(groups[1]?.blockIds).toEqual(['block-003', 'block-004']);
    expect(groups[1]?.context).toBe('Next section.\nMore body.');
  });

  it('首个 Block 是 heading 时不会产生空组', () => {
    const groups = buildContextGroups([
      makeBlock('block-001', 'Title', 'heading'),
      makeBlock('block-002', 'Body.'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.blockIds).toEqual(['block-001', 'block-002']);
  });

  it('超过 maxChars 时开新组', () => {
    const groups = buildContextGroups(
      [
        makeBlock('block-001', 'a'.repeat(600)),
        makeBlock('block-002', 'b'.repeat(600)),
        makeBlock('block-003', 'c'.repeat(600)),
      ],
      { maxChars: 700 },
    );

    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.blockIds).toHaveLength(1);
    }
  });

  it('单个超长 Block 独占一组（不会无限累积）', () => {
    const groups = buildContextGroups(
      [makeBlock('block-001', 'a'.repeat(5000)), makeBlock('block-002', 'short')],
      { maxChars: 1000 },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.blockIds).toEqual(['block-001']);
  });

  it('contextId 连续编号', () => {
    const groups = buildContextGroups(
      [
        makeBlock('block-001', 'A', 'heading'),
        makeBlock('block-002', 'B', 'heading'),
        makeBlock('block-003', 'C', 'heading'),
      ],
      { idPrefix: 'art' },
    );

    expect(groups.map((group) => group.contextId)).toEqual(['art-001', 'art-002', 'art-003']);
  });

  it('全部 Block 恰好归入一个组', () => {
    const blocks = Array.from({ length: 20 }, (_unused, index) =>
      makeBlock(`block-${String(index + 1).padStart(3, '0')}`, `Paragraph ${index}.`),
    );

    const groups = buildContextGroups(blocks, { maxChars: 50 });
    const ids = groups.flatMap((group) => group.blockIds);

    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });
});

describe('indexContextByBlock — 反查索引', () => {
  it('可按 Block ID 取回其所属分组', () => {
    const groups = buildContextGroups([
      makeBlock('block-001', 'Title', 'heading'),
      makeBlock('block-002', 'Body.'),
    ]);

    const index = indexContextByBlock(groups);

    expect(index.get('block-001')?.contextId).toBe('ctx-001');
    expect(index.get('block-002')?.contextId).toBe('ctx-001');
    expect(index.get('block-999')).toBeUndefined();
  });
});
