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
 * Phase 10 · MutationObserver + 动态内容。
 *
 * 验收标准（方案第 82.2 节）：
 *   滚动后新加载内容自动翻译；SPA 原地更新文本也能被捕获；
 *   插件自身插入的节点被忽略，**无无限循环**
 *
 * 用短 fixture（`basic-article.html`）：它的全部内容都落在「视口 + 前瞻区」内，
 * 动态插入的节点也就能立刻被翻译，不必先滚动。
 */

interface Stats {
  translateRequests: number;
  translateItems: number;
}

async function readStats(page: Page): Promise<Stats> {
  const response = await page.request.get('http://127.0.0.1:8000/__e2e/stats');
  return (await response.json()) as Stats;
}

async function resetStats(page: Page): Promise<void> {
  await page.request.post('http://127.0.0.1:8000/__e2e/reset');
}

/** 打开 fixture、翻译、返回页面与 Popup。 */
async function translateFixture(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
) {
  const fixture = await context.newPage();
  await fixture.setViewportSize({ width: 900, height: 1000 });
  await fixture.goto(FIXTURE_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context);

  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

  return { fixture, popup };
}

test.describe('Phase 10 · 动态内容', () => {
  test('页面新插入的内容被自动翻译', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    // 模拟滚动 / 分页加载：页面自己往 DOM 里插新段落
    await fixture.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'injected';
      paragraph.textContent = 'This paragraph was injected by the page after load.';
      document.querySelector('article')?.append(paragraph);
    });

    await expect(fixture.locator('#injected + [data-ai-translator="true"]')).toHaveCount(1, {
      timeout: 30_000,
    });

    await popup.close();
    await fixture.close();
  });

  test('SPA 原地更新文本被捕获并重新翻译', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    // 原文段落已被翻译
    await expect(fixture.locator('#plain-paragraph + [data-ai-translator="true"]')).toContainText(
      '【译】Building reliable AI products',
    );

    // SPA 原地改写文本
    await fixture.evaluate(() => {
      const paragraph = document.querySelector('#plain-paragraph');
      if (paragraph) {
        paragraph.textContent = 'Completely new text from the SPA.';
      }
    });

    await expect(fixture.locator('#plain-paragraph + [data-ai-translator="true"]')).toContainText(
      '【译】Completely new text from the SPA.',
      { timeout: 30_000 },
    );

    // 旧译文节点被替换掉，而不是叠加出第二个
    await expect(fixture.locator('#plain-paragraph + [data-ai-translator="true"]')).toHaveCount(1);

    await popup.close();
    await fixture.close();
  });

  test('插件自身插入的节点被忽略，不产生无限循环', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    const before = await readStats(fixture);
    const pluginNodesBefore = await countPluginNodes(fixture);

    // 渲染出的译文节点会触发 MutationObserver。若没有屏蔽机制，
    // 它们会被当成「页面新内容」反复翻译，请求数与节点数都会持续增长。
    await fixture.waitForTimeout(2000);

    const after = await readStats(fixture);

    expect(after.translateRequests).toBe(before.translateRequests);
    expect(after.translateItems).toBe(before.translateItems);
    expect(await countPluginNodes(fixture)).toBe(pluginNodesBefore);

    await popup.close();
    await fixture.close();
  });

  test('中文模式下同样不会触发循环', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    await popup.getByRole('radio', { name: '中文' }).check();
    await expect(fixture.locator('h1')).toHaveText('【译】AI Engineering in Practice');

    // 中文模式是就地改写文本，节点上不带 data-ai-translator，
    // 只能靠渲染期间的暂停机制屏蔽
    await resetStats(fixture);
    await fixture.waitForTimeout(2000);

    const after = await readStats(fixture);
    expect(after.translateRequests).toBe(0);

    await popup.close();
    await fixture.close();
  });

  test('⭐ 容器被换成等价新节点后，不会出现两份译文', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    const before = await countPluginNodes(fixture);

    // React 客户端渲染的常见形状：把段落换成**等价的新节点**。
    // 锚点因此改变，旧条目既不会被 upsert 认出，也不在重新分段的根里——
    // 不专门清理的话，旧译文节点（它是容器的兄弟）会留在页面上，
    // 新译文一到就成了「同一段被翻了两遍」。
    const replaced = 'Replaced paragraph inserted by the page after hydration.';
    await fixture.evaluate((text) => {
      const old = document.querySelector('#plain-paragraph');
      if (!(old instanceof HTMLElement)) {
        return;
      }
      const replacement = document.createElement('p');
      replacement.id = 'plain-paragraph';
      replacement.textContent = text;
      old.replaceWith(replacement);
    }, replaced);

    // 新译文渲染出来
    await expect(fixture.locator('#plain-paragraph + [data-ai-translator="true"]')).toContainText(
      `【译】${replaced}`,
      { timeout: 30_000 },
    );

    // 而页面上仍然只有原来那么多个译文节点——旧的那一份已经被清掉
    await expect(fixture.locator('#plain-paragraph + [data-ai-translator="true"]')).toHaveCount(1);
    expect(await countPluginNodes(fixture)).toBe(before);

    await popup.close();
    await fixture.close();
  });

  test('动态插入但内容无需翻译时不产生请求', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateFixture(context, extensionId);

    await resetStats(fixture);

    // 纯数字 / URL：分段器会跳过，不该产生任何请求
    await fixture.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'noise';
      paragraph.textContent = '2026 https://example.com 42';
      document.querySelector('article')?.append(paragraph);
    });

    await fixture.waitForTimeout(1500);

    const after = await readStats(fixture);
    expect(after.translateRequests).toBe(0);

    await popup.close();
    await fixture.close();
  });
});
