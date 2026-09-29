/**
 * 正文 HTML 净化（方案第 62 节）。
 *
 * Readability 的输出来自**任意网页**，属于不可信输入。渲染前必须净化。
 *
 * ## 为什么不用 innerHTML
 *
 * 铁律 2 禁止 `innerHTML`。而「先净化再 innerHTML」会留下一条危险的捷径——
 * 下次有人加功能时，很容易顺手再塞一段未净化的 HTML 进去。
 *
 * 这里的做法是：`DOMParser` 解析到**独立文档**，净化后把节点**移动**过来。
 * 全程不碰 `innerHTML`，从机制上堵死这条路。
 *
 * ## 净化规则
 *
 * 1. **删掉危险标签**：脚本、样式、框架、表单控件、媒体元素
 * 2. **删掉事件属性**：`on*` 一律移除（否则一个 `onerror` 就能执行任意代码）
 * 3. **删掉危险协议**：`javascript:` / `data:` 的 URL 属性
 * 4. **删掉 `style` 属性**：页面样式会干扰阅读视图的排版
 */

/** 整体删除的标签。 */
const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'OBJECT',
  'EMBED',
  'APPLET',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'AUDIO',
  'VIDEO',
  'SOURCE',
  'TRACK',
  'CANVAS',
]);

/** 需要检查协议的 URL 属性。 */
const URL_ATTRIBUTES: readonly string[] = [
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'xlink:href',
  'data',
];

/** 允许保留的协议前缀。相对路径与锚点直接放行。 */
const SAFE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

function isDangerousUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();

  // 相对路径、锚点、协议相对 URL —— 没有协议可劫持
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return false;
  }

  if (!trimmed.includes(':')) {
    return false;
  }

  return !SAFE_PROTOCOLS.some((protocol) => trimmed.startsWith(protocol));
}

function scrubElement(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();

    // 事件处理器：一个 onerror 就够执行任意代码
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (name === 'style') {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (URL_ATTRIBUTES.includes(name) && isDangerousUrl(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }
}

/**
 * 净化正文 HTML，返回**独立文档**里的根元素。
 *
 * 调用方用 `document.adoptNode()` 把它的子节点移到阅读视图容器里——
 * 不要用 `innerHTML`。
 */
export function sanitizeArticle(html: string): Element | null {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const root = parsed.body;

  if (root === null) {
    return null;
  }

  // 先收集再删除：边遍历边改会漏掉节点
  for (const element of [...root.querySelectorAll('*')]) {
    if (FORBIDDEN_TAGS.has(element.tagName)) {
      element.remove();
      continue;
    }
    scrubElement(element);
  }

  return root;
}

/**
 * 把净化后的节点搬进目标容器。
 *
 * 用 `adoptNode` **移动**而不是复制 HTML 字符串——这是不使用 `innerHTML`
 * 的关键一步。返回搬入的节点数。
 */
export function mountArticle(root: Element, container: Element): number {
  const document = container.ownerDocument;
  let mounted = 0;

  for (const child of [...root.childNodes]) {
    // 注释节点没有渲染价值，且可能是条件注释的残留
    if (child.nodeType === 8) {
      continue;
    }

    container.append(document.adoptNode(child));
    mounted += 1;
  }

  return mounted;
}
