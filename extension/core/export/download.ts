/**
 * 通用文件下载（方案第 32 节）。
 *
 * ## 为什么不用 `chrome.downloads`
 *
 * 那需要 `downloads` 权限（用户会看到"管理下载"的权限提示），
 * 而 Blob + `<a download>` 不需要任何权限就能触发下载。
 * 为一个导出功能多要一条权限不划算。
 *
 * ## 为什么单独抽出来
 *
 * 总结与笔记都要导出 Markdown，但**内容形态完全不同**
 * （总结是主旨 + 要点，笔记是概念 + 大纲 + 结论）。
 * 所以只共用「怎么把一段文本存成文件」，各自组装自己的 Markdown。
 */

/** 文件名里不能出现的字符。 */
const UNSAFE_FILENAME = /[\\/:*?"<>|]/g;

/** 把任意标题转成安全的文件名片段。 */
export function sanitizeFilename(name: string, fallback = 'export'): string {
  const cleaned = name.replace(UNSAFE_FILENAME, '_').slice(0, 80).trim();

  // 全是非法字符时 `cleaned` 会只剩分隔线，用兜底名更清楚
  return cleaned.replace(/^[_-]+$/, '') || fallback;
}

/**
 * 触发浏览器下载。
 *
 * 返回实际使用的文件名，便于调用方给出反馈。
 */
export function downloadTextFile(
  filename: string,
  content: string,
  document: Document,
  mimeType = 'text/markdown;charset=utf-8',
): string {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // 不挂到页面上也能触发下载，但部分浏览器要求节点在文档里
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();

  // 立刻回收会让下载拿不到内容（部分浏览器），延后释放
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);

  return filename;
}
