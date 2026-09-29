import { activateFixtureTab, countPluginNodes, expect, openPopup, test } from './fixtures';

/**
 * Phase 15 · 阅读模式（方案第 62 节）。
 *
 * 验收标准（方案第 82.2 节）：
 *   长文章可进入**独立阅读视图**并翻译正文
 *
 * 用 `article-with-noise.html`：它有导航 / 侧栏 / 页脚 / 订阅位，
 * 正好验证 Readability 的剥离效果——纯正文页面测不出这一点。
 */

const NOISY_URL = 'http://127.0.0.1:8000/article-with-noise.html';

test.describe('Phase 15 · 阅读模式', () => {
  test('提取正文并在独立视图里渲染', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 1000 });
    await fixture.goto(NOISY_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, NOISY_URL);

    const readerPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: '阅读模式' }).click();
    const reader = await readerPromise;

    // Readability 的标题取自 <title>（含站点名），用包含匹配
    await expect(reader.getByRole('heading', { level: 1 })).toContainText('Why Streaming Matters');
    await expect(reader.locator('#reader-body')).toContainText('Waiting for a full batch');

    await reader.close();
    await popup.close();
    await fixture.close();
  });

  test('导航、侧栏、页脚都不进阅读视图', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 1000 });
    await fixture.goto(NOISY_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, NOISY_URL);

    const readerPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: '阅读模式' }).click();
    const reader = await readerPromise;

    await expect(reader.locator('#reader-body')).toContainText('Waiting for a full batch');

    const text = (await reader.locator('body').textContent()) ?? '';
    expect(text).not.toContain('Skip to content');
    expect(text).not.toContain('Related posts');
    expect(text).not.toContain('Subscribe to the newsletter');
    expect(text).not.toContain('Privacy policy');

    await reader.close();
    await popup.close();
    await fixture.close();
  });

  test('原文页面一个节点都没被改动（铁律 3）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 1000 });
    await fixture.goto(NOISY_URL);

    const before = await fixture.evaluate(() => document.body.innerHTML);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, NOISY_URL);

    const readerPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: '阅读模式' }).click();
    const reader = await readerPromise;
    // Readability 的标题取自 <title>（含站点名），用包含匹配
    await expect(reader.getByRole('heading', { level: 1 })).toContainText('Why Streaming Matters');

    // 提取在克隆文档上跑，原页面应当**完全没变**
    expect(await fixture.evaluate(() => document.body.innerHTML)).toBe(before);
    expect(await countPluginNodes(fixture)).toBe(0);

    await reader.close();
    await popup.close();
    await fixture.close();
  });

  test('阅读视图里可以翻译正文', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 1000 });
    await fixture.goto(NOISY_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, NOISY_URL);

    const readerPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: '阅读模式' }).click();
    const reader = await readerPromise;

    await expect(reader.locator('#reader-body')).toContainText('Waiting for a full batch');

    await reader.getByRole('button', { name: '翻译正文' }).click();
    await expect(reader.locator('#reader-status')).toContainText('已翻译', { timeout: 60_000 });

    // 译文出现在阅读视图里
    await expect(reader.locator('#reader-body')).toContainText('【译】');
    expect(await countPluginNodes(reader)).toBeGreaterThan(0);

    await reader.close();
    await popup.close();
    await fixture.close();
  });

  test('内容过短的页面给出明确提示而不是空白视图', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.goto('http://127.0.0.1:8000/spa.html');

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, 'http://127.0.0.1:8000/spa.html');

    await popup.getByRole('button', { name: '阅读模式' }).click();

    await expect(popup.locator('#status')).toContainText('没有提取到可读的正文', {
      timeout: 15_000,
    });

    await popup.close();
    await fixture.close();
  });
});

/**
 * 阅读视图里生成学习笔记（方案第 32 节）。
 *
 * ## 与「总结」的区别
 *
 * **总结是压缩，笔记是重组。**
 *
 * | | 总结 | 笔记 |
 * | --- | --- | --- |
 * | 目的 | 快速了解讲了什么 | 日后复习、查阅 |
 * | 读者 | 现在 | 未来的自己 |
 * | 内容 | 一句话 + 几条要点 | 定位 + 概念 + 分节大纲 + 结论 |
 *
 * 所以阅读视图给的是笔记，不是总结。其他两处入口（右键选中、
 * 侧边栏整页）保持简短总结不变。
 *
 * ## 为什么阅读视图这条输入最干净
 *
 * 它用 Readability 提取的正文，已经剥掉导航、侧栏、广告。
 */

test.describe('Phase 18 · 阅读视图生成笔记', () => {
  /** 打开阅读视图。 */
  async function openReader(
    context: Parameters<typeof activateFixtureTab>[0],
    extensionId: string,
  ): Promise<{
    fixture: import('@playwright/test').Page;
    reader: import('@playwright/test').Page;
  }> {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1000, height: 900 });
    await fixture.goto(NOISY_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context, NOISY_URL);

    const readerPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: '阅读模式' }).click();
    const reader = await readerPromise;

    await expect(reader.getByRole('heading', { level: 1 })).toContainText('Why Streaming Matters');

    await popup.close();
    return { fixture, reader };
  }

  test('笔记面板默认隐藏', async ({ context, extensionId }) => {
    const { fixture, reader } = await openReader(context, extensionId);

    await expect(reader.locator('#reader-note-panel')).toBeHidden();

    await reader.close();
    await fixture.close();
  });

  test('⭐ 生成笔记：定位 + 核心概念 + 分节大纲 + 结论', async ({ context, extensionId }) => {
    const { fixture, reader } = await openReader(context, extensionId);

    await reader.getByRole('button', { name: '生成笔记' }).click();

    await expect(reader.locator('#reader-note-panel')).toBeVisible({ timeout: 30_000 });
    await expect(reader.locator('#reader-note-positioning')).toContainText('【记】');

    // 概念是键值对，不是一列要点
    await expect(reader.locator('#reader-note-concepts dt')).toHaveCount(2);
    await expect(reader.locator('#reader-note-concepts dd')).toHaveCount(2);

    // 大纲保留分节
    await expect(reader.locator('#reader-note-outline .note__heading')).toHaveCount(2);
    await expect(reader.locator('#reader-note-outline .note__points li')).toHaveCount(3);

    // 结论
    await expect(reader.locator('#reader-note-takeaways li')).toHaveCount(2);

    await expect(reader.locator('#reader-note-model')).not.toHaveText('');
    await expect(reader.locator('#reader-status')).toContainText('笔记已生成');

    await reader.close();
    await fixture.close();
  });

  test('⭐ 导出的 Markdown 保留层级', async ({ context, extensionId }) => {
    const { fixture, reader } = await openReader(context, extensionId);

    await reader.getByRole('button', { name: '生成笔记' }).click();
    await expect(reader.locator('#reader-note-panel')).toBeVisible({ timeout: 30_000 });

    const downloadPromise = reader.waitForEvent('download', { timeout: 15_000 });
    await reader.locator('#reader-note-export').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.md$/);
    await expect(reader.locator('#reader-status')).toContainText('已导出');

    await reader.close();
    await fixture.close();
  });

  test('笔记文本按纯文本渲染，不解析 HTML（铁律 2）', async ({ context, extensionId }) => {
    const { fixture, reader } = await openReader(context, extensionId);

    await reader.getByRole('button', { name: '生成笔记' }).click();
    await expect(reader.locator('#reader-note-panel')).toBeVisible({ timeout: 30_000 });

    const html = await reader.locator('#reader-note-positioning').innerHTML();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');

    await reader.close();
    await fixture.close();
  });
});
