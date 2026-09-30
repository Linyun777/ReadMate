import { beforeEach, describe, expect, it } from 'vitest';

import type { TranslationBlock } from '@/shared/types';

import { segmentElement } from '../segmenter';
import { blockAnchor, getPageStore, PageStore, resetPageStore } from './page-store';

/** 构造一个最小可用的 Block，避免测试依赖分段器。 */
function makeBlock(id: string, text = 'Hello world', element?: Element): TranslationBlock {
  return {
    id,
    nodeIds: [`${id}-node-0`],
    text,
    plainText: text,
    tagName: 'P',
    blockType: 'paragraph',
    placeholders: [],
    element: element ?? document.createElement('p'),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetPageStore();
});

describe('PageStore — 注册与检索', () => {
  it('注册后可按 ID 取回', () => {
    const store = new PageStore();
    store.register(makeBlock('block-001'));

    expect(store.size).toBe(1);
    expect(store.has('block-001')).toBe(true);
    expect(store.get('block-001')?.block.id).toBe('block-001');
  });

  it('新注册的条目状态为 UNTRANSLATED', () => {
    const store = new PageStore();
    const entry = store.register(makeBlock('block-001'));

    expect(entry.status).toBe('UNTRANSLATED');
    expect(entry.translation).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  it('重复注册是幂等的，不会重置已有状态', () => {
    const store = new PageStore();
    store.register(makeBlock('block-001'));
    store.markTranslated('block-001', '你好');

    store.register(makeBlock('block-001'));

    expect(store.size).toBe(1);
    expect(store.get('block-001')?.status).toBe('TRANSLATED');
    expect(store.get('block-001')?.translation).toBe('你好');
  });

  it('未注册的 ID 返回 undefined，不抛错', () => {
    const store = new PageStore();

    expect(store.get('nope')).toBeUndefined();
    expect(store.setStatus('nope', 'QUEUED')).toBeUndefined();
  });

  it('registerAll 批量注册并保持顺序', () => {
    const store = new PageStore();
    store.registerAll([makeBlock('block-001'), makeBlock('block-002')]);

    expect(store.all().map((entry) => entry.block.id)).toEqual(['block-001', 'block-002']);
  });

  it('replaceAll 清空旧条目并重置页面状态', () => {
    const store = new PageStore();
    store.register(makeBlock('old-001'));
    store.setPageState('ACTIVE');

    store.replaceAll([makeBlock('new-001')]);

    expect(store.size).toBe(1);
    expect(store.has('old-001')).toBe(false);
    expect(store.pageState).toBe('IDLE');
  });
});

describe('PageStore — 状态迁移', () => {
  it('完整迁移链：UNTRANSLATED → QUEUED → TRANSLATING → TRANSLATED', () => {
    const store = new PageStore();
    store.register(makeBlock('block-001'));

    store.markQueued('block-001');
    expect(store.get('block-001')?.status).toBe('QUEUED');

    store.markTranslating('block-001');
    expect(store.get('block-001')?.status).toBe('TRANSLATING');

    store.markTranslated('block-001', '你好世界');
    expect(store.get('block-001')?.status).toBe('TRANSLATED');
    expect(store.get('block-001')?.translation).toBe('你好世界');
  });

  it('失败时记录错误原因', () => {
    const store = new PageStore();
    store.register(makeBlock('block-001'));

    store.markFailed('block-001', 'JSON 解析失败');

    expect(store.get('block-001')?.status).toBe('FAILED');
    expect(store.get('block-001')?.error).toBe('JSON 解析失败');
  });

  it('markMany 批量置状态（Batch 级操作）', () => {
    const store = new PageStore();
    store.registerAll([makeBlock('block-001'), makeBlock('block-002')]);

    store.markMany(['block-001', 'block-002'], 'TRANSLATING');

    expect(store.byStatus('TRANSLATING')).toHaveLength(2);
  });

  it('resetFailed 把失败条目退回 UNTRANSLATED 并清除错误', () => {
    const store = new PageStore();
    store.registerAll([makeBlock('block-001'), makeBlock('block-002')]);
    store.markFailed('block-001', '超时');
    store.markTranslated('block-002', '你好');

    const reset = store.resetFailed();

    expect(reset).toEqual(['block-001']);
    expect(store.get('block-001')?.status).toBe('UNTRANSLATED');
    expect(store.get('block-001')?.error).toBeUndefined();
    expect(store.get('block-002')?.status).toBe('TRANSLATED');
  });

  it('byStatuses 按多个状态筛选', () => {
    const store = new PageStore();
    store.registerAll([makeBlock('block-001'), makeBlock('block-002'), makeBlock('block-003')]);
    store.markTranslated('block-001', 'a');
    store.markFailed('block-002', 'b');

    expect(store.byStatuses(['TRANSLATED', 'FAILED']).map((entry) => entry.block.id)).toEqual([
      'block-001',
      'block-002',
    ]);
  });
});

describe('PageStore — 统计', () => {
  it('空存储的统计全为 0', () => {
    const store = new PageStore();

    expect(store.stats()).toEqual({
      total: 0,
      untranslated: 0,
      queued: 0,
      translating: 0,
      translated: 0,
      failed: 0,
      progress: 0,
    });
  });

  it('按状态计数并计算进度', () => {
    const store = new PageStore();
    store.registerAll([
      makeBlock('block-001'),
      makeBlock('block-002'),
      makeBlock('block-003'),
      makeBlock('block-004'),
    ]);
    store.markTranslated('block-001', 'a');
    store.markFailed('block-002', 'b');
    store.markQueued('block-003');

    const stats = store.stats();

    expect(stats).toMatchObject({
      total: 4,
      translated: 1,
      failed: 1,
      queued: 1,
      untranslated: 1,
      translating: 0,
    });
    // 已终结（成功 + 失败）= 2 / 4
    expect(stats.progress).toBe(0.5);
  });

  it('clear 清空条目并重置页面状态', () => {
    const store = new PageStore();
    store.register(makeBlock('block-001'));
    store.setPageState('TRANSLATING');

    store.clear();

    expect(store.size).toBe(0);
    expect(store.pageState).toBe('IDLE');
  });
});

describe('PageStore — 页面级状态机（方案第 75 节）', () => {
  it('默认 IDLE', () => {
    expect(new PageStore().pageState).toBe('IDLE');
  });

  it('可按生命周期推进', () => {
    const store = new PageStore();

    store.setPageState('SCANNING');
    expect(store.pageState).toBe('SCANNING');

    store.setPageState('TRANSLATING');
    expect(store.pageState).toBe('TRANSLATING');

    store.setPageState('ACTIVE');
    expect(store.pageState).toBe('ACTIVE');

    store.setPageState('PAUSED');
    expect(store.pageState).toBe('PAUSED');

    store.setPageState('RESTORED');
    expect(store.pageState).toBe('RESTORED');
  });
});

describe('集成：分段 → 注册 → 反查回 DOM', () => {
  it('Block 能记录其容器、全部节点与占位符绑定，并可反查', () => {
    document.body.innerHTML =
      '<p id="target">See <a href="#docs">the docs</a> before you start.</p>';

    const blocks = segmentElement(document.body, { targetLanguage: 'zh-CN' });
    const store = new PageStore();
    store.registerAll(blocks);

    const entry = store.get('block-001');
    expect(entry).toBeDefined();

    const block = entry?.block;
    expect(block?.element.id).toBe('target');
    expect(block?.nodeIds).toHaveLength(3);

    const anchor = block?.placeholders[0]?.element;
    expect(anchor?.tagName).toBe('A');
    expect(block?.element.contains(anchor ?? null)).toBe(true);
  });

  it('译文可写回条目并按 Block ID 取回', () => {
    document.body.innerHTML = '<p>See <a href="#docs">the docs</a> now.</p>';

    const store = new PageStore();
    store.registerAll(segmentElement(document.body, { targetLanguage: 'zh-CN' }));

    const blockId = store.all()[0]?.block.id;
    expect(blockId).toBeDefined();

    store.markTranslated(blockId ?? '', '请先看<0>文档</0>。');

    expect(store.get(blockId ?? '')?.translation).toBe('请先看<0>文档</0>。');
    expect(store.get(blockId ?? '')?.block.placeholders).toHaveLength(1);
  });
});

describe('PageStore · 按元素 upsert（Phase 10 动态内容）', () => {
  it('findByElement 能按容器反查', () => {
    const element = document.createElement('p');
    const store = new PageStore();
    const block = makeBlock('block-001', 'Hello.', element);

    store.register(block);

    expect(store.findByElement(element)?.block.id).toBe('block-001');
    expect(store.findByElement(document.createElement('p'))).toBeUndefined();
  });

  it('首次 upsert 返回 added', () => {
    const element = document.createElement('p');
    const store = new PageStore();

    expect(store.upsert(makeBlock('block-001', 'Hello.', element))).toBe('added');
    expect(store.size).toBe(1);
  });

  it('同容器同文本返回 unchanged，且不重置已有状态', () => {
    const element = document.createElement('p');
    const store = new PageStore();

    store.upsert(makeBlock('block-001', 'Hello.', element));
    store.markTranslated('block-001', '你好。');

    // ID 不同但容器与文本相同——重新分段会产生新的局部序号
    expect(store.upsert(makeBlock('dyn1-001', 'Hello.', element))).toBe('unchanged');
    expect(store.size).toBe(1);
    expect(store.get('block-001')?.status).toBe('TRANSLATED');
    expect(store.get('dyn1-001')).toBeUndefined();
  });

  it('同容器但文本变了返回 replaced，并重置为 UNTRANSLATED', () => {
    const element = document.createElement('p');
    const store = new PageStore();

    store.upsert(makeBlock('block-001', 'Hello.', element));
    store.markTranslated('block-001', '你好。');

    expect(store.upsert(makeBlock('dyn1-001', 'Hello there.', element))).toBe('replaced');
    expect(store.size).toBe(1);
    expect(store.get('block-001')).toBeUndefined();
    expect(store.get('dyn1-001')?.status).toBe('UNTRANSLATED');
    expect(store.findByElement(element)?.block.id).toBe('dyn1-001');
  });

  it('不同容器各自独立登记', () => {
    const store = new PageStore();
    const first = document.createElement('p');
    const second = document.createElement('p');

    expect(store.upsert(makeBlock('block-001', 'Hello.', first))).toBe('added');
    expect(store.upsert(makeBlock('dyn1-001', 'Hello.', second))).toBe('added');
    expect(store.size).toBe(2);
  });

  it('clear 之后元素索引也失效', () => {
    const element = document.createElement('p');
    const store = new PageStore();

    store.upsert(makeBlock('block-001', 'Hello.', element));
    store.clear();

    expect(store.findByElement(element)).toBeUndefined();
    expect(store.upsert(makeBlock('dyn1-001', 'Hello.', element))).toBe('added');
  });
});

describe('getPageStore — 共享实例', () => {
  it('多次调用返回同一实例', () => {
    expect(getPageStore()).toBe(getPageStore());
  });

  it('resetPageStore 后返回新实例', () => {
    const first = getPageStore();
    resetPageStore();

    expect(getPageStore()).not.toBe(first);
  });
});

/**
 * 拆大块：同一个容器下有多个 Block（方案第 57 节）。
 *
 * 容器本身不再能区分它们，所以身份锚点从「容器元素」推广成
 * 「容器元素 + 本段首个子节点」。未拆段时两者相同，历史行为不变。
 */
describe('PageStore — 拆大块的锚点（一个容器多个 Block）', () => {
  /** 造一个「拆段」块：容器相同，`range` 指向本段那一截节点。 */
  function makeRangedBlock(
    id: string,
    container: Element,
    text: string,
    nodes: Node[],
  ): TranslationBlock {
    return { ...makeBlock(id, text), element: container, range: { nodes } };
  }

  it('⭐ 同一容器的多段各自登记，靠首个子节点区分', () => {
    const container = document.createElement('p');
    const nodeA = document.createTextNode('A');
    const nodeB = document.createTextNode('B');
    container.append(nodeA, nodeB);

    const store = new PageStore();
    store.register(makeRangedBlock('block-001', container, 'A', [nodeA]));
    store.register(makeRangedBlock('block-002', container, 'B', [nodeB]));

    expect(store.size).toBe(2);
    expect(store.findByAnchor(nodeA)?.block.id).toBe('block-001');
    expect(store.findByAnchor(nodeB)?.block.id).toBe('block-002');
    // 容器本身不再是锚点——它下面有多个块，指向哪一段是不确定的
    expect(store.findByElement(container)).toBeUndefined();
  });

  it('upsert 按锚点去重：文本没变就 unchanged，变了才 replaced', () => {
    const container = document.createElement('p');
    const node = document.createTextNode('A');
    container.append(node);

    const store = new PageStore();

    expect(store.upsert(makeRangedBlock('block-001', container, 'A', [node]))).toBe('added');
    expect(store.upsert(makeRangedBlock('dyn1-001', container, 'A', [node]))).toBe('unchanged');
    expect(store.upsert(makeRangedBlock('dyn2-001', container, 'A changed', [node]))).toBe(
      'replaced',
    );
    expect(store.size).toBe(1);
  });

  it('未拆段的块仍然按容器元素反查（历史行为不变）', () => {
    const element = document.createElement('p');
    const store = new PageStore();
    store.register(makeBlock('block-001', 'Hello.', element));

    expect(store.findByElement(element)?.block.id).toBe('block-001');
    expect(store.findByAnchor(element)?.block.id).toBe('block-001');
  });

  it('blockAnchor：未拆段取容器，拆段取本段首节点', () => {
    const container = document.createElement('p');
    const node = document.createTextNode('A');
    container.append(node);

    expect(blockAnchor(makeBlock('block-001', 'Hello.', container))).toBe(container);
    expect(blockAnchor(makeRangedBlock('block-002', container, 'A', [node]))).toBe(node);
  });
});
