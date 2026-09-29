/**
 * 站点适配（方案第 28、64 节）。
 *
 * 核心代码只依赖 `SiteAdapter` 接口与 `selectAdapter(url)`——
 * **域名判断全部关在本目录里**。
 */

export { defaultAdapter } from './default';
export { githubAdapter } from './github';
export { redditAdapter } from './reddit';
export { adapters, selectAdapter } from './registry';
export { twitterAdapter } from './twitter';
export type { SiteAdapter } from './types';
