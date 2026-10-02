/**
 * 「守栏测试」共用的源码扫描工具。
 *
 * 这一组测试不看运行时行为，只看**源码形状**：铁律 2 禁的 DOM 写入 API、
 * 模块依赖方向、`package.json` 与源码 import 的一致性。共同点是
 * 「约定写在文档里，靠人自觉，而没有任何东西会失败」——
 * 这里给它补一条会自动生效的断言。
 *
 * 放 `tests/` 而不是某个模块下：这三条约定都**跨目录**，不属于任何单个模块。
 * （`adapters/no-domain-in-core.test.ts` 是例外——那条规则正是 `adapters` 存在的理由，
 * 所以它留在 `adapters/` 里。）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `extension/` 的绝对路径（本文件在 `extension/tests/` 下）。 */
export const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 会被打进扩展产物的源码目录。
 *
 * 刻意不含 `e2e/`（Playwright 用例）与 `tests/`（本目录）——
 * 它们不进产物，允许放宽约定。
 */
export const PRODUCTION_DIRS = ['core', 'entrypoints', 'shared', 'adapters'] as const;

/** 递归收集 `.ts` 源码文件；默认跳过 `*.test.ts`（测试里出现什么都不算问题）。 */
export function collectSourceFiles(dir: string, includeTests = false): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full, includeTests));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (!includeTests && entry.endsWith('.test.ts')) continue;
    files.push(full);
  }

  return files;
}

/** 生产目录下的全部源码文件（绝对路径）。 */
export function collectProductionFiles(): string[] {
  return PRODUCTION_DIRS.flatMap((dir) => collectSourceFiles(path.join(EXTENSION_ROOT, dir)));
}

/**
 * 取出源码里的模块说明符。
 *
 * 覆盖三种写法：`import ... from 'x'`、`export ... from 'x'`（`core/*\/index.ts` 用的是这种）、
 * 以及侧效应导入 `import 'x'`。动态 `import('x')` 也收。
 *
 * 单纯字符串匹配、不做语法解析：注释里若写出 `from '@/core/queue'` 这种**完整形态**
 * 会误报（实测当前源码没有）。真出现了，改注释比给扫描器加解析便宜。
 */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }

  return specifiers;
}

/** 把说明符解析成 `extension/` 下的相对路径；解析不出来时返回 null（裸包名）。 */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (specifier.startsWith('.')) {
    return path.relative(EXTENSION_ROOT, path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

/** 相对 `extension/` 的路径，只用于报错信息。 */
export function relativeFromRoot(file: string): string {
  return path.relative(EXTENSION_ROOT, file);
}

export function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}
