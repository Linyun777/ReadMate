/**
 * 控制面板的共享逻辑（方案第 83 节）。
 *
 * Popup 与 Side Panel 共用——两者功能重叠，各自实现必然走形。
 */

export {
  describeState,
  hasTranslation,
  isBusy,
  type PanelResult,
  queryPageState,
  requestRestore,
  requestSetMode,
  requestTranslate,
  toDisplayMode,
} from './panel-actions';
