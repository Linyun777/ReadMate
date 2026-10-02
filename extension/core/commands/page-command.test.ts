import { describe, expect, it } from 'vitest';

import {
  commandForMenuId,
  commandForShortcut,
  describeShortcutHint,
  PAGE_COMMANDS,
  pageCommandMessage,
} from './page-command';

/**
 * 页面级命令表（右键菜单 / 键盘快捷键）。
 *
 * 这张表的值是**字符串 ID**——写错了不会编译失败，只会在真实使用中
 * 静默失效（菜单点了没反应、快捷键按了没反应）。所以拿测试钉住查表。
 */

describe('命令表', () => {
  it('三项：翻译 / 恢复原文 / 阅读模式，翻译排第一（最常用）', () => {
    expect(PAGE_COMMANDS.map((spec) => spec.command)).toEqual(['translate', 'restore', 'reader']);
  });

  it('ID 与名字都不重复（重复会让 onClicked 命中最靠前的那条）', () => {
    const menuIds = PAGE_COMMANDS.map((spec) => spec.menuId);
    const shortcuts = PAGE_COMMANDS.map((spec) => spec.shortcutName);

    expect(new Set(menuIds).size).toBe(menuIds.length);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('菜单 ID 保留旧前缀（改名不该让已有设置失效）', () => {
    for (const spec of PAGE_COMMANDS) {
      expect(spec.menuId.startsWith('ai-web-translator-')).toBe(true);
    }
  });
});

describe('查表', () => {
  it('按菜单 ID 查得到，未知 ID 返回 null', () => {
    expect(commandForMenuId('ai-web-translator-translate-page')?.command).toBe('translate');
    expect(commandForMenuId('ai-web-translator-restore-page')?.command).toBe('restore');
    expect(commandForMenuId('ai-web-translator-open-reader')?.command).toBe('reader');
    expect(commandForMenuId('ai-web-translator-explain')).toBeNull();
    expect(commandForMenuId('')).toBeNull();
  });

  it('按快捷键名查得到，未知名字返回 null', () => {
    expect(commandForShortcut('translate-page')?.command).toBe('translate');
    expect(commandForShortcut('_execute_action')).toBeNull();
    expect(commandForShortcut('')).toBeNull();
  });
});

describe('describeShortcutHint', () => {
  it('按命令表顺序拼出提示，用当前生效的键', () => {
    expect(
      describeShortcutHint([
        { name: 'restore-page', shortcut: 'Alt+R' },
        { name: 'translate-page', shortcut: 'Alt+T' },
        { name: 'open-reader', shortcut: 'Alt+Shift+R' },
      ]),
    ).toBe('翻译这个页面 Alt+T · 恢复原文 Alt+R · 用阅读模式打开 Alt+Shift+R');
  });

  it('用户改过键就显示新键（提示不会说谎）', () => {
    expect(describeShortcutHint([{ name: 'translate-page', shortcut: '⌥T' }])).toBe(
      '翻译这个页面 ⌥T',
    );
  });

  it('没生效的键不显示；一个都没有时整行为空（返回 null）', () => {
    expect(describeShortcutHint([{ name: 'translate-page', shortcut: '' }])).toBeNull();
    expect(describeShortcutHint([])).toBeNull();
    expect(describeShortcutHint([{ name: '_execute_action', shortcut: 'Alt+Shift+P' }])).toBeNull();
  });

  it('缺字段（浏览器给的 Command 字段可选）不会炸', () => {
    expect(describeShortcutHint([{ shortcut: 'Alt+T' }, { name: 'translate-page' }])).toBeNull();
  });
});

describe('pageCommandMessage', () => {
  it('三条命令各自映到 content script 认得的消息类型', () => {
    const byCommand = new Map(
      PAGE_COMMANDS.map((spec) => [spec.command, pageCommandMessage(spec).type]),
    );

    expect(byCommand.get('translate')).toBe('TRANSLATE_PAGE');
    expect(byCommand.get('restore')).toBe('RESTORE_PAGE');
    // 阅读模式也走 content script（它才有页面 DOM），由它再交给 background 开页面
    expect(byCommand.get('reader')).toBe('EXTRACT_READER');
  });

  it('消息带 source 标记（协议约定，content script 据此判断来源）', () => {
    for (const spec of PAGE_COMMANDS) {
      expect(pageCommandMessage(spec).source).toBeDefined();
    }
  });
});
