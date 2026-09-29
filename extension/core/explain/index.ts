/**
 * AI 解释（方案第 29、41 节）。
 *
 * 选中文字 → 右键 → 解释。结果就地显示在选区附近。
 */

export {
  EXPLAIN_OVERLAY_ID,
  ExplainOverlay,
  type ExplainOverlayOptions,
} from './explain-overlay';
export {
  MAX_SELECTION_LENGTH,
  type ReadSelectionOptions,
  readSelection,
  type SelectionInfo,
} from './selection-context';
