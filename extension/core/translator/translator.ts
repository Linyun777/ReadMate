/**
 * Translator：**决定「发什么」**。
 *
 * 流程（方案第 86.6、86.7 节）：
 *
 *   1. 按视口优先级排序（含导航块优先）
 *   2. 按章节提取共享上下文分组
 *   3. 在各上下文组内划分批次（预算 + 均衡）
 *   4. 转换成队列可直接执行的线上请求
 *
 * **并发、重试与降级都不在本模块**——唯一调度点是 `core/queue`（方案第 86.7 节）。
 * 本模块只产出纯数据，不发请求。
 */

import { sendToBackground } from '@/core/messaging/client';
import { createMessage } from '@/core/messaging/protocol';
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_STYLE,
  DEFAULT_TARGET_LANGUAGE,
} from '@/shared/constants';
import type {
  FetchHealthMessage,
  FetchTranslationMessage,
  HealthResponse,
  TranslationBlock,
  TranslationRequest,
  TranslationStyle,
  WireTranslateRequest,
  WireTranslateResponse,
} from '@/shared/types';

import { planBatches, type TranslationBatch } from './batching';
import { buildContextGroups, type ContextGroup, type ContextGroupOptions } from './context';
import { type PriorityOptions, sortByPriority } from './priority';
import { ServerError } from './server-client';
import { toWireRequest } from './wire';

export interface TranslatorOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  style?: TranslationStyle;
  maxCharsPerBatch?: number;
  maxItemsPerBatch?: number;
  viewportHeight?: number;
  measure?: PriorityOptions['measure'];
  contextMaxChars?: ContextGroupOptions['maxChars'];
}

/** 一个已排定优先级的待发送批次。 */
export interface PlannedBatch {
  batch: TranslationBatch;
  contextId: string;
  context: string;
  blockIds: string[];
  /** 本批中最高优先级 Block 的序号，越小越先发 */
  priority: number;
}

export interface TranslationPlan {
  batches: PlannedBatch[];
  contextGroups: ContextGroup[];
}

function resolveViewportHeight(explicit: number | undefined): number {
  if (typeof explicit === 'number') {
    return explicit;
  }
  const height = globalThis.innerHeight;
  return typeof height === 'number' && height > 0 ? height : 800;
}

/**
 * 规划批次。**纯函数**，不发请求——便于单独测试。
 *
 * 上下文分组按**文档顺序**建立（章节边界由 heading 决定），
 * 组内批次按**视口优先级**排序，最后把全部批次按优先级重排。
 */
export function planTranslation(
  blocks: readonly TranslationBlock[],
  options: TranslatorOptions = {},
): TranslationPlan {
  if (blocks.length === 0) {
    return { batches: [], contextGroups: [] };
  }

  const priorityOptions: PriorityOptions = {
    viewportHeight: resolveViewportHeight(options.viewportHeight),
  };
  if (options.measure) {
    priorityOptions.measure = options.measure;
  }

  const ordered = sortByPriority(blocks, priorityOptions);
  const priorityIndex = new Map(ordered.map((block, index) => [block.id, index]));

  const contextOptions: ContextGroupOptions = {};
  if (options.contextMaxChars !== undefined) {
    contextOptions.maxChars = options.contextMaxChars;
  }
  const contextGroups = buildContextGroups(blocks, contextOptions);

  const byId = new Map(blocks.map((block) => [block.id, block]));

  const batchOptions: { maxChars?: number; maxItems?: number } = {};
  if (options.maxCharsPerBatch !== undefined) {
    batchOptions.maxChars = options.maxCharsPerBatch;
  }
  if (options.maxItemsPerBatch !== undefined) {
    batchOptions.maxItems = options.maxItemsPerBatch;
  }

  const planned: PlannedBatch[] = [];

  for (const group of contextGroups) {
    const groupBlocks = group.blockIds
      .map((blockId) => byId.get(blockId))
      .filter((block): block is TranslationBlock => block !== undefined)
      .sort(
        (a, b) =>
          (priorityIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (priorityIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );

    const batches = planBatches(groupBlocks, batchOptions);

    for (const batch of batches) {
      const blockIds = batch.items.map((item) => item.id);
      planned.push({
        batch,
        contextId: group.contextId,
        context: group.context,
        blockIds,
        priority: Math.min(
          ...blockIds.map((blockId) => priorityIndex.get(blockId) ?? Number.MAX_SAFE_INTEGER),
        ),
      });
    }
  }

  planned.sort((a, b) => a.priority - b.priority);

  return { batches: planned, contextGroups };
}

/**
 * 通过 background 转发请求（方案第 86.7 节：content script 不能直接 fetch）。
 *
 * 失败时抛 `ServerError`，**保留 `retryable` 标记**——`core/queue` 据此决定是否重试。
 * 若换成普通 `Error`，网络错误与 429 会被当成确定性失败而放弃重试。
 */
export async function sendViaBackground(
  payload: WireTranslateRequest,
): Promise<WireTranslateResponse> {
  const message = createMessage<FetchTranslationMessage>({ type: 'FETCH_TRANSLATION', payload });
  const response = await sendToBackground<WireTranslateResponse>(message);

  if (!response.ok || response.data === undefined) {
    throw new ServerError(response.error ?? '翻译请求失败', undefined, response.retryable === true);
  }

  return response.data;
}

/**
 * 通过 background 探测本地服务。
 *
 * content script 需要 `provider` / `model` / `promptVersion` 来算缓存键
 * （方案第 86.8 节），但它不能直接 fetch，所以健康检查也走 background。
 */
export async function fetchHealthViaBackground(): Promise<HealthResponse> {
  const message = createMessage<FetchHealthMessage>({ type: 'FETCH_HEALTH' });
  const response = await sendToBackground<HealthResponse>(message);

  if (!response.ok || response.data === undefined) {
    throw new Error(response.error ?? '无法连接本地服务');
  }

  return response.data;
}

function buildRequest(planned: PlannedBatch, options: TranslatorOptions): TranslationRequest {
  return {
    sourceLanguage: options.sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE,
    targetLanguage: options.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
    style: options.style ?? DEFAULT_STYLE,
    contextId: planned.contextId,
    context: planned.context,
    items: planned.batch.items,
  };
}

/**
 * 把批次计划转换成**队列可直接执行的线上请求**。
 *
 * 这是 translator 与 queue 的分界线：
 *   - translator 决定「发什么」（本函数，纯数据）
 *   - queue 决定「何时发、并发多少、失败怎么办」
 */
export function buildTasks(
  plan: TranslationPlan,
  options: TranslatorOptions = {},
): WireTranslateRequest[] {
  return plan.batches.map((planned) => toWireRequest(buildRequest(planned, options)));
}
