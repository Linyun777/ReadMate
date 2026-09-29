import { beforeEach, describe, expect, it } from 'vitest';

import { segmentElement } from './blocks';

/**
 * 代码块不应被翻译（回归测试）。
 *
 * ## 问题
 *
 * React 官方文档这类站点用 **Sandpack** 渲染代码：不是 `<pre><code>`，
 * 而是每行一个 `<div>`、每个 token 一个 `<span>`，靠 CSS 做高亮。
 *
 * 原来的跳过规则只认 `PRE` / `CODE` 标签 → 这些代码块**完全绕过** →
 * 一行代码变成一个 Block → 整页几千条，而且每条都在翻译 `const` / `return`。
 *
 * ## 修复思路
 *
 * 加一条**等宽字体**判定：代码的排版特征是 monospace，
 * 这与用什么标签、什么框架无关。
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const options = { targetLanguage: 'zh-CN' };

/** 造一段 React 文档风格的代码块（div + span 高亮，无 pre/code 标签）。 */
function sandpackBlock(lines: number): string {
  const rows = Array.from(
    { length: lines },
    (_unused, index) =>
      `<div class="sp-line"><span class="token">const</span> value${index} <span class="token">=</span> useState(0)</div>`,
  ).join('');

  return `<div class="sp-code" style="font-family: ui-monospace, monospace">${rows}</div>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('代码块跳过', () => {
  it('⭐ 等宽容器内的内容不产生 Block（React 文档那种 div 代码块）', () => {
    const root = mount(`
      <article>
        <p>Here is how you use state in a component.</p>
        ${sandpackBlock(30)}
        <p>That is the whole idea.</p>
      </article>
    `);

    const blocks = segmentElement(root, options);
    const texts = blocks.map((block) => block.plainText);

    // 只有两段正文，代码块一行都不该进来
    expect(blocks).toHaveLength(2);
    expect(texts.join(' ')).not.toContain('useState');
  });

  it('嵌套在等宽容器深处的节点同样被跳过', () => {
    const root = mount(`
      <div>
        <div style="font-family: monospace">
          <div><div><span>const deep = nested</span></div></div>
        </div>
      </div>
    `);

    expect(segmentElement(root, options)).toHaveLength(0);
  });

  it('已有的 pre / code 标签仍然被跳过', () => {
    const root = mount('<pre><code>const x = 1</code></pre><p>Real prose here.</p>');

    const blocks = segmentElement(root, options);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.plainText).toContain('Real prose');
  });

  it('⭐ 等宽字体不影响普通正文', () => {
    const root = mount('<p>This is ordinary prose with a normal font.</p>');

    expect(segmentElement(root, options)).toHaveLength(1);
  });

  it('⭐ 行内等宽的段落仍整体翻译，标识符被占位符保护', () => {
    // 这是关键边界：`<p>Use <code>useState</code> to ...</p>` 里
    // 段落本身要翻译，只是那个标识符不能被动到。
    //
    // 注意断言的是 `text`（带占位符）而不是 `plainText`——
    // `plainText` 按设计就包含行内元素的文字，它用于统计与日志；
    // 送去翻译并受占位符保护的是 `text`。
    const root = mount(
      '<p>Use <span style="font-family: monospace">useState</span> to hold local state in a component.</p>',
    );

    const blocks = segmentElement(root, options);

    expect(blocks).toHaveLength(1);
    // 整段没被误杀
    expect(blocks[0]?.plainText).toContain('to hold local state');
    // 标识符落在占位符里，模型改不动它
    expect(blocks[0]?.text).toMatch(/<\d+>useState<\/\d+>/);
  });

  it('行内等宽的段落不会被整段误杀', () => {
    const root = mount(
      '<p>The <span style="font-family: monospace">fetch</span> API returns a promise that resolves to a response.</p>',
    );

    expect(segmentElement(root, options)).toHaveLength(1);
  });
});
