import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PageStore } from '@/core/store';
import type {
  BlockType,
  MessageResponse,
  TranslationBlock,
  WireTranslateRequest,
  WireTranslateResponse,
} from '@/shared/types';

import { buildTasks, planTranslation, sendViaBackground } from './translator';

function makeBlock(
  id: string,
  text: string,
  blockType: BlockType = 'paragraph',
  element?: HTMLElement,
): TranslationBlock {
  return {
    id,
    nodeIds: [`${id}-node-0`],
    text,
    plainText: text,
    tagName: blockType === 'heading' ? 'H2' : 'P',
    blockType,
    placeholders: [],
    element: element ?? document.createElement('p'),
  };
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

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('planTranslation — 批次规划', () => {
  it('空输入返回空计划', () => {
    const plan = planTranslation([]);

    expect(plan.batches).toEqual([]);
    expect(plan.contextGroups).toEqual([]);
  });

  it('每个 Block 恰好出现在一个批次中', () => {
    const store = new PageStore();
    store.registerAll(
      Array.from({ length: 30 }, (_unused, index) =>
        makeBlock(`block-${String(index + 1).padStart(3, '0')}`, `Paragraph ${index}.`),
      ),
    );

    const plan = planTranslation(
      store.all().map((entry) => entry.block),
      { viewportHeight: 800 },
    );
    const ids = plan.batches.flatMap((batch) => batch.blockIds);

    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('批次携带其所属的上下文', () => {
    const store = new PageStore();
    store.registerAll([
      makeBlock('block-001', 'Title', 'heading'),
      makeBlock('block-002', 'Body text.'),
    ]);

    const plan = planTranslation(
      store.all().map((entry) => entry.block),
      { viewportHeight: 800 },
    );

    expect(plan.batches[0]?.contextId).toBe('ctx-001');
    expect(plan.batches[0]?.context).toBe('Title\nBody text.');
  });

  it('批次按优先级排序（视口内的批次优先）', () => {
    const visible = document.createElement('p');
    const far = document.createElement('p');
    document.body.append(far, visible);

    const store = new PageStore();
    store.registerAll([
      makeBlock('far-001', 'Far away paragraph text.', 'paragraph', far),
      makeBlock('visible-001', 'Visible paragraph text.', 'paragraph', visible),
    ]);

    const positions = new Map<Element, number>([
      [far, 5000],
      [visible, 100],
    ]);

    const plan = planTranslation(
      store.all().map((entry) => entry.block),
      {
        viewportHeight: 800,
        measure: (element) => {
          const top = positions.get(element) ?? 0;
          return { top, bottom: top + 50 };
        },
      },
    );

    // 两块内容都很短，会归入同一批次；这里验证的是组内顺序
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.blockIds).toEqual(['visible-001', 'far-001']);
  });

  it('heading 划分出的章节各自成批（不跨上下文）', () => {
    const store = new PageStore();
    store.registerAll([
      makeBlock('block-001', 'Section A heading', 'heading'),
      makeBlock('block-002', 'Section B heading', 'heading'),
    ]);

    const plan = planTranslation(
      store.all().map((entry) => entry.block),
      { viewportHeight: 800, contextMaxChars: 10 },
    );

    expect(plan.contextGroups).toHaveLength(2);
    for (const batch of plan.batches) {
      expect(batch.blockIds).toHaveLength(1);
    }
  });
});

describe('buildTasks — 产出队列可直接执行的请求', () => {
  it('每个批次产出一个请求', () => {
    const store = new PageStore();
    store.registerAll([
      makeBlock('block-001', 'a'.repeat(3000)),
      makeBlock('block-002', 'b'.repeat(3000)),
    ]);

    const options = { viewportHeight: 800, maxCharsPerBatch: 3500 };
    const tasks = buildTasks(
      planTranslation(
        store.all().map((entry) => entry.block),
        options,
      ),
      options,
    );

    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.items).toHaveLength(1);
  });

  it('请求携带目标语言、风格与共享上下文', () => {
    const store = new PageStore();
    store.registerAll([
      makeBlock('block-001', 'Title', 'heading'),
      makeBlock('block-002', 'Body.'),
    ]);

    const options = {
      viewportHeight: 800,
      targetLanguage: 'zh-CN',
      style: 'academic' as const,
    };
    const tasks = buildTasks(
      planTranslation(
        store.all().map((entry) => entry.block),
        options,
      ),
      options,
    );

    expect(tasks[0]?.target_language).toBe('zh-CN');
    expect(tasks[0]?.style).toBe('academic');
    expect(tasks[0]?.context_id).toBe('ctx-001');
    expect(tasks[0]?.context).toContain('Body.');
  });

  it('线上格式为 snake_case', () => {
    const store = new PageStore();
    store.registerAll([makeBlock('block-001', 'Hello world.')]);

    const options = { viewportHeight: 800 };
    const tasks = buildTasks(
      planTranslation(
        store.all().map((entry) => entry.block),
        options,
      ),
      options,
    );
    const task = tasks[0];

    expect(task).toBeDefined();
    expect(task).toHaveProperty('source_language');
    expect(task).toHaveProperty('target_language');
    expect(task).toHaveProperty('items');
    expect(task).not.toHaveProperty('sourceLanguage');
  });

  it('任务只含 id 与 text，不含 DOM 引用', () => {
    const store = new PageStore();
    store.registerAll([makeBlock('block-001', 'Hello world.')]);

    const options = { viewportHeight: 800 };
    const tasks = buildTasks(
      planTranslation(
        store.all().map((entry) => entry.block),
        options,
      ),
      options,
    );

    expect(tasks[0]?.items[0]).toEqual({ id: 'block-001', text: 'Hello world.' });
  });

  it('空计划产出空数组', () => {
    expect(buildTasks({ batches: [], contextGroups: [] })).toEqual([]);
  });
});

describe('sendViaBackground — 必须保留 retryable 标记', () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;

  function stubChrome(response: MessageResponse<WireTranslateResponse>): void {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { sendMessage: async () => response },
    };
  }

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it('成功时返回 data', async () => {
    const payload = makeTask(['block-001']);
    stubChrome({ ok: true, data: okResponse(payload) });

    await expect(sendViaBackground(payload)).resolves.toMatchObject({ model: 'stub' });
  });

  it('失败时抛 ServerError 并保留 retryable=true', async () => {
    // 这是回归防线：曾经这里抛的是普通 Error，导致网络错误与 429
    // 跨消息边界丢掉标记，被 core/queue 当成确定性失败而放弃重试
    stubChrome({ ok: false, error: '429 Too Many Requests', retryable: true });

    await expect(sendViaBackground(makeTask(['block-001']))).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('不可重试的失败标记为 retryable=false', async () => {
    stubChrome({ ok: false, error: '422 参数错误' });

    await expect(sendViaBackground(makeTask(['block-001']))).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('data 缺失时也视为失败', async () => {
    stubChrome({ ok: true });

    await expect(sendViaBackground(makeTask(['block-001']))).rejects.toThrow('翻译请求失败');
  });
});
