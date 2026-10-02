import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectSourceFiles,
  EXTENSION_ROOT,
  importSpecifiers,
  PRODUCTION_DIRS,
  readSource,
  relativeFromRoot,
  resolveSpecifier,
} from './source-scan';

/**
 * 守卫测试：**模块依赖方向**（`AGENTS.md` 第 5.2 节的模块边界表）。
 *
 * 那张表写的是「谁负责什么」，隐含的是**谁能依赖谁**——而依赖方向此前没有守栏。
 * 破了它不会立刻报错，代价在别处：`shared/` 依赖 `core/` 会绕出循环引用；
 * `core/` 依赖 `entrypoints/` 意味着「可单测的核心逻辑」开始拖进入口侧的
 * 副作用（注册监听器、注入脚本），jsdom 单测会莫名其妙地挂。
 *
 * 定的方向：
 *
 * ```text
 * entrypoints  →  core / adapters / shared      （组合根在最上层）
 * core         →  adapters / shared             （core 认得适配器，不认得入口）
 * adapters     →  adapters                      （叶子层）
 * shared       →  shared                        （叶子层，所有层都能用它）
 * ```
 *
 * `core/` 依赖 `adapters/` 是**允许**的：`PageController` 走 `selectAdapter(url)`
 * 拿站点差异，这正是适配器层存在的意义。
 */

/** 每层允许依赖的顶层目录。 */
const ALLOWED: Record<string, readonly string[]> = {
  entrypoints: ['entrypoints', 'core', 'adapters', 'shared'],
  core: ['core', 'adapters', 'shared'],
  adapters: ['adapters'],
  shared: ['shared'],
};

function topLevelDir(relative: string): string {
  return relative.split(path.sep)[0] ?? '';
}

describe('模块依赖方向（AGENTS.md 第 5.2 节）', () => {
  it('没有反向依赖', () => {
    const offenders: string[] = [];

    for (const dir of PRODUCTION_DIRS) {
      const allowed = ALLOWED[dir] ?? [];
      for (const file of collectSourceFiles(path.join(EXTENSION_ROOT, dir))) {
        for (const specifier of importSpecifiers(readSource(file))) {
          const resolved = resolveSpecifier(file, specifier);
          if (resolved === null) continue; // 裸包名归「运行时依赖」那条守栏管

          const target = topLevelDir(resolved);
          if (!PRODUCTION_DIRS.includes(target as (typeof PRODUCTION_DIRS)[number])) {
            offenders.push(`${relativeFromRoot(file)} 依赖 ${specifier}（跑到 extension/ 外面了）`);
            continue;
          }
          if (!allowed.includes(target)) {
            offenders.push(
              `${relativeFromRoot(file)} 依赖 ${specifier}（${dir}/ 不能依赖 ${target}/）`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('扫描确实解析到了依赖（防止守卫本身失效）', () => {
    const edges = PRODUCTION_DIRS.flatMap((dir) =>
      collectSourceFiles(path.join(EXTENSION_ROOT, dir)).flatMap((file) =>
        importSpecifiers(readSource(file)).filter((specifier) => resolveSpecifier(file, specifier)),
      ),
    );

    expect(edges.length).toBeGreaterThan(50);
  });

  it('说明符解析覆盖别名与相对路径', () => {
    const file = path.join(EXTENSION_ROOT, 'core', 'controller', 'page-controller.ts');

    expect(resolveSpecifier(file, '@/adapters')).toBe('adapters');
    expect(resolveSpecifier(file, '@/core/cache')).toBe(path.join('core', 'cache'));
    expect(resolveSpecifier(file, '../store')).toBe(path.join('core', 'store'));
    expect(resolveSpecifier(file, './page-controller')).toBe(
      path.join('core', 'controller', 'page-controller'),
    );
    expect(resolveSpecifier(file, '@mozilla/readability')).toBeNull();
  });
});
