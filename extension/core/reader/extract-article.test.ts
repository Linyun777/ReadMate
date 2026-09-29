import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { extractArticle } from './extract-article';

/**
 * 正文提取（方案第 62 节）。
 *
 * 最要紧的一条是「**不修改原文档**」——Readability 会就地改写传入的文档，
 * 直接给它真实 `document` 会破坏页面（违反铁律 3）。
 * 这个约束由 `提取不修改原文档` 这条用例钉住。
 */

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/pages',
);

function loadFixture(name: string): void {
  const html = readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('extractArticle — 提取', () => {
  it('从长文章里提取出正文', () => {
    loadFixture('long-article.html');

    const article = extractArticle(document);

    expect(article).not.toBeNull();
    expect(article?.content).toContain('Retrieval augmented generation');
    expect(article?.textLength).toBeGreaterThan(500);
  });

  it('标题取自文章而不是文档 title', () => {
    loadFixture('long-article.html');

    const article = extractArticle(document);

    expect(article?.title).toContain('Long Article');
  });

  it('带上原文地址，供阅读视图回跳', () => {
    loadFixture('long-article.html');

    const article = extractArticle(document);

    expect(article?.url).toBe(document.location.href);
  });

  it('内容过短时返回 null（登录页 / 列表页不该进阅读模式）', () => {
    document.body.innerHTML = '<p>太短了。</p>';

    expect(extractArticle(document)).toBeNull();
  });

  it('minTextLength 可调', () => {
    document.body.innerHTML = '<article><p>一段刚好够长的文字，用来测试阈值。</p></article>';

    expect(extractArticle(document, { minTextLength: 5 })).not.toBeNull();
    expect(extractArticle(document, { minTextLength: 10_000 })).toBeNull();
  });

  it('空文档返回 null 而不是抛错', () => {
    expect(extractArticle(document)).toBeNull();
  });
});

describe('extractArticle — 不修改原文档（铁律 3）', () => {
  it('提取后原 DOM 完全不变', () => {
    loadFixture('long-article.html');
    const before = document.body.innerHTML;

    extractArticle(document);

    expect(document.body.innerHTML).toBe(before);
  });

  it('提取后原文档的节点数不变', () => {
    loadFixture('long-article.html');
    const before = document.querySelectorAll('*').length;

    extractArticle(document);

    expect(document.querySelectorAll('*').length).toBe(before);
  });

  it('提取失败时也不修改原文档', () => {
    document.body.innerHTML = '<p>短。</p>';
    const before = document.body.innerHTML;

    expect(extractArticle(document)).toBeNull();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('extractArticle — 剥离噪声', () => {
  it('导航、侧栏、页脚、订阅位都不进正文', () => {
    loadFixture('article-with-noise.html');

    const article = extractArticle(document);
    const content = article?.content ?? '';

    // 正文在
    expect(content).toContain('Waiting for a full batch');

    // 噪声都不在
    expect(content).not.toContain('Skip to content');
    expect(content).not.toContain('Subscribe to the newsletter');
    expect(content).not.toContain('Related posts');
    expect(content).not.toContain('Privacy policy');
  });

  it('带噪声页面的正文长度明显小于整页文本', () => {
    loadFixture('article-with-noise.html');
    const pageText = (document.body.textContent ?? '').trim().length;

    const article = extractArticle(document);

    expect(article?.textLength).toBeLessThan(pageText);
    expect(article?.textLength).toBeGreaterThan(500);
  });
});
