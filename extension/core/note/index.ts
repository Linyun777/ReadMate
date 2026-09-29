/**
 * 学习笔记（方案第 32 节）。
 *
 * 与 `core/summary` 的分工：总结是压缩（读完知道大概），
 * 笔记是重组（日后能捡起来）。两者共用导出机制，内容形态各自定义。
 */

export {
  buildNoteMarkdown,
  downloadNote,
  type NoteExport,
  suggestNoteFilename,
} from './export-markdown';
