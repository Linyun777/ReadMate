import { beforeEach, describe, expect, it } from 'vitest';

import { PageStore } from '@/core/store';
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from '@/shared/constants';
import type {
  StreamTranslationRequest,
  TranslationBlock,
  WireTranslateRequest,
  WireTranslateResponse,
} from '@/shared/types';

import { TranslationQueue, type TranslationQueueOptions } from './translation-queue';

function makeBlock(id: string): TranslationBlock {
  const text = `Text for ${id}.`;

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

function makeStore(ids: readonly string[]): PageStore {
  const store = new PageStore();
  store.registerAll(ids.map((id) => makeBlock(id)));
  return store;
}

function makeTask(ids: readonly string[]): WireTranslateRequest {
  return {
    source_language: 'auto',
    target_language: 'zh-CN',
    style: 'natural',
    items: ids.map((id) => ({ id, text: `Text for ${id}.` })),
  };
}

function okResponse(payload: WireTranslateRequest): WireTranslateResponse {
  return {
    context_id: payload.context_id ?? null,
    prompt_version: 'v1',
    model: 'stub',
    items: payload.items.map((item) => ({
      id: item.id,
      source: item.text,
      translation: `【译】${item.text}`,
    })),
  };
}

/** 构造带 retryable 标记的错误，模拟 `ServerError`。 */
function retryableError(message: string): Error {
  return Object.assign(new Error(message), { retryable: true });
}

function fatalError(message: string): Error {
  return Object.assign(new Error(message), { retryable: false });
}

/** 测试里一律免去真实等待。 */
const noSleep = async (): Promise<void> => {};

function makeQueue(
  overrides: Partial<TranslationQueueOptions> & Pick<TranslationQueueOptions, 'send'>,
): TranslationQueue {
  return new TranslationQueue({ sleep: noSleep, ...overrides });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('TranslationQueue · 并发（Phase 8 验收标准）', () => {
  it('并发稳定在 3', async () => {
    const ids = Array.from({ length: 9 }, (_unused, index) => `b${index + 1}`);
    const store = makeStore(ids);

    let inFlight = 0;
    let peak = 0;

    const queue = makeQueue({
      send: async (payload) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return okResponse(payload);
      },
    });

    const result = await queue.run(
      ids.map((id) => makeTask([id])),
      store,
    );

    expect(peak).toBe(3);
    expect(result.succeeded).toBe(9);
  });

  it('并发数会被夹到 1–5', () => {
    const send = async (payload: WireTranslateRequest): Promise<WireTranslateResponse> =>
      okResponse(payload);

    expect(makeQueue({ send, concurrency: 0 }).concurrency).toBe(MIN_CONCURRENCY);
    expect(makeQueue({ send, concurrency: 99 }).concurrency).toBe(MAX_CONCURRENCY);
    expect(makeQueue({ send, concurrency: 4 }).concurrency).toBe(4);
  });

  it('任务数少于并发度时不会多开 worker', async () => {
    const store = makeStore(['b1']);

    let inFlight = 0;
    let peak = 0;

    const queue = makeQueue({
      send: async (payload) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return okResponse(payload);
      },
    });

    await queue.run([makeTask(['b1'])], store);

    expect(peak).toBe(1);
  });

  it('空任务列表直接返回', async () => {
    const result = await makeQueue({
      send: async (payload) => okResponse(payload),
    }).run([], makeStore([]));

    expect(result).toMatchObject({ tasks: 0, succeeded: 0, failed: 0, attempts: 0 });
  });
});

describe('TranslationQueue · 重试（方案第 73 节）', () => {
  it('可重试错误会重试，成功即停', async () => {
    const store = makeStore(['b1']);
    let calls = 0;

    const queue = makeQueue({
      maxRetries: 2,
      send: async (payload) => {
        calls += 1;
        if (calls < 3) {
          throw retryableError('429');
        }
        return okResponse(payload);
      },
    });

    const result = await queue.run([makeTask(['b1'])], store);

    expect(calls).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.attempts).toBe(3);
    expect(store.get('b1')?.status).toBe('TRANSLATED');
  });

  it('超过重试上限后放弃', async () => {
    const store = makeStore(['b1']);
    let calls = 0;

    const queue = makeQueue({
      maxRetries: 2,
      send: async () => {
        calls += 1;
        throw retryableError('500');
      },
    });

    const result = await queue.run([makeTask(['b1'])], store);

    // 首次 + 2 次重试
    expect(calls).toBe(3);
    expect(result.failed).toBe(1);
    expect(store.get('b1')?.status).toBe('FAILED');
  });

  it('不可重试错误立即放弃，不浪费请求', async () => {
    const store = makeStore(['b1']);
    let calls = 0;

    const queue = makeQueue({
      maxRetries: 2,
      send: async () => {
        calls += 1;
        throw fatalError('422 参数错误');
      },
    });

    const result = await queue.run([makeTask(['b1'])], store);

    expect(calls).toBe(1);
    expect(result.failed).toBe(1);
    expect(store.get('b1')?.error).toBe('422 参数错误');
  });

  it('退避延迟按 2 的幂增长', async () => {
    const store = makeStore(['b1']);
    const delays: number[] = [];

    const queue = new TranslationQueue({
      maxRetries: 2,
      retryDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
      send: async () => {
        throw retryableError('500');
      },
    });

    await queue.run([makeTask(['b1'])], store);

    expect(delays).toEqual([100, 200]);
  });

  it('maxRetries 为 0 时只尝试一次', async () => {
    const store = makeStore(['b1']);
    let calls = 0;

    const queue = makeQueue({
      maxRetries: 0,
      send: async () => {
        calls += 1;
        throw retryableError('500');
      },
    });

    await queue.run([makeTask(['b1'])], store);

    expect(calls).toBe(1);
  });
});

