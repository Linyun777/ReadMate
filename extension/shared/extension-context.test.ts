import { afterEach, describe, expect, it } from 'vitest';

import { isExtensionContextValid } from './extension-context';

/**
 * 扩展上下文存活检查。
 *
 * 这组测试守的是一个**误导性报错**：上下文失效后 `chrome.storage` 变成
 * `undefined`，WXT 的 storage 适配器会抛
 * "You must add the 'storage' permission to your manifest" ——
 * 看起来像 manifest 配错了，实际是扩展被重新加载过。
 */

const original = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = original;
});

function stubChrome(value: unknown): void {
  (globalThis as { chrome?: unknown }).chrome = value;
}

describe('isExtensionContextValid', () => {
  it('runtime.id 存在时视为有效', () => {
    stubChrome({ runtime: { id: 'abc' } });

    expect(isExtensionContextValid()).toBe(true);
  });

  it('runtime.id 为 undefined 时视为失效', () => {
    // 这是上下文失效的可靠信号：对象还在，只是内容空了
    stubChrome({ runtime: {} });

    expect(isExtensionContextValid()).toBe(false);
  });

  it('runtime 不存在时视为失效', () => {
    stubChrome({});

    expect(isExtensionContextValid()).toBe(false);
  });

  it('chrome 完全不存在时视为失效', () => {
    stubChrome(undefined);

    expect(isExtensionContextValid()).toBe(false);
  });

  it('访问 chrome 本身抛错时也视为失效，而不是让调用方崩掉', () => {
    stubChrome(
      new Proxy(
        {},
        {
          get() {
            throw new Error('被 CSP 拦了');
          },
        },
      ),
    );

    expect(isExtensionContextValid()).toBe(false);
  });
});
