import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectProductionFiles,
  EXTENSION_ROOT,
  importSpecifiers,
  readSource,
  relativeFromRoot,
} from './source-scan';

/**
 * 守卫测试：**`package.json` 的 `dependencies` 与源码的裸包 import 双向一致**。
 *
 * 为什么值得守：扩展是**打包**产物，`import '@mozilla/readability'` 会被
 * 打进 bundle；但 `dependencies` 是**声明**，也是 `npm install` 的依据。
 * 两处一旦分叉，两种失败都不好查：
 *
 * ```text
 * 源码用了、dependencies 没写  → 本机 node_modules 里有（devDependencies 或传递依赖带来的），
 *                              跑得好好的；别人重新 install 后打包才炸
 * dependencies 写了、源码没用  → 装了一个永远不会被打进产物的包（体积/审计噪音），
 *                              多半是删代码时忘了删声明
 * ```
 *
 * 这与 `server/tests/test_env_example.py`（配置项 ↔ `.env.example`）同一个思路：
 * **同一个事实存了两份，就让它对不上时立刻红。**
 *
 * 只扫生产目录（`core/` / `entrypoints/` / `shared/` / `adapters/`）：
 * 测试用的包（`vitest` / `jsdom` / `@playwright/test`）是 `devDependencies`，
 * 它们在 `e2e/`、`*.test.ts` 与配置文件里出现，不归这条守栏管。
 */

interface PackageJson {
  dependencies?: Record<string, string>;
}

/** 内置模块不算依赖（当前生产代码没用，留着是为了不误报）。 */
function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:');
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('@/') && !isBuiltin(specifier);
}

function declaredDependencies(): string[] {
  const raw = readSource(path.join(EXTENSION_ROOT, 'package.json'));
  const pkg = JSON.parse(raw) as PackageJson;

  return Object.keys(pkg.dependencies ?? {}).sort();
}

function importedPackages(): string[] {
  const used = new Set<string>();

  for (const file of collectProductionFiles()) {
    for (const specifier of importSpecifiers(readSource(file))) {
      if (isBare(specifier)) used.add(specifier);
    }
  }

  return [...used].sort();
}

describe('运行时依赖与 package.json 一致', () => {
  it('源码里 import 的包都已声明在 dependencies 里', () => {
    const declared = new Set(declaredDependencies());

    expect(importedPackages().filter((name) => !declared.has(name))).toEqual([]);
  });

  it('dependencies 里没有源码用不到的包', () => {
    const imported = new Set(importedPackages());

    expect(declaredDependencies().filter((name) => !imported.has(name))).toEqual([]);
  });

  it('扫描确实两遍都拿到了东西（防止守卫本身失效）', () => {
    expect(collectProductionFiles().length).toBeGreaterThan(20);
    expect(importedPackages()).toEqual(['@mozilla/readability']);
    expect(relativeFromRoot(path.join(EXTENSION_ROOT, 'package.json'))).toBe('package.json');
  });
});
