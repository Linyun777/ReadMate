/**
 * 翻译队列 —— **唯一调度点**（方案第 86.7 节）。
 *
 * 职责：**并发控制、重试调度、失败降级**。
 * 不负责分段、Batch 划分、Prompt 组装与 DOM 写入。
 *
 * ## 为什么调度必须在 content script
 *
 * MV3 的 service worker **会被浏览器随时回收**（方案第 86.7 节）。队列状态若放在
 * background，回收后即丢失且无法恢复；content script 跟随页面生命周期，
 * 页面在则队列在，是天然的调度宿主。
 *
 * ## 为什么执行要走 background
 *
 * content script 运行在页面 origin 下，请求受**页面 CSP 的 `connect-src` 限制**，
 * 在多数网站会被直接阻断。实际 HTTP 由 background 发出。
 *
 * ## 失败降级路径（方案第 86.9 节）
 *
 * ```text
 * 批次请求失败
 *   ↓ 重试 1~2 次（第 73 节，仅对可重试错误）
 * 仍失败
 *   ↓ 拆分为单条重试
 * 仍失败 → 该 Block 标记 FAILED，保留原文，记录错误
 * ```
 *
 * 收益：单个异常 Block 不会导致整批失败。
 */

import type { PageStore } from '@/core/store';
import { fromWireResponse } from '@/core/translator/wire';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  RETRY_BASE_DELAY_MS,
} from '@/shared/constants';
import type {
  SendTranslationRequest,
  StreamTranslationRequest,
  TranslationStreamItem,
  WireTranslateRequest,
} from '@/shared/types';

export interface TranslationQueueOptions {
  /** 并发请求数。默认 3，会被夹到 1–5 */
  concurrency?: number;
  /** 单次任务的最大重试次数（不含首次尝试）。默认 2 */
  maxRetries?: number;
  /** 重试退避基数（毫秒），按 2 的幂增长 */
  retryDelayMs?: number;
  /** 非流式发送实现 */
  send?: SendTranslationRequest;
  /**
   * 流式发送实现（方案第 86.9 节）。**提供时优先使用**。
   *
   * 流式模式下条目边到边写入 store，因此「任务失败」不再等于
   * 「全部条目失败」——已经拿到的条目会被保留。
   */
  stream?: StreamTranslationRequest;
  /** 每个条目落库时回调，供上层增量渲染 */
  onItem?: (item: TranslationStreamItem) => void;
  /** 注入点：便于测试免去真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

export interface QueueRunResult {
  /** 计划执行的任务数（降级产生的单条任务不计入） */
  tasks: number;
  succeeded: number;
  failed: number;
  translatedItems: number;
  /** 因批次失败而降级为单条重试的批次数 */
  degraded: number;
  /** 实际发出的请求总数（含重试与降级） */
  attempts: number;
  /** 是否被用户取消（取消后统计值只反映已完成的那些） */
  cancelled: boolean;
}

/** 判断错误是否值得重试。 */
function isRetryable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  // 没有标记的错误（如注入的替身抛的普通 Error）视为不可重试，
  // 避免把确定性错误重试成风暴
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 统计这批任务涉及的 Block 中，最终有多少拿到了译文。
 *
 * 从 store 统计而不是累加返回值——流式下条目是边到边写入的，
 * 失败的任务也可能已经成功了一部分。控制器统计缓存命中时也复用本函数。
 */
export function countTranslated(tasks: readonly WireTranslateRequest[], store: PageStore): number {
  const ids = new Set<string>();
  for (const task of tasks) {
    for (const item of task.items) {
      ids.add(item.id);
    }
  }

  let translated = 0;
  for (const id of ids) {
    if (store.get(id)?.status === 'TRANSLATED') {
      translated += 1;
    }
  }

  return translated;
}

