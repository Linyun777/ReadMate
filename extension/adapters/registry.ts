/**
 * 适配器注册表（方案第 64 节）。
 *
 * **这是全项目唯一知道「哪个域名对应哪个适配器」的地方。**
 * 核心代码通过 `selectAdapter(url)` 拿适配器，自己不做任何域名判断。
 *
 * 顺序有意义：先匹配到的胜出。`defaultAdapter` 必须放在最后，
 * 它的 `matches()` 恒为 true。
 */

import { defaultAdapter } from './default';
import { githubAdapter } from './github';
import { redditAdapter } from './reddit';
import { twitterAdapter } from './twitter';
import type { SiteAdapter } from './types';

/** 按优先级排列。最后一个必须是 `defaultAdapter`。 */
export const adapters: readonly SiteAdapter[] = [
  twitterAdapter,
  redditAdapter,
  githubAdapter,
  defaultAdapter,
];

/** 按 URL 选适配器。永远返回一个（兜底是 `defaultAdapter`）。 */
export function selectAdapter(url: URL): SiteAdapter {
  for (const adapter of adapters) {
    if (adapter.matches(url)) {
      return adapter;
    }
  }
  return defaultAdapter;
}
