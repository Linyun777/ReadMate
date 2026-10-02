import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PAGE_COMMANDS } from '@/core/commands';

import { EXTENSION_ROOT, readSource } from './source-scan';

/**
 * 守卫测试：**`wxt.config.ts` 的 `commands` 与 `core/commands` 的命令表一致**。
 *
 * 两处都写着快捷键名（`translate-page` 这种字符串），对不上不会编译失败：
 * 现象是「按了快捷键没反应」，而 `chrome.commands.onCommand` 拿到的名字
 * 谁也匹配不上——最难查的一类静默失效。查表那一侧有单测，
 * 这份补的是「manifest 里到底声明了哪些名字」。
 *
 * 另一个方向也查：manifest 里声明了、命令表里没有 → 用户看得到却按不动。
 */

const CONFIG_FILE = path.join(EXTENSION_ROOT, 'wxt.config.ts');

/**
 * 取 `commands: { ... }` 的整段（按花括号配对，不能用非贪婪正则——
 * 第一项自己的 `}` 就会让它提前收尾，实测踩过）。
 */
function commandsBlock(): string {
  const source = readSource(CONFIG_FILE);
  const start = /^\s*commands:\s*\{/m.exec(source);

  if (start === null) return '';

  const from = source.indexOf('{', start.index);
  let depth = 0;

  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, index + 1);
    }
  }

  return '';
}

/** 取 `commands` 里的一级键名（各占一行，形如 `'name': {`）。 */
function declaredCommandNames(): string[] {
  return [...commandsBlock().matchAll(/^\s*'([^']+)':\s*\{/gm)].map((match) => match[1] ?? '');
}

describe('快捷键：manifest 与命令表一致', () => {
  it('命令表里的每条都有声明', () => {
    const declared = declaredCommandNames();

    for (const spec of PAGE_COMMANDS) {
      expect(declared, `${spec.shortcutName} 没写进 wxt.config.ts 的 commands`).toContain(
        spec.shortcutName,
      );
    }
  });

  it('manifest 里声明了的都在命令表里（否则按了没反应）', () => {
    const known = PAGE_COMMANDS.map((spec) => spec.shortcutName);

    expect(declaredCommandNames().filter((name) => !known.includes(name))).toEqual([]);
  });

  it('每条都有 suggested_key（没有默认键的快捷键用户根本发现不了）', () => {
    expect(commandsBlock().match(/suggested_key/g)?.length).toBe(PAGE_COMMANDS.length);
  });

  it('解析确实拿到了东西（防止守卫本身失效）', () => {
    expect(declaredCommandNames().length).toBeGreaterThan(0);
  });
});
