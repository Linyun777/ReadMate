/**
 * 学习笔记导出为 Markdown（方案第 32 节）。
 *
 * 与总结导出的区别不只是字段：**笔记的目标是「日后能捡起来」**，
 * 所以结构要保留层级（概念是键值对、大纲有分节），而不是压成一列要点。
 */

import { downloadTextFile, sanitizeFilename } from '@/core/export';
import type { WireNoteResponse } from '@/shared/types';

export interface NoteExport {
  note: WireNoteResponse;
  /** 被做笔记的原文 */
  source: string;
  /** 来源页面地址 */
  url: string;
  /** 页面标题 */
  title: string;
  /** 导出时间（ISO） */
  exportedAt: string;
}

/**
 * 组装 Markdown。
 *
 * 刻意带上**原文与来源**：笔记脱离原文之后价值会打折——
 * 过一段时间回看，需要知道它记的是什么、从哪来。
 */
export function buildNoteMarkdown(entry: NoteExport): string {
  const { note } = entry;
  const lines: string[] = [];

  lines.push(`# ${entry.title || '学习笔记'}`);
  lines.push('');
  lines.push(`> ${note.positioning}`);
  lines.push('');

  if (note.concepts.length > 0) {
    lines.push('## 核心概念');
    lines.push('');
    for (const concept of note.concepts) {
      lines.push(`- **${concept.term}** —— ${concept.explanation}`);
    }
    lines.push('');
  }

  for (const section of note.outline) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    for (const point of section.points) {
      lines.push(`- ${point}`);
    }
    lines.push('');
  }

  if (note.takeaways.length > 0) {
    lines.push('## 结论');
    lines.push('');
    for (const takeaway of note.takeaways) {
      lines.push(`- ${takeaway}`);
    }
    lines.push('');
  }

  lines.push('## 原文');
  lines.push('');
  lines.push(entry.source.trim());
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`- 来源：${entry.url}`);
  lines.push(`- 模型：${note.model}`);
  lines.push(`- 导出时间：${entry.exportedAt}`);

  return lines.join('\n');
}

/** 建议的文件名（不含扩展名）。以日期开头，便于按时间排序。 */
export function suggestNoteFilename(entry: NoteExport): string {
  const stamp = entry.exportedAt.slice(0, 10);
  return `${stamp}-${sanitizeFilename(entry.title, 'note')}`;
}

/** 触发下载，返回实际文件名。 */
export function downloadNote(entry: NoteExport, document: Document): string {
  return downloadTextFile(`${suggestNoteFilename(entry)}.md`, buildNoteMarkdown(entry), document);
}
