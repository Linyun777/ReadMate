/**
 * Twitter / X 适配器（方案第 28、64 节）。
 *
 * ## 为什么需要特化
 *
 * 时间线只是页面的一列，旁边还有左侧导航、右侧趋势与推荐。
 * 以 `document.body` 为根会把这三块全翻一遍——既浪费 token，
 * 又会把「趋势」「推荐关注」这类噪声翻译出来。
 *
 * 因此把根收窄到主列（`[data-testid="primaryColumn"]`）。
 *
 * ## 动态内容
 *
 * 时间线是无限滚动的：新推文不断插入主列。MutationObserver 的观察根
 * 与分段根一致（都来自 `getRoot`），所以新推文会被自动接入。
 */

import type { SiteAdapter } from './types';

const HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
]);

/** 主列选择器，按优先级排列。 */
const ROOT_SELECTORS = ['[data-testid="primaryColumn"]', 'main[role="main"]', 'main'];

/**
 * 必须跳过的区域。
 *
 * 主列之外的东西理论上不会被分段，但导航与侧栏有时会嵌在主列内部
 * （例如移动端布局），因此仍显式排除一次。
 */
const IGNORED_SELECTORS = [
  '[data-testid="sidebarColumn"]',
  '[data-testid="BottomBar"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="menu"]',
];

export const twitterAdapter: SiteAdapter = {
  name: 'twitter',

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
