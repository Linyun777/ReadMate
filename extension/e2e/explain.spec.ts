import {
  activateFixtureTab,
  expect,
  FIXTURE_URL,
  openPopup,
  requireWorker,
  test,
} from './fixtures';

/**
 * Phase 16 · AI Explain（方案第 29、41 节）。
 *
 * 验收标准：选中文字右键可获取解释，走 `POST /api/v1/explain`。
 *
 * ## ⚠️ 覆盖边界
 *
 * **右键菜单本身点不到**——它是浏览器原生 UI，不在页面 DOM 里，
 * Playwright 无法点击。所以这里只验证**菜单点击之后的链路**：
 *
 *   选中文字 → 触发 EXPLAIN_SELECTION → 读选区 → 请求服务端 → 浮层显示
 *
 * 「菜单项注册成功」与「点击菜单项能触发」这两步没有自动化覆盖，
 * 只能靠手工验证（见计划文档的 Phase 16 手工验证步骤）。
 */

const OVERLAY = '#ai-web-translator-explain';

/** 在页面里选中某个元素的内容。 */
async function selectElement(
  page: Parameters<typeof activateFixtureTab>[0] extends never
    ? never
    : Awaited<ReturnType<typeof openPopup>>,
  selector: string,
): Promise<void> {
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
async function triggerExplain(context: Parameters<typeof activateFixtureTab>[0]): Promise<string> {
  return await requireWorker(context).evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (typeof tab?.id !== 'number') {
      return 'no-active-tab';
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        source: 'ai-web-translator',
        type: 'EXPLAIN_SELECTION',
        requestId: `e2e-${Date.now()}`,
      });
      return JSON.stringify(response);
    } catch (error) {
      return `error: ${String(error)}`;
    }
  });
}

test.describe('Phase 16 · AI Explain', () => {
  test('选中文字后浮层显示解释', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 800 });
    await fixture.goto(FIXTURE_URL);

    // 先注入 content script（右键菜单那条路径会按需注入，这里手动触发一次）
    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    await selectElement(fixture, '#plain-paragraph');

    const sent = await triggerExplain(context);
    expect(sent, `content script 应回执：${sent}`).toContain('"ok":true');

    await expect(fixture.locator(OVERLAY)).toBeVisible({ timeout: 20_000 });
    await expect(fixture.locator(OVERLAY)).toContainText('AI 解释');
    await expect(fixture.locator(OVERLAY)).toContainText('【释】');

    await popup.close();
    await fixture.close();
  });

  test('浮层带 data-ai-translator 标记，不会被当成页面新内容', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 800 });
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    await selectElement(fixture, '#plain-paragraph');
    await triggerExplain(context);
    await expect(fixture.locator(OVERLAY)).toBeVisible({ timeout: 20_000 });

    // 标记在，MutationObserver 才会忽略它（方案第 13.2 节）
    expect(await fixture.locator(`${OVERLAY}[data-ai-translator="true"]`).count()).toBe(1);

    // 浮层不会因为 MutationObserver 反复重建
    await fixture.waitForTimeout(1500);
    expect(await fixture.locator(OVERLAY).count()).toBe(1);

    await popup.close();
    await fixture.close();
  });

  test('Esc 可以关闭浮层', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 800 });
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    await selectElement(fixture, '#plain-paragraph');
    await triggerExplain(context);
    await expect(fixture.locator(OVERLAY)).toBeVisible({ timeout: 20_000 });

    await fixture.keyboard.press('Escape');

    await expect(fixture.locator(OVERLAY)).toHaveCount(0);

    await popup.close();
    await fixture.close();
  });

  test('没有选中文字时不弹浮层', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 800 });
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 清空选区
    await fixture.evaluate(() => {
      window.getSelection()?.removeAllRanges();
    });

    const sent = await triggerExplain(context);

    expect(sent).toContain('没有选中');
    await expect(fixture.locator(OVERLAY)).toHaveCount(0);

    await popup.close();
    await fixture.close();
  });
});
