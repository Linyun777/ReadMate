import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { segmentElement } from '@/core/segmenter';
import type { TranslationBlock } from '@/shared/types';

import { Renderer, stripInsertedNodes } from './renderer';

/** 挂载 HTML 并分段，返回 Block 列表（测试用真实 Segmenter，保证与生产链路一致）。 */
function setup(html: string): TranslationBlock[] {
  document.body.innerHTML = html;
  return segmentElement(document.body, { targetLanguage: 'zh-CN' });
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error('期望至少一个元素');
  }
  return item;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Renderer · 中文模式', () => {
  it('用译文替换原文', () => {
    const block = first(setup('<p>Hello world.</p>'));
    const renderer = new Renderer();

    expect(renderer.render(block, '你好，世界。', 'chinese')).toEqual({ ok: true });
    expect(document.querySelector('p')?.textContent).toBe('你好，世界。');
  });

  it('复用 inline 元素对象，不重建 DOM 结构（铁律第 3 条）', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const strong = block.placeholders[0]?.element;

    new Renderer().render(block, '现在阅读<0>文档</0>。', 'chinese');

    expect(document.querySelector('p strong')).toBe(strong);
    expect(strong?.textContent).toBe('文档');
  });

  it('占位符被重排时按译文顺序重建子节点', () => {
    const block = first(
      setup(
        '<p>The <strong>LLM</strong> returns a <em>JSON</em> payload over <a href="#http">HTTP</a>.</p>',
      ),
    );
    const elements = block.placeholders.map((binding) => binding.element);
    const [strong, em, anchor] = elements;

    const result = new Renderer().render(
      block,
      '<0>LLM</0>通过<2>HTTP</2>返回一个<1>JSON</1>负载。',
      'chinese',
    );

    expect(result).toEqual({ ok: true });

    const paragraph = document.querySelector('p');
    expect(paragraph?.textContent).toBe('LLM通过HTTP返回一个JSON负载。');
    // 元素对象被复用，只是顺序变了
    expect(Array.from(paragraph?.children ?? [])).toEqual([strong, anchor, em]);
    expect(strong?.textContent).toBe('LLM');
    expect(anchor?.textContent).toBe('HTTP');
    expect(em?.textContent).toBe('JSON');
  });

  it('原子占位符（br）保留', () => {
    const block = first(setup('<p>Line one<br>Line two</p>'));
    const br = block.placeholders[0]?.node;

    new Renderer().render(block, '第一行<0/>第二行', 'chinese');

    const paragraph = document.querySelector('p');
    expect(paragraph?.textContent).toBe('第一行第二行');
    expect(paragraph?.querySelector('br')).toBe(br);
  });

  it('⭐ 行内 code 的标识符原样保留（占位符内容不被翻译）', () => {
    const block = first(setup('<p>Run <code>npm install</code> first.</p>'));

    // 模型把占位符里的标识符原样带回来——这正是成对占位符的价值：
    // 它看得见 `npm install`，不会像面对 `<0/>` 那样把它丢掉
    new Renderer().render(block, '先运行<0>npm install</0>。', 'chinese');

    expect(document.querySelector('code')?.textContent).toBe('npm install');
    expect(document.querySelector('p')?.textContent).toBe('先运行npm install。');
  });

  it('行内 code 里的标识符被改写时也照原样落回（模型不该改，但不阻止）', () => {
    // 不阻止的原因：验证只管占位符索引与配对，不管内容——
    // 想拦住得再引一层语义校验，代价远大于收益
    const block = first(setup('<p>Run <code>npm install</code> first.</p>'));

    new Renderer().render(block, '先运行<0>npm 安装</0>。', 'chinese');

    expect(document.querySelector('code')?.textContent).toBe('npm 安装');
  });

  it('嵌套占位符', () => {
    const block = first(setup('<p><a href="#x"><strong>Bold link</strong></a> and text.</p>'));

    new Renderer().render(block, '<0><1>粗体链接</1></0>以及文本。', 'chinese');

    expect(document.querySelector('a strong')?.textContent).toBe('粗体链接');
    expect(document.querySelector('p')?.textContent).toBe('粗体链接以及文本。');
  });

  it('容器内的块级后代不被破坏', () => {
    const block = first(setup('<div>before<p>inside</p>after</div>'));

    new Renderer().render(block, '之前之后', 'chinese');

    const container = document.querySelector('div');
    expect(container?.querySelector('p')?.textContent).toBe('inside');
    expect(container?.textContent).toBe('之前之后inside');
  });

  it('译文中的 HTML 字符按纯文本写入，不被解析（铁律第 2 条）', () => {
    const block = first(setup('<p>Hello world.</p>'));

    new Renderer().render(block, '<img src=x onerror=alert(1)>你好', 'chinese');

    const paragraph = document.querySelector('p');
    expect(paragraph?.querySelector('img')).toBeNull();
    expect(paragraph?.textContent).toBe('<img src=x onerror=alert(1)>你好');
  });
});

