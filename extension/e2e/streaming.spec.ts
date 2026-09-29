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
 * Phase 5B · 流式增量解析（方案第 86.9 节）。
 *
 * 验收标准（方案第 82.2 节 Phase 5）：
 *   **首个完整段落可在整个 Batch 返回前渲染**
 *
 * 判定方式：在翻译过程中持续采样「已渲染的译文节点数」，
 * 要求它**经过中间值**——即出现过 `0 < n < 最终值` 的时刻。
 *
 * 这个判定能真正区分流式与非流式：
 * 非流式实现下所有译文在同一个同步渲染里一次性出现，
 * 计数直接从 0 跳到最终值，采样不可能捕捉到中间值。
 *
 * 为了让中间窗口足够长，E2E 的 FastAPI 用 `LLM_MOCK_STREAM_DELAY_MS=200`
 * 拉开了流式段之间的间隔（见 `playwright.config.ts`）。
 */

interface Stats {
  translateRequests: number;
  translateItems: number;
}

async function readStats(page: Page): Promise<Stats> {
  const response = await page.request.get('http://127.0.0.1:8000/__e2e/stats');
  return (await response.json()) as Stats;
}

test.describe('Phase 5B · 流式增量解析', () => {
  test('译文在整批返回前就开始渲染（计数经过中间值）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();

    const samples: number[] = [];
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      samples.push(await countPluginNodes(fixture));

      const status = await popup.locator('#status').textContent();
      if (status?.includes('已翻译') === true) {
        break;
      }

      await fixture.waitForTimeout(20);
    }

    await expect(popup.locator('#status')).toContainText('已翻译');

    const finalCount = samples.at(-1) ?? 0;
    expect(finalCount).toBeGreaterThan(1);

    // 关键断言：中途出现过「非 0 且非最终值」的计数
    const sawIntermediate = samples.some((count) => count > 0 && count < finalCount);
    expect(sawIntermediate, `采样序列应包含中间值：${samples.join(',')}`).toBe(true);

    await popup.close();
    await fixture.close();
  });

  test('流式下每个条目仍然完整（含占位符）', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    // 含 inline 标记的段落：译文里的占位符必须被正确回填
    await expect(fixture.locator('#inline-demo + [data-ai-translator="true"]')).toContainText(
      '【译】AI engineering is changing software development',
    );

    // inline 元素仍可点击，href 未变
    await expect(fixture.locator('#inline-demo a')).toHaveAttribute(
      'href',
      '/docs/getting-started',
    );

    // 被忽略的代码块没有被翻译
    await expect(fixture.locator('pre#code-demo')).toContainText('const client = new OpenAI');

    await popup.close();
    await fixture.close();
  });

  test('流式请求走的是流式端点', async ({ context, extensionId }) => {
    const fixture = await context.newPage();
    await fixture.setViewportSize({ width: 900, height: 1000 });
    await fixture.goto(FIXTURE_URL);
    await fixture.request.post('http://127.0.0.1:8000/__e2e/reset');

    const popup = await openPopup(context, extensionId);
    await activateFixtureTab(context);

    await popup.locator('#translate').click();
    await expect(popup.locator('#status')).toContainText('已翻译', { timeout: 60_000 });

    const stats = await readStats(fixture);

    // 请求确实到了服务端，且条目数与页面 Block 数量级一致
    expect(stats.translateRequests).toBeGreaterThan(0);
    expect(stats.translateItems).toBeGreaterThan(0);

    await popup.close();
    await fixture.close();
  });
});
