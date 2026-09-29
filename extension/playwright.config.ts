import { defineConfig } from '@playwright/test';

/**
 * Playwright 配置。
 *
 * 两个测试服务器（`webServer` 数组）：
 *
 *   1. `e2e/static-server.mjs`（8000）——提供 fixture 页，并把 `/api/v1/*`
 *      反向代理到真实 FastAPI。为什么必须这样分层，见该文件顶部注释：
 *      manifest 的 `host_permissions` 只覆盖 `http://127.0.0.1:8000/*`，
 *      而 fixture 页与 API 都需要扩展能访问。
 *   2. FastAPI（8001，`LLM_PROVIDER=mock`）——**不发起真实模型请求**（方案第 86.9 节）。
 *
 * 其他注意：
 *   - 单 worker、串行执行。扩展测试共享一个持久化浏览器上下文，并行会互相干扰。
 *   - 若本机已在 8000 / 8001 端口跑着服务，请先停掉再执行 E2E。
 *   - **FastAPI 通过 `e2e/start-server.mjs` 启动，不在这里写命令行**：
 *     那种写法依赖 POSIX shell 语义（`VAR=value cmd`、`.venv/bin/`、`/tmp/`），
 *     在 Windows 上会挂。原因见该脚本顶部注释。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  webServer: [
    {
      command: 'node e2e/static-server.mjs',
      url: 'http://127.0.0.1:8000/basic-article.html',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      // 环境变量、venv 路径、临时目录都在脚本里处理（跨平台）
      command: 'node e2e/start-server.mjs',
      url: 'http://127.0.0.1:8001/api/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],

  use: {
    trace: 'on-first-retry',
  },
});
