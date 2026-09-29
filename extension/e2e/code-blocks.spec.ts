import type { Page } from '@playwright/test';

import { activateFixtureTab, countPluginNodes, expect, openPopup, test } from './fixtures';

/**
 * 代码密集的文档页（回归测试）。
 *
 * ## 起因
 *
 * Master 报告：React 官方文档那种页面，翻译会「一直在 js 中做重复操作，
 * 达到了几千条」。
 *
 * ## 根因
 *
 * React 文档用 **Sandpack** 渲染代码：不是 `<pre><code>`，
 * 而是每行一个 `<div>`、每个 token 一个 `<span>`，靠 CSS 高亮。
 * 原来的跳过规则只认 `PRE` / `CODE` 标签 → 这些代码块**完全绕过** →
 * 一行代码一个 Block → 整页几千条，且都在翻译 `const` / `return`。
 *
 * ## 修法
 *
 * 判据改成「**等宽字体 + 块级显示**」——代码的排版特征是 monospace，
 * 与用什么标签、什么框架无关。行内等宽不算（那是正文里的变量名）。
 *
 * ## 这个测试证明什么
 *
 * 单元测试能证明分段器不再产出代码 Block，但证明不了**整条链路**——
 * 比如渲染层会不会仍然往里写、请求条数会不会真的降下来。
 */

const CODE_URL = 'http://127.0.0.1:8000/code-heavy-docs.html';

interface Stats {
  translateRequests: number;
  translateItems: number;
}

async function readStats(page: Page): Promise<Stats> {
  const response = await page.request.get('http://127.0.0.1:8000/__e2e/stats');
  return (await response.json()) as Stats;
}

test.describe('Phase 20 · 代码块不被翻译', () => {
  test('⭐ 代码块整体跳过，只翻译正文', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    await fixture.request.post('http://127.0.0.1:8000/__e2e/reset');

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 1. 代码块内部一个插件节点都没有
    const codeNodes = await fixture.locator('.sp-code [data-ai-translator="true"]').count();
    expect(codeNodes, '代码块里不该有任何译文节点').toBe(0);

    // 2. 代码文字原样保留（页面上有两个代码块，逐个看）
    const codeText = await fixture.locator('.sp-code').allTextContents();
    expect(codeText.join(' ')).toContain('useState');
    expect(codeText.join(' ')).toContain('createTheme');

    // 3. ⭐ 请求条目数应当只有正文那么多（4 段 + 1 标题 + 1 小标题）
    //    修复前这里是「几十条」，代码一行一条
    const stats = await readStats(fixture);
    expect(
      stats.translateItems,
      `翻译条目数应当是个位数，实际 ${stats.translateItems}（修复前会包含每一行代码）`,
    ).toBeLessThan(15);

    // 4. 正文确实翻译了。
    //    注意双语模式下译文是**同级节点**（`#prose-1` 的兄弟），
    //    不在段落里面——所以查插件节点而不是段落文字。
    const proseTranslated = await fixture.locator('#prose-1 + [data-ai-translator="true"]').count();
    expect(proseTranslated, '正文段落后面应当跟着译文节点').toBe(1);

    await popup.close();
    await fixture.close();
  });

  test('恢复原文后页面与翻译前逐字节一致', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    const before = await fixture.locator('main').innerHTML();

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    await popup.locator('#restore').click();
    await expect.poll(async () => countPluginNodes(fixture), { timeout: 15_000 }).toBe(0);

    const after = await fixture.locator('main').innerHTML();
    expect(after).toBe(before);

    await popup.close();
    await fixture.close();
  });

  test('代码块里的 MutationObserver 不会反复触发', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    await fixture.request.post('http://127.0.0.1:8000/__e2e/reset');

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const first = await readStats(fixture);

    // 等一段时间，确认没有因为代码块里的写入而反复重翻
    await fixture.waitForTimeout(3000);

    const second = await readStats(fixture);
    expect(second.translateItems).toBe(first.translateItems);

    await popup.close();
    await fixture.close();
  });
});
