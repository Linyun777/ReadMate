import { describe, expect, it } from 'vitest';

import { mountArticle, sanitizeArticle } from './sanitize';

/**
 * 正文净化（方案第 62 节）。
 *
 * Readability 的输出来自**任意网页**，是不可信输入。
 * 这组测试是安全边界，不是排版细节——每一条都对应一种真实的注入手法。
 */

function sanitize(html: string): Element {
  const root = sanitizeArticle(html);
  if (root === null) {
    throw new Error('净化失败');
  }
  return root;
}

describe('sanitizeArticle — 删除危险标签', () => {
  it('删掉 <script>', () => {
    const root = sanitize('<p>正文</p><script>alert(1)</script>');

    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('正文');
  });

  it('删掉 <style> 与 <link>', () => {
    const root = sanitize(
      '<style>body{display:none}</style><link rel="stylesheet" href="/x.css"><p>正文</p>',
    );

    expect(root.querySelector('style')).toBeNull();
    expect(root.querySelector('link')).toBeNull();
  });

  it('删掉 <iframe> / <object> / <embed>', () => {
    const root = sanitize(
      '<iframe src="https://evil.example/"></iframe><object data="x"></object><embed src="y">',
    );

    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('object')).toBeNull();
    expect(root.querySelector('embed')).toBeNull();
  });

  it('删掉表单控件', () => {
    const root = sanitize(
      '<form action="/steal"><input name="p"><button>提交</button></form><p>正文</p>',
    );

    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('input')).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });

  it('删掉 <meta> 与 <base>（可用来改基址劫持相对链接）', () => {
    const root = sanitize(
      '<base href="https://evil.example/"><meta http-equiv="refresh" content="0"><p>正文</p>',
    );

    expect(root.querySelector('base')).toBeNull();
    expect(root.querySelector('meta')).toBeNull();
  });
});

describe('sanitizeArticle — 删除事件属性', () => {
  it('删掉 onerror', () => {
    const root = sanitize('<img src="x" onerror="alert(1)">');

    const img = root.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.hasAttribute('onerror')).toBe(false);
  });

  it('删掉 onclick / onload / onmouseover', () => {
    const root = sanitize(
      '<p onclick="alert(1)" onload="alert(2)" onmouseover="alert(3)">正文</p>',
    );

    const paragraph = root.querySelector('p');
    expect(paragraph?.attributes.length).toBe(0);
  });

  it('大小写混写也拦得住', () => {
    const root = sanitize('<p ONCLICK="alert(1)">正文</p>');

    expect(root.querySelector('p')?.hasAttribute('onclick')).toBe(false);
  });
});

describe('sanitizeArticle — 删除危险协议', () => {
  it('删掉 javascript: 链接', () => {
    const root = sanitize('<a href="javascript:alert(1)">点我</a>');

    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
    // 文字保留——只去掉链接能力
    expect(root.textContent).toContain('点我');
  });

  it('删掉 data: URL', () => {
    const root = sanitize('<img src="data:text/html;base64,PHNjcmlwdD4=">');

    expect(root.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('删掉 vbscript:', () => {
    const root = sanitize('<a href="vbscript:msgbox(1)">x</a>');

    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('保留 http / https / mailto / tel', () => {
    const root = sanitize(
      '<a href="https://example.com/">a</a><a href="http://example.com/">b</a><a href="mailto:x@example.com">c</a><a href="tel:+123">d</a>',
    );

    const links = [...root.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.com/',
      'http://example.com/',
      'mailto:x@example.com',
      'tel:+123',
    ]);
  });

  it('保留相对路径与锚点', () => {
    const root = sanitize(
      '<a href="/docs/a">a</a><a href="#section">b</a><a href="./x">c</a><a href="?q=1">d</a>',
    );

    const links = [...root.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/docs/a',
      '#section',
      './x',
      '?q=1',
    ]);
  });
});

describe('sanitizeArticle — 保留正文结构', () => {
  it('保留标题、段落、列表、引用、代码', () => {
    const root = sanitize(
      '<h2>标题</h2><p>段落</p><ul><li>条目</li></ul><blockquote>引用</blockquote><pre><code>const x = 1;</code></pre>',
    );

    expect(root.querySelector('h2')?.textContent).toBe('标题');
    expect(root.querySelector('p')?.textContent).toBe('段落');
    expect(root.querySelector('li')?.textContent).toBe('条目');
    expect(root.querySelector('blockquote')?.textContent).toBe('引用');
    expect(root.querySelector('code')?.textContent).toBe('const x = 1;');
  });

  it('保留 inline 标记（加粗、链接、行内代码）', () => {
    const root = sanitize('<p>见 <strong>文档</strong> 与 <a href="/d">链接</a>。</p>');

    expect(root.querySelector('strong')?.textContent).toBe('文档');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/d');
  });

  it('删掉 style 属性（页面样式会干扰阅读视图排版）', () => {
    const root = sanitize('<p style="color:red;position:fixed">正文</p>');

    expect(root.querySelector('p')?.hasAttribute('style')).toBe(false);
  });

  it('保留无害的自定义属性', () => {
    const root = sanitize('<p data-x="1" lang="en">正文</p>');

    const paragraph = root.querySelector('p');
    expect(paragraph?.getAttribute('data-x')).toBe('1');
    expect(paragraph?.getAttribute('lang')).toBe('en');
  });

  it('空输入返回空根而不是抛错', () => {
    expect(sanitizeArticle('')?.childNodes.length ?? 0).toBe(0);
  });
});

describe('mountArticle — 移动而非复制', () => {
  it('把子节点搬进容器', () => {
    const root = sanitize('<p>第一段</p><p>第二段</p>');
    const container = document.createElement('div');

    const mounted = mountArticle(root, container);

    expect(mounted).toBe(2);
    expect(container.querySelectorAll('p')).toHaveLength(2);
    // 原根已空——是移动不是复制
    expect(root.childNodes).toHaveLength(0);
  });

  it('跳过注释节点', () => {
    const root = sanitize('<p>正文</p>');
    root.append(document.createComment(' 条件注释 '));

    const container = document.createElement('div');
    mountArticle(root, container);

    expect(container.childNodes).toHaveLength(1);
    expect(container.firstChild?.nodeType).toBe(1);
  });

  it('节点被移到目标文档（ownerDocument 已更新）', () => {
    const root = sanitize('<p>正文</p>');
    const container = document.createElement('div');

    mountArticle(root, container);

    expect(container.querySelector('p')?.ownerDocument).toBe(document);
  });
});
