/**
 * 导出（方案第 32 节）。
 *
 * 只提供「把一段文本存成文件」这件通用的事；Markdown 的组装各功能自己做
 * ——总结与笔记的内容形态完全不同，硬套一个模板只会两边都别扭。
 */

export { downloadTextFile, sanitizeFilename } from './download';