describe('Renderer · 双语模式', () => {
  it('heading / paragraph 在原文之后追加同级 div', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));

    new Renderer().render(block, '现在阅读<0>文档</0>。', 'bilingual');

    const paragraph = document.querySelector('p');
    expect(paragraph?.textContent).toBe('Read the docs now.');

    const holder = paragraph?.nextElementSibling;
    expect(holder?.tagName).toBe('DIV');
    expect(holder?.getAttribute('data-ai-translator')).toBe('true');
    // 双语译文是纯文本，不复制 inline 结构
    expect(holder?.textContent).toBe('现在阅读文档。');
    expect(holder?.querySelector('strong')).toBeNull();
  });

  it('table 在单元格内追加 span', () => {
    const blocks = setup('<table><tr><td>Model</td></tr></table>');
    const block = blocks.find((item) => item.blockType === 'table');
    if (!block) {
      throw new Error('未找到表格 Block');
    }

    new Renderer().render(block, '模型', 'bilingual');

    const cell = document.querySelector('td');
    expect(cell?.textContent).toBe('Model模型');
    expect(cell?.querySelector('span[data-ai-translator="true"]')?.textContent).toBe('模型');
  });

  it('inline Block 走替换而非追加（方案第 86.2 节）', () => {
    const block = first(setup('<span>Loose text here.</span>'));

    new Renderer().render(block, '这里是散落文本。', 'bilingual');

    expect(document.querySelector('span')?.textContent).toBe('这里是散落文本。');
    expect(document.querySelector('[data-ai-translator="true"]')).toBeNull();
  });

  it('原文完全不被改动', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const strong = block.placeholders[0]?.element;

    new Renderer().render(block, '现在阅读<0>文档</0>。', 'bilingual');

    expect(document.querySelector('p')?.textContent).toBe('Read the docs now.');
    expect(strong?.textContent).toBe('docs');
  });
});

