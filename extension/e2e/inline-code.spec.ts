import { activateFixtureTab, expect, openPopup, test } from './fixtures';

/**
 * 行内代码里的标识符必须出现在译文里。
 *
 * ⚠️ **双语模式下译文只放纯文本**（`renderer.ts` 的 `#renderBilingual`）——
 * 这是刻意的：复制 inline 结构会让页面出现两份链接/强调标记。
 * 所以标识符的文字在译文里，但 `<code>` 元素不带过去。
 * 中文模式是就地重建，结构会一起回来。
 *
 * ## 起因
 *
 * Master 报告：「有些专有函数名虽然不会被翻译，但同时也不会出现在译文的一栏，
 * 导致译文看起来不完整」。
 *
 * ## 根因
 *
 * 行内 `<code>` 曾经是**原子占位符** `<0/>`——元素保住了，但**内容不发给模型**。
 * 模型看到一个空占位符，不知道那里有什么，于是**经常直接丢掉它**，
 * 译文里就少了那个函数名。
 *
 * ## 修法
 *
 * 把 `CODE` / `KBD` / `SAMP` 从 `IGNORED_TAGS` 里移除 → 行内时当普通内联元素，
 * 用**成对占位符** `<0>npm install</0>`。模型看得到内容，能自然放置也不会丢。
 * 块级代码仍由 `isCodeContainer()`（等宽 + 块级）整体跳过。
 *
 * ## 这个测试证明什么
 *
 * 单元测试能证明占位符形态变了，但证明不了**整条链路**——
 * 标识符最终有没有出现在译文的 DOM 里，只有真实渲染才算数。
 */

const CODE_URL = 'http://127.0.0.1:8000/code-block.html';

test.describe('Phase 21 · 行内代码的标识符保留在译文里', () => {
  test('⭐ 译文里包含行内代码的标识符', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 段落后面跟着的译文节点
    const translated = fixture.locator('#inline-code + [data-ai-translator="true"]');
    await expect(translated).toBeVisible();

    // ⭐ 核心断言：标识符必须出现在译文里（修复前这里是空的）
    await expect(translated).toContainText('npm install');
    await expect(translated).toContainText('npm run dev');

    // 原文段落的结构没被动过
    expect(await fixture.locator('#inline-code code').count()).toBe(2);

    await popup.close();
    await fixture.close();
  });

  test('⭐ 中文模式下标识符连结构一起保留（就地重建）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 中文模式是就地重建，inline 结构会跟着译文一起回来
    await popup.getByRole('radio', { name: '中文' }).check();

    await expect(fixture.locator('#inline-code')).toContainText('npm install');
    expect(
      await fixture.locator('#inline-code code').count(),
      '中文模式下 <code> 元素应当被重建',
    ).toBe(2);

    await popup.close();
    await fixture.close();
  });

  test('⭐ <kbd> 的按键名同样保留', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const translated = fixture.locator('#kbd-text + [data-ai-translator="true"]');

    // 按键名必须出现——它们是句子的一部分，丢了就读不通
    await expect(translated).toContainText('Cmd');
    await expect(translated).toContainText('K');
    // 原文的 <kbd> 结构保持不动
    expect(await fixture.locator('#kbd-text kbd').count()).toBe(2);

    await popup.close();
    await fixture.close();
  });

  test('块级代码仍然一个 Block 都不产生', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(CODE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, CODE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 块级 <pre><code> 内部一个插件节点都没有
    expect(await fixture.locator('#block-code [data-ai-translator="true"]').count()).toBe(0);
    // 原文一字未改
    await expect(fixture.locator('#block-code')).toContainText('process.env.LLM_API_KEY');

    await popup.close();
    await fixture.close();
  });
});
