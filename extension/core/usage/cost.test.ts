import { describe, expect, it } from 'vitest';

import { estimateCost, formatCost, formatTimestamp, formatTokens, hasPricing } from './cost';

/**
 * 成本估算（成本可见性）。
 *
 * 这一层的存在理由是：**服务端只报 token，不报金额**。
 * token 是事实，价格是外部输入且会变——把价格写进服务端 API，
 * 等于「官方一调价，API 就开始说谎」。
 */

const USAGE = { prompt_tokens: 13_317, completion_tokens: 9_566 };

describe('hasPricing', () => {
  it('两边都为 0 时视为未设单价', () => {
    expect(hasPricing({ inputPricePerMillion: 0, outputPricePerMillion: 0 })).toBe(false);
  });

  it('只填一边也算设了', () => {
    expect(hasPricing({ inputPricePerMillion: 1, outputPricePerMillion: 0 })).toBe(true);
    expect(hasPricing({ inputPricePerMillion: 0, outputPricePerMillion: 4 })).toBe(true);
  });
});

describe('estimateCost', () => {
  it('未设单价时返回 null，而不是 0', () => {
    // 返回 0 会让人以为「花了 0 元」，而实际是「算不出来」
    const estimate = estimateCost(USAGE, {
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
    });

    expect(estimate.cost).toBeNull();
  });

  it('按输入 / 输出分别计价', () => {
    const estimate = estimateCost(USAGE, {
      inputPricePerMillion: 1,
      outputPricePerMillion: 4,
    });

    // 13317/1e6*1 + 9566/1e6*4 = 0.013317 + 0.038264
    expect(estimate.cost).toBeCloseTo(0.051581, 6);
  });

  it('只填输出价时输入不计费', () => {
    const estimate = estimateCost(USAGE, {
      inputPricePerMillion: 0,
      outputPricePerMillion: 4,
    });

    expect(estimate.cost).toBeCloseTo(0.038264, 6);
  });

  it('零用量算出 0（而不是 null）', () => {
    const estimate = estimateCost(
      { prompt_tokens: 0, completion_tokens: 0 },
      { inputPricePerMillion: 1, outputPricePerMillion: 4 },
    );

    expect(estimate.cost).toBe(0);
  });

  it('货币单位是元', () => {
    expect(
      estimateCost(USAGE, { inputPricePerMillion: 1, outputPricePerMillion: 1 }).currency,
    ).toBe('CNY');
  });
});

describe('formatCost', () => {
  it('小额用四位小数，否则会全显示成 0.00', () => {
    expect(formatCost(0.000123)).toBe('0.0001 元');
  });

  it('中额用三位小数', () => {
    expect(formatCost(0.0516)).toBe('0.052 元');
  });

  it('一元以上用两位小数', () => {
    expect(formatCost(12.3456)).toBe('12.35 元');
  });

  it('零单独处理', () => {
    expect(formatCost(0)).toBe('0 元');
  });
});

describe('formatTokens', () => {
  it('带千分位', () => {
    expect(formatTokens(22883)).toBe('22,883');
  });

  it('小数字不加分隔', () => {
    expect(formatTokens(42)).toBe('42');
  });
});

describe('formatTimestamp', () => {
  it('转成可读形式', () => {
    // 用本地时区构造，避免测试依赖运行环境的时区
    const local = new Date(2026, 8, 27, 20, 5, 0).toISOString();

    expect(formatTimestamp(local)).toBe('2026-09-27 20:05');
  });

  it('null 显示为占位符', () => {
    expect(formatTimestamp(null)).toBe('—');
  });

  it('空串显示为占位符', () => {
    expect(formatTimestamp('   ')).toBe('—');
  });

  it('非法时间显示为占位符，而不是 Invalid Date', () => {
    expect(formatTimestamp('not-a-date')).toBe('—');
  });
});
