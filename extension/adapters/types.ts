/**
 * 站点适配接口（方案第 28、64 节）。
 *
 * ## 为什么要有这一层
 *
 * 通用分段器对大多数网页够用，但少数站点需要调整：
 *   - **正文不在 `document.body` 的合理范围**（Twitter 的时间线只是一列，
 *     旁边还有侧栏、趋势、导航）
 *   - **正文用自定义元素承载**（Reddit 的 `shreddit-post` 不在标准块级标签里）
 *   - **有些区域必须跳过**（GitHub 的代码块与文件树）
 *
 * ## 唯一的硬约束
 *
 * **域名判断只允许出现在 `matches()` 里**，而且只能出现在 `adapters/` 目录下。
 * 核心代码（`core/`）中不允许出现任何站点域名——`adapters/no-domain-in-core.test.ts`
 * 会扫描源码来钉住这一点。
 *
 * 这正是方案第 64 节说的「避免在核心代码中堆大量域名判断」。
 */

export interface SiteAdapter {
  /** 展示名，用于日志与调试 */
  readonly name: string;

  /**
   * 是否适用于该 URL。
   *
   * **这是全项目唯一允许出现站点域名的地方。**
   */
  matches(url: URL): boolean;

  /**
   * 分段与观察的根节点。返回 `null` 表示回落到 `document.body`。
   *
   * 分段与 MutationObserver 共用同一个根：两者若不一致，
   * 动态内容就会在「观察范围」与「分段范围」之间出现缝隙。
   */
  getRoot(document: Document): Element | null;

  /**
   * 额外的块级标签。
   *
   * 站点用自定义元素承载正文时（如 Reddit 的 `shreddit-post`），
   * 通用块级标签表认不出来，只能在这里补。
   */
  readonly extraBlockTags?: readonly string[];

  /** 额外的忽略规则。返回 true 表示该元素整体跳过。 */
  shouldIgnore?(element: Element): boolean;
}
