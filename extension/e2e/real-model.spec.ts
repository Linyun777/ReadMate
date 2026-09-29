import {
  activateFixtureTab,
  countPluginNodes,
  expect,
  FIXTURE_URL,
  openPopup,
  test,
} from './fixtures';

/**
 * 真实模型冒烟测试（**可选，默认跳过**）。
 *
 * ## 为什么需要它
 *
 * 常规 E2E 全部走 `LLM_PROVIDER=mock`（方案第 86.9 节：E2E 不得发起真实模型请求）。
 * 好处是确定、免费、快；代价是**它证明不了真实模型会照做**。
 *
 * `server/scripts/check_placeholder_retention.py` 补了一半——用真实模型验证
 * 占位符保留率——但它直接调服务，**绕过了扩展**：分段、批量、队列、渲染
 * 全都没参与。
 *
 * 这个 spec 补的是剩下的那一半：**真实模型 × 完整链路**。
 *
 * ## 怎么跑
 *
 * ```bash
 * # 1. 用真实 Provider 启动服务端（8001）
 * cd server && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
 *
 * # 2. 启动 fixture 服务（8000）
 * cd extension && node e2e/static-server.mjs
 *
 * # 3. 打开开关跑（Playwright 会复用已启动的服务）
 * cd extension && REAL_MODEL_E2E=1 npx playwright test e2e/real-model.spec.ts
 * ```
 *
 * ⚠️ **会发起真实模型请求并产生费用。**
 *
 * ## 断言的是「行为」而不是「文案」
 *
 * 真实模型的译文无法预测，所以这里断言的是**结构性事实**：
 * 译文渲染出来了、是中文、inline 元素一个不多一个不少、
 * 恢复原文后 DOM 与最初逐字节相同。
 *
 * 这些断言恰恰是 mock 测不到的地方——mock 的「译文」是固定前缀，
 * 结构校验永远通过。
 */

const ENABLED = process.env.REAL_MODEL_E2E === '1';

test.skip(!ENABLED, '需要真实模型：设 REAL_MODEL_E2E=1，并用真实 Provider 启动服务端');

/** 统计页面里的汉字数量，用于判断「这确实是中文译文」。 */
const HAN_COUNT = /[\p{Script=Han}]/gu;

async function countHan(page: Parameters<typeof countPluginNodes>[0]): Promise<number> {
  const text = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-ai-translator="true"]'))
      .map((node) => node.textContent ?? '')
      .join(''),
  );

  return (text.match(HAN_COUNT) ?? []).length;
}

test.describe('真实模型 · 完整链路冒烟', () => {
  test('翻译 basic-article：渲染出中文译文，inline 结构不变', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(FIXTURE_URL);

    const before = await fixture.evaluate(() => document.body.innerHTML);
    const strongBefore = await fixture.locator('strong').count();
    const linkBefore = await fixture.locator('a').count();

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();

    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 120_000 });

    // 1. 确实渲染了译文节点
    expect(await countPluginNodes(fixture)).toBeGreaterThan(0);

    // 2. 译文确实是中文（不是原样返回英文）
    expect(await countHan(fixture)).toBeGreaterThan(20);

    // 3. ⭐ 占位符往返成功：inline 元素一个不多一个不少
    expect(await fixture.locator('strong').count()).toBe(strongBefore);
    expect(await fixture.locator('a').count()).toBe(linkBefore);

    // 4. ⭐ 恢复原文后 DOM 与最初逐字节相同
    await popup.getByRole('radio', { name: '原文' }).check();

    await expect
      .poll(async () => fixture.evaluate(() => document.body.innerHTML), { timeout: 30_000 })
      .toBe(before);

    await popup.close();
    await fixture.close();
  });

  test('翻译 nested-inline：嵌套占位符在真实模型下也能往返', async ({ context, extensionId }) => {
    const nestedUrl = 'http://127.0.0.1:8000/nested-inline.html';

    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(nestedUrl);

    const before = await fixture.evaluate(() => document.body.innerHTML);
    const strongBefore = await fixture.locator('strong').count();
    const emBefore = await fixture.locator('em').count();
    const imgBefore = await fixture.locator('img').count();

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, nestedUrl);
    await popup.locator('#translate').click();

    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 120_000 });

    // 深层嵌套 + 相邻标签 + <br> + 内联图片，全部必须原样保留
    expect(await fixture.locator('strong').count()).toBe(strongBefore);
    expect(await fixture.locator('em').count()).toBe(emBefore);
    expect(await fixture.locator('img').count()).toBe(imgBefore);

    await popup.getByRole('radio', { name: '原文' }).check();

    await expect
      .poll(async () => fixture.evaluate(() => document.body.innerHTML), { timeout: 30_000 })
      .toBe(before);

    await popup.close();
    await fixture.close();
  });
});
