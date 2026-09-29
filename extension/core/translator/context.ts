/**
 * 共享上下文分组（方案第 86.6 节）。
 *
 * 一篇页面**不是每个 Block 一份 context**，而是按章节分组共享：
 *
 *   - 术语、语气、指代在同一章节范围内一致
 *   - 请求体更小（一份 context 服务该章节的所有 Batch）
 *   - context 在 Prompt 最前部 → 同一章节的多个 Batch 前缀一致，
 *     可命中 Provider 的 prompt caching
 *
 * 分组规则：
 *   1. 遇到 `blockType === 'heading'` 时开新组（章节边界）
 *   2. 累积长度超过上限时也开新组（避免超出模型窗口）
 */

import { MAX_ARTICLE_CONTEXT_CHARS } from '@/shared/constants';
import type { TranslationBlock } from '@/shared/types';

export interface ContextGroup {
  contextId: string;
  /** 该组所有 Block 的 `plainText` 拼接，作为共享上下文 */
  context: string;
  blockIds: string[];
}

export interface ContextGroupOptions {
  maxChars?: number;
  idPrefix?: string;
}

export function buildContextGroups(
  blocks: readonly TranslationBlock[],
  options: ContextGroupOptions = {},
): ContextGroup[] {
  const maxChars = options.maxChars ?? MAX_ARTICLE_CONTEXT_CHARS;
  const idPrefix = options.idPrefix ?? 'ctx';

  const groups: ContextGroup[] = [];
  let texts: string[] = [];
  let blockIds: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (blockIds.length === 0) {
      return;
    }

    groups.push({
      contextId: `${idPrefix}-${String(groups.length + 1).padStart(3, '0')}`,
      context: texts.join('\n'),
      blockIds: [...blockIds],
    });

    texts = [];
    blockIds = [];
    length = 0;
  };

  for (const block of blocks) {
    const isHeading = block.blockType === 'heading';
    const wouldExceed = blockIds.length > 0 && length + block.plainText.length + 1 > maxChars;

    if (blockIds.length > 0 && (isHeading || wouldExceed)) {
      flush();
    }

    texts.push(block.plainText);
    blockIds.push(block.id);
    length += block.plainText.length + 1;
  }

  flush();

  return groups;
}

/** 建立 Block ID → contextId 的索引，便于按 Block 反查其上下文。 */
export function indexContextByBlock(groups: readonly ContextGroup[]): Map<string, ContextGroup> {
  const index = new Map<string, ContextGroup>();

  for (const group of groups) {
    for (const blockId of group.blockIds) {
      index.set(blockId, group);
    }
  }

  return index;
}
