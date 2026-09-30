import type { Page } from '@playwright/test';

import { activateFixtureTab, expect, openPopup, test } from './fixtures';

/**
 * 拆大块（方案第 57 节）：一个超长容器切成多个 Block。
 *
 * ## 为什么要专门有一条 E2E
 *
 * 单测能证明「分段器切了」「渲染器能恢复」，但证明不了**整条链路**：
 * 视口筛选、批次划分、队列、流式增量渲染、双语节点追加、
 * 切回原文时的清理——任何一环把拆出来的段丢了，页面上就少一段译文，
 * 而单测全都还是绿的。
 *
 * 用 `long-container.html`：它同时有「该切」「不该切（嵌了块级后代）」
 * 「不该切（表格单元格）」三种容器。
 */

const LONG_URL = 'http://127.0.0.1:8000/long-container.html';

/** 打开 fixture 并完成一次翻译。 */
async function translateLongFixture(
  context: Parameters<typeof activateFixtureTab>[0],
  extensionId: string,
): Promise<{ fixture: Page; popup: Page }> {
  const fixture = await context.newPage();
  await fixture.setViewportSize({ width: 1000, height: 1200 });
  await fixture.goto(LONG_URL);

  const popup = await openPopup(context, extensionId);
  await activateFixtureTab(context, LONG_URL);

  await popup.locator('#translate').click();
  await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

  return { fixture, popup };
}

test.describe('拆大块 · 超长容器切成多个 Block', () => {
  test('⭐ 超长容器渲染出多段译文（不是一个巨型块）', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateLongFixture(context, extensionId);

    // 每一段一个译文节点：> 1 就说明真的拆开了
    const segments = fixture.locator('#flat-long > [data-ai-translator="true"]');
    await expect(segments).not.toHaveCount(1);
    expect(await segments.count()).toBeGreaterThan(1);

    // 而且每一段都拿到了译文
    for (const text of await segments.allTextContents()) {
      expect(text).toContain('【译】');
    }

    await popup.close();
    await fixture.close();
  });

  test('嵌套块级后代的容器不拆：整块只渲染一个译文节点', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateLongFixture(context, extensionId);

    // #with-block 自身文本也超过阈值，但它内部嵌了 <p>，按规则不切
    expect(await fixture.locator('#with-block > [data-ai-translator="true"]').count()).toBe(1);
    // 嵌套段落照常自成一块
    expect(await fixture.locator('#nested + [data-ai-translator="true"]').count()).toBe(1);

    await popup.close();
    await fixture.close();
  });

  test('表格单元格不拆', async ({ context, extensionId }) => {
    const { fixture, popup } = await translateLongFixture(context, extensionId);

    expect(await fixture.locator('#cell > [data-ai-translator="true"]').count()).toBe(1);

    await popup.close();
    await fixture.close();
  });

  test('⭐ 切回原文后超长容器逐字节恢复', async ({ context, extensionId }) => {
    // ⚠️ 基线必须在**翻译之前**截——翻译完再截，里面已经有译文节点了
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 1200 });
    await fixture.goto(LONG_URL);

    const before = await fixture.locator('#flat-long').innerHTML();
    expect(before.length).toBeGreaterThan(1000);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, LONG_URL);
    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    await popup.getByRole('radio', { name: '原文' }).check();
    await expect(fixture.locator('#flat-long > [data-ai-translator="true"]')).toHaveCount(0);

    // 多段各自换回原位——顺序错一个字符这条就会红
    expect(await fixture.locator('#flat-long').innerHTML()).toBe(before);

    await popup.close();
    await fixture.close();
  });
});
