import type { Page } from '@playwright/test';

import {
  activateFixtureTab,
  countPluginNodes,
  expect,
  FIXTURE_URL,
  openPopup,
  test,
} from './fixtures';

/**
 * Phase 12 · 译文缓存（方案第 86.8 节）。
 *
 * 验收标准（方案第 82.2 节）：
 *   同一段文字在同一页面第二次出现不产生新请求；**刷新页面后缓存仍命中**
 *
 * 用 `basic-article.html`：内容固定，两次翻译的文本完全一致，
 * 因此第二次应当全部命中缓存、**一个请求都不发**。
 *
 * 缓存存在 `chrome.storage.local`，页面刷新不会清掉——这正是本阶段的核心价值。
 */

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

/** 打开 fixture、翻译、等完成。 */
async function translateFixture(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
) {
  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context);
  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });
  return popup;
}

test.describe('Phase 12 · 译文缓存', () => {
  test('刷新页面后缓存仍命中，不再产生请求', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);
    await resetStats(fixture);

    const popup = await translateFixture(context, extensionId);
    const first = await readStats(fixture);
    expect(first.translateRequests).toBeGreaterThan(0);

    // 刷新页面：DOM 重建、content script 重新注入，但扩展的 storage 还在
    await fixture.reload();
    await fixture.waitForTimeout(500);

    const reopened = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await reopened.locator('#translate').click();
    await expect(reopened.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const second = await readStats(fixture);

    // 关键断言：刷新后全部命中缓存，没有新增请求
    expect(second.translateRequests).toBe(first.translateRequests);

    // 译文照常渲染
    expect(await countPluginNodes(fixture)).toBeGreaterThan(0);

    await reopened.close();
    await popup.close();
    await fixture.close();
  });

  test('缓存命中时仍然正确渲染译文', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);

    const popup = await translateFixture(context, extensionId);
    const nodesBefore = await countPluginNodes(fixture);

    await fixture.reload();
    await fixture.waitForTimeout(500);

    const reopened = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await reopened.locator('#translate').click();
    await expect(reopened.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 走缓存的渲染结果与走请求的完全一致
    expect(await countPluginNodes(fixture)).toBe(nodesBefore);
    await expect(fixture.locator('h1 + [data-ai-translator="true"]')).toContainText(
      '【译】AI Engineering in Practice',
    );

    await reopened.close();
    await popup.close();
    await fixture.close();
  });

  test('切换显示模式不会重新请求（缓存与模式互不干扰）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);
    await resetStats(fixture);

    const popup = await translateFixture(context, extensionId);
    const afterTranslate = await readStats(fixture);

    await popup.getByRole('radio', { name: '中文' }).check();
    await expect(fixture.locator('h1')).toHaveText('【译】AI Engineering in Practice');

    await popup.getByRole('radio', { name: '原文' }).check();
    await expect(fixture.locator('h1')).toHaveText('AI Engineering in Practice');

    const afterSwitch = await readStats(fixture);
    expect(afterSwitch.translateRequests).toBe(afterTranslate.translateRequests);

    await popup.close();
    await fixture.close();
  });
});
