import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_SELECTION_LENGTH, readSelection } from './selection-context';

/**
 * 选区读取（方案第 41 节）。
 *
 * 「上下文」是这里的关键：只把选中的三个词发给模型，解释质量会差很多——
 * 同一个词在不同语境里意思可能完全不同。
 */

function selectNode(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);

  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

describe('readSelection — 基本行为', () => {
  it('没有选区时返回 null', () => {
    document.body.innerHTML = '<p>一段文字。</p>';

    expect(readSelection(document)).toBeNull();
  });

  it('折叠的选区（只是点了下光标）返回 null', () => {
    document.body.innerHTML = '<p>一段文字。</p>';
    const paragraph = document.querySelector('p');
    if (paragraph === null) {
      throw new Error('缺少测试节点');
    }

    const range = document.createRange();
    range.setStart(paragraph.firstChild ?? paragraph, 0);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(readSelection(document)).toBeNull();
  });

  it('选中文字后返回文字与上下文', () => {
    document.body.innerHTML =
      '<p id="target">We look for engineers with high-agency ownership who drive work.</p>';

    const paragraph = document.querySelector('#target');
    if (paragraph === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(paragraph);

    const info = readSelection(document);

    expect(info?.selection).toContain('high-agency');
    expect(info?.context).toContain('engineers');
  });

  it('上下文取整个块级容器，而不是整页', () => {
    document.body.innerHTML =
      '<div><p>第一段无关内容。</p><p id="target">目标段落里的文字。</p></div>';

    const target = document.querySelector('#target');
    if (target === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(target);

    const info = readSelection(document);

    expect(info?.context).toContain('目标段落');
    expect(info?.context).not.toContain('第一段');
  });

  it('选区两端空白被去掉', () => {
    document.body.innerHTML = '<p id="target">  两端有空白  </p>';

    const target = document.querySelector('#target');
    if (target === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(target);

    expect(readSelection(document)?.selection).toBe('两端有空白');
  });
});

describe('readSelection — 拒绝的情况', () => {
  it('超长选区返回 null（那是「总结」而不是「解释」）', () => {
    document.body.innerHTML = `<p id="target">${'x'.repeat(MAX_SELECTION_LENGTH + 100)}</p>`;

    const target = document.querySelector('#target');
    if (target === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(target);

    expect(readSelection(document)).toBeNull();
  });

  it('选中的是插件自己插入的节点时返回 null', () => {
    document.body.innerHTML =
      '<p>正文。</p><div data-ai-translator="true" id="plugin">译文内容</div>';

    const plugin = document.querySelector('#plugin');
    if (plugin === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(plugin);

    expect(readSelection(document)).toBeNull();
  });

  it('选中插件节点的后代也返回 null', () => {
    document.body.innerHTML =
      '<div data-ai-translator="true"><span id="inner">译文片段</span></div>';

    const inner = document.querySelector('#inner');
    if (inner === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(inner);

    expect(readSelection(document)).toBeNull();
  });
});

describe('readSelection — 站点适配', () => {
  it('extraBlockTags 影响上下文的边界', () => {
    document.body.innerHTML =
      '<shreddit-post><shreddit-text-body id="target">Reddit 的自定义元素正文。</shreddit-text-body></shreddit-post>';

    const target = document.querySelector('#target');
    if (target === null) {
      throw new Error('缺少测试节点');
    }
    selectNode(target);

    // 不传 extraBlockTags：容器会一路向上找到 div/body，上下文更长
    const withoutExtra = readSelection(document);
    // 传了之后：容器就是 shreddit-text-body 本身
    const withExtra = readSelection(document, { extraBlockTags: ['SHREDDIT-TEXT-BODY'] });

    expect(withoutExtra?.selection).toBeTruthy();
    expect(withExtra?.context).toBe('Reddit 的自定义元素正文。');
  });
});
