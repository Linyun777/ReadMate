import { describe, expect, it } from 'vitest';

import { buildSummaryMarkdown, type SummaryExport, suggestFilename } from './export-markdown';

/**
 * 总结导出（方案第 32 节）。
 *
 * Markdown 是最终产物，格式错了在笔记软件里很难看——所以断言的是
 * **结构**（有几个标题、原文在不在、元信息全不全），不是逐字文本。
 */

function makeEntry(overrides: Partial<SummaryExport> = {}): SummaryExport {
  return {
    gist: '流式渲染让每段一到就显示，失败时表现为部分结果加错误。',
    points: ['每段一到就渲染', '失败是部分成功', '重试只发未拿到的'],
    source: 'Streaming lets each paragraph render as soon as it arrives.',
    url: 'https://example.com/article',
    title: 'Why Streaming Matters',
    model: 'deepseek-flash',
    exportedAt: '2026-09-27T11:00:00.000Z',
    ...overrides,
  };
}

describe('buildSummaryMarkdown', () => {
  it('标题取自页面标题', () => {
    expect(buildSummaryMarkdown(makeEntry())).toContain('# Why Streaming Matters');
  });

  it('主旨作为引用块', () => {
    expect(buildSummaryMarkdown(makeEntry())).toContain('> 流式渲染让每段一到就显示');
  });

  it('要点渲染成列表', () => {
    const markdown = buildSummaryMarkdown(makeEntry());

    expect(markdown).toContain('## 要点');
    expect(markdown).toContain('- 每段一到就渲染');
    expect(markdown).toContain('- 重试只发未拿到的');
  });

  it('⭐ 带上原文——总结脱离原文之后价值会打折', () => {
    const markdown = buildSummaryMarkdown(makeEntry());

    expect(markdown).toContain('## 原文');
    expect(markdown).toContain('Streaming lets each paragraph render');
  });

  it('元信息包含来源 / 模型 / 时间', () => {
    const markdown = buildSummaryMarkdown(makeEntry());

    expect(markdown).toContain('https://example.com/article');
    expect(markdown).toContain('deepseek-flash');
    expect(markdown).toContain('2026-09-27T11:00:00.000Z');
  });

  it('没有要点时不产生空的小节', () => {
    const markdown = buildSummaryMarkdown(makeEntry({ points: [] }));

    expect(markdown).not.toContain('## 要点');
    expect(markdown).toContain('## 原文');
  });

  it('没有标题时用兜底标题', () => {
    expect(buildSummaryMarkdown(makeEntry({ title: '' }))).toContain('# 页面总结');
  });

  it('原文两端空白被去掉', () => {
    const markdown = buildSummaryMarkdown(makeEntry({ source: '  正文  ' }));

    expect(markdown).toContain('\n正文\n');
  });
});

describe('suggestFilename', () => {
  it('以日期开头，便于按时间排序', () => {
    expect(suggestFilename(makeEntry())).toBe('2026-09-27-Why Streaming Matters');
  });

  it('替换文件名里的非法字符', () => {
    const name = suggestFilename(makeEntry({ title: 'a/b:c*d?e"f<g>h|i' }));

    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toContain('a_b_c_d_e_f_g_h_i');
  });

  it('标题为空时用兜底名', () => {
    expect(suggestFilename(makeEntry({ title: '' }))).toContain('summary');
  });

  it('过长的标题被截断', () => {
    const name = suggestFilename(makeEntry({ title: 'x'.repeat(300) }));

    expect(name.length).toBeLessThan(120);
  });

  it('只有非法字符时用兜底名，而不是一串下划线', () => {
    const name = suggestFilename(makeEntry({ title: '///' }));

    // 一串下划线当文件名没有信息量，兜底名更有用
    expect(name).toBe('2026-09-27-summary');
  });
});
