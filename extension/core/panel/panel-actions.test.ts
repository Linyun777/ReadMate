import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContentScriptState, DisplayMode, MessageResponse } from '@/shared/types';

import {
  describeState,
  hasTranslation,
  isBusy,
  queryPageState,
  requestRestore,
  requestSetMode,
  requestTranslate,
  summarizeFailure,
  toDisplayMode,
} from './panel-actions';

/**
 * 控制面板的共享逻辑（方案第 83 节）。
 *
 * 抽出来的理由之一就是**可测**——entrypoint 里的 DOM 接线测不到，
 * 这里的纯逻辑能单测。两个面板（Popup / Side Panel）都靠这组测试兜底。
 */

function makeState(overrides: Partial<ContentScriptState> = {}): ContentScriptState {
  return {
    state: 'ACTIVE',
    title: 'Example',
    mode: 'bilingual',
    stats: {
      total: 10,
      untranslated: 0,
      queued: 0,
      translating: 0,
      translated: 10,
      failed: 0,
      progress: 1,
    },
    ...overrides,
  };
}

function stubChrome(response: MessageResponse<ContentScriptState>): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage: async () => response },
  };
}

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

beforeEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe('面板命令', () => {
  it('queryPageState 成功时带回页面状态', async () => {
    const state = makeState();
    stubChrome({ ok: true, data: state });

    const result = await queryPageState();

    expect(result.ok).toBe(true);
    expect(result.state?.title).toBe('Example');
  });

  it('queryPageState 失败时给出可展示的原因', async () => {
    stubChrome({ ok: false, error: '当前页面尚未注入翻译脚本' });

    const result = await queryPageState();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('当前页面尚未注入翻译脚本');
  });

  it('响应 ok 但没有 data 时也视为失败', async () => {
    stubChrome({ ok: true });

    const result = await queryPageState();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('当前页面尚未注入翻译脚本');
  });

  it('失败且没有 error 时用兜底文案', async () => {
    stubChrome({ ok: false });

    const result = await requestTranslate();

    expect(result.error).toBe('翻译失败');
  });

  it('requestTranslate / requestRestore / requestSetMode 都走同一套结果转换', async () => {
    stubChrome({ ok: true, data: makeState({ mode: 'chinese' }) });

    expect((await requestTranslate()).ok).toBe(true);
    expect((await requestRestore()).ok).toBe(true);

    const switched = await requestSetMode('chinese');
    expect(switched.state?.mode).toBe('chinese');
  });
});

describe('toDisplayMode', () => {
  it.each<[string, DisplayMode | null]>([
    ['original', 'original'],
    ['bilingual', 'bilingual'],
    ['chinese', 'chinese'],
    ['', null],
    ['nonsense', null],
    ['ORIGINAL', null],
  ])('%s → %s', (input, expected) => {
    expect(toDisplayMode(input)).toBe(expected);
  });
});

describe('isBusy', () => {
  it('SCANNING 与 TRANSLATING 算忙', () => {
    expect(isBusy(makeState({ state: 'SCANNING' }))).toBe(true);
    expect(isBusy(makeState({ state: 'TRANSLATING' }))).toBe(true);
  });

  it('其余状态不算忙', () => {
    expect(isBusy(makeState({ state: 'IDLE' }))).toBe(false);
    expect(isBusy(makeState({ state: 'ACTIVE' }))).toBe(false);
    expect(isBusy(makeState({ state: 'RESTORED' }))).toBe(false);
  });
});

describe('hasTranslation', () => {
  it('有译文时为真', () => {
    expect(hasTranslation(makeState())).toBe(true);
  });

  it('一段都没翻时为假', () => {
    const state = makeState();
    state.stats.translated = 0;

    expect(hasTranslation(state)).toBe(false);
  });
});

describe('describeState', () => {
  it('扫描 / 翻译中显示「正在翻译…」', () => {
    expect(describeState(makeState({ state: 'SCANNING' }))).toBe('正在翻译…');
    expect(describeState(makeState({ state: 'TRANSLATING' }))).toBe('正在翻译…');
  });

  it('没有可翻译内容时明确说明', () => {
    const state = makeState();
    state.stats.total = 0;
    state.stats.translated = 0;

    expect(describeState(state)).toBe('未找到可翻译的内容');
  });

  it('全部失败时给出失败段数', () => {
    const state = makeState();
    state.stats.translated = 0;
    state.stats.failed = 3;

    expect(describeState(state)).toBe('翻译失败：3 段未成功');
  });

  it('正常情况显示进度', () => {
    expect(describeState(makeState())).toBe('已翻译 10/10 段');
  });

  it('有部分失败时补充失败数', () => {
    const state = makeState();
    state.stats.failed = 2;

    expect(describeState(state)).toBe('已翻译 10/10 段（失败 2）');
  });

  it('恢复原文后说明译文仍在缓存里', () => {
    const state = makeState({ state: 'RESTORED' });

    expect(describeState(state)).toBe('已恢复原文，10 段译文已缓存');
  });

  it('恢复原文且有失败时两者都说明', () => {
    const state = makeState({ state: 'RESTORED' });
    state.stats.failed = 1;

    expect(describeState(state)).toBe('已恢复原文，10 段译文已缓存（失败 1）');
  });
});

describe('失败原因（2026-10-02 补）', () => {
  it('全部失败时把原因说清楚——只报段数等于什么都没说', () => {
    const state = makeState({ failureReason: '服务端返回 401' });
    state.stats.translated = 0;
    state.stats.failed = 3;

    expect(describeState(state)).toBe('翻译失败：3 段未成功：服务端返回 401');
  });

  it('部分失败时也带上原因', () => {
    const state = makeState({ failureReason: 'HTTP 502' });
    state.stats.failed = 2;

    expect(describeState(state)).toBe('已翻译 10/10 段（失败 2）：HTTP 502');
  });

  it('恢复原文后同样带原因', () => {
    const state = makeState({ state: 'RESTORED', failureReason: 'HTTP 502' });
    state.stats.failed = 1;

    expect(describeState(state)).toBe('已恢复原文，10 段译文已缓存（失败 1）：HTTP 502');
  });

  it('没有原因时不硬凑——老页面的 content script 不带这个字段', () => {
    const state = makeState();
    state.stats.failed = 2;

    expect(describeState(state)).toBe('已翻译 10/10 段（失败 2）');
  });

  it('没有失败时不显示原因（哪怕字段里残留着上一次的）', () => {
    expect(describeState(makeState({ failureReason: '陈年旧事' }))).toBe('已翻译 10/10 段');
  });

  it('浏览器的网络错误换成人话 + 下一步', () => {
    expect(summarizeFailure('TypeError: Failed to fetch')).toBe(
      '连不上本地服务，确认它已启动（设置页可测试连接）',
    );
  });

  it('服务端的详情原样保留，太长才截断', () => {
    expect(summarizeFailure('服务端未配置 LLM_API_KEY')).toBe('服务端未配置 LLM_API_KEY');
    expect(summarizeFailure('x'.repeat(200))).toBe(`${'x'.repeat(59)}…`);
  });

  it('空值 / 空白 / 换行都收拾干净', () => {
    expect(summarizeFailure(null)).toBeNull();
    expect(summarizeFailure(undefined)).toBeNull();
    expect(summarizeFailure('   ')).toBeNull();
    expect(summarizeFailure('第一行\n第二行')).toBe('第一行 第二行');
  });
});
