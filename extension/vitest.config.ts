import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest 配置（方案第 76 节：Unit Test 推荐 Vitest，DOM 测试用 jsdom）。
 *
 * 说明：
 *   - 用 jsdom 环境，Segmenter 的测试需要真实的 DOM API
 *   - 单独配置 `@` 别名，因为 WXT 的别名只在它自己的构建流程里生效
 *   - 跑 `core/` / `shared/` / `adapters/` 下的 `*.test.ts`；E2E 归 Playwright 管
 *   - `tests/` 放**跨目录**的守栏测试（铁律 2 的 DOM 写入禁令、模块依赖方向、
 *     运行时依赖一致性）——它们不属于任何单个模块，也不进产物
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': currentDir,
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'core/**/*.test.ts',
      'shared/**/*.test.ts',
      'adapters/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    reporters: 'default',
  },
});
