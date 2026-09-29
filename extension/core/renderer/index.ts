/**
 * Renderer：译文 → DOM，含恢复原文（方案第 55、86.2 节）。
 *
 * 职责边界：
 *   - **只写 DOM**，不取译文（那是 `core/translator`）
 *   - **不做结构校验的决策**——校验失败时直接拒绝渲染（铁律第 5 条）
 *   - 不负责调度（那是 `core/queue`）
 */

export { Renderer, type RenderResult, stripInsertedNodes } from './renderer';
export { flattenTranslation, parseTranslation, type RenderToken } from './tokens';
