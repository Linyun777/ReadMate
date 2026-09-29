/**
 * 解释浮层（方案第 41 节）。
 *
 * 选中文字 → 右键 → 解释，结果就地显示在选区附近。
 *
 * ## 与铁律 3 的关系
 *
 * 浮层是**追加**一个节点，不是重建页面结构——和双语渲染追加译文节点是同一类操作，
 * 因此不违反铁律 3。
 *
 * 节点带 `data-ai-translator="true"`，因此：
 *   - `MutationObserver` 会忽略它（方案第 13.2 节），不会触发重新分段
 *   - 与插件其他插入节点保持一致的识别方式
 *
 * ## 为什么不用 innerHTML
 *
 * 解释文本来自模型，属于**不可信输入**（铁律 2）。全部走 `textContent` 写入。
 */

import { PLUGIN_NODE_ATTR } from '@/shared/constants';

export const EXPLAIN_OVERLAY_ID = 'ai-web-translator-explain';

export interface ExplainOverlayOptions {
  document?: Document;
  /** 面板最大宽度（像素） */
  maxWidth?: number;
}

const DEFAULT_MAX_WIDTH = 360;

/**
 * 浮层主题。
 *
 * 用内联样式而不是外部样式表：浮层注入到**任意网页**里，
 * 那些页面没有我们的 CSS 变量。所以这里只能自己判断深浅色。
 */
interface OverlayTheme {
  surface: string;
  text: string;
  muted: string;
  border: string;
  shadow: string;
  codeBg: string;
}

const LIGHT_THEME: OverlayTheme = {
  surface: '#ffffff',
  text: '#18181b',
  muted: '#71717a',
  border: '#e4e4e7',
  shadow: '0 8px 28px rgb(0 0 0 / 12%)',
  codeBg: '#f4f4f5',
};

const DARK_THEME: OverlayTheme = {
  surface: '#18181b',
  text: '#fafafa',
  muted: '#a1a1aa',
  border: '#3f3f46',
  shadow: '0 8px 28px rgb(0 0 0 / 60%)',
  codeBg: '#27272a',
};

function currentTheme(document: Document): OverlayTheme {
  try {
    return document.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches === true
      ? DARK_THEME
      : LIGHT_THEME;
  } catch {
    return LIGHT_THEME;
  }
}

