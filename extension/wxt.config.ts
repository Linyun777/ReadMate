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
    version: '2.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'sidePanel'],
    host_permissions: ['http://127.0.0.1:8000/*'],
  },
});
