import { expect, test } from './fixtures';

/**
 * 设置页的「模型服务」区块。
 *
 * ## 这个功能解决什么
 *
 * 换 Provider（GLM / Kimi / …）以前要手工编辑 `server/.env`。
 * 现在在设置页改，**改完立即生效，不用重启服务**。
 *
 * ## ⚠️ 安全边界（这几条是这个文件存在的重点）
 *
 * 1. **API Key 只进不出**：服务端的 `GET /config` 只返回 `hasApiKey`
 *    布尔值，响应里绝不能出现密钥本身（铁律 1）
 * 2. **浏览器不保存密钥**：输入框保存后立即清空，且重新加载时永远是空的
 * 3. **E2E 不碰真实配置**：服务端由 `start-server.mjs` 用临时的
 *    `ENV_FILE_PATH` 启动——否则跑一次测试就把用户的 Key 和模型改了
 */

const E2E_BASE_URL = 'https://api.example.test/v1';
const E2E_MODEL = 'model-before';

/** 直连服务端（绕过 fixture 反代），用于重置状态。 */
const SERVER = 'http://127.0.0.1:8001/api/v1/config';

/**
 * 每个用例都从**已知状态**开始。
 *
 * 这个功能是「改服务端配置」，用例之间天然会互相影响——
 * 前一个把模型改成 model-after，后一个还在按 model-before 断言。
 * 与其让用例彼此依赖执行顺序，不如每个都先重置。
 */
test.beforeEach(async ({ context }) => {
  await context.request.put(SERVER, {
    data: { baseUrl: E2E_BASE_URL, model: E2E_MODEL, summaryModel: '' },
  });
});

test.describe('Phase 22 · 模型服务设置', () => {
  test('⭐ 显示服务端当前配置', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-base-url')).toHaveValue(E2E_BASE_URL, { timeout: 15_000 });
    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL);
    // 摘要模型留空时服务端返回回落到 model
    await expect(page.locator('#llm-summary-model')).toHaveValue(E2E_MODEL);

    await page.close();
  });

  test('⭐ API Key 输入框永远是空的（浏览器不保存密钥）', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 15_000 });

    // 无论服务端有没有配 Key，这个框都不该有值
    await expect(page.locator('#llm-api-key')).toHaveValue('');

    await page.close();
  });

  test('⭐ 服务端响应里不含密钥', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    // 直接问服务端要原始响应
    const raw = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:8000/api/v1/config');
      return response.text();
    });

    expect(raw).not.toContain('sk-');
    expect(raw.toLowerCase()).not.toContain('apikey=');
    expect(raw).toContain('hasApiKey');

    await page.close();
  });

  test('改模型并保存，重新加载后仍在', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 15_000 });

    await page.locator('#llm-model').fill('model-after');
    await page.locator('#save-llm').click();

    await expect(page.locator('#status')).toContainText('已保存', { timeout: 15_000 });

    // 重新加载：值应当持久化（写进了服务端的 .env）
    await page.reload();
    await expect(page.locator('#llm-model')).toHaveValue('model-after', { timeout: 15_000 });

    await page.close();
  });

  test('只改地址时不必重填密钥', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-base-url')).toHaveValue(E2E_BASE_URL, { timeout: 15_000 });

    // 只改地址，Key 留空
    await page.locator('#llm-base-url').fill('https://open.bigmodel.cn/api/paas/v4');
    await page.locator('#save-llm').click();
    await expect(page.locator('#status')).toContainText('已保存', { timeout: 15_000 });

    await page.reload();
    await expect(page.locator('#llm-base-url')).toHaveValue(
      'https://open.bigmodel.cn/api/paas/v4',
      { timeout: 15_000 },
    );
    // 密钥那一栏仍然为空——它不该被浏览器读到
    await expect(page.locator('#llm-api-key')).toHaveValue('');

    await page.close();
  });

  test('没有改动时不提交', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 15_000 });

    await page.locator('#save-llm').click();

    await expect(page.locator('#status')).toContainText('没有改动', { timeout: 10_000 });

    await page.close();
  });

  test('非法地址被拒绝，且不写坏配置', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-base-url')).toHaveValue(E2E_BASE_URL, { timeout: 15_000 });

    await page.locator('#llm-base-url').fill('ftp://not-http');
    await page.locator('#save-llm').click();

    await expect(page.locator('#llm-status')).toContainText('保存失败', { timeout: 15_000 });

    // 配置没被改坏
    await page.reload();
    await expect(page.locator('#llm-base-url')).toHaveValue(E2E_BASE_URL, { timeout: 15_000 });

    await page.close();
  });

  test('重新读取按钮能拉回服务端的值', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 15_000 });

    // 改掉但不保存
    await page.locator('#llm-model').fill('discarded');
    await page.locator('#reload-llm').click();

    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 10_000 });

    await page.close();
  });

  /**
   * ⭐ 这个文件最重要的一条。
   *
   * 「浏览器端永不保存真实 LLM API Key」是铁律 1。设置页允许**输入**密钥
   * （否则换 Provider 还得手工编辑 .env），但绝不能**留下**它。
   *
   * 所以这里填一个能识别的假密钥、保存、然后翻遍 `chrome.storage` ——
   * 任何位置出现它都算失败。
   *
   * ⚠️ 这条用例会改变服务端状态（Key 从空变成已配置），
   * 所以放在最后。前面的用例都假设 `hasApiKey=false`。
   */
  test('⭐ 保存密钥后，它不会留在浏览器存储里', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 15_000 });

    const sentinel = 'sk-SENTINEL-must-not-be-stored';

    await page.locator('#llm-api-key').fill(sentinel);
    await page.locator('#save-llm').click();
    await expect(page.locator('#status')).toContainText('已保存', { timeout: 15_000 });

    // 1. 输入框被清空
    await expect(page.locator('#llm-api-key')).toHaveValue('');

    // 2. ⭐ chrome.storage 的任何角落都不该有它
    const stored = await page.evaluate(async () => {
      const local = await chrome.storage.local.get(null);
      const sync = await chrome.storage.sync.get(null);
      return JSON.stringify({ local, sync });
    });

    expect(stored).not.toContain(sentinel);
    expect(stored).not.toContain('SENTINEL');

    // 3. 重新加载后输入框仍是空的
    await page.reload();
    await expect(page.locator('#llm-model')).toHaveValue(E2E_MODEL, { timeout: 15_000 });
    await expect(page.locator('#llm-api-key')).toHaveValue('');

    await page.close();
  });
});