/** 是否要求减少动态效果。前庭功能障碍用户会因为位移动画不适。 */
function prefersReducedMotion(document: Document): boolean {
  try {
    return document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** 与选区之间的间距 */
const GAP = 8;

/** 视口边距，避免贴边 */
const MARGIN = 12;

export class ExplainOverlay {
  readonly #document: Document;
  readonly #maxWidth: number;

  #root: HTMLElement | null = null;
  #body: HTMLElement | null = null;
  #keyHandler: ((event: KeyboardEvent) => void) | null = null;
  #pointerHandler: ((event: MouseEvent) => void) | null = null;

  constructor(options: ExplainOverlayOptions = {}) {
    this.#document = options.document ?? globalThis.document;
    this.#maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  }

  get visible(): boolean {
    return this.#root !== null;
  }

  /** 打开面板并显示「解释中」。`anchor` 是选区的视口坐标。 */
  open(anchor: DOMRect): void {
    this.close();
    this.#build();

    const root = this.#root;
    if (root === null) {
      return;
    }

    this.#render('解释中…', 'loading');
    this.#position(anchor);

    this.#installDismissHandlers();
  }

  /** 填入解释结果。 */
  fill(text: string): void {
    this.#render(text, 'ready');
  }

  /**
   * 显示结构化的总结（主旨 + 要点 + 导出按钮）。
   *
   * 与解释共用同一个浮层：定位、关闭方式、插件节点标记全都一样，
   * 差别只在内容形态——解释是一段话，总结是一个主旨加一列要点。
   *
   * 全部走 `textContent` —— 总结来自模型，属于不可信输入（铁律 2）。
   */
  showSummary(summary: { gist: string; points: readonly string[] }, onExport: () => void): void {
    const body = this.#body;
    if (body === null) {
      return;
    }

    body.replaceChildren();
    body.style.color = 'inherit';

    const gist = this.#document.createElement('p');
    Object.assign(gist.style, { margin: '0 0 10px', fontWeight: '500' });
    gist.textContent = summary.gist;
    body.append(gist);

    if (summary.points.length > 0) {
      const list = this.#document.createElement('ul');
      Object.assign(list.style, {
        margin: '0 0 12px',
        paddingLeft: '18px',
        color: currentTheme(this.#document).muted,
      });

      for (const point of summary.points) {
        const item = this.#document.createElement('li');
        item.style.marginBottom = '4px';
        item.textContent = point;
        list.append(item);
      }

      body.append(list);
    }

    const exportButton = this.#document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = '导出 Markdown';
    exportButton.id = 'ai-web-translator-export';
    const theme = currentTheme(this.#document);
    Object.assign(exportButton.style, {
      border: `1px solid ${theme.border}`,
      borderRadius: '8px',
      background: 'transparent',
      color: theme.text,
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '12px',
      padding: '5px 11px',
    });
    exportButton.addEventListener('click', () => {
      onExport();
    });

    body.append(exportButton);
  }

  /** 显示一行提示（如导出成功）。 */
  note(text: string): void {
    const body = this.#body;
    if (body === null) {
      return;
    }

    const hint = this.#document.createElement('p');
    Object.assign(hint.style, {
      margin: '10px 0 0',
      fontSize: '12px',
      color: currentTheme(this.#document).muted,
    });
    hint.textContent = text;
    body.append(hint);
  }

  /** 显示失败原因。 */
  fail(reason: string): void {
    this.#render(`解释失败：${reason}`, 'error');
  }

  /** 关闭并移除面板。 */
  close(): void {
    this.#removeDismissHandlers();

    this.#root?.remove();
    this.#root = null;
    this.#body = null;
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  #build(): void {
    const root = this.#document.createElement('div');
    root.id = EXPLAIN_OVERLAY_ID;
    // 与插件其他插入节点保持一致的识别方式：
    // MutationObserver 据此忽略它，不会触发重新分段
    root.setAttribute(PLUGIN_NODE_ATTR, 'true');

    const theme = currentTheme(this.#document);

    Object.assign(root.style, {
      position: 'fixed',
      zIndex: '2147483647',
      maxWidth: `${this.#maxWidth}px`,
      padding: '14px 16px',
      border: `1px solid ${theme.border}`,
      borderRadius: '12px',
      background: theme.surface,
      color: theme.text,
      boxShadow: theme.shadow,
      font: '14px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    });

    // 进入动画：淡入 + 轻微上移。位移很小——这是浮层，不是弹窗。
    // 尊重 reduced-motion：直接显示，不做位移。
    if (!prefersReducedMotion(this.#document)) {
      root.style.opacity = '0';
      root.style.transform = 'translateY(-4px)';
      root.style.transition =
        'opacity 160ms ease-out, transform 160ms cubic-bezier(0.16, 1, 0.3, 1)';

      requestAnimationFrame(() => {
        root.style.opacity = '1';
        root.style.transform = 'translateY(0)';
      });
    }

    const header = this.#document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '8px',
      fontSize: '11px',
      fontWeight: '600',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: theme.muted,
    });

    const title = this.#document.createElement('span');
    title.textContent = 'AI 解释';

    const spacer = this.#document.createElement('span');
    spacer.style.flex = '1';

    const closeButton = this.#document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '关闭';
    Object.assign(closeButton.style, {
      border: 'none',
      background: 'transparent',
      color: theme.muted,
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '12px',
      padding: '0 2px',
    });
    closeButton.addEventListener('click', () => {
      this.close();
    });

    header.append(title, spacer, closeButton);

    const body = this.#document.createElement('div');
    this.#body = body;

    root.append(header, body);
    this.#document.body.append(root);

    this.#root = root;
  }

  /** 全部走 textContent —— 解释文本是不可信输入（铁律 2）。 */
  #render(text: string, kind: 'loading' | 'ready' | 'error'): void {
    if (this.#body === null) {
      return;
    }

    this.#body.textContent = text;
    this.#body.style.color =
      kind === 'error' ? '#a33a2c' : kind === 'loading' ? '#6b6b6b' : 'inherit';
  }

  /** 定位到选区附近，并保证不超出视口。 */
  #position(anchor: DOMRect): void {
    const root = this.#root;
    if (root === null) {
      return;
    }

    // 先放到左上角量尺寸，再按尺寸修正位置
    root.style.left = '0px';
    root.style.top = '0px';

    const rect = root.getBoundingClientRect();
    const viewportWidth = this.#document.documentElement.clientWidth;
    const viewportHeight = this.#document.documentElement.clientHeight;

    let left = anchor.left;
    if (left + rect.width > viewportWidth - MARGIN) {
      left = Math.max(MARGIN, viewportWidth - rect.width - MARGIN);
    }

    let top = anchor.bottom + GAP;
    if (top + rect.height > viewportHeight - MARGIN) {
      // 下方放不下就翻到选区上方
      top = Math.max(MARGIN, anchor.top - rect.height - GAP);
    }

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  #installDismissHandlers(): void {
    this.#keyHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.close();
      }
    };

    this.#pointerHandler = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && this.#root?.contains(target) === true) {
        return;
      }
      this.close();
    };

    this.#document.addEventListener('keydown', this.#keyHandler, true);
    // 用捕获阶段：即使页面 stopPropagation 也能收到
    this.#document.addEventListener('mousedown', this.#pointerHandler, true);
  }

  #removeDismissHandlers(): void {
    if (this.#keyHandler !== null) {
      this.#document.removeEventListener('keydown', this.#keyHandler, true);
      this.#keyHandler = null;
    }
    if (this.#pointerHandler !== null) {
      this.#document.removeEventListener('mousedown', this.#pointerHandler, true);
      this.#pointerHandler = null;
    }
  }
}
