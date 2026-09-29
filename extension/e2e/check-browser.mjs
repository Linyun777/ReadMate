/**
 * 在指定浏览器里加载扩展，检查是否真的能用。
 *
 * 用来回答「Edge / Chrome 能不能装」这类问题——**实测比查资料可靠**。
 *
 * 用法：
 *   node e2e/check-browser.mjs                # 用 Edge
 *   node e2e/check-browser.mjs chrome         # 用 Chrome
 *   node e2e/check-browser.mjs chromium       # 用 Playwright 自带的 Chromium
 *
 * 需要扩展已构建（npm run build），且 fixture 服务在 8000 端口。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(here, '..', '.output', 'chrome-mv3');

const channel = process.argv[2] ?? 'msedge';

const context = await chromium.launchPersistentContext('', {
  channel,
  // 扩展在无头模式下不工作
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
  ],
});

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
};

try {
  // 等 service worker 起来——它出现就说明扩展加载成功了
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));

  const extensionId = new URL(worker.url()).host;
  check('扩展加载成功', true, `ID ${extensionId}`);

  // 浏览器版本
  const version = context.browser()?.version() ?? '?';
  check('浏览器版本', true, version);

  // 打开 Popup，检查各界面是否渲染
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForTimeout(600);

  const popupTitle = await popup.locator('.popup__title').textContent();
  check('Popup 渲染', popupTitle === '伴读 · ReadMate', `标题「${popupTitle}」`);

  // ⭐ 关键：sidePanel 这个 API 在不在
  const api = await popup.evaluate(() => ({
    sidePanel: typeof chrome.sidePanel,
    scripting: typeof chrome.scripting,
    contextMenus: typeof chrome.contextMenus,
    storage: typeof chrome.storage?.local,
    // Manifest V3 的 service worker 有没有跑起来
    hasRuntimeId: typeof chrome.runtime?.id === 'string',
  }));

  check('chrome.storage.local', api.storage === 'object', api.storage);
  check('chrome.scripting', api.scripting === 'object', api.scripting);
  check('chrome.contextMenus', api.contextMenus === 'object', api.contextMenus);
  check('chrome.runtime.id', api.hasRuntimeId);
  check('chrome.sidePanel（侧边栏）', api.sidePanel === 'object', api.sidePanel);

  // 设置页 / 阅读页 / 侧边栏页能不能打开
  for (const [label, file] of [
    ['设置页', 'options.html'],
    ['阅读页', 'reader.html'],
    ['侧边栏页', 'sidepanel.html'],
  ]) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    await page.waitForTimeout(400);
    const hasBody = (await page.locator('body').count()) > 0;
    check(`${label}可打开`, hasBody);
    await page.close();
  }

  // 真实翻译一次（走 mock 服务，不花钱）
  const fixture = await context.newPage();
  await fixture.goto('http://127.0.0.1:8000/basic-article.html');
  await fixture.waitForTimeout(500);

  // ⚠️ 必须先把这个标签页设为「活动标签页」。
  // `activeTab` 权限只在活动标签页上生效——不激活的话 content script
  // 不会被注入，点翻译只会得到「尚未翻译当前页面」。
  //
  // 不能用 `popup.bringToFront()`：那会把 Popup 变成活动页，
  // 反而让 fixture 页失去 activeTab。
  const activated = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url?.includes('basic-article.html'));
    if (typeof target?.id !== 'number') {
      return false;
    }
    await chrome.tabs.update(target.id, { active: true });
    return true;
  });
  check('激活 fixture 标签页', activated);

  await popup.locator('#translate').click();

  let translated = false;
  try {
    await popup
      .locator('#status')
      .filter({ hasText: '已翻译' })
      .waitFor({ timeout: 30_000 });
    translated = true;
  } catch {
    translated = false;
  }
  check(
    '实际翻译一次',
    translated,
    translated ? '' : await popup.locator('#status').textContent(),
  );

  const pluginNodes = await fixture.locator('[data-ai-translator="true"]').count();
  check('译文写入页面', pluginNodes > 0, `${pluginNodes} 个节点`);

  console.log();
  const failed = results.filter((item) => !item.ok);
  console.log(
    failed.length === 0
      ? `  ✅ ${channel} 完全可用`
      : `  ⚠ ${channel} 有 ${failed.length} 项不通过：${failed.map((f) => f.label).join('、')}`,
  );

  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('  检查失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await context.close();
}