/**
 * 以固定并发度执行任务。
 *
 * `cursor` 在 `await` 之前自增，JS 单线程下不会出现两个 worker 取到同一项。
 *
 * `shouldStop` 在每个任务**开始前**检查一次：取消后不再领新任务，
 * 但在途的那几个会跑完（它们已经发出去了，拦不住）。
 * 这个粒度是刻意的——用户感知到的是「不再越翻越多」，而不是「立刻归零」。
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  let cursor = 0;

  const runnerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < items.length) {
      if (shouldStop?.() === true) {
        return;
      }

      const index = cursor;
      cursor += 1;

      const item = items[index];
      if (item === undefined) {
        break;
      }
      await worker(item);
    }
  });

  await Promise.all(runners);
}

export class TranslationQueue {
  readonly #concurrency: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #send: SendTranslationRequest | undefined;
  readonly #stream: StreamTranslationRequest | undefined;
  readonly #onItem: ((item: TranslationStreamItem) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  #attempts = 0;
  #cancelled = false;

  constructor(options: TranslationQueueOptions) {
    const requested = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.#concurrency = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, requested));
    this.#maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? RETRY_BASE_DELAY_MS);
    this.#send = options.send;
    this.#stream = options.stream;
    this.#onItem = options.onItem;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get concurrency(): number {
    return this.#concurrency;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /**
   * 取消本次运行。
   *
   * 三处生效，缺一不可：
   *
   *   1. **不再领新任务**（`runWithConcurrency` 的 `shouldStop`）
   *   2. **不再重试**（`#attempt` 的重试循环）
   *   3. **不再增量渲染**（`#dispatchStream` 的 `onItem`）
   *
   * 第 3 条最容易被忽略，但它是「恢复原文后又自己变回译文」的**真正原因**：
   * 在途请求返回时仍会调 `onItem`，把译文重新写进 DOM。
   * 只做前两条的话，用户会看到译文在点完「恢复原文」之后又冒出来。
   *
   * 已经发出去的请求拦不住——这是 HTTP 的物理限制，不是实现偷懒。
   * 但用户感知到的是「不再越翻越多」，这就够了。
   */
  cancel(): void {
    this.#cancelled = true;
  }

  /**
   * 执行全部任务。
   *
   * 结果写入 `store`；单个任务失败不影响其他任务。
   */
  async run(tasks: readonly WireTranslateRequest[], store: PageStore): Promise<QueueRunResult> {
    const result: QueueRunResult = {
      tasks: tasks.length,
      succeeded: 0,
      failed: 0,
      translatedItems: 0,
      degraded: 0,
      attempts: 0,
      cancelled: false,
    };

    this.#attempts = 0;
    // 每次 run 都是一次新的运行——上次的取消不该影响这次
    this.#cancelled = false;

    await runWithConcurrency(
      tasks,
      this.#concurrency,
      async (task) => {
        await this.#executeTask(task, store, result);
      },
      () => this.#cancelled,
    );

    result.cancelled = this.#cancelled;
    result.attempts = this.#attempts;
    // 从 store 统计，而不是累加每次尝试的返回值——
    // 流式模式下条目是边到边写入的，失败的任务也可能已经成功了一部分
    result.translatedItems = countTranslated(tasks, store);
    return result;
  }

  /** 执行一个批次任务，失败时降级为单条重试。 */
  async #executeTask(
    task: WireTranslateRequest,
    store: PageStore,
    result: QueueRunResult,
  ): Promise<void> {
    // 取消后不再启动新批次，也不再改动这些 Block 的状态——
    // 它们应当留在 UNTRANSLATED，等用户下次翻译时被重新拾起
    if (this.#cancelled) {
      return;
    }

    const blockIds = task.items.map((item) => item.id);
    store.markMany(blockIds, 'QUEUED');
    store.markMany(blockIds, 'TRANSLATING');

    const outcome = await this.#attempt(task, store);

    // 注意：这里**不按取消状态拦截**。
    //
    // 已经完成并返回的批次，译文是花了钱的——用户点「取消」的语义是
    // 「别再往下翻了」，不是「把已经翻好的扔掉」。
    // 真正要拦的是「取消之后才到达的流式条目」，那在 `#dispatchStream` 里处理。
    if (outcome.ok) {
      for (const item of outcome.items) {
        store.markTranslated(item.id, item.translation);
      }
      result.succeeded += 1;
      return;
    }

    // 失败时**只处理还没拿到译文的**。
    // 流式模式下条目边到边落库，一次中途失败可能已经成功了一部分——
    // 那些已经渲染出去的译文不该被推回 FAILED 再翻一遍。
    const failedIds = blockIds.filter((id) => store.get(id)?.status !== 'TRANSLATED');

    if (failedIds.length === 0) {
      result.succeeded += 1;
      return;
    }

    // 单条任务再失败就没什么可降级的了
    if (task.items.length === 1) {
      for (const blockId of failedIds) {
        store.markFailed(blockId, outcome.reason);
      }
      result.failed += 1;
      return;
    }

    // 降级：把没拿到的拆成单条重试
    result.degraded += 1;
    const singles = task.items
      .filter((item) => failedIds.includes(item.id))
      .map<WireTranslateRequest>((item) => ({ ...task, items: [item] }));

    let failedSingles = 0;

    await runWithConcurrency(singles, this.#concurrency, async (single) => {
      const singleIds = single.items.map((item) => item.id);
      store.markMany(singleIds, 'TRANSLATING');

      const singleOutcome = await this.#attempt(single, store);

      if (singleOutcome.ok) {
        for (const item of singleOutcome.items) {
          store.markTranslated(item.id, item.translation);
        }
        return;
      }

      failedSingles += 1;
      for (const blockId of singleIds) {
        if (store.get(blockId)?.status !== 'TRANSLATED') {
          store.markFailed(blockId, singleOutcome.reason);
        }
      }
    });

    // 降级后仍然全成功，就当作这个批次成功了——`succeeded + failed` 始终等于任务数
    if (failedSingles === 0) {
      result.succeeded += 1;
    } else {
      result.failed += 1;
    }
  }

  /**
   * 带重试地发送一次请求。
   *
   * 只对 `retryable === true` 的错误重试（网络错误 / 超时 / 429 / 5xx /
   * 上游结构校验失败），确定性错误（4xx 参数问题、配置错误）直接放弃。
   *
   * 每次尝试前都会**剔除已经拿到译文的条目**：流式失败后重试时，
   * 已经成功的部分不该再翻一遍（既省 token，也避免覆盖已渲染的内容）。
   */
  async #attempt(
    task: WireTranslateRequest,
    store: PageStore,
  ): Promise<
    { ok: true; items: { id: string; translation: string }[] } | { ok: false; reason: string }
  > {
    let lastReason = '未知错误';

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const pending = task.items.filter((item) => store.get(item.id)?.status !== 'TRANSLATED');
      if (pending.length === 0) {
        return { ok: true, items: [] };
      }

      const payload: WireTranslateRequest = { ...task, items: pending };
      this.#attempts += 1;

      try {
        return await this.#dispatch(payload, store);
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);

        const canRetry = attempt < this.#maxRetries && isRetryable(error);
        if (!canRetry) {
          break;
        }

        await this.#sleep(this.#retryDelayMs * 2 ** attempt);
      }
    }

    return { ok: false, reason: lastReason };
  }

  /** 按是否配置了流式实现选择发送方式。 */
  async #dispatch(
    payload: WireTranslateRequest,
    store: PageStore,
  ): Promise<{ ok: true; items: { id: string; translation: string }[] }> {
    if (this.#stream !== undefined) {
      return await this.#dispatchStream(payload, store);
    }

    if (this.#send === undefined) {
      throw new Error('TranslationQueue 需要 send 或 stream 之一');
    }

    const wireResponse = await this.#send(payload);
    return { ok: true, items: fromWireResponse(wireResponse).items };
  }

  /**
   * 流式发送：条目边到边落库并回调。
   *
   * 只有 `done` 才算成功。中途 `error` 会抛错，让 `#attempt` 决定是否重试——
   * 那时已经落库的条目会被 `#attempt` 的剔除逻辑排除掉。
   */
  async #dispatchStream(
    payload: WireTranslateRequest,
    store: PageStore,
  ): Promise<{ ok: true; items: { id: string; translation: string }[] }> {
    const stream = this.#stream;
    if (stream === undefined) {
      throw new Error('未配置流式实现');
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      const items: { id: string; translation: string }[] = [];

      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        action();
      };

      stream(payload, {
        onItem: (item) => {
          // 取消后**连 items 都不收**——只拦 store 写入是不够的：
          // `outcome.items` 会被 `#executeTask` 拿去标记已翻译，
          // 于是用户点完「恢复原文」又会看到译文冒出来。
          //
          // 取消前已经收到的条目保留（钱已经花了），取消后到达的丢弃。
          if (this.#cancelled) {
            return;
          }

          items.push({ id: item.id, translation: item.translation });
          store.markTranslated(item.id, item.translation);
          this.#onItem?.(item);
        },
        onDone: () => {
          settle(() => {
            resolve({ ok: true, items });
          });
        },
        onError: (reason) => {
          settle(() => {
            reject(new Error(reason));
          });
        },
      });
    });
  }
}
