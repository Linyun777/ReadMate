import type { Page } from '@playwright/test';

import {
  activateFixtureTab,
  countPluginNodes,
  expect,
  FIXTURE_URL,
  openPopup,
  test,
} from './fixtures';

/**
 * Side Panel：常驻控制台（方案第 83 节）。
 *
 * 验收标准：
 *   侧边栏常驻显示当前页面状态，可直接翻译 / 切模式 / 恢复原文
 *
 * ## ⚠️ 覆盖边界
 *
 * **「点击按钮打开侧边栏」这一步没有自动化覆盖**——侧边栏是浏览器原生 UI，
 * 不在页面 DOM 里，且 `chrome.sidePanel.open()` 要求用户手势。
 *
 * 这里把 `sidepanel.html` 当普通页面打开来测**面板本身的逻辑**，
 * 与 E2E 测 Popup 的方式一致。「能打开」那一步只能手工验证。
 */

async function openSidePanel(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<Page> {
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/** 打开 fixture 页 + 侧边栏，并把 fixture 设为活动标签页。 */
async function setup(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<{ fixture: Page; panel: Page }> {
  const fixture = await context.newPage();
  await fixture.setViewportSize({ width: 1000, height: 900 });
  await fixture.goto(FIXTURE_URL);

  const panel = await openSidePanel(context, extensionId);
  await activateFixtureTab(context);

  return { fixture, panel };
}

test.describe('Side Panel · 常驻控制台', () => {
  test('翻译后显示页面标题与进度', async ({ context, extensionId }) => {
    const { fixture, panel } = await setup(context, extensionId);

    await panel.locator('#translate').click();

    // 标题来自 content script——首次翻译前拿不到（面板没有 tabs 权限读 tab.title）
    await expect(panel.locator('#page-title')).toContainText('AI Engineering', {
      timeout: 60_000,
    });
    await expect(panel.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    await panel.close();
    await fixture.close();
  });

  test('从侧边栏翻译页面，进度自动更新', async ({ context, extensionId }) => {
    const { fixture, panel } = await setup(context, extensionId);

    await expect(panel.locator('#translate')).toBeEnabled({ timeout: 15_000 });
    await panel.locator('#translate').click();

    // 轮询会自动把进度刷进来，不需要手动刷新面板
    await expect(panel.locator('#status')).toContainText('已翻译', { timeout: 60_000 });
    await expect(panel.locator('#status')).not.toContainText('已翻译 0/', { timeout: 60_000 });

    // 页面上确实渲染了译文
    expect(await countPluginNodes(fixture)).toBeGreaterThan(0);

    await panel.close();
    await fixture.close();
  });

  test('从侧边栏切换显示模式', async ({ context, extensionId }) => {
    const { fixture, panel } = await setup(context, extensionId);

    await panel.locator('#translate').click();
    await expect(panel.locator('#status')).not.toContainText('已翻译 0/', { timeout: 60_000 });

    // 切到中文模式
    await panel.getByRole('radio', { name: '中文' }).check();
    await expect(fixture.locator('h1')).toHaveText('【译】AI Engineering in Practice', {
      timeout: 15_000,
    });

    // 切回原文
    await panel.getByRole('radio', { name: '原文' }).check();
    await expect(fixture.locator('h1')).toHaveText('AI Engineering in Practice', {
      timeout: 15_000,
    });

    await panel.close();
    await fixture.close();
  });

  test('恢复原文后状态说明译文仍在缓存里', async ({ context, extensionId }) => {
    const { fixture, panel } = await setup(context, extensionId);

    await panel.locator('#translate').click();
    await expect(panel.locator('#status')).not.toContainText('已翻译 0/', { timeout: 60_000 });

    await panel.locator('#restore').click();

    await expect(panel.locator('#status')).toContainText('已恢复原文', { timeout: 15_000 });
    expect(await countPluginNodes(fixture)).toBe(0);

    await panel.close();
    await fixture.close();
  });

  test('切换标签页后面板跟随新页面（轮询生效）', async ({ context, extensionId }) => {
    const { fixture, panel } = await setup(context, extensionId);

    await panel.locator('#translate').click();
    await expect(panel.locator('#page-title')).toContainText('AI Engineering', { timeout: 60_000 });

    // 切到一个尚未翻译的页面——面板应跟随，而不是残留上一个页面的状态
    const second = await context.newPage();
    await second.goto('http://127.0.0.1:8000/long-article.html');
    await activateFixtureTab(context, 'http://127.0.0.1:8000/long-article.html');

    await expect(panel.locator('#status')).toContainText('尚未翻译', { timeout: 15_000 });
    await expect(panel.locator('#page-title')).toHaveText('');

    await second.close();
    await panel.close();
    await fixture.close();
  });

  test('尚未翻译的页面：提示明确，且翻译按钮可用（点击会按需注入）', async ({
    context,
    extensionId,
  }) => {
    const { fixture, panel } = await setup(context, extensionId);

    // 首次翻译前页面本来就没有 content script，状态查询必然失败——
    // 但这正是「需要翻译」的正常状态，按钮**不能**被禁用，
    // 否则侧边栏会永远卡死（这个缺陷被这条用例抓到过）
    await expect(panel.locator('#status')).toContainText('尚未翻译', { timeout: 15_000 });
    await expect(panel.locator('#translate')).toBeEnabled();
    await expect(panel.locator('#restore')).toBeDisabled();

    await panel.close();
    await fixture.close();
  });

  test('无法注入的页面（扩展页）点击后给出明确失败', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId);
    const panel = await openSidePanel(context, extensionId);

    // 不用 activateFixtureTab：扩展页不在 host_permissions 里，
    // chrome.tabs.query 读不到它的 url。但新开的页面本来就是活动的。
    await expect(panel.locator('#status')).toContainText('尚未翻译', { timeout: 15_000 });
    await panel.locator('#translate').click();

    await expect(panel.locator('#status')).toContainText('失败', { timeout: 15_000 });

    await panel.close();
    await popup.close();
  });

  test('清除缓存按钮生效', async ({ context, extensionId }) => {
    const { fixture, panel } = await setup(context, extensionId);

    await panel.locator('#translate').click();
    await expect(panel.locator('#status')).not.toContainText('已翻译 0/', { timeout: 60_000 });

    // 注意不能用 not.toContainText('0 条')——「20 条」也包含这个子串
    await expect(panel.locator('#cache-summary')).not.toHaveText('0 条 · 0 B', {
      timeout: 15_000,
    });

    await panel.locator('#clear-cache').click();
    await expect(panel.locator('#status')).toContainText('已清除', { timeout: 15_000 });
    await expect(panel.locator('#cache-summary')).toContainText('0 条');

    await panel.close();
    await fixture.close();
  });
});

test.describe('Side Panel · 页面总结（方案第 32 节的 V3 规划）', () => {
  /** 总结需要一篇够长的文章——用 long-article fixture。 */
  const LONG_URL = 'http://127.0.0.1:8000/long-article.html';

  async function setupLongArticle(
    context: Parameters<typeof activateFixtureTab>[0],
    extensionId: string,
  ): Promise<{ fixture: Page; panel: Page }> {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(LONG_URL);

    const panel = await openSidePanel(context, extensionId);
    await activateFixtureTab(context, LONG_URL);

    return { fixture, panel };
  }

  test('总结当前页面并渲染 gist 与要点', async ({ context, extensionId }) => {
    const { fixture, panel } = await setupLongArticle(context, extensionId);

    // 总结结果默认隐藏
    await expect(panel.locator('#summary')).toBeHidden();

    await panel.locator('#summarize').click();

    await expect(panel.locator('#summary')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('#summary-gist')).toContainText('【摘】');
    await expect(panel.locator('#summary-points li')).toHaveCount(3);
    await expect(panel.locator('#status')).toContainText('总结完成');

    await panel.close();
    await fixture.close();
  });

  test('总结文本按纯文本渲染，不解析 HTML（铁律 2）', async ({ context, extensionId }) => {
    const { fixture, panel } = await setupLongArticle(context, extensionId);

    await panel.locator('#summarize').click();
    await expect(panel.locator('#summary')).toBeVisible({ timeout: 30_000 });

    // 模型输出是不可信输入——即使包含标签也应当作纯文本
    const html = await panel.locator('#summary-gist').innerHTML();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');

    await panel.close();
    await fixture.close();
  });

  test('再次总结会替换上一次结果，而不是叠加', async ({ context, extensionId }) => {
    const { fixture, panel } = await setupLongArticle(context, extensionId);

    await panel.locator('#summarize').click();
    await expect(panel.locator('#summary')).toBeVisible({ timeout: 30_000 });

    await panel.locator('#summarize').click();
    await expect(panel.locator('#summary')).toBeVisible({ timeout: 30_000 });

    // 要点列表不会累积成两份
    await expect(panel.locator('#summary-points li')).toHaveCount(3);
    await expect(panel.locator('#summary-gist')).toHaveCount(1);

    await panel.close();
    await fixture.close();
  });

  test('内容过短的页面给出明确失败', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto('http://127.0.0.1:8000/spa.html');

    const panel = await openSidePanel(context, extensionId);
    await activateFixtureTab(context, 'http://127.0.0.1:8000/spa.html');

    await panel.locator('#summarize').click();

    await expect(panel.locator('#status')).toContainText('总结失败', { timeout: 20_000 });
    await expect(panel.locator('#summary')).toBeHidden();

    await panel.close();
    await fixture.close();
  });
});
