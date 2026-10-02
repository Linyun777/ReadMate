/**
 * 控制面板的共享逻辑（方案第 83 节：V2 的 Side Panel）。
 *
 * Popup 与 Side Panel 的功能高度重叠——都是「看当前页面状态 + 发命令」。
 * 把逻辑抽出来有两个好处：
 *
 *   1. **不会走形**。两份各自演化的话，迟早出现「Popup 修了、侧边栏没修」。
 *      Phase 16 的 `get_llm_client` 刚踩过同一个坑。
 *   2. **可测**。entrypoint 里的 DOM 接线测不到，这里的纯逻辑能单测。
 */

import { sendToBackground } from '@/core/messaging/client';
import { createMessage } from '@/core/messaging/protocol';
import type {
  ContentScriptState,
  DisplayMode,
  GetPageStateMessage,
  RestorePageMessage,
  SetDisplayModeMessage,
  TranslatePageMessage,
} from '@/shared/types';

/** 一次面板操作的结果。 */
export interface PanelResult {
  ok: boolean;
  /** 成功时的页面状态 */
  state?: ContentScriptState;
  /** 失败原因（已转成可直接展示的文案） */
  error?: string;
}

function toResult(
  response: { ok: boolean; data?: ContentScriptState; error?: string },
  fallbackError: string,
): PanelResult {
  if (response.ok && response.data !== undefined) {
    return { ok: true, state: response.data };
  }

  return { ok: false, error: response.error ?? fallbackError };
}

/** 查当前页面的翻译状态。 */
export async function queryPageState(): Promise<PanelResult> {
  const response = await sendToBackground<ContentScriptState>(
    createMessage<GetPageStateMessage>({ type: 'GET_PAGE_STATE' }),
  );

  return toResult(response, '当前页面尚未注入翻译脚本');
}

/** 命令当前页面开始翻译。 */
export async function requestTranslate(): Promise<PanelResult> {
  const response = await sendToBackground<ContentScriptState>(
    createMessage<TranslatePageMessage>({ type: 'TRANSLATE_PAGE' }),
  );

  return toResult(response, '翻译失败');
}

/** 命令当前页面恢复原文。 */
export async function requestRestore(): Promise<PanelResult> {
  const response = await sendToBackground<ContentScriptState>(
    createMessage<RestorePageMessage>({ type: 'RESTORE_PAGE' }),
  );

  return toResult(response, '恢复原文失败');
}

/** 切换当前页面的显示模式。 */
export async function requestSetMode(mode: DisplayMode): Promise<PanelResult> {
  const response = await sendToBackground<ContentScriptState>(
    createMessage<SetDisplayModeMessage>({ type: 'SET_DISPLAY_MODE', mode }),
  );

  return toResult(response, '切换显示模式失败');
}

/* ------------------------------------------------------------------ *
 * 展示逻辑
 * ------------------------------------------------------------------ */

/** 把 radio 的 value 收窄成 `DisplayMode`，避免用类型断言。 */
export function toDisplayMode(value: string): DisplayMode | null {
  return value === 'original' || value === 'bilingual' || value === 'chinese' ? value : null;
}

/**
 * 页面是否处于「正在忙」的状态——此时翻译按钮应当禁用。
 *
 * 用户要停下来不用找「取消」按钮：**切到「原文」模式即停止**。
 * 「我不想看译文了」和「别翻了」本来就是同一件事，多一个状态按钮
 * 反而让界面和心智都变复杂（试过，退回）。
 */
export function isBusy(state: ContentScriptState): boolean {
  return state.state === 'SCANNING' || state.state === 'TRANSLATING';
}

/** 页面是否已有译文（决定「恢复原文」是否可用）。 */
export function hasTranslation(state: ContentScriptState): boolean {
  return state.stats.translated > 0;
}

/**
 * 失败原因太长就截断——状态栏是一行，塞不下 FastAPI 的整段校验报错。
 *
 * 60 个字符够放「连不上本地服务」这类人话，也够看出服务端 detail 的要点。
 */
const MAX_FAILURE_REASON_CHARS = 60;

/**
 * 这些原因**原样没法看**，换成人话（`core/translator/server-client.ts` 的
 * 网络错误就是浏览器给的那句 `TypeError: Failed to fetch`）。
 *
 * 换成什么样：说清「是什么 + 下一步做什么」。用户遇到的第一次失败几乎都是
 * 「服务没启动」——给一句「确认它已启动」比任何错误码都有用。
 */
const FAILURE_REWRITES: readonly [RegExp, string][] = [
  [/failed to fetch|networkerror|load failed/i, '连不上本地服务，确认它已启动（设置页可测试连接）'],
];

/** 一条失败原因的人话版本；空值一律返回 null。 */
export function summarizeFailure(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) {
    return null;
  }

  const trimmed = reason.replace(/\s+/g, ' ').trim();
  if (trimmed === '') {
    return null;
  }

  for (const [pattern, rewrite] of FAILURE_REWRITES) {
    if (pattern.test(trimmed)) {
      return rewrite;
    }
  }

  return trimmed.length > MAX_FAILURE_REASON_CHARS
    ? `${trimmed.slice(0, MAX_FAILURE_REASON_CHARS - 1)}…`
    : trimmed;
}

/**
 * 把页面状态翻译成一句人话。
 *
 * 同一段文案两个面板共用——状态描述不一致会让人以为功能不一样。
 *
 * 失败时要带上**原因**（2026-10-02）：只报「失败 3 段」等于什么都没说，
 * 用户既不知道是服务没起来、Key 不对，还是被限流。原因来自
 * `ContentScriptState.failureReason`（由队列记录的 `markFailed` 一路传上来）。
 */
export function describeState(state: ContentScriptState): string {
  const { stats, state: pageState } = state;

  if (pageState === 'SCANNING' || pageState === 'TRANSLATING') {
    return '正在翻译…';
  }
  if (stats.total === 0) {
    return '未找到可翻译的内容';
  }

  const reason = stats.failed > 0 ? summarizeFailure(state.failureReason) : null;
  const reasonNote = reason === null ? '' : `：${reason}`;

  if (stats.translated === 0 && stats.failed > 0) {
    return `翻译失败：${stats.failed} 段未成功${reasonNote}`;
  }

  const failure = stats.failed > 0 ? `（失败 ${stats.failed}）` : '';

  if (pageState === 'RESTORED') {
    return `已恢复原文，${stats.translated} 段译文已缓存${failure}${reasonNote}`;
  }

  // 剩余的是**等待滚动**，不是失败——viewport-first 只翻视口附近的内容。
  // 不写清楚的话，「已翻译 25/244 段」看起来像有 219 段挂了。
  const pending = stats.total - stats.translated - stats.failed;
  const pendingNote = pending > 0 ? '，其余滚动时自动翻译' : '';

  return `已翻译 ${stats.translated}/${stats.total} 段${failure}${reasonNote}${pendingNote}`;
}
