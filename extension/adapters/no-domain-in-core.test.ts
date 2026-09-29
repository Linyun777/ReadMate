import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 守卫测试：**核心代码里不许出现站点域名**（方案第 64 节）。
 *
 * 「避免在核心代码中堆大量域名判断」是这一阶段的验收标准之一。
 * 与其靠人自觉，不如让测试来钉住——这条断言会随源码变化而自动生效。
 *
 * 允许出现域名的位置只有 `adapters/`：那里是唯一该知道域名的地方。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 需要保持干净的目录。刻意不含 `adapters/`、`e2e/`、`tests/`。 */
const GUARDED_DIRS = ['core', 'entrypoints', 'shared'];

/** 站点域名。新增适配器时记得往这里补。 */
const SITE_DOMAINS = ['twitter.com', 'x.com', 'reddit.com', 'github.com'];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }

    // 只查源码；测试文件里出现域名是正常的（如本文件的断言）
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }

  return files;
}

describe('核心代码不含站点域名（方案第 64 节）', () => {
  it('core / entrypoints / shared 下没有任何站点域名', () => {
    const offenders: string[] = [];

    for (const dir of GUARDED_DIRS) {
      for (const file of collectSourceFiles(path.join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const domain of SITE_DOMAINS) {
          if (text.includes(domain)) {
            offenders.push(`${path.relative(ROOT, file)} 含 "${domain}"`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('扫描确实覆盖到了文件（防止守卫本身失效）', () => {
    const total = GUARDED_DIRS.reduce(
      (sum, dir) => sum + collectSourceFiles(path.join(ROOT, dir)).length,
      0,
    );

    expect(total).toBeGreaterThan(10);
  });
});
