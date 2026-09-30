import { beforeEach, describe, expect, it } from 'vitest';

import { segmentElement } from './blocks';

/** 把 HTML 挂到 body 上，返回 body 作为分段根。 */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const options = { targetLanguage: 'zh-CN' };

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('segmentElement — Block 划分（方案第 56、57 节）', () => {
  it('按最近的块级祖先分组，输出文档顺序', () => {
    const blocks = segmentElement(
      mount('<h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual([
      'Title',
      'First paragraph.',
      'Second paragraph.',
    ]);
    expect(blocks.map((block) => block.blockType)).toEqual(['heading', 'paragraph', 'paragraph']);
  });

  it('Block ID 按文档顺序连续编号', () => {
    const blocks = segmentElement(mount('<h1>Title</h1><p>Body text.</p>'), options);

    expect(blocks.map((block) => block.id)).toEqual(['block-001', 'block-002']);
  });

  it('每个 Block 记录其包含的文本节点 ID', () => {
    const blocks = segmentElement(mount('<p>Hello <strong>world</strong>!</p>'), options);

    expect(blocks[0]?.nodeIds).toHaveLength(3);
  });

  it('每个 Block 记录其 DOM 容器，可反查回页面', () => {
    const blocks = segmentElement(
      mount('<div><p id="first">First paragraph.</p><p id="second">Second paragraph.</p></div>'),
      options,
    );

    expect(blocks.map((block) => block.element.id)).toEqual(['first', 'second']);
    expect(blocks[0]?.element.tagName).toBe('P');
  });

  it('占位符绑定的元素确实位于该 Block 的容器内', () => {
    const blocks = segmentElement(
      mount('<p id="host">See <a href="#docs">the docs</a> now.</p>'),
      options,
    );

    const block = blocks[0];
    const anchor = block?.placeholders[0]?.element;

    expect(anchor?.tagName).toBe('A');
    expect(block?.element.contains(anchor ?? null)).toBe(true);
  });

  it('inline 标记生成占位符而非拆分 Block', () => {
    const blocks = segmentElement(
      mount(
        '<p>AI engineering is changing <strong>software development</strong> rapidly. Read the <a href="/docs">documentation</a> before you start.</p>',
      ),
      options,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      'AI engineering is changing <0>software development</0> rapidly. Read the <1>documentation</1> before you start.',
    );
    expect(blocks[0]?.placeholders).toHaveLength(2);
  });
});

