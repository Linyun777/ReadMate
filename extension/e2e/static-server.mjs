/**
 * E2E 用的测试服务器：静态 fixture + API 反向代理。
 *
 * ## 为什么需要它
 *
 * 两个约束逼出了这个设计：
 *
 * 1. **fixture 页必须由 `http://127.0.0.1:8000` 提供**
 *    扩展采用 `activeTab` + `scripting.executeScript` 按需注入，而自动化测试
 *    无法模拟「用户点击扩展图标」这一手势。没有该手势时，`executeScript`
 *    需要 `host_permissions` 覆盖目标页面；manifest 里只配了这一个 origin。
 *
 * 2. **扩展也要能访问 FastAPI**
 *    background 的 fetch 同样受 `host_permissions` 约束。若把 FastAPI 直接
 *    跑在 8000，就和 fixture 页抢端口了。
 *
 * 解法：本服务器占用 8000，**把 `/api/v1/*` 反向代理到真实 FastAPI**
 * （默认 `http://127.0.0.1:8001`）。这样扩展只需一个 host 权限，
 * 而测的仍是真实的 FastAPI（`LLM_PROVIDER=mock`），不是替身。
 *
 * 无第三方依赖。
 */

import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.E2E_PORT ?? 8000);
const API_TARGET = process.env.E2E_API_TARGET ?? 'http://127.0.0.1:8001';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/pages');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * 转发到 FastAPI 的统计量，供 E2E 断言使用。
 *
 * `translateItems` 是**请求里携带的条目总数**——Phase 9 靠它直接断言
 * 「未进入视口的内容不产生请求」，而不是只断言「没被翻译」。
 *
 * `lastTargetLanguage` / `lastStyle` 记录最近一次请求的语言与风格，
 * 用于验证 Options 里的设置确实传到了请求里（Phase 13）。
 */
const stats = {
  translateRequests: 0,
  translateItems: 0,
  lastTargetLanguage: null,
  lastStyle: null,
};

function isTranslateRequest(request) {
  return request.method === 'POST' && (request.url ?? '').startsWith('/api/v1/translate');
}

/**
 * 失败注入（只存在于 E2E 服务器）。
 *
 * 用来测「翻译失败时界面说了什么」——服务端一切正常时这条分支永远走不到。
 *   detail  —— 返回 400 + `{ detail }`（确定性错误，队列不会重试，跑得快）
 *   network —— 直接断开连接（扩展看到的是 `Failed to fetch`）
 */
const failTranslate = { remaining: 0, mode: 'detail', detail: 'E2E 注入的服务端错误' };

/** 把 `/api/v1/*` 的请求转发到真实 FastAPI。 */
function proxyToApi(request, response) {
  if (isTranslateRequest(request) && failTranslate.remaining > 0) {
    failTranslate.remaining -= 1;
    request.resume();

    if (failTranslate.mode === 'network') {
      response.destroy();
      return;
    }

    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ detail: failTranslate.detail }));
    return;
  }

  const target = new URL(request.url ?? '/', API_TARGET);

  const proxied = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: { ...request.headers, host: target.host },
    },
    (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    },
  );

  proxied.on('error', (error) => {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({ detail: `E2E 代理无法连接 FastAPI（${API_TARGET}）：${error.message}` }),
    );
  });

  if (!isTranslateRequest(request)) {
    request.pipe(proxied);
    return;
  }

  // 翻译请求需要读一遍请求体才能统计条目数，因此不能直接 pipe
  const chunks = [];
  request.on('data', (chunk) => {
    chunks.push(chunk);
  });
  request.on('end', () => {
    const body = Buffer.concat(chunks);

    stats.translateRequests += 1;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (Array.isArray(parsed.items)) {
        stats.translateItems += parsed.items.length;
      }
      if (typeof parsed.target_language === 'string') {
        stats.lastTargetLanguage = parsed.target_language;
      }
      if (typeof parsed.style === 'string') {
        stats.lastStyle = parsed.style;
      }
    } catch {
      // 请求体不是 JSON，只计请求数
    }

    proxied.end(body);
  });
}

/**
 * 测试观测端点（仅存在于 E2E 服务器，不进入扩展）。
 *
 *   GET  /__e2e/stats                       读取统计
 *   POST /__e2e/reset                       归零
 *   POST /__e2e/fail-translate?count=1&mode=detail|network   注入翻译失败
 */
function handleObservability(response, pathname, url) {
  if (pathname === '/__e2e/stats') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(stats));
    return true;
  }

  if (pathname === '/__e2e/fail-translate') {
    failTranslate.remaining = Number.parseInt(url.searchParams.get('count') ?? '1', 10) || 1;
    failTranslate.mode = url.searchParams.get('mode') === 'network' ? 'network' : 'detail';
    failTranslate.detail = url.searchParams.get('detail') ?? failTranslate.detail;
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(failTranslate));
    return true;
  }

  if (pathname === '/__e2e/reset') {
    failTranslate.remaining = 0;
    stats.translateRequests = 0;
    stats.translateItems = 0;
    stats.lastTargetLanguage = null;
    stats.lastStyle = null;
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(stats));
    return true;
  }

  return false;
}

async function serveFixture(request, response) {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
  const filePath = path.join(ROOT, relative);

  // 防止路径穿越到 fixtures 目录之外
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (handleObservability(response, url.pathname, url)) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    proxyToApi(request, response);
    return;
  }

  void serveFixture(request, response);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] fixture server on http://127.0.0.1:${PORT} → API ${API_TARGET}`);
});
