import { describe, expect, it } from 'vitest';

import type { WireNoteResponse } from '@/shared/types';

import { buildNoteMarkdown, type NoteExport, suggestNoteFilename } from './export-markdown';

/**
 * 笔记导出（方案第 32 节）。
 *
 * 与总结导出的差别不只是字段：**笔记要保留层级**。
 * 所以这里断言的重点是「结构有没有被保留」，不是逐字文本。
 */

function makeNote(overrides: Partial<WireNoteResponse> = {}): WireNoteResponse {
  return {
    positioning: '一份关于流式渲染的工程笔记。',
    concepts: [
      { term: 'Streaming', explanation: '逐段产出结果，而不是等整批完成。' },
      { term: 'Partial failure', explanation: '中途出错时得到部分结果加一个错误。' },
    ],
    outline: [
      { heading: '渲染时机', points: ['每段一到就渲染', '不必等整批'] },
      { heading: '失败表现', points: ['部分成功是常态'] },
    ],
    takeaways: ['失败不再是全有或全无。'],
    model: 'deepseek-flash',
    prompt_version: 'v1',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<NoteExport> = {}): NoteExport {
  return {
    note: makeNote(),
    source: 'Streaming lets each paragraph render as soon as it arrives.',
    url: 'https://example.com/article',
    title: 'Why Streaming Matters',
    exportedAt: '2026-09-27T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildNoteMarkdown', () => {
  it('标题取自页面标题', () => {
    expect(buildNoteMarkdown(makeEntry())).toContain('# Why Streaming Matters');
  });

  it('定位作为引用块', () => {
    expect(buildNoteMarkdown(makeEntry())).toContain('> 一份关于流式渲染的工程笔记。');
  });

  it('⭐ 概念渲染成「术语 —— 解释」，保留键值关系', () => {
    const markdown = buildNoteMarkdown(makeEntry());

    expect(markdown).toContain('## 核心概念');
    expect(markdown).toContain('- **Streaming** —— 逐段产出结果，而不是等整批完成。');
    expect(markdown).toContain('- **Partial failure** —— 中途出错时得到部分结果加一个错误。');
  });

  it('⭐ 大纲保留分节，不压成一列', () => {
    const markdown = buildNoteMarkdown(makeEntry());

    expect(markdown).toContain('## 渲染时机');
    expect(markdown).toContain('- 每段一到就渲染');
    expect(markdown).toContain('## 失败表现');
    expect(markdown).toContain('- 部分成功是常态');
  });

  it('结论单独成节', () => {
    const markdown = buildNoteMarkdown(makeEntry());

    expect(markdown).toContain('## 结论');
    expect(markdown).toContain('- 失败不再是全有或全无。');
  });

  it('⭐ 带上原文——笔记脱离原文之后价值会打折', () => {
    const markdown = buildNoteMarkdown(makeEntry());

    expect(markdown).toContain('## 原文');
    expect(markdown).toContain('Streaming lets each paragraph render');
  });

  it('元信息包含来源 / 模型 / 时间', () => {
    const markdown = buildNoteMarkdown(makeEntry());

    expect(markdown).toContain('https://example.com/article');
    expect(markdown).toContain('deepseek-flash');
    expect(markdown).toContain('2026-09-27T12:00:00.000Z');
  });

  it('空的概念 / 结论不产生空小节', () => {
    const markdown = buildNoteMarkdown(
      makeEntry({ note: makeNote({ concepts: [], takeaways: [] }) }),
    );

    expect(markdown).not.toContain('## 核心概念');
    expect(markdown).not.toContain('## 结论');
    // 大纲仍在
    expect(markdown).toContain('## 渲染时机');
  });

  it('没有标题时用兜底标题', () => {
    expect(buildNoteMarkdown(makeEntry({ title: '' }))).toContain('# 学习笔记');
  });

  it('原文两端空白被去掉', () => {
    expect(buildNoteMarkdown(makeEntry({ source: '  正文  ' }))).toContain('\n正文\n');
  });
});

describe('suggestNoteFilename', () => {
  it('以日期开头，便于按时间排序', () => {
    expect(suggestNoteFilename(makeEntry())).toBe('2026-09-27-Why Streaming Matters');
  });

  it('替换文件名里的非法字符', () => {
    const name = suggestNoteFilename(makeEntry({ title: 'a/b:c*d?e"f<g>h|i' }));

    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('只有非法字符时用兜底名', () => {
    expect(suggestNoteFilename(makeEntry({ title: '///' }))).toBe('2026-09-27-note');
  });
});
