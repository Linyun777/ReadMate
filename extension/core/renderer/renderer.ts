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
  /**
   * 本块的**原文节点**，保持对象身份，恢复时原样挂回。
   *
   * - 未拆段：容器的原始直接子节点（历史行为）
   * - 拆段：本段那一段子节点
   */
  originalChildren: Node[];
  /**
   * 本块**消费**掉的容器直接子节点（文本节点 + 占位符节点），按文档顺序。
   *
   * 与 `originalChildren` 的区别：未拆段时容器里还可能有块级后代
   * （属于别的 Block），它们不在受管集合里，渲染时不能动。
   */
  managedNodes: Node[];
  /**
   * 受管节点之后、第一个**不属于本块**的兄弟节点。
   *
   * 渲染时先记下来，恢复时把原文插回这个位置，而不是落到容器末尾。
   * ⚠️ 它可能被**后面那段**的渲染移除，所以恢复前必须再确认一次。
   */
  refNode: Node | null;
  /** 译文替换进去的节点（中文模式与 inline 双语） */
  replacedNodes: Node[];
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

/**
 * 本块消费的容器直接子节点，按文档顺序。
 *
 * 未拆段时不能直接用 `originalChildren`——里面还混着块级后代
 * （属于别的 Block），动它们会破坏别人的渲染。
 */
function orderedManagedNodes(
  container: Element,
  block: TranslationBlock,
  tracked: ReadonlySet<Node>,
): Node[] {
  const managed = new Set(tracked);
  for (const binding of block.placeholders) {
    if (binding.kind === 'pair' && binding.element) {
      managed.add(binding.element);
    }
    if (binding.kind === 'atom' && binding.node) {
      managed.add(binding.node);
    }
  }

  return Array.from(container.childNodes).filter((node) => managed.has(node));
}

/** 受管节点之后、第一个不属于本块的兄弟节点。见 `refNode` 的说明。 */
function nextUnmanagedSibling(container: Element, managed: readonly Node[]): Node | null {
  const first = managed[0];
  if (first === undefined) {
    return null;
  }

  const managedSet = new Set(managed);
  const children: Node[] = Array.from(container.childNodes);

  for (let index = children.indexOf(first) + 1; index < children.length; index += 1) {
    const node = children[index];
    if (node !== undefined && !managedSet.has(node)) {
      return node;
    }
  }

  return null;
}

/**
 * 本块插进去的节点在容器里形成的连续段之后的下一个节点。
 *
 * 兜底用：`refNode` 被后面那段渲染移除时，用「自己内容的末尾」重新定位。
 */
function nextSiblingAfterRun(container: Element, nodes: readonly Node[]): Node | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node !== undefined && node.parentNode === container) {
      return node.nextSibling;
    }
  }
  return null;
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
    const range = block.range;
    const record: BlockRenderRecord = {
      container,
      replaced: false,
      // 拆段时只认本段那一截；其余段归别的 Block
      originalElementChildren: new Map(),
      managedNodes: [],
      refNode: null,
      replacedNodes: [],
      insertedNodes: [],
      originalChildren:
        range === undefined ? Array.from(container.childNodes) : Array.from(range.nodes),
    };

    for (const binding of block.placeholders) {
      if (binding.kind === 'pair' && binding.element) {
        record.originalElementChildren.set(binding.element, Array.from(binding.element.childNodes));
      }
    }

    record.managedNodes =
      range === undefined
        ? orderedManagedNodes(container, block, collectTrackedNodes(record))
        : Array.from(range.nodes);
    record.refNode = nextUnmanagedSibling(container, record.managedNodes);

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

    const fragment = container.ownerDocument.createDocumentFragment();
    fragment.append(...nodes);

    // 摘掉本块自己管的原文节点。被复用的元素（占位符）已经随 fragment 搬走，
    // 这里不会重复摘；块级后代不在受管集合内，原样不动。
    for (const node of record.managedNodes) {
      if (node.parentNode === container) {
        container.removeChild(node);
      }
    }

    // 插回原位置——`refNode` 是被后面那段渲染移除时才退回兜底定位
    const ref =
      record.refNode?.parentNode === container
        ? record.refNode
        : nextSiblingAfterRun(container, nodes);

    if (ref !== null) {
      container.insertBefore(fragment, ref);
    } else {
      container.append(fragment);
    }

    record.replacedNodes = nodes;
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
    } else if (block.range !== undefined) {
      // 拆段：译文跟在**本段原文之后**（在容器内）。这样各段的先后与原文一致，
      // 与流式到达顺序无关——追加在容器之后的话，先到的段会排在后面。
      const last = record.managedNodes[record.managedNodes.length - 1];
      if (last !== undefined && last.parentNode === record.container) {
        record.container.insertBefore(holder, last.nextSibling);
      } else {
        record.container.append(holder);
      }
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
      const { container } = record;

      // 先把原文节点收进 fragment——它们要么已经脱离文档，要么正被复用在
      // 译文里；两种情况的**对象身份都没变**，挂回去就是原文
      const fragment = container.ownerDocument.createDocumentFragment();
      fragment.append(...record.originalChildren);

      // 位置：优先用渲染时记下的参考节点；它被后面那段渲染移除时，
      // 退回「自己内容的末尾」。两者都没有（本块没产出任何节点）才追加到末尾。
      const ref =
        record.refNode?.parentNode === container
          ? record.refNode
          : nextSiblingAfterRun(container, record.replacedNodes);

      if (ref !== null) {
        container.insertBefore(fragment, ref);
      } else {
        container.append(fragment);
      }

      // 摘掉「本块新建的」节点。占位符元素是**原文对象被复用**的，
      // 它们同时出现在 originalChildren 与 replacedNodes 里——
      // 不加这个判断会把刚恢复好的 inline 结构又删掉。
      const originals = new Set(record.originalChildren);
      for (const node of record.replacedNodes) {
        if (!originals.has(node) && node.parentNode === container) {
          container.removeChild(node);
        }
      }
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

  /**
   * 恢复某个范围内已渲染的 Block，返回恢复的数量。
   *
   * 与「用 `PageStore` 反查容器再恢复」的区别：**不看 store**。
   * 重新分段之后条目可能已经被换掉或被对账删掉，而渲染记录还在——
   * 孤儿记录里的译文节点会留在页面上，新译文一到就成了
   * 「同一段被翻了两遍」。记录本来就归渲染器管，范围判定直接用它。
   */
  restoreWithin(root: Element): number {
    let count = 0;

    for (const blockId of [...this.#records.keys()]) {
      const record = this.#records.get(blockId);
      if (record === undefined) {
        continue;
      }

      const { container } = record;
      if (container !== root && !root.contains(container)) {
        continue;
      }

      if (this.restore(blockId)) {
        count += 1;
      }
    }

    return count;
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
