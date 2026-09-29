/**
 * 默认适配器（方案第 64 节）。
 *
 * 不做任何站点特化：分段根是 `document.body`，没有额外块级标签，
 * 也没有额外忽略规则。绝大多数网页走这条路径。
 */

import type { SiteAdapter } from './types';

export const defaultAdapter: SiteAdapter = {
  name: 'default',
  matches: () => true,
  getRoot: (document) => document.body,
};
