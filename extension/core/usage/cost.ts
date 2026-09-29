/**
 * 用量与成本估算（成本可见性）。
 *
 * ## 分工
 *
 * 服务端的 `/api/v1/usage` **只报 token，不报金额**。金额在这里算——
 * 因为 token 是事实，价格是外部输入且会变。把价格写进服务端 API，
 * 等于「官方一调价，API 就开始说谎」。
 *
 * ## 单价的来源
 *
 * 用户在设置页自己填。**不预设默认价**——预设一个过时的数字比不显示更糟：
 * 用户会以为那是真的。
 */

import type { ExtensionSettings, WireUsageResponse } from '@/shared/types';

/** 估算结果。`cost` 为 `null` 表示没设单价，算不出来。 */
export interface CostEstimate {
  cost: number | null;
  /** 单位：元 */
  currency: 'CNY';
}

/** 两个单价都为 0（或非法）时视为「未设置」。 */
export function hasPricing(
  settings: Pick<ExtensionSettings, 'inputPricePerMillion' | 'outputPricePerMillion'>,
): boolean {
  return settings.inputPricePerMillion > 0 || settings.outputPricePerMillion > 0;
}

/**
 * 按单价估算成本（元）。
 *
 * 单价为 0 的那一边不计费——这样用户可以只填一边
 * （比如某些 Provider 只对输出计费）。
 */
export function estimateCost(
  usage: Pick<WireUsageResponse, 'prompt_tokens' | 'completion_tokens'>,
  settings: Pick<ExtensionSettings, 'inputPricePerMillion' | 'outputPricePerMillion'>,
): CostEstimate {
  if (!hasPricing(settings)) {
    return { cost: null, currency: 'CNY' };
  }

  const cost =
    (usage.prompt_tokens / 1_000_000) * settings.inputPricePerMillion +
    (usage.completion_tokens / 1_000_000) * settings.outputPricePerMillion;

  return { cost, currency: 'CNY' };
}

/** 金额格式化。小额用更多小数位，否则会显示成 0.00。 */
export function formatCost(cost: number): string {
  if (cost === 0) {
    return '0 元';
  }
  if (cost < 0.01) {
    // 小额下两位小数会全变成 0.00，看不出差别
    return `${cost.toFixed(4)} 元`;
  }
  if (cost < 1) {
    return `${cost.toFixed(3)} 元`;
  }

  return `${cost.toFixed(2)} 元`;
}

/** token 数格式化，带千分位。 */
export function formatTokens(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** 把 ISO 时间转成 `2026-09-27 20:05` 这种可读形式。 */
export function formatTimestamp(iso: string | null): string {
  if (iso === null || iso.trim() === '') {
    return '—';
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  const pad = (value: number): string => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
