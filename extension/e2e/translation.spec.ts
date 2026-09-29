import type { BrowserContext, Page } from '@playwright/test';

import {
  activateFixtureTab,
  countPluginNodes,
  expect,
  FIXTURE_URL,
  openPopup,
  test,
} from './fixtures';

/**
 * Phase 7 · 中文 / 原文 / 双语三模式切换。
 *
 * 验收标准（方案第 82.2 节）：
 *   1. 切换不触发重新请求
 *   2. 双语模式在 fixture 页面不破版
 *   3. 切回原文时插件节点被完全移除
 *
 * 「不触发重新请求」靠 E2E 服务器暴露的计数端点直接断言
 * （见 `e2e/static-server.mjs` 的 `/__e2e/stats`），而不是靠间接推断。
 */

/** 读取 E2E 服务器统计的翻译请求数。 */
async function translateRequestCount(page: Page): Promise<number> {
  const response = await page.request.get('http://127.0.0.1:8000/__e2e/stats');
  const body = (await response.json()) as { translateRequests: number };
  return body.translateRequests;
}

async function resetRequestCount(page: Page): Promise<void> {
  await page.request.post('http://127.0.0.1:8000/__e2e/reset');
}

/** 打开 fixture 页与 Popup，并完成一次翻译。 */
async function translateFixture(context: BrowserContext, extensionId: string) {
  const fixture = await context.newPage();
  await fixture.goto(FIXTURE_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context);

  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译');

  return { fixture, popup };
}

test.describe('Phase 7 · 三模式切换', () => {
  test('双语模式：原文保留、译文追加、页面结构不破', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    // 原文完全不动
    await expect(fixture.locator('h1')).toHaveText('AI Engineering in Practice');
    await expect(fixture.locator('pre#code-demo')).toContainText('const client = new OpenAI');

    // 译文作为插件节点追加
    expect(await countPluginNodes(fixture)).toBeGreaterThan(0);
    await expect(fixture.locator('body')).toContainText('【译】AI Engineering in Practice');

    // 结构未被破坏：导航链接仍可用且 href 未变
    await expect(fixture.locator('nav a')).toHaveCount(3);
    await expect(fixture.locator('nav a').first()).toHaveAttribute('href', '/docs');

    // 列表项没有被拆散或合并
    await expect(fixture.locator('ul#list-demo > li')).toHaveCount(3);

    // 表格行数不变
    await expect(fixture.locator('table#table-demo tr')).toHaveCount(3);

    await popup.close();
    await fixture.close();
  });

  test('中文模式：原文被译文替换，不产生插件节点', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    await popup.getByRole('radio', { name: '中文' }).check();
    await expect(popup.locator('#status')).toContainText('已翻译');

    await expect(fixture.locator('h1')).toHaveText('【译】AI Engineering in Practice');
    expect(await countPluginNodes(fixture)).toBe(0);

    // inline 元素被复用，内容为译文（mock 只加前缀，所以内容仍是原文）
    await expect(fixture.locator('p#inline-demo strong')).toHaveText('software development');
    await expect(fixture.locator('p#inline-demo a')).toHaveAttribute(
      'href',
      '/docs/getting-started',
    );

    // 被忽略的代码块内容未被改动
    await expect(fixture.locator('pre#code-demo')).toContainText('const client = new OpenAI');

    await popup.close();
    await fixture.close();
  });

  test('切回原文：插件节点被完全移除，DOM 与翻译前一致', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    const before = await fixture.evaluate(() => document.body.innerHTML);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译');
    expect(await countPluginNodes(fixture)).toBeGreaterThan(0);

    await popup.getByRole('radio', { name: '原文' }).check();
    await expect(popup.locator('#status')).toContainText('已恢复原文');

    await expect.poll(() => countPluginNodes(fixture)).toBe(0);
    expect(await fixture.evaluate(() => document.body.innerHTML)).toBe(before);

    await popup.close();
    await fixture.close();
  });

  test('中文模式切回原文同样完全恢复', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    const before = await fixture.evaluate(() => document.body.innerHTML);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译');

    await popup.getByRole('radio', { name: '中文' }).check();
    await expect(fixture.locator('h1')).toHaveText('【译】AI Engineering in Practice');

    await popup.getByRole('radio', { name: '原文' }).check();
    await expect(popup.locator('#status')).toContainText('已恢复原文');

    expect(await fixture.evaluate(() => document.body.innerHTML)).toBe(before);

    await popup.close();
    await fixture.close();
  });

  test('模式切换不触发新的翻译请求', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await resetRequestCount(fixture);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译');

    const afterTranslate = await translateRequestCount(fixture);
    expect(afterTranslate).toBeGreaterThan(0);

    // 反复切换：译文一直在 PageStore 里，切换只是重新渲染
    await popup.getByRole('radio', { name: '中文' }).check();
    await expect(fixture.locator('h1')).toHaveText('【译】AI Engineering in Practice');

    await popup.getByRole('radio', { name: '原文' }).check();
    await expect(popup.locator('#status')).toContainText('已恢复原文');

    await popup.getByRole('radio', { name: '双语' }).check();
    await expect(popup.locator('#status')).toContainText('已翻译');

    expect(await translateRequestCount(fixture)).toBe(afterTranslate);

    await popup.close();
    await fixture.close();
  });
});
