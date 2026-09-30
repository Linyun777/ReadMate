import { afterEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_SOURCE } from '@/shared/constants';
import type { SetDisplayModeMessage, TranslatePageMessage } from '@/shared/types';

import { createMessage, isExtensionMessage } from './protocol';

/**
 * 消息协议（方案第 8.1、86.7 节）。
 *
 * 这个文件存在的理由是 `isExtensionMessage` —— 它是 background 与 content script
 * 的**第一道过滤**（见 `entrypoints/background.ts` 与 `entrypoints/content.ts`
 * 的 `onMessage` 监听器）。页面脚本可以往扩展发任意消息，挡不住就会被当成命令执行。
 *
 * 它是纯函数、分支很少、失败代价高 —— 正是单测该盯的形状。
 */

function translatePage(): TranslatePageMessage {
  return createMessage<TranslatePageMessage>({ type: 'TRANSLATE_PAGE' });
}

describe('消息协议 · 构造', () => {
  it('自动补上 source 与 requestId', () => {
    const message = translatePage();

    expect(message.type).toBe('TRANSLATE_PAGE');
    expect(message.source).toBe(MESSAGE_SOURCE);
    expect(typeof message.requestId).toBe('string');
    expect(message.requestId.length).toBeGreaterThan(0);
  });

  it('保留调用方传入的业务字段', () => {
    const message = createMessage<SetDisplayModeMessage>({
      type: 'SET_DISPLAY_MODE',
      mode: 'bilingual',
    });

    expect(message.mode).toBe('bilingual');
  });

  it('每条消息的 requestId 都不同', () => {
    const ids = new Set(Array.from({ length: 50 }, () => translatePage().requestId));

    expect(ids.size).toBe(50);
  });
});

describe('消息协议 · requestId 的降级路径', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 某些上下文（如 file:// 页面）没有 crypto.randomUUID。
  // 降级后仍必须唯一 —— 否则「按 requestId 追踪/去重」会误判成同一条消息。
  it('没有 crypto.randomUUID 时退化成「时间戳 + 计数器」', () => {
    vi.stubGlobal('crypto', {});

    expect(translatePage().requestId).toMatch(/^req-[0-9a-z]+-\d+$/);
  });

  it('降级后仍然互不重复', () => {
    vi.stubGlobal('crypto', {});

    const ids = new Set(Array.from({ length: 20 }, () => translatePage().requestId));

    expect(ids.size).toBe(20);
  });
});

describe('消息协议 · 来源校验（第一道过滤）', () => {
  it('接受本扩展构造的消息', () => {
    expect(isExtensionMessage(translatePage())).toBe(true);
  });

  it('多余字段不影响判定', () => {
    expect(
      isExtensionMessage({
        ...translatePage(),
        payload: { anything: true },
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'TRANSLATE_PAGE'],
    ['数字', 42],
    ['空对象', {}],
    ['缺 source', { type: 'TRANSLATE_PAGE', requestId: 'r-1' }],
    // ⭐ 页面脚本自己发的消息：字段都对，只有 source 不是我们的
    ['source 来自页面', { source: 'page', type: 'TRANSLATE_PAGE', requestId: 'r-1' }],
    ['type 不是字符串', { source: MESSAGE_SOURCE, type: 1, requestId: 'r-1' }],
    ['缺 requestId', { source: MESSAGE_SOURCE, type: 'TRANSLATE_PAGE' }],
    ['requestId 不是字符串', { source: MESSAGE_SOURCE, type: 'TRANSLATE_PAGE', requestId: 1 }],
  ])('拒绝 %s', (label, value) => {
    expect(isExtensionMessage(value), label).toBe(false);
  });
});
