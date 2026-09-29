import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test';

/**
 * Playwright 扩展测试夹具。
 *
 * 加载的是**真实构建产物**（`extension/.output/chrome-mv3`），
 * 而不是源码目录——这样构建配置问题会在 E2E 阶段暴露。
 *
 * 依据：方案第 76 节，E2E 是发布门禁。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const EXTENSION_PATH = path.resolve(currentDir, '../.output/chrome-mv3');
export const FIXTURE_DIR = path.resolve(currentDir, '../tests/fixtures/pages');

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  clearCache: null;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright 夹具要求此签名
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const extensionId = worker.url().split('/')[2];
    if (!extensionId) {
      throw new Error(`无法从 service worker URL 解析扩展 ID：${worker.url()}`);
    }
    await use(extensionId);
  },

  /**
   * 每个用例开始前清空译文缓存。
   *
   * 缓存存在 `chrome.storage.local` 里，会跨用例存活——不清掉的话
   * 「发了几个请求」这类断言会被上一个用例的缓存污染。
   */
  clearCache: [
    async ({ context }, use) => {
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });

      await worker.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        // 前缀与 shared/constants.ts 的 CACHE_KEY_PREFIX 一致
        const keys = Object.keys(all).filter((key) => key.startsWith('tc:'));
        if (keys.length > 0) {
          await chrome.storage.local.remove(keys);
        }
      });

      await use(null);
    },
    { auto: true },
  ],
});

export const expect = test.expect;

/* ------------------------------------------------------------------ *
 * 共享辅助
 *
 * 为什么测试页必须是 8000 端口：见 `e2e/static-server.mjs` 顶部注释。
 * ------------------------------------------------------------------ */

export const FIXTURE_URL = 'http://127.0.0.1:8000/basic-article.html';

/** 取 background service worker；缺失时直接失败并给出清晰原因。 */
export function requireWorker(context: BrowserContext) {
  const [worker] = context.serviceWorkers();
  if (!worker) {
    throw new Error('background service worker 未启动');
  }
  return worker;
}

/** 打开 Popup 页面（在测试中以普通标签页形式打开）。 */
export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

/**
 * 把指定 fixture 标签页设为「活动标签页」，模拟用户从该页打开 Popup 的场景。
 *
 * `url` 默认是 `basic-article.html`。**同一测试若打开了多个 fixture，必须显式传入**
 * ——否则按 URL 前缀匹配可能命中错误的那一个。
 */
export async function activateFixtureTab(
  context: BrowserContext,
  url: string = FIXTURE_URL,
): Promise<void> {
  const activated = await requireWorker(context).evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url?.startsWith(targetUrl));
    if (typeof target?.id !== 'number') {
      return false;
    }
    await chrome.tabs.update(target.id, { active: true });
    return true;
  }, url);

  expect(activated, `应能定位并激活 fixture 标签页：${url}`).toBe(true);
}

/** 页面上插件插入的双语节点数量。 */
export async function countPluginNodes(page: Page): Promise<number> {
  return await page.evaluate(() => document.querySelectorAll('[data-ai-translator="true"]').length);
}
