/**
 * 启动 E2E 用的 FastAPI（mock Provider，端口 8001）。
 *
 * ## 为什么要有这个脚本
 *
 * 原本 `playwright.config.ts` 里直接写命令行：
 *
 * ```text
 * LLM_PROVIDER=mock ... USAGE_LEDGER_PATH=/tmp/... .venv/bin/uvicorn app.main:app ...
 * ```
 *
 * 那是 **POSIX shell 语义**，在 Windows 上三处都会挂：
 *
 *   1. `VAR=value command` 内联环境变量 —— cmd / PowerShell 不支持
 *   2. `.venv/bin/uvicorn` —— Windows 是 `.venv\Scripts\`
 *   3. `/tmp/...` —— Windows 没有 `/tmp`
 *
 * 而 E2E 是发布门禁，跑不起来就等于没法验证改动。
 *
 * 用 Node 启动则三端一致：环境变量走 `spawn` 的 `env` 选项（不经过 shell），
 * 路径用 `path.join` 拼，临时目录用 `os.tmpdir()`。
 *
 * **刻意不用 `cross-env`**：它能解决环境变量语法，但解决不了
 * 「venv 的 python 在哪」——那件事只有自己写才靠得住。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', '..', 'server');

const PORT = '8001';
const HOST = '127.0.0.1';

/**
 * 找 venv 里的 Python。
 *
 * POSIX 放在 `bin/`，Windows 放在 `Scripts/` 且带 `.exe` 后缀。
 * 两个都试，都不在就给出能照着做的提示，而不是抛一句 ENOENT。
 */
function resolvePython() {
  const candidates = [
    path.join(serverDir, '.venv', 'bin', 'python'),
    path.join(serverDir, '.venv', 'Scripts', 'python.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  console.error(
    [
      `找不到虚拟环境里的 Python。已尝试：`,
      ...candidates.map((item) => `  ${item}`),
      '',
      '请先创建并安装依赖：',
      '  cd server',
      '  python -m venv .venv',
      '  .venv/bin/pip install -r requirements.txt      # Windows: .venv\\Scripts\\pip',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const python = resolvePython();

/**
 * 用真实 Provider 而不是 mock。
 *
 * `REAL_MODEL_E2E=1` 时打开——供 `real-model.spec.ts` 与
 * `screenshots.spec.ts` 使用。**会发起真实请求并产生费用。**
 *
 * 不打开时一律 mock，这是 E2E 的默认行为（不得发起真实模型请求）。
 */
const useRealModel = process.env.REAL_MODEL_E2E === '1';

/**
 * E2E 用的 `.env`，指向临时目录。
 *
 * ⚠️ **必须隔离。** 设置页的「保存到服务端」会写 `.env` ——
 * 不隔离的话，跑一次 E2E 就把真实的 Key 和模型配置改了。
 * 与 `USAGE_LEDGER_PATH` 同样的思路。
 *
 * 预填几个值，让设置页有东西可显示、可断言。
 */
const envFile = path.join(tmpdir(), 'wt-e2e.env');
writeFileSync(
  envFile,
  [
    'LLM_PROVIDER=mock',
    'LLM_API_KEY=',
    'LLM_BASE_URL=https://api.example.test/v1',
    'LLM_MODEL=model-before',
    'LLM_SUMMARY_MODEL=',
    '',
  ].join('\n'),
  'utf8',
);

/**
 * 用 `-m uvicorn` 而不是直接调 uvicorn 可执行文件。
 *
 * 后者在 Windows 上叫 `uvicorn.exe`，还要再拼一次路径；走模块调用
 * 由 Python 自己解析，三端一致。
 */
const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', HOST, '--port', PORT], {
  cwd: serverDir,
  env: {
    ...process.env,

    // 默认 mock（不得发起真实模型请求）；REAL_MODEL_E2E=1 时用真实 Provider
    LLM_PROVIDER: useRealModel ? 'openai_compatible' : 'mock',

    // 拉开流式段之间的间隔，让「完成一段就渲染一段」的中间状态
    // 可以被断言到（见 e2e/streaming.spec.ts）
    LLM_MOCK_STREAM_DELAY_MS: '100',

    // 指向临时文件：E2E 走 mock，用量是按字符数瞎估的，
    // 写进真实台账会让统计失真
    USAGE_LEDGER_PATH: path.join(tmpdir(), 'wt-e2e-usage.jsonl'),

    // 同上：设置页的「保存到服务端」会写 .env，
    // 不能让 E2E 改到真实配置
    // 允许外部覆盖——生成截图时要指向带真实 Key 的 .env
    ENV_FILE_PATH: process.env.ENV_FILE_PATH ?? envFile,
  },
  stdio: 'inherit',
});

// Playwright 结束时会终止我们 —— 把信号转发给子进程，别留下孤儿 uvicorn
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 0);
});

child.on('error', (error) => {
  console.error('启动 E2E 服务失败：', error.message);
  process.exit(1);
});
