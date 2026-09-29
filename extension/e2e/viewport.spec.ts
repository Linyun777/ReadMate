import type { Page } from '@playwright/test';

import { activateFixtureTab, expect, openPopup, test } from './fixtures';

/**
 * Phase 9 · Viewport-first + Lazy Translation（方案第 65、66 节）。
 *
 * 验收标准：
 *   首屏内容优先翻译；**未进入视口的内容不产生请求**
 *
 * 用 `long-article.html`（24 段 + 标题，约 2600px 高）——短页面测不出 lazy，
 * 因为「视口 + 前瞻区」会覆盖整页。
 *
 * 「不产生请求」用 E2E 服务器的 `/__e2e/stats` 直接断言请求携带的条目数，
 * 而不是只断言「没被翻译」——后者在「翻译了但没渲染」的实现下也会通过。
 */

const LONG_URL = 'http://127.0.0.1:8000/long-article.html';

/** 长页面的 Block 总数：1 个标题 + 24 个段落 */
const TOTAL_BLOCKS = 25;

const VIEWPORT = { width: 900, height: 720 };

interface Stats {
  translateRequests: number;
  translateItems: number;
}

async function readStats(page: Page): Promise<Stats> {
  const response = await page.request.get('http://127.0.0.1:8000/__e2e/stats');
  return (await response.json()) as Stats;
}

async function resetStats(page: Page): Promise<void> {
  await page.request.post('http://127.0.0.1:8000/__e2e/reset');
}

/** 打开长页面、翻译首屏。返回 fixture 页与 Popup 页。 */
async function translateFirstScreen(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
) {
  const fixture = await context.newPage();
  await fixture.setViewportSize(VIEWPORT);
  await fixture.goto(LONG_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context, LONG_URL);

  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

  return { fixture, popup };
}

test.describe('Phase 9 · Viewport-first + Lazy', () => {
  test('首屏内容优先翻译，页面底部暂不翻译', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFirstScreen(context, extensionId);

    // 首屏段落被翻译（双语模式：译文是原段落的紧邻兄弟节点）
    await expect(fixture.locator('#para-01 + [data-ai-translator="true"]')).toHaveCount(1);
    await expect(fixture.locator('#para-03 + [data-ai-translator="true"]')).toHaveCount(1);

    // 页面底部尚未翻译
    await expect(fixture.locator('#para-24 + [data-ai-translator="true"]')).toHaveCount(0);
    await expect(fixture.locator('#para-20 + [data-ai-translator="true"]')).toHaveCount(0);

    await popup.close();
    await fixture.close();
  });

  test('未进入视口的内容不产生请求', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize(VIEWPORT);
    await fixture.goto(LONG_URL);
    await resetStats(fixture);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LONG_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const stats = await readStats(fixture);

    expect(stats.translateRequests).toBeGreaterThan(0);
    expect(stats.translateItems).toBeGreaterThan(0);
    // 关键断言：请求携带的条目数明显少于整页 Block 数
    expect(stats.translateItems).toBeLessThan(TOTAL_BLOCKS);

    await popup.close();
    await fixture.close();
  });

  test('滚动到页面底部后，底部内容被自动翻译', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFirstScreen(context, extensionId);

    await expect(fixture.locator('#para-24 + [data-ai-translator="true"]')).toHaveCount(0);

    // 滚到底部 → IntersectionObserver 触发 → 追加翻译
    await fixture.locator('#para-24').scrollIntoViewIfNeeded();

    await expect(fixture.locator('#para-24 + [data-ai-translator="true"]')).toHaveCount(1, {
      timeout: 30_000,
    });

    await popup.close();
    await fixture.close();
  });

  test('滚动触发的翻译不会重复请求首屏内容', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize(VIEWPORT);
    await fixture.goto(LONG_URL);
    await resetStats(fixture);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LONG_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const firstScreen = await readStats(fixture);

    await fixture.locator('#para-24').scrollIntoViewIfNeeded();
    await expect(fixture.locator('#para-24 + [data-ai-translator="true"]')).toHaveCount(1, {
      timeout: 30_000,
    });

    const afterScroll = await readStats(fixture);

    // 第二次请求只带底部的内容，不重复首屏
    expect(afterScroll.translateItems).toBeGreaterThan(firstScreen.translateItems);
    expect(afterScroll.translateItems).toBeLessThanOrEqual(TOTAL_BLOCKS);

    await popup.close();
    await fixture.close();
  });
});
