/**
 * 译文 token 化（方案第 86.1 节）。
 *
 * 把含占位符的译文解析成 token 流，供 Renderer 重建 DOM。
 *
 * **为什么必须按 token 顺序重建**：实测确认模型会为符合目标语言语序而重排占位符
 * （实测保留率 100%）。因此不能「按索引把译文硬塞回原位」，
 * 只能按译文的 token 顺序重新组装容器的子节点。
 */

export type RenderToken =
  | { kind: 'text'; value: string }
  | { kind: 'open'; index: number }
  | { kind: 'close'; index: number }
  | { kind: 'atom'; index: number };

/** 匹配 `<0>` / `<0/>` / `</0>` */
const TOKEN_PATTERN = /<(\d+)(\/?)>|<\/(\d+)>/g;

/**
 * 解析译文。
 *
 * 与占位符校验用的是同一套词法，因此校验通过的译文一定能被正确解析。
 */
export function parseTranslation(translation: string): RenderToken[] {
  const tokens: RenderToken[] = [];
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');

  let cursor = 0;
  let match = pattern.exec(translation);

  while (match !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'text', value: translation.slice(cursor, match.index) });
    }

    const openIndex = match[1] !== undefined ? Number(match[1]) : undefined;
    const selfClosing = match[2] === '/';
    const closeIndex = match[3] !== undefined ? Number(match[3]) : undefined;

    if (closeIndex !== undefined) {
      tokens.push({ kind: 'close', index: closeIndex });
    } else if (openIndex !== undefined) {
      tokens.push(
        selfClosing ? { kind: 'atom', index: openIndex } : { kind: 'open', index: openIndex },
      );
    }

    cursor = match.index + match[0].length;
    match = pattern.exec(translation);
  }

  if (cursor < translation.length) {
    tokens.push({ kind: 'text', value: translation.slice(cursor) });
  }

  return tokens;
}

/**
 * 压平成纯文本。
 *
 * 双语模式把译文追加为同级节点时使用——**不在译文里复制 inline 元素结构**，
 * 避免页面出现两份链接/强调标记。原文那一份已经承载了这些语义。
 */
export function flattenTranslation(tokens: readonly RenderToken[]): string {
  let text = '';

  for (const token of tokens) {
    if (token.kind === 'text') {
      text += token.value;
    }
  }

  return text.trim();
}
