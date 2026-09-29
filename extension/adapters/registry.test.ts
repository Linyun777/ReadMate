import { describe, expect, it } from 'vitest';

import {
  adapters,
  defaultAdapter,
  githubAdapter,
  redditAdapter,
  selectAdapter,
  twitterAdapter,
} from './index';

describe('selectAdapter — 站点匹配', () => {
  it.each([
    ['https://twitter.com/home', 'twitter'],
    ['https://www.twitter.com/home', 'twitter'],
    ['https://mobile.twitter.com/home', 'twitter'],
    ['https://x.com/home', 'twitter'],
    ['https://reddit.com/r/typescript', 'reddit'],
    ['https://www.reddit.com/r/typescript', 'reddit'],
    ['https://old.reddit.com/r/typescript', 'reddit'],
    ['https://sh.reddit.com/r/typescript', 'reddit'],
    ['https://github.com/Linyun777/Trans-AIweb', 'github'],
    ['https://gist.github.com/someone/abc123', 'github'],
  ])('%s → %s', (url, expected) => {
    expect(selectAdapter(new URL(url)).name).toBe(expected);
  });

  it.each([
    'https://example.com/',
    'https://news.ycombinator.com/',
    'http://127.0.0.1:8000/basic-article.html',
    // 后缀相似但不是同一个站点——不能被子串匹配误伤
    'https://nottwitter.com/',
    'https://github.com.evil.example/',
    'https://myreddit.com/',
  ])('未知站点回落到默认适配器：%s', (url) => {
    expect(selectAdapter(new URL(url))).toBe(defaultAdapter);
  });
});

describe('adapters 注册表不变式', () => {
  it('默认适配器排在最后（它是兜底）', () => {
    expect(adapters.at(-1)).toBe(defaultAdapter);
  });

  it('每个适配器有唯一的 name', () => {
    const names = adapters.map((adapter) => adapter.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('除默认适配器外，每个都只匹配自己的站点', () => {
    expect(twitterAdapter.matches(new URL('https://reddit.com/'))).toBe(false);
    expect(twitterAdapter.matches(new URL('https://github.com/'))).toBe(false);
    expect(redditAdapter.matches(new URL('https://twitter.com/'))).toBe(false);
    expect(redditAdapter.matches(new URL('https://github.com/'))).toBe(false);
    expect(githubAdapter.matches(new URL('https://twitter.com/'))).toBe(false);
    expect(githubAdapter.matches(new URL('https://reddit.com/'))).toBe(false);
  });

  it('默认适配器匹配任意 URL', () => {
    expect(defaultAdapter.matches(new URL('https://anything.example/'))).toBe(true);
  });

  it('getRoot 在找不到目标容器时返回 null（由调用方回落到 body）', () => {
    // 空文档里没有 primaryColumn / shreddit-app / main
    document.body.innerHTML = '';

    expect(twitterAdapter.getRoot(document)).toBeNull();
    expect(redditAdapter.getRoot(document)).toBeNull();
  });
});
