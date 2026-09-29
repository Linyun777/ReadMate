/**
 * 正文提取（方案第 62 节）。
 *
 * 普通网页里塞满了导航、登录、推荐、广告、Footer、按钮、版权文字。
 * Readability 把这些剥掉，只留文章主体。
 *
 * ## 为什么必须做成独立阅读视图
 *
 * Readability 的输出是**重新生成的 HTML 字符串**，这与铁律 3
 * 「不重建网页 DOM 结构」直接冲突。
 *
 * 解决办法是**不让它碰原页面**：
 *
 * ```text
 * document.cloneNode(true)   ← 在克隆上跑
 *   ↓ Readability
 * 提取正文 HTML
 *   ↓
 * 渲染到独立的阅读视图页
 * ```
 *
 * 原页面一个节点都不动，铁律不受影响（方案第 62 节：
 * 「更推荐把 Reader Mode 做成独立阅读视图，而不是强行映射回原页面全部 DOM」）。
 *
 * ## 许可证
 *
 * `@mozilla/readability` 是 Apache-2.0。声明见仓库根目录的 `NOTICE`。
 */

import { Readability } from '@mozilla/readability';

export interface ExtractedArticle {
  /** 文章标题。Readability 找不到时回落为文档标题 */
  title: string;
  /** 正文 HTML（由 Readability 重新生成，**不是**原页面的 DOM） */
  content: string;
  /** 正文纯文本。总结要用它——HTML 标签对模型是噪声 */
  text: string;
  /** 原文地址，供阅读视图回跳 */
  url: string;
  /** 纯文本字符数，用于判断「这到底是不是一篇文章」 */
  textLength: number;
}

export interface ExtractOptions {
  /**
   * 最低正文字符数。低于此值认为不是文章。
   *
   * 默认 500——短页面（登录页、列表页、错误页）进阅读模式没有意义。
   */
  minTextLength?: number;
}

export const DEFAULT_MIN_TEXT_LENGTH = 500;

/** 从 HTML 里取纯文本，不构造 DOM。 */
function measurePlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 提取文章主体。
 *
 * **绝不修改传入的 document**——内部在克隆上跑 Readability。
 * 提取失败或内容过短时返回 `null`（调用方据此提示用户）。
 */
export function extractArticle(
  document: Document,
  options: ExtractOptions = {},
): ExtractedArticle | null {
  const minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;

  let parsed: { title?: string | null; content?: string | null; textContent?: string | null };

  try {
    // 关键：克隆。Readability 会就地修改传入的文档，
    // 直接给它真实 document 会破坏页面（违反铁律 3）
    const clone = document.cloneNode(true) as Document;
    const article = new Readability(clone).parse();

    if (article === null) {
      return null;
    }
    parsed = article;
  } catch {
    // Readability 对畸形 DOM 会抛错——那只是「这篇文章提不出来」，不是异常情况
    return null;
  }

  const content = parsed.content ?? '';
  if (content.trim() === '') {
    return null;
  }

  const plain = (parsed.textContent ?? '').trim() || measurePlainText(content);
  const textLength = plain.length;
  if (textLength < minTextLength) {
    return null;
  }

  return {
    title: (parsed.title ?? '').trim() || document.title.trim() || '未命名文章',
    content,
    text: plain,
    url: document.location?.href ?? '',
    textLength,
  };
}
