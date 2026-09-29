import { activateFixtureTab, countPluginNodes, expect, openPopup, test } from './fixtures';

/**
 * Phase 11 · SPA 路由变化处理（方案第 74 节）。
 *
 * 验收标准（方案第 82.2 节）：
 *   路由切换后**旧状态被清理并重新分段**
 *
 * 用 `spa.html`：点击按钮会 `pushState` 改写 URL 并原地替换内容，不整页刷新。
 */

const SPA_URL = 'http://127.0.0.1:8000/spa.html';

/** 打开 SPA fixture 并完成一次翻译。 */
async function translateSpa(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
) {
  const fixture = await context.newPage();
  await fixture.setViewportSize({ width: 900, height: 1000 });
  await fixture.goto(SPA_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context, SPA_URL);

  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

  return { fixture, popup };
}

test.describe('Phase 11 · SPA 路由变化', () => {
  test('路由切换后旧状态被清理，新页面自动翻译', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateSpa(context, extensionId);

    // 第一页已翻译
    await expect(fixture.locator('#content + [data-ai-translator="true"]')).toContainText(
      '【译】This is the first page',
    );

    // 前端路由切换：URL 变 + 内容原地替换
    await fixture.getByRole('button', { name: 'Page Two' }).click();

    // 新页面**无需再点 Popup** 就自动翻译
    await expect(fixture.locator('#content + [data-ai-translator="true"]')).toContainText(
      '【译】This is the second page, loaded without a full reload.',
      { timeout: 30_000 },
    );

    // 旧页面的译文已被清除
    await expect(fixture.locator('body')).not.toContainText('This is the first page');

    await popup.close();
    await fixture.close();
  });

  test('路由切换后旧译文节点没有残留', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateSpa(context, extensionId);

    const before = await countPluginNodes(fixture);
    expect(before).toBeGreaterThan(0);

    await fixture.getByRole('button', { name: 'Page Two' }).click();

    await expect(fixture.locator('#content + [data-ai-translator="true"]')).toContainText(
      '【译】This is the second page',
      { timeout: 30_000 },
    );

    // 新页面的译文节点数与旧页面一致，没有叠加残留
    expect(await countPluginNodes(fixture)).toBe(before);

    await popup.close();
    await fixture.close();
  });

  test('连续切换路由不会累积状态', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateSpa(context, extensionId);

    await fixture.getByRole('button', { name: 'Page Two' }).click();
    await expect(fixture.locator('#content + [data-ai-translator="true"]')).toContainText(
      '【译】This is the second page',
      { timeout: 30_000 },
    );

    const afterFirstSwitch = await countPluginNodes(fixture);

    // 再点一次：URL 没变（不触发路由处理），但内容被原地重建
    await fixture.getByRole('button', { name: 'Page Two' }).click();
    await expect(fixture.locator('#content + [data-ai-translator="true"]')).toContainText(
      '【译】This is the second page',
      { timeout: 30_000 },
    );
    await fixture.waitForTimeout(500);

    // 状态没有累积
    expect(await countPluginNodes(fixture)).toBe(afterFirstSwitch);
    expect(await fixture.locator('#content + [data-ai-translator="true"]').count()).toBe(1);

    await popup.close();
    await fixture.close();
  });
});
