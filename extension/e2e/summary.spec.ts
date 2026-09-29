import type { Page } from '@playwright/test';

import {
  activateFixtureTab,
  expect,
  FIXTURE_URL,
  openPopup,
  requireWorker,
  test,
} from './fixtures';

/**
 * 总结选中内容（方案第 32 节第一层）。
 *
 * 验收标准：
 *   选中一段文字 → 右键 → 总结，浮层显示主旨与要点，可导出 Markdown
 *
 * ## ⚠️ 覆盖边界
 *
 * **右键菜单本身点不到**——浏览器原生 UI，Playwright 无法点击。
 * 所以这里只验证**菜单点击之后的链路**：
 *
 *   选中文字 → SUMMARIZE_SELECTION → 读选区 → 请求服务端 → 浮层显示
 *
 * 「菜单项注册成功」与「点击能触发」只能手工验证。
 * 这与 AI 解释的验证边界完全一致（同一套菜单机制）。
 */

const OVERLAY = '#ai-web-translator-explain';

/** 在页面里选中某个元素的内容。 */
async function selectElement(page: Page, selector: string): Promise<void> {
  await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(element);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, selector);
}

/** 模拟「点了右键菜单」——直接向 content script 发那条消息。 */
async function triggerSummarize(
  context: Parameters<typeof activateFixtureTab>[0],
): Promise<string> {
  return await requireWorker(context).evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (typeof tab?.id !== 'number') {
      return 'no-active-tab';
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        source: 'ai-web-translator',
        type: 'SUMMARIZE_SELECTION',
        requestId: `e2e-${Date.now()}`,
      });
      return JSON.stringify(response);
    } catch (error) {
      return `error: ${String(error)}`;
    }
  });
}

/** 打开 fixture 并注入 content script。 */
async function setup(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<{ fixture: Page; popup: Page }> {
  const fixture = await context.newPage();
  await fixture.setViewportSize({ width: 1000, height: 800 });
  await fixture.goto(FIXTURE_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context);

  // 右键菜单那条路径会按需注入，这里手动触发一次
  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

  return { fixture, popup };
}

test.describe('Phase 18 · 总结选中内容', () => {
  test('选中一段文字后浮层显示主旨与要点', async ({ context, extensionId }) => {
    const { fixture, popup } = await setup(context, extensionId);

    await selectElement(fixture, '#plain-paragraph');
    const sent = await triggerSummarize(context);
    expect(sent, `content script 应回执：${sent}`).toContain('"ok":true');

    await expect(fixture.locator(OVERLAY)).toBeVisible({ timeout: 30_000 });
    await expect(fixture.locator(OVERLAY)).toContainText('【摘】');
    // 要点是列表
    await expect(fixture.locator(`${OVERLAY} li`).first()).toBeVisible();

    await popup.close();
    await fixture.close();
  });

  test('浮层带 data-ai-translator 标记，不会被当成页面新内容', async ({ context, extensionId }) => {
    const { fixture, popup } = await setup(context, extensionId);

    await selectElement(fixture, '#plain-paragraph');
    await triggerSummarize(context);
    await expect(fixture.locator(OVERLAY)).toBeVisible({ timeout: 30_000 });

    expect(await fixture.locator(`${OVERLAY}[data-ai-translator="true"]`).count()).toBe(1);

    // 不会被 MutationObserver 反复重建
    await fixture.waitForTimeout(1500);
    expect(await fixture.locator(OVERLAY).count()).toBe(1);

    await popup.close();
    await fixture.close();
  });

  test('⭐ 提供导出 Markdown 按钮', async ({ context, extensionId }) => {
    const { fixture, popup } = await setup(context, extensionId);

    await selectElement(fixture, '#plain-paragraph');
    await triggerSummarize(context);
    await expect(fixture.locator(OVERLAY)).toBeVisible({ timeout: 30_000 });

    const exportButton = fixture.locator('#ai-web-translator-export');
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toHaveText('导出 Markdown');

    // 点击应当触发下载
    const downloadPromise = fixture.waitForEvent('download', { timeout: 15_000 });
    await exportButton.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.md$/);
    // 导出后给出反馈
    await expect(fixture.locator(OVERLAY)).toContainText('已导出');

    await popup.close();
    await fixture.close();
  });

  test('没有选中文字时不弹浮层', async ({ context, extensionId }) => {
    const { fixture, popup } = await setup(context, extensionId);

    await fixture.evaluate(() => {
      window.getSelection()?.removeAllRanges();
    });

    const sent = await triggerSummarize(context);

    expect(sent).toContain('没有选中');
    await expect(fixture.locator(OVERLAY)).toHaveCount(0);

    await popup.close();
    await fixture.close();
  });
});
