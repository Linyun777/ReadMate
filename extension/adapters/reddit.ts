/**
 * Reddit 适配器（方案第 28、64 节）。
 *
 * ## 为什么需要特化
 *
 * Reddit 新版界面用**自定义元素**承载正文：`shreddit-post`、`shreddit-comment`、
 * `shreddit-text-body` 都不在标准块级标签表里。
 *
 * 后果很具体：`findBlockContainer` 认不出它们，会一路向上找到外层 `<div>`，
 * 于是**整条帖子（标题 + 正文 + 投票栏 + 操作按钮）被并成一个 Block**——
 * 译文会挤在一起，占位符也会把按钮结构一起卷进来。
 *
 * 补上 `extraBlockTags` 之后，每个自定义元素各自成为一个 Block。
 *
 * ## 动态内容
 *
 * 评论区「展开更多」会插入新的 `shreddit-comment`，由 MutationObserver 接入。
 */

import type { SiteAdapter } from './types';

const HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'sh.reddit.com',
]);

const ROOT_SELECTORS = ['shreddit-app', 'main', '[role="main"]'];

/** 自定义元素：通用块级标签表认不出来，必须显式声明。 */
const EXTRA_BLOCK_TAGS = [
  'SHREDDIT-POST',
  'SHREDDIT-COMMENT',
  'SHREDDIT-TEXT-BODY',
  'SHREDDIT-POST-TITLE',
  'FACEPLATE-BUTTON',
];

const IGNORED_SELECTORS = [
  'shreddit-sidebar',
  '[data-testid="subreddit-sidebar"]',
  'shreddit-comment-action-row',
  '[slot="credit-bar"]',
  '[role="navigation"]',
  '[role="banner"]',
];

export const redditAdapter: SiteAdapter = {
  name: 'reddit',

  matches: (url) => HOSTS.has(url.hostname),

  getRoot: (document) => {
    for (const selector of ROOT_SELECTORS) {
      const element = document.querySelector(selector);
      if (element !== null) {
        return element;
      }
    }
    return null;
  },

  extraBlockTags: EXTRA_BLOCK_TAGS,

  shouldIgnore: (element) => {
    for (const selector of IGNORED_SELECTORS) {
      if (element.closest(selector) !== null) {
        return true;
      }
    }
    return false;
  },
};
