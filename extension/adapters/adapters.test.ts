import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { segmentElement } from '@/core/segmenter';
import type { TranslationBlock } from '@/shared/types';

import { githubAdapter, redditAdapter, twitterAdapter } from './index';
import type { SiteAdapter } from './types';

/**
 * 站点适配行为（方案第 28、64 节）。
 *
 * **为什么用复刻结构的 fixture 而不是真实站点**：Twitter / Reddit / GitHub
 * 在 E2E 里访问不了（网络受限、登录墙、抓取条款）。用复刻 DOM 测的是
 * 「适配规则对不对」——这正是适配器要保证的事；「站点今天长什么样」
 * 是另一回事，只能靠线上反馈。
 *
 * fixture 都在 `tests/fixtures/pages/`，与 E2E 共用同一份目录。
 */

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/pages',
);

/** 加载 fixture 到当前文档（head 与 body 都要，样式会影响可见性判定）。 */
function loadFixture(name: string): void {
  const html = readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

/** 按适配器的规则分段——与 `PageController.#segmentOptions` 保持一致。 */
function segmentWith(adapter: SiteAdapter): TranslationBlock[] {
  const root = adapter.getRoot(document) ?? document.body;

  return segmentElement(root, {
    targetLanguage: 'zh-CN',
    ...(adapter.extraBlockTags === undefined ? {} : { extraBlockTags: adapter.extraBlockTags }),
    ...(adapter.shouldIgnore === undefined ? {} : { shouldIgnore: adapter.shouldIgnore }),
  });
}

function texts(blocks: readonly TranslationBlock[]): string[] {
  return blocks.map((block) => block.plainText);
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('Twitter 适配器', () => {
  it('只翻主列，不碰侧栏与导航', () => {
    loadFixture('twitter-timeline.html');

    const found = texts(segmentWith(twitterAdapter));

    expect(found.some((text) => text.includes('streaming translation pipeline'))).toBe(true);
    expect(found.some((text) => text.includes('concurrency at three'))).toBe(true);

    // 侧栏与导航不该出现
    expect(found.some((text) => text.includes('Trends'))).toBe(false);
    expect(found.some((text) => text.includes('Who to follow'))).toBe(false);
    expect(found.some((text) => text.includes('Explore'))).toBe(false);
  });

  it('每条推文的正文各自成块', () => {
    loadFixture('twitter-timeline.html');

    const found = texts(segmentWith(twitterAdapter));

    // 两条推文不该被并成一个 Block
    const tweetBodies = found.filter((text) => text.includes('pipeline') || text.includes('three'));
    expect(tweetBodies).toHaveLength(2);
  });

  it('主列不存在时 getRoot 返回 null（调用方回落到 body）', () => {
    document.body.innerHTML = '<p>No primary column here.</p>';

    expect(twitterAdapter.getRoot(document)).toBeNull();
  });

  it('显式排除导航区域', () => {
    loadFixture('twitter-timeline.html');

    const nav = document.querySelector('[role="navigation"]');
    if (nav === null) {
      throw new Error('fixture 缺少导航节点');
    }

    expect(twitterAdapter.shouldIgnore?.(nav)).toBe(true);
  });
});

describe('Reddit 适配器', () => {
  it('自定义元素各自成块，而不是整篇并成一块', () => {
    loadFixture('reddit-thread.html');

    const found = texts(segmentWith(redditAdapter));

    // 标题、正文、评论各一块
    expect(found.some((text) => text.includes('treat custom elements as inline'))).toBe(true);
    expect(found.some((text) => text.includes('walks up past them'))).toBe(true);
    expect(found.some((text) => text.includes('extraBlockTags fixes it'))).toBe(true);

    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it('不翻侧栏与操作栏', () => {
    loadFixture('reddit-thread.html');

    const found = texts(segmentWith(redditAdapter));

    expect(found.some((text) => text.includes('Related communities'))).toBe(false);
    expect(found.some((text) => text.includes('Vote'))).toBe(false);
    expect(found.some((text) => text.includes('Popular'))).toBe(false);
  });

  it('extraBlockTags 覆盖了 shreddit 系列自定义元素', () => {
    expect(redditAdapter.extraBlockTags).toContain('SHREDDIT-POST');
    expect(redditAdapter.extraBlockTags).toContain('SHREDDIT-COMMENT');
    expect(redditAdapter.extraBlockTags).toContain('SHREDDIT-TEXT-BODY');
  });

  it('去掉 extraBlockTags 后会退化成整篇一块——证明它确实在起作用', () => {
    loadFixture('reddit-thread.html');

    const withoutExtra = segmentElement(redditAdapter.getRoot(document) ?? document.body, {
      targetLanguage: 'zh-CN',
      ...(redditAdapter.shouldIgnore === undefined
        ? {}
        : { shouldIgnore: redditAdapter.shouldIgnore }),
    });

    const withExtra = segmentWith(redditAdapter);

    // 少了额外块级标签，块数必然更少（正文被并进外层容器）
    expect(withoutExtra.length).toBeLessThan(withExtra.length);
  });
});

describe('GitHub 适配器', () => {
  it('翻正文，不翻代码视图', () => {
    loadFixture('github-issue.html');

    const found = texts(segmentWith(githubAdapter));

    expect(found.some((text) => text.includes('multi-byte character'))).toBe(true);
    expect(found.some((text) => text.includes('Confirmed.'))).toBe(true);

    // 代码行不该出现
    expect(found.some((text) => text.includes('new TextDecoder'))).toBe(false);
    expect(found.some((text) => text.includes('stream: true'))).toBe(false);
  });

  it('不翻文件树与文件导航', () => {
    loadFixture('github-issue.html');

    const found = texts(segmentWith(githubAdapter));

    expect(found.some((text) => text.includes('3 branches'))).toBe(false);
    expect(found.some((text) => text.includes('Pull requests'))).toBe(false);
  });

  it('代码视图与文件导航都被显式排除', () => {
    loadFixture('github-issue.html');

    const code = document.querySelector('.blob-code');
    const fileNav = document.querySelector('.file-navigation');

    expect(code).not.toBeNull();
    expect(fileNav).not.toBeNull();
    expect(githubAdapter.shouldIgnore?.(code as Element)).toBe(true);
    expect(githubAdapter.shouldIgnore?.(fileNav as Element)).toBe(true);
  });

  it('正文段落没有被代码规则误伤', () => {
    loadFixture('github-issue.html');

    const body = document.querySelector('.markdown-body');
    if (body === null) {
      throw new Error('fixture 缺少正文节点');
    }

    expect(githubAdapter.shouldIgnore?.(body)).toBe(false);
  });
});

describe('三个适配器互不干扰', () => {
  it('用 Twitter 适配器处理 Reddit fixture 会得到不同结果', () => {
    loadFixture('reddit-thread.html');
    const twitterBlocks = texts(segmentWith(twitterAdapter));

    loadFixture('reddit-thread.html');
    const redditBlocks = texts(segmentWith(redditAdapter));

    expect(twitterBlocks).not.toEqual(redditBlocks);
  });
});