describe('TranslationQueue · 失败降级（方案第 86.9 节）', () => {
  it('批次重试耗尽后降级为单条，只有坏的那条失败', async () => {
    const store = makeStore(['b1', 'b2', 'b3']);

    let batchCalls = 0;
    let singleCalls = 0;

    const queue = makeQueue({
      maxRetries: 2,
      send: async (payload) => {
        if (payload.items.length > 1) {
          batchCalls += 1;
          throw retryableError('批次失败');
        }

        singleCalls += 1;
        const id = payload.items[0]?.id;
        if (id === 'b2') {
          throw fatalError('这条内容有问题');
        }
        return okResponse(payload);
      },
    });

    const result = await queue.run([makeTask(['b1', 'b2', 'b3'])], store);

    expect(batchCalls).toBe(3); // 首次 + 2 次重试
    expect(singleCalls).toBe(3); // 三条各一次

    expect(result.degraded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.translatedItems).toBe(2);

    expect(store.get('b1')?.status).toBe('TRANSLATED');
    expect(store.get('b2')?.status).toBe('FAILED');
    expect(store.get('b2')?.error).toBe('这条内容有问题');
    expect(store.get('b3')?.status).toBe('TRANSLATED');
  });

  it('降级后全部成功则计入 succeeded', async () => {
    const store = makeStore(['b1', 'b2']);

    const queue = makeQueue({
      maxRetries: 1,
      send: async (payload) => {
        if (payload.items.length > 1) {
          throw retryableError('批次失败');
        }
        return okResponse(payload);
      },
    });

    const result = await queue.run([makeTask(['b1', 'b2'])], store);

    expect(result.degraded).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(store.byStatus('TRANSLATED')).toHaveLength(2);
  });

  it('单条任务失败不再降级', async () => {
    const store = makeStore(['b1']);

    const queue = makeQueue({
      maxRetries: 1,
      send: async () => {
        throw retryableError('500');
      },
    });

    const result = await queue.run([makeTask(['b1'])], store);

    expect(result.degraded).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('succeeded + failed 始终等于任务数', async () => {
    const store = makeStore(['b1', 'b2', 'b3', 'b4']);

    const queue = makeQueue({
      maxRetries: 1,
      send: async (payload) => {
        if (payload.items[0]?.id === 'b2') {
          throw fatalError('坏块');
        }
        if (payload.items.length > 1) {
          throw retryableError('批次失败');
        }
        return okResponse(payload);
      },
    });

    const result = await queue.run([makeTask(['b1', 'b2']), makeTask(['b3', 'b4'])], store);

    expect(result.succeeded + result.failed).toBe(result.tasks);
  });
});

describe('TranslationQueue · 隔离性（Phase 8 验收标准）', () => {
  it('单个批次失败不影响其他批次', async () => {
    const store = makeStore(['b1', 'b2', 'b3']);

    const queue = makeQueue({
      concurrency: 1,
      maxRetries: 0,
      send: async (payload) => {
        if (payload.items[0]?.id === 'b2') {
          throw fatalError('这批坏了');
        }
        return okResponse(payload);
      },
    });

    const result = await queue.run([makeTask(['b1']), makeTask(['b2']), makeTask(['b3'])], store);

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(store.byStatus('TRANSLATED')).toHaveLength(2);
    expect(store.byStatus('FAILED')).toHaveLength(1);
  });

  it('并发执行时异常不会中断其他任务', async () => {
    const ids = Array.from({ length: 6 }, (_unused, index) => `b${index + 1}`);
    const store = makeStore(ids);

    const queue = makeQueue({
      maxRetries: 0,
      send: async (payload) => {
        const id = payload.items[0]?.id;
        if (id === 'b2' || id === 'b5') {
          throw fatalError('坏块');
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
        return okResponse(payload);
      },
    });

    const result = await queue.run(
      ids.map((id) => makeTask([id])),
      store,
    );

    expect(result.succeeded).toBe(4);
    expect(result.failed).toBe(2);
  });
});

describe('TranslationQueue · 状态迁移', () => {
  it('成功路径经过 QUEUED → TRANSLATING → TRANSLATED', async () => {
    const store = makeStore(['b1']);
    const seen: string[] = [];

    const queue = makeQueue({
      send: async (payload) => {
        seen.push(store.get('b1')?.status ?? 'missing');
        return okResponse(payload);
      },
    });

    await queue.run([makeTask(['b1'])], store);

    expect(seen).toEqual(['TRANSLATING']);
    expect(store.get('b1')?.status).toBe('TRANSLATED');
  });

  it('失败后 resetFailed 可让它们重新进入待翻译集合', async () => {
    const store = makeStore(['b1']);

    const queue = makeQueue({
      maxRetries: 0,
      send: async () => {
        throw fatalError('boom');
      },
    });

    await queue.run([makeTask(['b1'])], store);

    expect(store.resetFailed()).toEqual(['b1']);
    expect(store.byStatus('UNTRANSLATED')).toHaveLength(1);
  });
});

describe('TranslationQueue · 流式（方案第 86.9 节）', () => {
  /** 构造流式替身：行为由 `behaviour` 决定，记录每次收到的 payload。 */
  function makeStreamStub(
    behaviour: (
      payload: WireTranslateRequest,
      sink: Parameters<StreamTranslationRequest>[1],
    ) => void,
  ) {
    const calls: WireTranslateRequest[] = [];

    const stream: StreamTranslationRequest = (payload, sink) => {
      calls.push(payload);
      behaviour(payload, sink);
      return { cancel: () => {} };
    };

    return { stream, calls };
  }

  /** 把整批按条依次下发，最后 done。 */
  function succeedAll(
    payload: WireTranslateRequest,
    sink: Parameters<StreamTranslationRequest>[1],
  ): void {
    for (const item of payload.items) {
      sink.onItem({ id: item.id, source: item.text, translation: `【译】${item.text}` });
    }
    sink.onDone({ promptVersion: 'v1', model: 'stub' });
  }

  it('流式成功后条目落库', async () => {
    const store = makeStore(['b1', 'b2']);
    const { stream } = makeStreamStub(succeedAll);

    const result = await new TranslationQueue({ stream }).run([makeTask(['b1', 'b2'])], store);

    expect(result.succeeded).toBe(1);
    expect(result.translatedItems).toBe(2);
    expect(store.get('b1')?.translation).toBe('【译】Text for b1.');
  });

  it('onItem 在每个条目到达时回调', async () => {
    const store = makeStore(['b1', 'b2']);
    const seen: string[] = [];
    const { stream } = makeStreamStub(succeedAll);

    await new TranslationQueue({
      stream,
      onItem: (item) => {
        seen.push(item.id);
      },
    }).run([makeTask(['b1', 'b2'])], store);

    expect(seen).toEqual(['b1', 'b2']);
  });

  it('条目是边到边落库的，不是等 done 才写', async () => {
    const store = makeStore(['b1']);
    const statusAtDone: string[] = [];

    const stream: StreamTranslationRequest = (payload, sink) => {
      const item = payload.items[0];
      if (item !== undefined) {
        sink.onItem({ id: item.id, source: item.text, translation: '【译】x' });
      }
      // 此刻 store 里就应该已经有译文了
      statusAtDone.push(store.get('b1')?.status ?? 'missing');
      sink.onDone({ promptVersion: 'v1', model: 'stub' });
      return { cancel: () => {} };
    };

    await new TranslationQueue({ stream }).run([makeTask(['b1'])], store);

    expect(statusAtDone).toEqual(['TRANSLATED']);
  });

  it('中途失败时已成功的条目被保留', async () => {
    const store = makeStore(['b1', 'b2', 'b3']);
    let round = 0;

    const stream: StreamTranslationRequest = (payload, sink) => {
      round += 1;

      // 只有第一轮的第一个条目成功，之后一律失败
      if (round === 1) {
        const first = payload.items[0];
        if (first !== undefined) {
          sink.onItem({ id: first.id, source: first.text, translation: '【译】ok' });
        }
      }
      sink.onError('流式传输中断');
      return { cancel: () => {} };
    };

    const result = await new TranslationQueue({ stream, maxRetries: 0 }).run(
      [makeTask(['b1', 'b2', 'b3'])],
      store,
    );

    // 第一个条目保住了，其余降级为单条后仍然失败
    expect(store.get('b1')?.status).toBe('TRANSLATED');
    expect(store.get('b2')?.status).toBe('FAILED');
    expect(store.get('b3')?.status).toBe('FAILED');
    expect(result.translatedItems).toBe(1);
    expect(result.degraded).toBe(1);
  });

  it('重试时剔除已经拿到译文的条目', async () => {
    const store = makeStore(['b1', 'b2']);
    const requested: string[][] = [];
    let round = 0;

    const stream: StreamTranslationRequest = (payload, sink) => {
      requested.push(payload.items.map((item) => item.id));
      round += 1;

      if (round === 1) {
        // 第一轮只成功 b1 就断了
        const first = payload.items[0];
        if (first !== undefined) {
          sink.onItem({ id: first.id, source: first.text, translation: '【译】ok' });
        }
        sink.onError('断了');
        return { cancel: () => {} };
      }

      succeedAll(payload, sink);
      return { cancel: () => {} };
    };

    const result = await new TranslationQueue({
      stream,
      maxRetries: 1,
      sleep: async () => {},
    }).run([makeTask(['b1', 'b2'])], store);

    // 第二轮只请求 b2
    expect(requested).toEqual([['b1', 'b2'], ['b2']]);
    expect(result.translatedItems).toBe(2);
    expect(store.byStatus('TRANSLATED')).toHaveLength(2);
  });

  it('流式下全部成功时 succeeded 计数正确', async () => {
    const store = makeStore(['b1', 'b2', 'b3']);
    const { stream } = makeStreamStub(succeedAll);

    const result = await new TranslationQueue({ stream }).run(
      [makeTask(['b1']), makeTask(['b2']), makeTask(['b3'])],
      store,
    );

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.translatedItems).toBe(3);
  });
});

describe('取消', () => {
  it('取消后不再领新任务', async () => {
    const store = makeStore(['a', 'b', 'c', 'd']);
    const started: string[] = [];
    let queue: TranslationQueue;

    queue = new TranslationQueue({
      concurrency: 1,
      maxRetries: 0,
      send: async (task) => {
        started.push(task.items[0]?.id ?? '?');
        // 第一个任务一开始就取消
        queue.cancel();
        return okResponse(task);
      },
    });

    const result = await queue.run(
      [makeTask(['a']), makeTask(['b']), makeTask(['c']), makeTask(['d'])],
      store,
    );

    expect(started).toEqual(['a']);
    expect(result.cancelled).toBe(true);
    expect(result.tasks).toBe(4);
  });

  it('取消后不再写 store（在途请求返回也不写）', async () => {
    const store = makeStore(['a']);
    const rendered: string[] = [];

    const queue = new TranslationQueue({
      concurrency: 1,
      maxRetries: 0,
      stream: (_payload, sink) => {
        // 模拟「请求已发出，取消发生在响应之前」
        queue.cancel();
        sink.onItem({ id: 'a', source: 'Text for a.', translation: '【译】late' });
        sink.onDone({ promptVersion: 'v1', model: 'stub' });
        return { cancel: () => undefined };
      },
      onItem: (item) => {
        rendered.push(item.id);
      },
    });

    await queue.run([makeTask(['a'])], store);

    // 关键：迟到的那条**不该被标记成已翻译**，也不该触发渲染。
    // （它会停在 TRANSLATING，由 `PageController.cancel()` 统一退回 UNTRANSLATED
    //   ——队列不负责「用户视角的状态」，只保证不写错。）
    expect(store.get('a')?.status).not.toBe('TRANSLATED');
    expect(rendered).toEqual([]);
  });

  it('取消不影响「已翻译」的条目', async () => {
    const store = makeStore(['a', 'b']);
    let queue: TranslationQueue;

    queue = new TranslationQueue({
      concurrency: 1,
      maxRetries: 0,
      send: async (task) => {
        if (task.items[0]?.id === 'b') {
          queue.cancel();
        }
        return okResponse(task);
      },
    });

    await queue.run([makeTask(['a']), makeTask(['b'])], store);

    expect(store.get('a')?.status).toBe('TRANSLATED');
    expect(store.get('b')?.status).toBe('TRANSLATED');
  });

  it('重新 run 会清掉上次的取消状态', async () => {
    const store = makeStore(['a']);
    const queue = new TranslationQueue({
      concurrency: 1,
      maxRetries: 0,
      send: async (task) => okResponse(task),
    });

    queue.cancel();
    expect(queue.cancelled).toBe(true);

    const result = await queue.run([makeTask(['a'])], store);

    expect(queue.cancelled).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(store.get('a')?.status).toBe('TRANSLATED');
  });

  it('未取消时 cancelled 为 false', async () => {
    const store = makeStore(['a']);
    const queue = new TranslationQueue({
      concurrency: 1,
      maxRetries: 0,
      send: async (task) => okResponse(task),
    });

    const result = await queue.run([makeTask(['a'])], store);

    expect(result.cancelled).toBe(false);
  });
});
