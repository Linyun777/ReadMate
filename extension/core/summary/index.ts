/**
 * 总结（方案第 32 节）。
 *
 * 第一层（通用）：选中任意文字 → 右键 → 「总结选中的内容」。
 * 第二层（站点增强，待做）：适配器声明可总结单元，如「总结这条推文」。
 */

export {
  buildSummaryMarkdown,
  downloadMarkdown,
  type SummaryExport,
  suggestFilename,
} from './export-markdown';
