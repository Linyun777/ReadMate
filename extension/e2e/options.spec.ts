import type { Page } from '@playwright/test';

import { activateFixtureTab, expect, FIXTURE_URL, openPopup, test } from './fixtures';

/**
 * Phase 13 · Options 设置页（方案第 39 节）。
 *
 * 验收标准（方案第 82.2 节）：
 *   刷新浏览器后 `serverUrl` / 目标语言 / 风格 / 显示模式仍保留；可查看并清除缓存
 *
 * 设置存在 `chrome.storage.local`，Options 页刷新后应当读回同一份值。
 */

interface Stats {
  translateRequests: number;
  translateItems: number;
  lastTargetLanguage: string | null;
  lastStyle: string | null;
}

async function readStats(page: Page): Promise<Stats> {
  const response = await page.request.get('http://127.0.0.1:8000/__e2e/stats');
  return (await response.json()) as Stats;
}

async function resetStats(page: Page): Promise<void> {
  await page.request.post('http://127.0.0.1:8000/__e2e/reset');
}

async function openOptions(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page;
}

test.describe('Phase 13 · Options 设置页', () => {
  test('设置保存后刷新页面仍在', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);

    await page.getByLabel('FastAPI 服务地址').fill('http://127.0.0.1:8000');
    await page.getByLabel('目标语言').fill('ja');
    await page.getByLabel('翻译风格').selectOption('academic');
    await page.getByLabel('默认显示模式').selectOption('chinese');

    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.locator('#status')).toContainText('已保存');

    // 刷新页面（等价于重开浏览器后重新打开设置页）
    await page.reload();

    await expect(page.getByLabel('FastAPI 服务地址')).toHaveValue('http://127.0.0.1:8000');
    await expect(page.getByLabel('目标语言')).toHaveValue('ja');
    await expect(page.getByLabel('翻译风格')).toHaveValue('academic');
    await expect(page.getByLabel('默认显示模式')).toHaveValue('chinese');

    await page.close();
  });

  test('恢复默认会写回默认值', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);

    await page.getByLabel('目标语言').fill('ja');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByLabel('目标语言')).toHaveValue('ja');

    await page.getByRole('button', { name: '恢复默认' }).click();
    await expect(page.locator('#status')).toContainText('已恢复默认');

    await page.reload();
    await expect(page.getByLabel('目标语言')).toHaveValue('zh-CN');

    await page.close();
  });

  test('非法服务地址回落默认，不会写坏存储，并且明说已回落', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);

    await page.getByLabel('FastAPI 服务地址').fill('ftp://example.com');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.locator('#status')).toContainText('已保存');

    // 静默回落会让用户以为地址生效了，然后对着连不上的服务排查半天——
    // 回显他填的原值，并说清是回落（2026-10-02 补）
    await expect(page.locator('#status')).toContainText('已回落默认');
    await expect(page.locator('#status')).toContainText('ftp://example.com');

    // 保存时规范化，表单立刻回落到默认地址
    await expect(page.getByLabel('FastAPI 服务地址')).toHaveValue('http://127.0.0.1:8000');

    await page.close();
  });

  test('设置的目标语言与风格确实传进翻译请求', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    await options.getByLabel('目标语言').fill('ja');
    await options.getByLabel('翻译风格').selectOption('academic');
    await options.getByRole('button', { name: '保存设置' }).click();
    await expect(options.locator('#status')).toContainText('已保存');

    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);
    await resetStats(fixture);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const stats = await readStats(fixture);

    expect(stats.lastTargetLanguage).toBe('ja');
    expect(stats.lastStyle).toBe('academic');

    await popup.close();
    await fixture.close();
    await options.close();
  });

  test('缓存用量可见，且可清除', async ({ context, extensionId }) => {
    // 先翻译一次，产生缓存
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const options = await openOptions(context, extensionId);

    // 用量可见且非零
    await expect(options.locator('#cache-count')).not.toHaveText('0 条');
    await expect(options.locator('#cache-bytes')).not.toHaveText('0 B');
    await expect(options.locator('#cache-limit')).toContainText('5000 条');

    await options.getByRole('button', { name: '清除缓存' }).click();
    await expect(options.locator('#status')).toContainText('已清除');
    await expect(options.locator('#cache-count')).toHaveText('0 条');

    await options.close();
    await popup.close();
    await fixture.close();
  });
});

test.describe('设置页 · 版本号', () => {
  test('显示扩展版本，且与 manifest 一致', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    // 从 manifest 读，而不是写死——版本号会变
    const version = await page.evaluate(() => chrome.runtime.getManifest().version);

    await expect(page.locator('#app-version')).toHaveText(`v${version}`, { timeout: 10_000 });

    await page.close();
  });
});
