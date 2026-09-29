import { activateFixtureTab, countPluginNodes, expect, openPopup, test } from './fixtures';

/**
 * 停止翻译（Phase 17）。
 *
 * ## 设计演变
 *
 * 起因是 Master 实际使用中报的两个问题：
 *   1. 点了翻译之后**没法停**，会一直翻下去
 *   2. 点「恢复原文」**没有用**
 *
 * 第一版做了「翻译当前页面 / 取消翻译 / 重新翻译」的三态按钮 + 状态颜色。
 * **试过之后退回**：界面和心智都变复杂，状态同步也容易出 bug。
 *
 * 现在的方案更简单——**切到「原文」模式即停止**。
 * 「我不想看译文了」和「别翻了」本来就是同一件事，用模式表达最自然。
 *
 * ## 为什么用 large-page
 *
 * 需要翻译**持续足够久**才能观察到「中途切模式」的效果。
 * 101 个段落配 mock 的流式延迟（见 `playwright.config.ts`）能撑住几秒。
 */

const LARGE_URL = 'http://127.0.0.1:8000/large-page.html';

test.describe('Phase 17 · 停止翻译', () => {
  test('翻译中切到「原文」会停止，页面回到原文', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(LARGE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LARGE_URL);

    await popup.locator('#translate').click();

    // 等确实翻出了一些内容
    await expect
      .poll(async () => countPluginNodes(fixture), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // 切到「原文」——这就是停止方式
    await popup.getByRole('radio', { name: '原文' }).check();

    await expect.poll(async () => countPluginNodes(fixture), { timeout: 15_000 }).toBe(0);

    // ⭐ 关键：再等足够久，确认在途请求返回后**不会**把译文写回来
    await fixture.waitForTimeout(5000);

    expect(await countPluginNodes(fixture)).toBe(0);
    await expect(fixture.locator('h1')).toHaveText('Large Page');

    await popup.close();
    await fixture.close();
  });

  test('停止后不再继续翻译', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(LARGE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LARGE_URL);

    await popup.locator('#translate').click();
    await expect
      .poll(async () => countPluginNodes(fixture), { timeout: 30_000 })
      .toBeGreaterThan(0);

    await popup.getByRole('radio', { name: '原文' }).check();

    // 等一会儿，确认没有新的译文节点冒出来
    await fixture.waitForTimeout(3000);
    const afterStop = await countPluginNodes(fixture);

    await fixture.waitForTimeout(3000);
    expect(await countPluginNodes(fixture)).toBe(afterStop);

    await popup.close();
    await fixture.close();
  });

  test('切回「双语」能立刻看到已经翻好的部分（不重新请求）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(LARGE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LARGE_URL);

    await popup.locator('#translate').click();
    await expect
      .poll(async () => countPluginNodes(fixture), { timeout: 30_000 })
      .toBeGreaterThan(0);

    await popup.getByRole('radio', { name: '原文' }).check();
    await expect.poll(async () => countPluginNodes(fixture), { timeout: 15_000 }).toBe(0);

    // 切回双语：已翻好的应当立刻出现（译文一直在 store 里）
    await popup.getByRole('radio', { name: '双语' }).check();

    await expect
      .poll(async () => countPluginNodes(fixture), { timeout: 10_000 })
      .toBeGreaterThan(0);

    await popup.close();
    await fixture.close();
  });

  test('⭐ 翻译中途「恢复原文」后页面保持原文（不会被迟到的译文覆盖）', async ({
    context,
    extensionId,
  }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(LARGE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LARGE_URL);

    await popup.locator('#translate').click();

    await expect
      .poll(async () => countPluginNodes(fixture), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // 中途恢复原文——用户报的就是这一步「没有用」
    await popup.locator('#restore').click();

    await expect.poll(async () => countPluginNodes(fixture), { timeout: 15_000 }).toBe(0);

    await fixture.waitForTimeout(5000);

    expect(await countPluginNodes(fixture)).toBe(0);
    await expect(fixture.locator('h1')).toHaveText('Large Page');

    await popup.close();
    await fixture.close();
  });
});
