import type { Page } from '@playwright/test';

import { activateFixtureTab, expect, FIXTURE_URL, openPopup, test } from './fixtures';

/**
 * 成本可见性。
 *
 * 验收标准：
 *   用量能被看到，且填了单价能估算金额
 *
 * ## 分工（这条决定了测试怎么写）
 *
 * 服务端 `/api/v1/usage` **只报 token，不报金额**——token 是事实，
 * 价格是外部输入且会变。金额由扩展按用户填的单价算。
 *
 * 所以：
 *   - 不填单价 → 只显示 token
 *   - 填了单价 → 多显示一行估算金额
 */

async function openOptions(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page;
}

/** 先制造一些用量：翻译一次 fixture。 */
async function produceUsage(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<void> {
  const fixture = await context.newPage();
  await fixture.goto(FIXTURE_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context);

  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

  await popup.close();
  await fixture.close();
}

test.describe('Phase 19 · 成本可见性', () => {
  test('设置页显示用量（token）', async ({ context, extensionId }) => {
    await produceUsage(context, extensionId);

    const options = await openOptions(context, extensionId);

    // 调用次数与 token 数都应有值，而不是占位符
    await expect(options.locator('#usage-calls')).not.toHaveText('—', { timeout: 15_000 });
    await expect(options.locator('#usage-prompt')).not.toHaveText('—');
    await expect(options.locator('#usage-completion')).not.toHaveText('—');
    // 没填单价时明确说「未设单价」，而不是显示 0
    await expect(options.locator('#usage-cost')).toHaveText('未设单价');

    await options.close();
  });

  test('⭐ 填了单价后估算出金额', async ({ context, extensionId }) => {
    await produceUsage(context, extensionId);

    const options = await openOptions(context, extensionId);
    await expect(options.locator('#usage-calls')).not.toHaveText('—', { timeout: 15_000 });

    // 填单价（不保存也能立刻估算——刷新用量读的是当前表单值）
    await options.locator('#input-price').fill('1');
    await options.locator('#output-price').fill('4');
    await options.locator('#refresh-usage').click();

    await expect(options.locator('#usage-cost')).toContainText('元', { timeout: 15_000 });
    await expect(options.locator('#usage-cost')).not.toHaveText('未设单价');

    await options.close();
  });

  test('单价会随设置一起保存', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);

    await options.locator('#input-price').fill('1');
    await options.locator('#output-price').fill('4');
    await options.locator('#save').click();
    await expect(options.locator('#status')).toContainText('已保存');

    // 重新打开应保留
    await options.reload();
    await expect(options.locator('#input-price')).toHaveValue('1', { timeout: 10_000 });
    await expect(options.locator('#output-price')).toHaveValue('4');

    await options.close();
  });

  test('侧边栏显示用量', async ({ context, extensionId }) => {
    await produceUsage(context, extensionId);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await activateFixtureTab(context);

    await expect(panel.locator('#usage-summary')).toContainText('次调用', { timeout: 15_000 });
    await expect(panel.locator('#usage-summary')).toContainText('token');

    await panel.close();
    await fixture.close();
  });

  test('清空用量后归零', async ({ context, extensionId }) => {
    await produceUsage(context, extensionId);

    const options = await openOptions(context, extensionId);
    await expect(options.locator('#usage-calls')).not.toHaveText('—', { timeout: 15_000 });

    await options.locator('#clear-usage').click();
    await expect(options.locator('#status')).toContainText('已清空', { timeout: 15_000 });
    await expect(options.locator('#usage-calls')).toHaveText('0 次');

    await options.close();
  });
});
