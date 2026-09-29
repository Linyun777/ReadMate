/**
 * GitHub 适配器（方案第 28、64 节）。
 *
 * ## 为什么需要特化
 *
 * 一个 issue 页面上有：文件树、代码块、行号、提交信息、时间戳、按钮。
 * 通用分段器已经能跳过 `<pre>` / `<code>`（在 `IGNORED_TAG_SET` 里），
 * 但**行号、diff 视图、文件导航**这些是普通 `<div>` / `<span>`，
 * 会被当成正文翻出来——译文混进代码行号里，页面会乱。
 *
 * 所以这里显式排除代码视图与文件导航，并把根收窄到讨论区。
 *
 * ## 动态内容
 *
 * 「Load more」「Show resolved」会插入新的评论，由 MutationObserver 接入。
 */

import type { SiteAdapter } from './types';

const HOSTS = new Set(['github.com', 'www.github.com', 'gist.github.com']);

const ROOT_SELECTORS = [
  // issue / PR 的讨论区
  '[data-testid="issue-viewer"]',
  '#discussion_bucket',
  // README 与代码浏览
  '[data-testid="repository-view"]',
  'main',
];

/**
 * 必须跳过的区域。
 *
 * `blob-code` 与 `react-code-lines` 是代码视图（行号 + 代码 + 高亮 span），
 * 结构上不是 `<pre>` / `<code>`，通用规则拦不住。
 */
const IGNORED_SELECTORS = [
  '.blob-code',
  '.blob-num',
  '.react-code-lines',
  '.react-blob-print-hide',
  '.file-navigation',
  '[data-testid="breadcrumbs"]',
  '[data-testid="tree-view"]',
  '.diff-table',
  '[role="navigation"]',
  '[role="banner"]',
];

export const githubAdapter: SiteAdapter = {
  name: 'github',

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

  shouldIgnore: (element) => {
    for (const selector of IGNORED_SELECTORS) {
      if (element.closest(selector) !== null) {
        return true;
      }
    }
    return false;
  },
};
