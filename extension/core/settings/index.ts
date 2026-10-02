/**
 * 扩展设置：`chrome.storage.local` 持久化（方案第 39 节）。
 *
 * **不含 API Key**——Key 只存在于服务端 `.env`。
 */

export {
  ensureServerAccess,
  originPatternFor,
  type PermissionsApi,
  type ServerAccess,
  serverAccessMessage,
  serverUrlWasReplaced,
} from './host-permission';
export {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  resetSettings,
  saveSettings,
} from './settings-store';
