import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { activateFixtureTab, expect, openPopup, test } from './fixtures';

/**
 * 生成 README 用的截图。
 *
 * ## 为什么需要真实模型
 *
 * mock Provider 返回的是 `【译】原文`，截图里会是占位文本，没法看。
 * 所以这个文件**默认跳过**，要用真实 Provider 时才跑：
 *
 * ```bash
 * # 用真实 Provider 跑（会发起真实请求并产生费用）
 * # ENV_FILE_PATH 指向带真实 API Key 的 .env
 * cd extension
 * REAL_MODEL_E2E=1 ENV_FILE_PATH=../server/.env \
 *   npx playwright test e2e/screenshots.spec.ts
 * ```
 *
 * 一篇短文约 0.005 元（按 flash 闲时价）。
 *
 * 产出写到 `docs/`，直接提交即可。
 */

const ENABLED = process.env.REAL_MODEL_E2E === '1';
const OUT_DIR = path.resolve(import.meta.dirname, '../../docs');
const ARTICLE_URL = 'http://127.0.0.1:8000/basic-article.html';

test.skip(!ENABLED, '需要真实模型：设 REAL_MODEL_E2E=1 才跑');

test.describe('生成 README 截图', () => {
  test.beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
  });

  /**
   * 翻译当前 fixture 页并等完成。
   *
   * 每个用例都先翻译——**截图里的状态栏要是「已翻译」，不能是「就绪」**。
   * 第二次以后会命中译文缓存，不会重复计费。
   */
  async function translateArticle(
    context: Parameters<typeof activateFixtureTab>[0],
    extensionId: string,
  ) {
    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, ARTICLE_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 120_000 });
    return popup;
  }

  test('双语翻译效果', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1100, height: 820 });
    await fixture.goto(ARTICLE_URL);

    const popup = await translateArticle(context, extensionId);

    // 滚到正文开头，让译文出现在视野里
    await fixture.evaluate(() => window.scrollTo(0, 0));
    await fixture.waitForTimeout(400);

    await fixture.screenshot({ path: path.join(OUT_DIR, 'bilingual.png') });

    await popup.close();
    await fixture.close();
  });

  test('Popup 控制面板', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto(ARTICLE_URL);

    const popup = await translateArticle(context, extensionId);
    await popup.waitForTimeout(400);

    // 弹窗页面本身是 320px 宽，但截图默认抓整个视口（1080 宽），
    // 弹窗只占左上角、右边一大片空白。按内容裁切。
    const size = await popup.evaluate(() => {
      const body = document.body;
      return {
        width: Math.ceil(body.scrollWidth || body.offsetWidth),
        height: Math.ceil(body.scrollHeight || body.offsetHeight),
      };
    });

    await popup.screenshot({
      path: path.join(OUT_DIR, 'popup.png'),
      clip: { x: 0, y: 0, width: size.width, height: size.height },
    });

    await popup.close();
    await fixture.close();
  });

  test('侧边栏与总结', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1100, height: 900 });
    await fixture.goto(ARTICLE_URL);

    // 先翻译——否则状态栏会显示「未找到可翻译的内容」，截出来不好看
    const popup = await translateArticle(context, extensionId);
    await popup.close();

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForTimeout(1000);

    await activateFixtureTab(context, ARTICLE_URL);
    await panel.locator('#summarize').click();
    await expect(panel.locator('#summary-gist')).not.toBeEmpty({ timeout: 120_000 });
    await panel.waitForTimeout(500);

    await panel.screenshot({ path: path.join(OUT_DIR, 'sidepanel.png') });

    await panel.close();
    await fixture.close();
  });

  test('阅读模式', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1100, height: 900 });
    await fixture.goto(ARTICLE_URL);

    const popup = await translateArticle(context, extensionId);

    // 点「阅读模式」——它在新标签页打开
    const [reader] = await Promise.all([
      context.waitForEvent('page'),
      popup.locator('#open-reader').click(),
    ]);

    await reader.setViewportSize({ width: 1100, height: 900 });
    await reader.waitForLoadState('domcontentloaded');
    await expect(reader.locator('.reader__article')).toBeVisible({ timeout: 30_000 });
    await reader.waitForTimeout(600);

    await reader.screenshot({ path: path.join(OUT_DIR, 'reader.png') });

    await reader.close();
    await popup.close();
    await fixture.close();
  });
});
