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
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': currentDir,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['core/**/*.test.ts', 'shared/**/*.test.ts', 'adapters/**/*.test.ts'],
    reporters: 'default',
  },
});
