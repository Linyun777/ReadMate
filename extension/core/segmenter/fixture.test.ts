import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import type { TranslationBlock } from '@/shared/types';

import { segmentElement } from './blocks';

/**
 * fixture 页面回归（方案第 77 节：Segmenter / Renderer 修改时必须跑回归）。
 *
 * 这里对整页断言**行为特征**而不是完整快照——快照会因为无关的排版调整
 * 频繁失效，而行为特征只在逻辑真的变化时才失败。
 */

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/pages',
);

/**
 * 加载 fixture。
 *
 * head 与 body 都要挂上——fixture 的 `<style>` 在 head 里，
 * 而 `.hidden { display: none }` 会影响可见性判定。
 */
function loadFixture(name: string): HTMLElement {
  const html = readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  return document.body;
}

const options = { targetLanguage: 'zh-CN' };

function segmentFixture() {
  return segmentElement(loadFixture('basic-article.html'), options);
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('fixture 回归：basic-article.html', () => {
  it('产出多个 Block，ID 唯一且连续', () => {
    const blocks = segmentFixture();

    expect(blocks.length).toBeGreaterThan(10);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    expect(blocks[0]?.id).toBe('block-001');
  });

  it('每个 Block 都有非空 text 与 plainText', () => {
    for (const block of segmentFixture()) {
      expect(block.text.length).toBeGreaterThan(0);
      expect(block.plainText.length).toBeGreaterThan(0);
    }
  });

  it('标题识别为 heading', () => {
    const blocks = segmentFixture();
    const title = blocks.find((block) => block.plainText === 'AI Engineering in Practice');

    expect(title?.blockType).toBe('heading');
    expect(title?.tagName).toBe('H1');
  });

  it('含 inline 标记的段落生成两个成对占位符', () => {
    const blocks = segmentFixture();
    const paragraph = blocks.find((block) => block.plainText.includes('software development'));

    expect(paragraph?.text).toBe(
      'AI engineering is changing <0>software development</0> rapidly. Read the <1>documentation</1> before you start.',
    );
    expect(paragraph?.placeholders.map((item) => item.kind)).toEqual(['pair', 'pair']);
  });

  it('列表项各自成 Block，blockType 为 list', () => {
    const blocks = segmentFixture();
    const items = blocks.filter((block) => block.blockType === 'list');

    expect(items.map((block) => block.plainText)).toEqual([
      'Silent truncation of long inputs',
      'Inconsistent formatting between calls',
      'Hallucinated identifiers in generated code',
    ]);
  });

  it('表格单元格各自成 Block，blockType 为 table', () => {
    const blocks = segmentFixture();
    const cells = blocks.filter((block) => block.blockType === 'table');

    expect(cells.map((block) => block.plainText)).toEqual([
      'Model',
      'Context',
      'Best for',
      'deepseek-chat',
      '64k',
      'General translation',
      'gpt-5-mini',
      '128k',
      'Long articles',
    ]);
  });

  it('代码块（pre / code）不产生 Block', () => {
    const blocks = segmentFixture();

    expect(blocks.some((block) => block.plainText.includes('const client'))).toBe(false);
    expect(blocks.some((block) => block.tagName === 'PRE')).toBe(false);
  });

  it('display:none 的段落不产生 Block', () => {
    const blocks = segmentFixture();

    expect(blocks.some((block) => block.plainText.includes('must never be translated'))).toBe(
      false,
    );
  });

  it('只含数字 / URL / 邮箱 / 符号的段落不产生 Block', () => {
    const blocks = segmentFixture();

    expect(blocks.some((block) => block.plainText.includes('https://example.com'))).toBe(false);
    expect(blocks.some((block) => block.plainText === '2026')).toBe(false);
  });

  it('短表意文字标题未被过短规则误杀', () => {
    const blocks = segmentFixture();

    expect(blocks.some((block) => block.plainText === 'ニュース')).toBe(true);
  });

  it('导航链接被归入同一个 Block（方案第 86.6 节的导航块）', () => {
    const blocks = segmentFixture();
    const nav = blocks.find((block) => block.tagName === 'NAV');

    expect(nav).toBeDefined();
    expect(nav?.placeholders).toHaveLength(3);
    expect(nav?.plainText).toBe('Documentation Pricing Blog');
  });
});

/* ------------------------------------------------------------------ *
 * 方案第 77 节要求的其余 fixture
 *
 * 前一组测的是 basic-article.html（一份「什么都有一点」的综合页面）。
 * 下面按**具体风险点**分组——每个 fixture 只测一类容易出错的东西，
 * 出问题时能立刻定位到是哪一类。
 * ------------------------------------------------------------------ */

/** 按名字加载 fixture 并分段。 */
function segmentNamed(name: string): TranslationBlock[] {
  return segmentElement(loadFixture(name), options);
}

describe('fixture 回归：nested-inline.html（占位符嵌套）', () => {
  it('深层嵌套生成嵌套的成对占位符', () => {
    const blocks = segmentNamed('nested-inline.html');
    const deep = blocks.find((block) => block.plainText.includes('Deeper nesting'));

    expect(deep?.text).toBe(
      'Deeper nesting with <0>bold <1>and italic <2>and a link</2></1></0> wrapped inside.',
    );
    expect(deep?.placeholders.map((item) => item.kind)).toEqual(['pair', 'pair', 'pair']);
  });

  it('相邻的 inline 标签各占一个占位符', () => {
    const blocks = segmentNamed('nested-inline.html');
    const adjacent = blocks.find((block) => block.plainText.includes('Adjacent tags'));

    expect(adjacent?.text).toBe(
      'Adjacent tags <0>bold</0><1>italic</1> with no space between them.',
    );
  });

  it('<br> 生成原子占位符', () => {
    const blocks = segmentNamed('nested-inline.html');
    const breaks = blocks.find((block) => block.plainText.includes('First line'));

    expect(breaks?.text).toBe('First line<0/>Second line after a break<1/>Third line.');
    expect(breaks?.placeholders.map((item) => item.kind)).toEqual(['atom', 'atom']);
  });

  it('内联图片生成原子占位符', () => {
    const blocks = segmentNamed('nested-inline.html');
    const image = blocks.find((block) => block.plainText.includes('Text before an image'));

    expect(image?.placeholders).toHaveLength(1);
    expect(image?.placeholders[0]?.kind).toBe('atom');
  });

  it('占位符包裹 inline 元素时内容仍可翻译', () => {
    const blocks = segmentNamed('nested-inline.html');
    const simple = blocks.find((block) => block.plainText.includes('A sentence with'));

    expect(simple?.plainText).toBe('A sentence with bold text in the middle of it.');
  });

  it('整段都是 inline 元素时仍产出 Block', () => {
    const blocks = segmentNamed('nested-inline.html');

    expect(blocks.some((block) => block.plainText === 'Nothing but bold')).toBe(true);
  });

  it('嵌套列表的每一项各自成 Block', () => {
    const blocks = segmentNamed('nested-inline.html');
    const items = blocks.filter((block) => block.blockType === 'list');

    expect(items.some((block) => block.plainText === 'Nested item with emphasis')).toBe(true);
  });

  it('每个占位符索引在 Block 内唯一且从 0 开始', () => {
    for (const block of segmentNamed('nested-inline.html')) {
      const indexes = block.placeholders.map((item) => item.index);
      expect(indexes).toEqual(indexes.map((_unused, position) => position));
    }
  });
});

describe('fixture 回归：code-block.html（代码不翻译）', () => {
  it('块级 <pre><code> 不产生 Block', () => {
    const blocks = segmentNamed('code-block.html');

    expect(blocks.some((block) => block.plainText.includes('new OpenAI'))).toBe(false);
    expect(blocks.some((block) => block.tagName === 'PRE')).toBe(false);
  });

  it('纯文本 <pre> 同样不产生 Block', () => {
    const blocks = segmentNamed('code-block.html');

    expect(blocks.some((block) => block.plainText.includes('plain preformatted'))).toBe(false);
  });

  it('⭐ 段落里的 inline <code> 用成对占位符，标识符对模型可见', () => {
    const blocks = segmentNamed('code-block.html');
    const paragraph = blocks.find((block) => block.plainText.includes('first, then'));

    // 标识符留在块里（模型看得到），但被占位符包住改不动
    expect(paragraph?.plainText).toBe(
      'Run npm install first, then npm run dev to start the dev server.',
    );
    expect(paragraph?.placeholders.map((item) => item.kind)).toEqual(['pair', 'pair']);
    expect(paragraph?.text).toContain('<0>npm install</0>');
  });

  it('⭐ <kbd> 同样用成对占位符', () => {
    const blocks = segmentNamed('code-block.html');
    const kbd = blocks.find((block) => block.plainText.includes('command palette'));

    expect(kbd?.placeholders.map((item) => item.kind)).toEqual(['pair', 'pair']);
    expect(kbd?.text).toContain('<0>Cmd</0>');
  });

  it('代码块前后的正文照常产出 Block', () => {
    const blocks = segmentNamed('code-block.html');

    expect(blocks.some((block) => block.plainText.includes('configure the client'))).toBe(true);
    expect(blocks.some((block) => block.plainText.includes('constructing the client'))).toBe(true);
  });
});

describe('fixture 回归：table.html（表格）', () => {
  it('表头与单元格各自成 Block，blockType 为 table', () => {
    const blocks = segmentNamed('table.html');
    const cells = blocks.filter((block) => block.blockType === 'table');

    // 3 个表头 + 9 个单元格 + 1 个 caption + 第二个表的 1 个单元格
    expect(cells).toHaveLength(14);
    expect(cells.slice(0, 3).map((block) => block.plainText)).toEqual([
      'Option',
      'Type',
      'Description',
    ]);
  });

  it('单元格文本完整保留', () => {
    const blocks = segmentNamed('table.html');

    expect(
      blocks.some((block) => block.plainText === 'How many requests may be in flight at once.'),
    ).toBe(true);
  });

  it('caption 成 Block', () => {
    const blocks = segmentNamed('table.html');

    expect(blocks.some((block) => block.plainText === 'Table with a caption')).toBe(true);
  });

  it('表格前后的段落正常', () => {
    const blocks = segmentNamed('table.html');

    expect(blocks.some((block) => block.plainText.includes('supported options'))).toBe(true);
    expect(blocks.some((block) => block.plainText.includes('clamped to the documented'))).toBe(
      true,
    );
  });
});

describe('fixture 回归：mixed-language.html（目标语言检测）', () => {
  const blocks = (): TranslationBlock[] => segmentNamed('mixed-language.html');

  it('纯英文段落照常翻译', () => {
    expect(blocks().some((block) => block.plainText.includes('entirely in English'))).toBe(true);
  });

  it('纯中文段落被跳过', () => {
    expect(blocks().some((block) => block.plainText.includes('完全是中文'))).toBe(false);
  });

  it('中英各半的段落照常翻译', () => {
    expect(blocks().some((block) => block.plainText.includes('mixes English'))).toBe(true);
  });

  it('英文为主、夹少量中文的段落照常翻译', () => {
    expect(blocks().some((block) => block.plainText.includes('only a few Chinese'))).toBe(true);
  });

  it('中文为主、夹少量英文的段落被跳过（汉字占比过半）', () => {
    expect(blocks().some((block) => block.plainText.includes('中间夹了一个'))).toBe(false);
  });

  it('日文段落照常翻译（目标语言是中文）', () => {
    expect(blocks().some((block) => block.plainText.includes('これは日本語'))).toBe(true);
  });

  it('含数字的段落照常翻译', () => {
    expect(blocks().some((block) => block.plainText.includes('Version 2 released'))).toBe(true);
  });

  it('纯数字与纯 URL 段落被跳过', () => {
    expect(blocks().some((block) => block.plainText === '2026 42 3.14 100% ¥1,234')).toBe(false);
    expect(blocks().some((block) => block.plainText.includes('https://example.com'))).toBe(false);
  });
});

describe('fixture 回归：dynamic-feed.html（动态内容）', () => {
  it('初始条目全部产出 Block', () => {
    const blocks = segmentNamed('dynamic-feed.html');

    expect(blocks.some((block) => block.plainText === 'First item')).toBe(true);
    expect(blocks.some((block) => block.plainText === 'Second item')).toBe(true);
    expect(blocks.some((block) => block.plainText.includes('updated in place'))).toBe(true);
  });

  it('按钮文字也被分段（inline Block）', () => {
    const blocks = segmentNamed('dynamic-feed.html');
    const buttons = blocks.filter((block) => block.tagName === 'BUTTON');

    expect(buttons.map((block) => block.plainText)).toEqual(['Load more', 'Rewrite live region']);
  });

  it('页面脚本本身不产出 Block', () => {
    const blocks = segmentNamed('dynamic-feed.html');

    expect(blocks.some((block) => block.plainText.includes('addEventListener'))).toBe(false);
    expect(blocks.some((block) => block.plainText.includes('createElement'))).toBe(false);
  });
});

describe('fixture 回归：large-page.html（规模）', () => {
  it('100 个段落 + 标题全部产出 Block', () => {
    const blocks = segmentNamed('large-page.html');

    expect(blocks).toHaveLength(101);
    expect(blocks.filter((block) => block.blockType === 'heading')).toHaveLength(1);
    expect(blocks.filter((block) => block.blockType === 'paragraph')).toHaveLength(100);
  });

  it('Block ID 唯一且连续', () => {
    const blocks = segmentNamed('large-page.html');
    const ids = blocks.map((block) => block.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('block-001');
    expect(ids.at(-1)).toBe('block-101');
  });

  it('每个 Block 的占位符索引独立从 0 开始', () => {
    for (const block of segmentNamed('large-page.html')) {
      expect(block.placeholders).toHaveLength(0);
    }
  });
});

/**
 * 代码密集的文档页（Phase 20）。
 *
 * 模拟 React 官方文档：代码块由 Sandpack 渲染——每行一个 `<div>`、
 * 每个 token 一个 `<span>`，**没有 `PRE` / `CODE` 标签**。
 *
 * 这是「不该被翻译的东西」里最容易被漏掉的一类：只认标签的跳过规则
 * 会完全绕过它们，于是一行代码一个 Block，整页几千条。
 */
describe('fixture 回归：code-heavy-docs.html', () => {
  function segmentCodeFixture(): TranslationBlock[] {
    return segmentElement(loadFixture('code-heavy-docs.html'), options);
  }

  it('⭐ 代码块不产生任何 Block', () => {
    const blocks = segmentCodeFixture();
    const allText = blocks.map((block) => block.plainText).join('\n');

    // 只检查**代码独有**的片段。
    // 不能拿 `useState` 这类词做判据——正文里本来就会提到它
    // （"The useState hook returns a pair..."），那是该翻译的内容。
    const codeOnly = [
      'setCount(count + 1)',
      'createTheme({',
      'ThemeProvider theme={theme}',
      'variant="contained"',
      'fontFamily: "Roboto',
    ];

    for (const fragment of codeOnly) {
      expect(allText, `代码片段 ${fragment} 不该出现在待翻译内容里`).not.toContain(fragment);
    }
  });

  it('每个 Block 都像正文，没有「一行代码」形状的', () => {
    // 换个角度验证：代码行有明确特征——整行都是符号，或以关键字开头。
    //
    // 不用长度做判据：`App.js`（代码块的标签）和 `Theming`（小标题）
    // 都只有 6–7 个字符，它们是**该翻译的正文**，不是代码。
    const blocks = segmentCodeFixture();

    for (const block of blocks) {
      const text = block.plainText.trim();

      expect(text, '不该出现「整行都是符号」的 Block').not.toMatch(/^[\s{}();<>=+\-*/.,:]+$/);
      expect(text, '不该出现「以 JS 关键字开头」的 Block').not.toMatch(
        /^(const|let|var|return|import|export|function)\b/,
      );
    }
  });

  it('只翻译正文，条目数是个位数', () => {
    const blocks = segmentCodeFixture();

    // 页面有：1 个 h1 + 4 段正文 + 1 个 h2 = 6 条；
    // 33 行代码一条都不该进来
    expect(blocks.length).toBeLessThanOrEqual(8);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it('正文内容确实被分段了', () => {
    const allText = segmentCodeFixture()
      .map((block) => block.plainText)
      .join('\n');

    expect(allText).toContain('local state between renders');
    expect(allText).toContain('batches updates');
    expect(allText).toContain('theme describes colours');
  });

  it('代码块所在位置的正文段落没有被误杀', () => {
    // 边界：代码块夹在两段正文之间，前后两段都要保留
    const allText = segmentCodeFixture()
      .map((block) => block.plainText)
      .join('\n');

    expect(allText).toContain('useState hook'); // 代码块之前
    expect(allText).toContain('next section looks at'); // 代码块之后
  });
});
