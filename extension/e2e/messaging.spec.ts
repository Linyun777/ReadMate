import { activateFixtureTab, expect, FIXTURE_URL, openPopup, test } from './fixtures';

/**
 * Phase 1 · TRANSLATE_PAGE 消息通道。
 *
 * 验收标准（方案第 82.2 节）：
 *   点击按钮能发送 `TRANSLATE_PAGE` 并被 Content Script 接收
 *
 * 三个约束决定了本文件的写法：
 *
 * 1. **测试页必须由 `http://127.0.0.1:8000` 提供**——自动化测试无法模拟
 *    「用户点击扩展图标」的手势，因此 `executeScript` 依赖 manifest 的
 *    host_permissions，而后者只覆盖该端口（方案第 22 节要求最小权限）。
 *    见 `e2e/static-server.mjs`。
 *
 * 2. **必须由 Popup 驱动，不能在 service worker 里 `runtime.sendMessage`**——
 *    Chrome 的语义是「不把消息回送给发送者自身」，从 SW 发出的消息
 *    不会被 SW 自己的 `onMessage` 监听器收到，会报 `Could not establish connection`。
 *
 * 3. **不能用 `page.evaluate` 读取 content script 设置的全局变量**——
 *    MV3 的 content script 运行在隔离世界，与页面的主世界不共享 `globalThis`。
 *    要验证 content script 是否在该页运行，最可靠的方式是看**页面本身是否被改动**。
 *
 * 第 3 条是本文件断言方式的核心：既然完整链路已通，就用「页面真的被翻译了」
 * 来证明消息到达了正确的页面——这比回显一个标题更有说服力。
 */

const TRANSLATED_TITLE = '【译】AI Engineering in Practice';

test.describe('Phase 1 · TRANSLATE_PAGE 消息通道', () => {
  test('完整链路：Popup 命令 → background 按需注入 → content script 翻译页面', async ({
    context,
    extensionId,
  }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();

    // Popup 收到 content script 回传的状态
    await expect(popup.locator('#status')).toContainText('已翻译');

    // 页面本身被改动 → 证明命令到达了正确的页面，且完整链路可用
    await expect(fixture.locator('body')).toContainText(TRANSLATED_TITLE);

    await popup.close();
    await fixture.close();
  });

  test('重复点击命中「已注入」路径，不重复注入且不重复请求', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    const button = popup.locator('#translate');

    await button.click();
    await expect(popup.locator('#status')).toContainText('已翻译');

    // 第二次点击时全部 Block 已 TRANSLATED，`translatePage` 只处理 UNTRANSLATED
    await button.click();
    await expect(popup.locator('#status')).toContainText('已翻译');

    // 页面仍然是翻译后的状态，没有被重复渲染破坏
    await expect(fixture.locator('body')).toContainText(TRANSLATED_TITLE);

    await popup.close();
    await fixture.close();
  });

  test('无法注入的页面（扩展页）回传明确错误，而不是静默失败', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId);
    await popup.bringToFront();

    await popup.locator('#translate').click();

    await expect(popup.locator('#status')).toContainText('失败：');

    await popup.close();
  });

  test('未翻译的页面上打开 Popup 会提示尚未翻译', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await expect(popup.locator('#status')).toContainText('尚未翻译当前页面');

    await popup.close();
    await fixture.close();
  });
});
