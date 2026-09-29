import path from 'node:path';

import { EXTENSION_PATH, expect, FIXTURE_DIR, test } from './fixtures';

/**
 * Phase 0 冒烟旅程。
 *
 * 验证「构建产物可被浏览器加载 → 各入口页面可渲染」这条链路成立。
 *
 * 注意：content script 采用运行时注册（`registration: 'runtime'`），
 * 不会自动注入页面，因此本阶段不断言其注入状态——该链路在 Phase 1 接通。
 */

test.describe('Phase 0 · 骨架冒烟', () => {
  test('构建产物存在且可被加载，background service worker 存活', async ({
    context,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(context.serviceWorkers().length).toBeGreaterThan(0);
    expect(EXTENSION_PATH).toContain('.output');
  });

  test('Popup 可正常渲染', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(page.getByRole('heading', { name: '伴读 · ReadMate' })).toBeVisible();
    await expect(page.locator('#translate')).toBeVisible();
    await expect(page.getByRole('radio', { name: '双语' })).toBeChecked();

    await page.close();
  });

  test('Options 页可正常渲染', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.getByRole('heading', { name: '伴读 · ReadMate' })).toBeVisible();
    await expect(page.getByLabel('FastAPI 服务地址')).toBeVisible();
    await expect(page.getByLabel('翻译风格')).toBeVisible();
    await expect(page.getByRole('button', { name: '保存设置' })).toBeVisible();

    await page.close();
  });

  test('fixture 页面可被加载（供后续 Phase 使用）', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`file://${path.join(FIXTURE_DIR, 'basic-article.html')}`);

    await expect(page.locator('h1')).toHaveText('AI Engineering in Practice');
    await expect(page.locator('#inline-demo strong')).toHaveText('software development');

    await page.close();
  });
});
