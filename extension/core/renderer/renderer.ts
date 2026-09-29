/**
 * Renderer：译文 → DOM（方案第 86.2 节）。
 *
 * 铁律约束：
 *   - **结构校验失败绝不渲染**（第 5 条）
 *   - 禁用 `innerHTML`，一律 `textContent` / `createTextNode`（第 2 条）
 *   - 不重建网页 DOM 结构：容器与 inline 元素对象**复用**，只改其内容（第 3 条）
 *   - 所有翻译必须可恢复原文（第 4 条）
 *
 * 渲染策略：
 *
 * | 模式 | blockType | 做法 |
 * | --- | --- | --- |
 * | 双语 | heading / paragraph / list | 原文不动，之后追加同级 `<div data-ai-translator>` |
 * | 双语 | table | 单元格内追加 `<span data-ai-translator>` |
 * | 双语 | inline | 与中文模式相同（inline 不渲染双语） |
 * | 中文 | 全部 | 按**译文 token 顺序**重建容器的受管内容 |
 *
 * 「按译文顺序重建」是硬要求：实测确认模型会为符合目标语言语序而重排占位符
 * （实测：占位符保留率 100%，见 `server/scripts/check_placeholder_retention.py`）。
 */

import { validatePlaceholders } from '@/core/segmenter';
import { PLUGIN_NODE_ATTR } from '@/shared/constants';
import type { DisplayMode, PlaceholderBinding, TranslationBlock } from '@/shared/types';

import { flattenTranslation, parseTranslation, type RenderToken } from './tokens';

export type RenderResult = { ok: true } | { ok: false; reason: string };

interface BlockRenderRecord {
  container: Element;
  /** 是否改写了容器内容（中文模式与 inline 双语为 true） */
  replaced: boolean;
  /** 容器的原始直接子节点，保持对象身份，恢复时原样挂回 */
  originalChildren: Node[];
  /** 占位符元素的原始子节点 */
  originalElementChildren: Map<Element, Node[]>;
  /** 双语模式插入的节点 */
  insertedNodes: Node[];
}

interface Cursor {
  position: number;
}

function indexPlaceholders(
  placeholders: readonly PlaceholderBinding[],
): Map<number, PlaceholderBinding> {
  return new Map(placeholders.map((binding) => [binding.index, binding]));
}

/**
 * 按 token 顺序构建节点序列（递归下降）。
 *
 * - 文本 token → 新建 TextNode
 * - 成对 token → **复用原元素**，递归填充其内容
 * - 原子 token → 复用原节点（元素或 CSS 换行对应的 TextNode）
 */
function buildNodes(
  tokens: readonly RenderToken[],
  cursor: Cursor,
  stopIndex: number | null,
  byIndex: ReadonlyMap<number, PlaceholderBinding>,
  document: Document,
): Node[] {
  const nodes: Node[] = [];

  while (cursor.position < tokens.length) {
    const token = tokens[cursor.position];
    if (token === undefined) {
      break;
    }

    if (token.kind === 'close') {
      cursor.position += 1;
      if (token.index === stopIndex) {
        return nodes;
      }
      // 校验已保证配对正确，这里的多余闭合标签只是防御性跳过
      continue;
    }

    cursor.position += 1;

    if (token.kind === 'text') {
      nodes.push(document.createTextNode(token.value));
      continue;
    }

    if (token.kind === 'atom') {
      const binding = byIndex.get(token.index);
      if (binding?.node) {
        nodes.push(binding.node);
      }
      continue;
    }

    const element = byIndex.get(token.index)?.element;
    if (!element) {
      continue;
    }

    const inner = buildNodes(tokens, cursor, token.index, byIndex, document);
    element.replaceChildren(...inner);
    nodes.push(element);
  }

  return nodes;
}

/** 收集容器的「受管节点」：直接文本节点 + 占位符元素。 */
function collectTrackedNodes(record: BlockRenderRecord): Set<Node> {
  const tracked = new Set<Node>();

  for (const node of record.originalChildren) {
    if (node.nodeType === Node.TEXT_NODE) {
      tracked.add(node);
    }
  }
  for (const element of record.originalElementChildren.keys()) {
    tracked.add(element);
  }

  return tracked;
}

export class Renderer {
  readonly #records = new Map<string, BlockRenderRecord>();

  get renderedCount(): number {
    return this.#records.size;
  }

  isRendered(blockId: string): boolean {
    return this.#records.has(blockId);
  }

