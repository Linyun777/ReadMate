/**
 * 扩展上下文存活检查。
 *
 * ## 要解决的问题
 *
 * 扩展被重新加载（开发时刷新、或自动更新）之后，**已经打开的页面里
 * 还跑着上一个版本的 content script**。此时它手里的 `chrome.*` 全部失效：
 *
 *   - `chrome.storage` → `undefined`
 *   - `chrome.runtime.sendMessage` → 抛 "Extension context invalidated"
 *
 * 而 WXT 的 storage 适配器在 `chrome.storage == null` 时会抛：
 *
 * ```text
 * You must add the 'storage' permission to your manifest to use 'wxt/storage'
 * ```
 *
 * **这条报错极具误导性**——manifest 里明明有 `storage` 权限。真正的原因是
 * 上下文已死，不是权限缺失。它会出现在 `chrome://extensions` 的错误列表里，
 * 让人以为是配置问题。
 *
 * ## 判断依据
 *
 * `chrome.runtime.id` 在上下文失效后变成 `undefined`，是最可靠的信号。
 * 单看 `chrome.runtime` 是否存在不够——失效后对象还在，只是内容空了。
 */

/** 扩展上下文是否仍然有效。 */
export function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && chrome.runtime?.id !== undefined;
  } catch {
    // 极端情况下访问 `chrome` 本身就会抛（被页面 CSP 拦等），一并当作失效
    return false;
  }
}

/** 上下文失效时的统一提示文案。 */
export const CONTEXT_INVALIDATED_MESSAGE =
  '扩展刚刚被重新加载，这个页面上还跑着旧版本的脚本。请刷新页面（F5）后重试。';