describe('segmentElement — 跳过规则', () => {
  it('忽略 SCRIPT / STYLE / NOSCRIPT', () => {
    const blocks = segmentElement(
      mount(
        '<script>var hidden = "script text";</script><style>.a{color:red}</style><noscript>noscript text</noscript><p>Real content here.</p>',
      ),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('忽略 CODE / PRE（方案第 9.3 节：程序代码默认保留原文）', () => {
    const blocks = segmentElement(
      mount('<pre><code>const client = new OpenAI();</code></pre><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('忽略 hidden 属性元素', () => {
    const blocks = segmentElement(
      mount('<p hidden>Never translate this.</p><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('忽略 display:none 元素', () => {
    const style = document.createElement('style');
    style.textContent = '.hidden { display: none; }';
    document.head.append(style);

    const blocks = segmentElement(
      mount('<p class="hidden">Never translate this.</p><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('忽略 contenteditable 元素', () => {
    const blocks = segmentElement(
      mount('<div contenteditable="true">User typed content.</div><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });
});

/**
 * 交互控件（2026-09-30 为「token 消耗偏高」加的规则）。
 *
 * 真实页面（Mintlify 文档站）上，导航按钮、tab、菜单项都会各自变成
 * 一个 Block——243 个块里 60% 短于 30 字符，全是这类操作标签。
 */
describe('segmentElement — 交互控件（button / role）', () => {
  it('按钮文字不再成 Block', () => {
    const blocks = segmentElement(
      mount('<div><button type="button">Copy page</button></div><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('只剩按钮的导航不产生 Block（spa.html 的 #go-two 就是这种结构）', () => {
    const blocks = segmentElement(
      mount('<nav><button id="go" type="button">Page Two</button></nav><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('role="button" / role="tab" 的自定义控件同样跳过', () => {
    const blocks = segmentElement(
      mount(
        '<div><div role="button">Copy page</div></div><div role="tablist"><div role="tab">JavaScript</div></div><p>Real content here.</p>',
      ),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('正文里混排的按钮变成原子占位符——元素保留，内容不发给模型', () => {
    const blocks = segmentElement(
      mount('<p>Press <button type="button">Copy page</button> to copy.</p>'),
      options,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Press <0/> to copy.');
    expect(blocks[0]?.plainText).toBe('Press to copy.');
    expect(blocks[0]?.placeholders.map((item) => item.kind)).toEqual(['atom']);
    expect(blocks[0]?.placeholders[0]?.node).toBeInstanceOf(HTMLButtonElement);
  });

  it('正文里的链接不受影响（<a> / role="link" 属于正文）', () => {
    const blocks = segmentElement(
      mount('<p>Read the <a href="/docs">documentation</a> first.</p>'),
      options,
    );

    expect(blocks[0]?.plainText).toBe('Read the documentation first.');
    expect(blocks[0]?.text).toBe('Read the <0>documentation</0> first.');
  });

  it('⭐ 容器内混排的 <svg><style> 不把 CSS 当正文（拼文本阶段也走同一判定）', () => {
    const blocks = segmentElement(
      mount('<p>Diagram follows <svg><style>#m{fill:#333}</style></svg>end.</p>'),
      options,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).not.toContain('fill:#333');
    expect(blocks[0]?.plainText).toBe('Diagram follows end.');
    expect(blocks[0]?.placeholders.map((item) => item.kind)).toEqual(['atom']);
  });
});

describe('segmentElement — 文本过滤（方案第 9.4 节）', () => {
  it('跳过纯数字段落', () => {
    const blocks = segmentElement(
      mount('<p>2026</p><p>1,234.56</p><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('跳过 URL 与邮箱段落', () => {
    const blocks = segmentElement(
      mount('<p>https://openai.com</p><p>hello@example.com</p><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('跳过已是目标语言的段落', () => {
    const blocks = segmentElement(
      mount('<p>这是一段中文内容。</p><p>Real content here.</p>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });

  it('短表意文字标题不被过短规则误杀', () => {
    const blocks = segmentElement(mount('<h2>ニュース</h2>'), options);

    expect(blocks.map((block) => block.plainText)).toEqual(['ニュース']);
    expect(blocks[0]?.blockType).toBe('heading');
  });

  it('单个拉丁字符的段落被跳过', () => {
    const blocks = segmentElement(mount('<p>a</p><p>Real content here.</p>'), options);

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });
});

describe('segmentElement — 块级类型与嵌套', () => {
  it('列表项各自成 Block', () => {
    const blocks = segmentElement(
      mount('<ul><li>First item</li><li>Second item</li></ul>'),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual(['First item', 'Second item']);
    expect(blocks.every((block) => block.blockType === 'list')).toBe(true);
  });

  it('li 内嵌 p 时拆成两个 Block', () => {
    const blocks = segmentElement(
      mount('<ul><li><p>Inside paragraph.</p>tail text</li></ul>'),
      options,
    );

    expect(blocks.map((block) => block.plainText).sort()).toEqual([
      'Inside paragraph.',
      'tail text',
    ]);
  });

  it('表格单元格各自成 Block，blockType 为 table', () => {
    const blocks = segmentElement(
      mount(
        '<table><thead><tr><th>Model</th><th>Context</th></tr></thead><tbody><tr><td>deepseek-chat</td><td>64k tokens</td></tr></tbody></table>',
      ),
      options,
    );

    expect(blocks.map((block) => block.plainText)).toEqual([
      'Model',
      'Context',
      'deepseek-chat',
      '64k tokens',
    ]);
    expect(blocks.every((block) => block.blockType === 'table')).toBe(true);
  });

  it('裸露文本退化为 inline Block', () => {
    const blocks = segmentElement(mount('<span>Loose text here.</span>'), options);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.blockType).toBe('inline');
    expect(blocks[0]?.tagName).toBe('SPAN');
  });

  it('空段落不产生 Block', () => {
    const blocks = segmentElement(mount('<p>   </p><p>Real content here.</p>'), options);

    expect(blocks.map((block) => block.plainText)).toEqual(['Real content here.']);
  });
});
