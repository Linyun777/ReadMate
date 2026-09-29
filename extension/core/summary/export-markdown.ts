import { downloadTextFile, sanitizeFilename } from '@/core/export';

/**
 * 总结导出为 Markdown（方案第 32 节）。
 *
 * 只负责**组装 Markdown**；「怎么把文本存成文件」在 `core/export` 里，
 * 与学习笔记共用。
 *
 * 总结的结构刻意扁平（一句话主旨 + 一列要点）——它的目标是「读完就知道大概」。
 * 需要层级的是笔记，见 `core/note`。
 */

export interface SummaryExport {
  /** 一句话主旨 */
  gist: string;
  /** 关键点 */
  points: readonly string[];
  /** 被总结的原文 */
  source: string;
  /** 来源页面地址 */
  url: string;
  /** 页面标题 */
  title: string;
  /** 使用的模型，便于日后回溯"这段总结是谁写的" */
  model: string;
  /** 导出时间（ISO） */
  exportedAt: string;
}

/**
 * 组装 Markdown。
 *
 * 刻意带上**原文与来源**：总结脱离原文之后价值会打折——
 * 过一段时间回看，需要知道它总结的是什么、从哪来。
 */
export function buildSummaryMarkdown(entry: SummaryExport): string {
  const lines: string[] = [];

  lines.push(`# ${entry.title || '页面总结'}`);
  lines.push('');
  lines.push(`> ${entry.gist}`);
  lines.push('');

  if (entry.points.length > 0) {
    lines.push('## 要点');
    lines.push('');
    for (const point of entry.points) {
      lines.push(`- ${point}`);
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
  lines.push(`- 模型：${entry.model}`);
  lines.push(`- 导出时间：${entry.exportedAt}`);

  return lines.join('\n');
}

/** 建议的文件名（不含扩展名）。 */
export function suggestFilename(entry: SummaryExport): string {
  const stamp = entry.exportedAt.slice(0, 10);
  return `${stamp}-${sanitizeFilename(entry.title, 'summary')}`;
}

/**
 * 触发浏览器下载。
 *
 * 返回实际使用的文件名，便于调用方给出反馈。
 */
export function downloadMarkdown(entry: SummaryExport, document: Document): string {
  return downloadTextFile(`${suggestFilename(entry)}.md`, buildSummaryMarkdown(entry), document);
}
