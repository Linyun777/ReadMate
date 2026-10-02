import type { Page } from '@playwright/test';

import { activateFixtureTab, expect, FIXTURE_URL, openPopup, test } from './fixtures';

/**
 * 失败时**说清为什么**（2026-10-02 补）。
 *
 * 在此之前，界面上只有「翻译失败：N 段未成功」——用户既不知道是服务没起来、
 * Key 不对，还是被限流，只能去翻 console。现在失败原因由队列一路传到面板：
 * 「翻译失败：N 段未成功：<原因>」。
 *
 * 两种原因分别测，因为它们的处理路径不同：
 *   - 服务端返回的 detail —— **原样**带给用户（那句话本来就是写给人看的）
 *   - 网络层的 `Failed to fetch` —— 换成人话 + 下一步
 *
 * 失败靠 `e2e/static-server.mjs` 的 `/__e2e/fail-translate` 注入
 * （服务端一切正常时这些分支永远走不到）。
 */

const FAIL_URL = 'http://127.0.0.1:8000/__e2e/fail-translate';
const RESET_URL = 'http://127.0.0.1:8000/__e2e/reset';

async function arm(page: Page, mode: 'detail' | 'network'): Promise<void> {
  // count 给大一点：队列会重试、还会降级成单条重试，全部都要失败
  await page.request.post(`${FAIL_URL}?count=200&mode=${mode}`);
}

async function disarm(page: Page): Promise<void> {
  await page.request.post(RESET_URL);
}

test.describe('翻译失败时的原因提示', () => {
  test('服务端返回的原因原样显示给用户', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);
    await disarm(fixture);
    await arm(fixture, 'detail');

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();

    await expect(popup.locator('#status')).toContainText('E2E 注入的服务端错误', {
      timeout: 30_000,
    });
    await expect(popup.locator('#status')).toContainText('失败');

    await popup.close();
    await fixture.close();
    await disarm(fixture);
  });

  test('连不上服务时换成一句人话（而不是 Failed to fetch）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);
    await disarm(fixture);
    await arm(fixture, 'network');

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);
    await popup.locator('#translate').click();

    await expect(popup.locator('#status')).toContainText('连不上本地服务', { timeout: 30_000 });
    // 浏览器那句原始报错不该出现在界面上
    await expect(popup.locator('#status')).not.toContainText('Failed to fetch');

    await popup.close();
    await fixture.close();
    await disarm(fixture);
  });
});