  /**
   * 当前已渲染的 Block ID。
   *
   * 供动态内容处理使用：重新分段前需要先把范围内的已渲染 Block 恢复原文，
   * 否则在中文模式下会读到**译文**并把它当成原文再翻一遍。
   */
  renderedIds(): string[] {
    return [...this.#records.keys()];
  }

  /**
   * 渲染一个 Block。
   *
   * 幂等：同一 Block 重复渲染会先恢复再重绘。
   * 结构校验失败时**不触碰 DOM**，直接返回失败原因。
   */
  render(block: TranslationBlock, translation: string, mode: DisplayMode): RenderResult {
    const validation = validatePlaceholders(translation, block.placeholders);
    if (!validation.ok) {
      return { ok: false, reason: validation.reason };
    }

    this.restore(block.id);

    const container = block.element;
    const record: BlockRenderRecord = {
      container,
      replaced: false,
      originalChildren: Array.from(container.childNodes),
      originalElementChildren: new Map(),
      insertedNodes: [],
    };

    for (const binding of block.placeholders) {
      if (binding.kind === 'pair' && binding.element) {
        record.originalElementChildren.set(binding.element, Array.from(binding.element.childNodes));
      }
    }

    const tokens = parseTranslation(translation);
    const bilingual = mode === 'bilingual' && block.blockType !== 'inline';

    if (bilingual) {
      this.#renderBilingual(block, tokens, record);
    } else {
      this.#renderReplace(block, tokens, record);
    }

    this.#records.set(block.id, record);
    return { ok: true };
  }

  /** 中文模式（及 inline 的双语）：按译文顺序重建容器的受管内容。 */
  #renderReplace(
    block: TranslationBlock,
    tokens: readonly RenderToken[],
    record: BlockRenderRecord,
  ): void {
    const container = record.container;
    const byIndex = indexPlaceholders(block.placeholders);
    const nodes = buildNodes(tokens, { position: 0 }, null, byIndex, container.ownerDocument);

    const tracked = collectTrackedNodes(record);
    const firstTracked = record.originalChildren.find((node) => tracked.has(node));

    const fragment = container.ownerDocument.createDocumentFragment();
    fragment.append(...nodes);

    // 新内容放在第一个受管节点原来的位置——这样块级后代（不在受管集合内）保持不动
    if (firstTracked?.parentNode === container) {
      container.replaceChild(fragment, firstTracked);
    } else {
      container.append(fragment);
    }

    // 清掉其余受管节点；已被复用到新位置的节点不动
    const placed = new Set<Node>(nodes);
    for (const node of tracked) {
      if (node === firstTracked || placed.has(node)) {
        continue;
      }
      if (node.parentNode === container) {
        container.removeChild(node);
      }
    }

    record.replaced = true;
  }

  /** 双语模式：原文不动，追加译文节点。 */
  #renderBilingual(
    block: TranslationBlock,
    tokens: readonly RenderToken[],
    record: BlockRenderRecord,
  ): void {
    const document = record.container.ownerDocument;
    const isTableCell = block.blockType === 'table';

    const holder = document.createElement(isTableCell ? 'span' : 'div');
    holder.setAttribute(PLUGIN_NODE_ATTR, 'true');
    // 双语译文只放纯文本：不在译文里复制 inline 结构，避免页面出现两份链接/强调标记
    holder.textContent = flattenTranslation(tokens);

    if (isTableCell) {
      // 方案第 86.2 节：table 在单元格内追加 span
      record.container.append(holder);
    } else {
      // 方案第 86.2 节：其余在原文之后追加同级 div
      record.container.after(holder);
    }

    record.insertedNodes.push(holder);
  }

  /** 恢复单个 Block 的原文。返回是否确实恢复了内容。 */
  restore(blockId: string): boolean {
    const record = this.#records.get(blockId);
    if (!record) {
      return false;
    }

    // 先还原占位符元素的内容（元素对象复用，所以改回去即可）
    for (const [element, children] of record.originalElementChildren) {
      element.replaceChildren(...children);
    }

    for (const node of record.insertedNodes) {
      node.parentNode?.removeChild(node);
    }

    if (record.replaced) {
      record.container.replaceChildren(...record.originalChildren);
    }

    this.#records.delete(blockId);
    return true;
  }

  /** 恢复全部。返回恢复的 Block 数。 */
  restoreAll(): number {
    const ids = [...this.#records.keys()];
    for (const id of ids) {
      this.restore(id);
    }
    return ids.length;
  }

  clear(): void {
    this.#records.clear();
  }
}

/**
 * 直接移除页面上所有插件插入的节点（方案第 86.2 节的 O(1) 恢复路径）。
 *
 * ⚠️ 只适用于**双语模式**——中文模式是就地改写文本，没有记录就无法还原，
 * 必须走 `Renderer.restoreAll()`。
 *
 * 用途：content script 被重新注入时清理上一次留下的双语节点。
 */
export function stripInsertedNodes(root: ParentNode = globalThis.document): number {
  const nodes = root.querySelectorAll(`[${PLUGIN_NODE_ATTR}="true"]`);
  for (const node of nodes) {
    node.parentNode?.removeChild(node);
  }
  return nodes.length;
}
