/**
 * 页面级命令：**右键菜单与键盘快捷键共用同一条分发**（2026-10-02）。
 *
 * 为什么单独一个模块：这两个入口做的事情完全一样（对**当前页面**发一条消息），
 * 差别只在「谁触发」。分开写必然出现「菜单改了、快捷键没改」——
 * 与 Popup / 侧边栏当初踩的是同一个坑（见 `core/panel` 的文件头）。
 *
 * 这里只放**纯数据 + 查表**：消息组装与 chrome API 留在 background（入口层）。
 * 好处是这张表能单测——菜单 ID 写错、快捷键名与 manifest 对不上，都会红。
 *
 * ⚠️ `menuId` 里的 `ai-web-translator-` 前缀是**旧的内部标识，刻意不改**
 * （改名不该让用户已有的设置失效，见 `AGENTS.md` 抬头）。
 */

import { createMessage } from '@/core/messaging/protocol';
import type {
  ExtensionMessage,
  ExtractReaderMessage,
  RestorePageMessage,
  TranslatePageMessage,
} from '@/shared/types';

export type PageCommand = 'translate' | 'restore' | 'reader';

export interface PageCommandSpec {
  command: PageCommand;
  /** 右键菜单项 ID（`contexts: ['page']`） */
  menuId: string;
  /** `wxt.config.ts` 的 `commands` 里的键 */
  shortcutName: string;
  /** 菜单标题；Popup 的快捷键提示也复用它 */
  title: string;
}

/**
 * 三项的顺序就是菜单里的顺序：翻译在最上面（最常用）。
 *
 * 「恢复原文」放在这里而不是只在 Popup：翻完想回到原文是很自然的下一步，
 * 而右键比「点图标 → 点按钮」少两步。
 */
export const PAGE_COMMANDS: readonly PageCommandSpec[] = [
  {
    command: 'translate',
    menuId: 'ai-web-translator-translate-page',
    shortcutName: 'translate-page',
    title: '翻译这个页面',
  },
  {
    command: 'restore',
    menuId: 'ai-web-translator-restore-page',
    shortcutName: 'restore-page',
    title: '恢复原文',
  },
  {
    command: 'reader',
    menuId: 'ai-web-translator-open-reader',
    shortcutName: 'open-reader',
    title: '用阅读模式打开',
  },
];

export function commandForMenuId(menuId: string): PageCommandSpec | null {
  return PAGE_COMMANDS.find((spec) => spec.menuId === menuId) ?? null;
}

export function commandForShortcut(name: string): PageCommandSpec | null {
  return PAGE_COMMANDS.find((spec) => spec.shortcutName === name) ?? null;
}

/**
 * 快捷键提示文案（Popup 底部）。
 *
 * 只显示**当前真的生效**的键：用户可能在 `chrome://extensions/shortcuts`
 * 里改过，也可能键被别的扩展抢了——那时 `getAll()` 返回的 `shortcut` 是空串。
 * 显示一个按了没反应的键，比不显示更糟。
 *
 * 传结构化的对象（而不是 `chrome.commands.Command`）是为了能单测：
 * jsdom 里没有 `chrome`。
 */
export function describeShortcutHint(
  // 字段都当可缺省：这是浏览器给的（`chrome.commands.Command` 的
  // `name` / `shortcut` 本来就是可选的）
  commands: readonly { name?: string | undefined; shortcut?: string | undefined }[],
): string | null {
  const parts: string[] = [];

  for (const spec of PAGE_COMMANDS) {
    const shortcut = commands.find((command) => command.name === spec.shortcutName)?.shortcut;
    if (shortcut !== undefined && shortcut !== '') {
      parts.push(`${spec.title} ${shortcut}`);
    }
  }

  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 把页面级命令翻成要发给 content script 的消息。
 *
 * 放在这里（而不是 entrypoint 里）是为了**能单测**：真发出去的消息类型
 * 与 content script 的 `onMessage` 分支必须对得上，写错了只有真实点击
 * 才会发现——而右键菜单和快捷键的触发在自动化里都点不到。
 */
export function pageCommandMessage(spec: PageCommandSpec): ExtensionMessage {
  switch (spec.command) {
    case 'translate':
      return createMessage<TranslatePageMessage>({ type: 'TRANSLATE_PAGE' });
    case 'restore':
      return createMessage<RestorePageMessage>({ type: 'RESTORE_PAGE' });
    case 'reader':
      return createMessage<ExtractReaderMessage>({ type: 'EXTRACT_READER' });
  }
}