describe('Renderer · 结构校验失败绝不渲染（铁律第 5 条）', () => {
  it('缺少占位符时拒绝渲染且不触碰 DOM', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    const result = renderer.render(block, '现在阅读文档。', 'chinese');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('缺少');
    }
    expect(document.body.innerHTML).toBe(before);
    expect(renderer.renderedCount).toBe(0);
  });

  it('多出占位符时拒绝渲染', () => {
    const block = first(setup('<p>Hello world.</p>'));
    const before = document.body.innerHTML;

    const result = new Renderer().render(block, '你好<0>世界</0>', 'chinese');

    expect(result.ok).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });

  it('双语模式下同样先校验', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const before = document.body.innerHTML;

    const result = new Renderer().render(block, '现在阅读文档。', 'bilingual');

    expect(result.ok).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('Renderer · 恢复原文', () => {
  it('中文模式恢复后 DOM 与翻译前完全一致', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    renderer.render(block, '现在阅读<0>文档</0>。', 'chinese');
    expect(document.body.innerHTML).not.toBe(before);

    expect(renderer.restore(block.id)).toBe(true);
    expect(document.body.innerHTML).toBe(before);
  });

  it('双语模式恢复后 DOM 与翻译前完全一致', () => {
    const block = first(setup('<p>Hello world.</p>'));
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    renderer.render(block, '你好，世界。', 'bilingual');
    renderer.restore(block.id);

    expect(document.body.innerHTML).toBe(before);
  });

  it('恢复嵌套占位符后结构完整', () => {
    const block = first(setup('<p><a href="#x"><strong>Bold link</strong></a> and text.</p>'));
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    renderer.render(block, '<0><1>粗体链接</1></0>以及文本。', 'chinese');
    renderer.restore(block.id);

    expect(document.body.innerHTML).toBe(before);
  });

  it('恢复块级后代所在的容器', () => {
    const block = first(setup('<div>before<p>inside</p>after</div>'));
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    renderer.render(block, '之前之后', 'chinese');
    renderer.restore(block.id);

    expect(document.body.innerHTML).toBe(before);
  });

  it('未渲染过的 Block 恢复返回 false', () => {
    expect(new Renderer().restore('block-999')).toBe(false);
  });

  it('restoreAll 恢复全部并返回数量', () => {
    const blocks = setup('<h1>Title</h1><p>Body text.</p>');
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, `【译】${block.plainText}`, 'chinese');
    }
    expect(renderer.renderedCount).toBe(blocks.length);

    expect(renderer.restoreAll()).toBe(blocks.length);
    expect(renderer.renderedCount).toBe(0);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('Renderer · 幂等与清理', () => {
  it('重复渲染同一 Block 会先恢复再重绘', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const renderer = new Renderer();

    renderer.render(block, '现在阅读<0>文档</0>。', 'chinese');
    renderer.render(block, '请阅读<0>文档</0>。', 'chinese');

    expect(document.querySelector('p')?.textContent).toBe('请阅读文档。');
    expect(renderer.renderedCount).toBe(1);
  });

  it('切换显示模式后 DOM 正确', () => {
    const block = first(setup('<p>Read the <strong>docs</strong> now.</p>'));
    const renderer = new Renderer();

    renderer.render(block, '现在阅读<0>文档</0>。', 'chinese');
    renderer.render(block, '现在阅读<0>文档</0>。', 'bilingual');

    expect(document.querySelector('p')?.textContent).toBe('Read the docs now.');
    expect(document.querySelector('[data-ai-translator="true"]')?.textContent).toBe(
      '现在阅读文档。',
    );
  });

  it('stripInsertedNodes 移除全部双语节点', () => {
    const blocks = setup('<h1>Title</h1><p>Body text.</p>');
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, '译文', 'bilingual');
    }

    expect(stripInsertedNodes(document)).toBe(blocks.length);
    expect(document.body.innerHTML).toBe(before);
  });

  it('isRendered 反映渲染状态', () => {
    const block = first(setup('<p>Hello world.</p>'));
    const renderer = new Renderer();

    expect(renderer.isRendered(block.id)).toBe(false);
    renderer.render(block, '你好，世界。', 'chinese');
    expect(renderer.isRendered(block.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * fixture 回归：结构往返（方案第 77 节）
 *
 * 方案第 77 节的原话是「Segmenter、Renderer 修改时必须跑回归」——
 * fixture 是给两者共用的。上面测的是分段结果，这里测**渲染后的可恢复性**。
 *
 * 这是最强的结构测试：渲染 → 恢复 → DOM 必须与渲染前**逐字节相同**。
 * 只要占位符回填错位、闭合标签丢失、或者多留一个插件节点，这条就会失败。
 * ------------------------------------------------------------------ */

const ROUND_TRIP_FIXTURES = [
  'basic-article.html',
  'nested-inline.html',
  'code-block.html',
  'table.html',
  'mixed-language.html',
  'long-container.html',
];

const ROUND_TRIP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/pages',
);

function loadFixture(name: string): void {
  const html = readFileSync(path.join(ROUND_TRIP_DIR, name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

/**
 * 构造一个**结构合法**的假译文。
 *
 * 直接拼 `【译】${plainText}` 是不行的——那样会丢掉全部占位符，
 * 渲染器会因结构校验失败而拒绝渲染（这是对的行为，但测不到往返）。
 * 在带占位符的 `text` 前面加前缀，占位符就原样保留了。
 */
function fakeTranslation(block: TranslationBlock): string {
  return `【译】${block.text}`;
}

describe.each(ROUND_TRIP_FIXTURES)('fixture 往返：%s', (name) => {
  it('双语模式渲染后恢复，DOM 与渲染前完全一致', () => {
    loadFixture(name);
    const before = document.body.innerHTML;

    const blocks = segmentElement(document.body, { targetLanguage: 'zh-CN' });
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, fakeTranslation(block), 'bilingual');
    }

    // 渲染确实发生了
    expect(document.querySelectorAll('[data-ai-translator="true"]').length).toBeGreaterThan(0);

    renderer.restoreAll();

    expect(document.body.innerHTML).toBe(before);
  });

  it('中文模式渲染后恢复，DOM 与渲染前完全一致', () => {
    loadFixture(name);
    const before = document.body.innerHTML;

    const blocks = segmentElement(document.body, { targetLanguage: 'zh-CN' });
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, fakeTranslation(block), 'chinese');
    }

    renderer.restoreAll();

    expect(document.body.innerHTML).toBe(before);
  });

  it('渲染不改变元素数量（只动文本与追加节点）', () => {
    loadFixture(name);
    const elementsBefore = document.querySelectorAll('*').length;

    const blocks = segmentElement(document.body, { targetLanguage: 'zh-CN' });
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, fakeTranslation(block), 'bilingual');
    }

    renderer.restoreAll();

    expect(document.querySelectorAll('*').length).toBe(elementsBefore);
  });
});

/**
 * 拆大块：同一个容器下有多个 Block（方案第 57 节）。
 *
 * 渲染器原来以「整个容器」为单位快照与恢复，两个 Block 共享容器会互相覆盖。
 * 现在受管内容收窄到**本段节点**，恢复靠「受管节点之后第一个不属于本块的兄弟」
 * 定位——所以这里的重点全在**恢复之后 DOM 是不是逐字节相同**。
 */
describe('Renderer · 拆大块（一个容器多个 Block）', () => {
  /**
   * 归一化比较：占位符在 DOM 里是**元素**（`<strong>renderer</strong>`），
   * 在 `plainText` 里是纯文本（`renderer`）；节点拼接处还可能出现连续空格。
   * 两者都抹掉再比。
   */
  const squash = (value: string): string => value.replace(/\s+/g, '');

  /** 取 `#flat-long` 这一组拆段块（顺序即文档顺序）。 */
  function rangedBlocks(): TranslationBlock[] {
    loadFixture('long-container.html');
    return segmentElement(document.body, { targetLanguage: 'zh-CN' }).filter(
      (block) => block.element.id === 'flat-long',
    );
  }

  it('前置条件：这一组确实是拆出来的多段', () => {
    const blocks = rangedBlocks();

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.range !== undefined)).toBe(true);
  });

  it('⭐ 中文模式：即使乱序渲染，容器内容仍按原文顺序拼好，且能逐字节恢复', () => {
    const blocks = rangedBlocks();
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    // 流式下条目到达顺序本来就不保证——刻意倒着渲染
    for (const block of [...blocks].reverse()) {
      expect(renderer.render(block, fakeTranslation(block), 'chinese')).toEqual({ ok: true });
    }

    const container = document.querySelector('#flat-long');
    expect(squash(container?.textContent ?? '')).toBe(
      blocks.map((block) => squash(`【译】${block.plainText}`)).join(''),
    );

    renderer.restoreAll();
    expect(document.body.innerHTML).toBe(before);
  });

  it('⭐ 双语模式：每段译文跟在本段原文之后，顺序与到达顺序无关，且能逐字节恢复', () => {
    const blocks = rangedBlocks();
    const before = document.body.innerHTML;
    const renderer = new Renderer();

    for (const block of [...blocks].reverse()) {
      renderer.render(block, fakeTranslation(block), 'bilingual');
    }

    const holders = Array.from(document.querySelectorAll('#flat-long [data-ai-translator="true"]'));

    expect(holders).toHaveLength(blocks.length);
    // 按文档顺序读出来的译文，与原文分段的先后一致
    expect(holders.map((holder) => squash(holder.textContent ?? ''))).toEqual(
      blocks.map((block) => squash(`【译】${block.plainText}`)),
    );

    renderer.restoreAll();
    expect(document.body.innerHTML).toBe(before);
  });

  it('恢复其中一段，其他段的译文不受影响', () => {
    const blocks = rangedBlocks();
    const target = first(blocks);
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, fakeTranslation(block), 'chinese');
    }

    expect(renderer.restore(target.id)).toBe(true);

    const container = document.querySelector('#flat-long');
    const firstTextNode = target.range?.nodes.find((node) => node.nodeType === Node.TEXT_NODE);
    const rawPrefix = (firstTextNode?.textContent ?? '').trim().slice(0, 24);

    expect(rawPrefix.length).toBeGreaterThan(0);
    expect(container?.textContent).toContain(rawPrefix);
    expect(container?.textContent).toContain('【译】');
  });

  it('重复渲染同一段是幂等的（先恢复再重绘）', () => {
    const blocks = rangedBlocks();
    const target = first(blocks);
    const renderer = new Renderer();

    renderer.render(target, fakeTranslation(target), 'chinese');
    renderer.render(target, `【改】${target.text}`, 'chinese');

    expect(document.querySelector('#flat-long')?.textContent).toContain('【改】');
    expect(document.querySelector('#flat-long')?.textContent).not.toContain('【译】');
  });

  it('拆段的容器里，未拆段的其他块不受影响（块级后代仍在原位）', () => {
    const all = (() => {
      loadFixture('long-container.html');
      return segmentElement(document.body, { targetLanguage: 'zh-CN' });
    })();
    const nested = all.find((block) => block.element.id === 'nested');
    const renderer = new Renderer();

    if (nested === undefined) {
      throw new Error('期望 fixture 里有嵌套段落');
    }

    for (const block of all) {
      renderer.render(block, fakeTranslation(block), 'chinese');
    }

    expect(document.querySelector('#with-block #nested')?.textContent).toBe(
      '【译】This nested paragraph belongs to its own block, not to the container.',
    );
  });
});

