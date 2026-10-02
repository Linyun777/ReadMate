import { defineConfig } from 'wxt';

/**
 * WXT 配置。
 *
 * 权限策略遵循方案第 22 节「最小权限」：
 *   - permissions 只申请 activeTab / scripting / storage / contextMenus / sidePanel
 *   - 不申请 <all_urls>
 *   - content script 采用运行时注册（registration: 'runtime'），
 *     由用户主动触发后再注入当前标签页，不预先声明匹配范围
 *
 * `contextMenus` 是 Phase 16（AI Explain）引入的：右键菜单需要它。
 * `sidePanel` 是 Side Panel 引入的：常驻控制台需要它。
 * 两者**都不会**带来额外的主机权限，也不会读取页面内容。
 */
export default defineConfig({
  manifest: {
    name: '伴读 · ReadMate',
    description: '网页翻译、阅读模式、总结与学习笔记（个人自用）',
    version: '2.2.0',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'sidePanel'],
    host_permissions: ['http://127.0.0.1:8000/*'],
    // 设置页允许把服务地址改成别的（局域网里另一台机器、换个端口），而
    // host_permissions 安装后就固定了——实测没有对应权限时后台 fetch 直接
    // `Failed to fetch`（服务端没有 CORS 中间件）。所以这里声明「可能要访问
    // 任意 http(s) 站点」，由设置页在用户点保存/测试连接时补授
    // （`core/settings/host-permission.ts`）。
    // ⚠️ 可选权限**不产生安装时的权限提示**，只在那一次请求时弹一次——
    // 与 host_permissions 的「装了就全给」不同，符合最小权限。
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    // 键盘快捷键（2026-10-02）。名字必须与 `core/commands/page-command.ts`
    // 的 `shortcutName` 一致——那边有单测钉住，改这里忘改那边会红。
    // 用户可以在 chrome://extensions/shortcuts 里改键；Popup 显示的是
    // **当前**生效的键（`chrome.commands.getAll()`），所以界面不会说谎。
    commands: {
      'translate-page': {
        suggested_key: { default: 'Alt+T' },
        description: '翻译当前页面',
      },
      'restore-page': {
        suggested_key: { default: 'Alt+R' },
        description: '恢复原文',
      },
      'open-reader': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: '用阅读模式打开当前页面',
      },
    },
  },
});