/**
 * 按范围恢复：**只看渲染器自己的记录**，不看 `PageStore`。
 *
 * 为什么必须这样：重新分段之后条目可能已经被换掉或被对账删掉，
 * 而渲染记录还在——孤儿记录里的译文节点会留在页面上，
 * 新译文一到就成了「同一段被翻了两遍」。
 */
describe('Renderer · restoreWithin（按范围恢复）', () => {
  it('恢复范围内的记录，范围外的不动', () => {
    const blocks = setup(
      '<div id="a"><p id="p1">First paragraph long enough.</p></div><div id="b"><p id="p2">Second paragraph long enough.</p></div>',
    );
    const renderer = new Renderer();

    for (const block of blocks) {
      renderer.render(block, fakeTranslation(block), 'bilingual');
    }

    const rootA = document.querySelector('#a');
    if (rootA === null) {
      throw new Error('期望 fixture 里有 #a');
    }

    expect(renderer.restoreWithin(rootA)).toBe(1);
    expect(document.querySelector('#p1 + [data-ai-translator="true"]')).toBeNull();
    expect(document.querySelector('#p2 + [data-ai-translator="true"]')).not.toBeNull();
  });

  it('⭐ 条目已经被删掉（孤儿记录）时同样能清掉译文节点', () => {
    const blocks = setup('<p id="p">A paragraph long enough to translate.</p>');
    const block = first(blocks);
    const renderer = new Renderer();

    renderer.render(block, fakeTranslation(block), 'bilingual');
    expect(document.querySelector('[data-ai-translator="true"]')).not.toBeNull();

    // 控制器那边已经不认识这个 Block 了，但渲染记录还在
    expect(renderer.restoreWithin(document.body)).toBe(1);
    expect(document.querySelector('[data-ai-translator="true"]')).toBeNull();
  });

  it('范围外没有记录时返回 0', () => {
    const renderer = new Renderer();
    expect(renderer.restoreWithin(document.body)).toBe(0);
  });
});
