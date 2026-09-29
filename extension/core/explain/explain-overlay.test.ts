import { beforeEach, describe, expect, it } from 'vitest';

import { PLUGIN_NODE_ATTR } from '@/shared/constants';

import { EXPLAIN_OVERLAY_ID, ExplainOverlay } from './explain-overlay';

/**
 * 解释浮层（方案第 41 节）。
 *
 * 关键约束有两条，各有一组用例守着：
 *   1. 面板必须带 `data-ai-translator`，否则 MutationObserver 会把它当成
 *      页面新内容反复处理（方案第 13.2 节）
 *   2. 解释文本来自模型，属于不可信输入——**只能走 textContent**（铁律 2）
 */

function makeRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    top: 100,
    bottom: 120,
    left: 40,
    right: 200,
    width: 160,
    height: 20,
    x: 40,
    y: 100,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${EXPLAIN_OVERLAY_ID}`);
}

/**
 * 设定视口尺寸。
 *
 * jsdom 没有布局引擎，`clientWidth` / `clientHeight` 恒为 0——
 * 不显式打桩的话，浮层会认为「视口高度为 0」而永远走「翻到上方」分支。
 */
function stubViewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: height,
    configurable: true,
  });
}

const overlays: ExplainOverlay[] = [];

function makeOverlay(): ExplainOverlay {
  const overlay = new ExplainOverlay({ document });
  overlays.push(overlay);
  return overlay;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.style.width = '';
  document.documentElement.style.height = '';
  overlays.length = 0;
});

describe('ExplainOverlay — 显示与内容', () => {
  it('open 后出现面板', () => {
    const overlay = makeOverlay();

    overlay.open(makeRect());

    expect(overlay.visible).toBe(true);
    expect(panel()).not.toBeNull();
  });

  it('面板带 data-ai-translator 标记（方案第 13.2 节）', () => {
    makeOverlay().open(makeRect());

    expect(panel()?.getAttribute(PLUGIN_NODE_ATTR)).toBe('true');
  });

  it('初始显示「解释中」', () => {
    makeOverlay().open(makeRect());

    expect(panel()?.textContent).toContain('解释中');
  });

  it('fill 写入解释文本', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    overlay.fill('这里的 high-agency 指主动推进能力。');

    expect(panel()?.textContent).toContain('high-agency');
  });

  it('fail 显示失败原因', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    overlay.fail('无法连接本地服务');

    expect(panel()?.textContent).toContain('无法连接本地服务');
  });

  it('解释文本按纯文本处理，HTML 不会被解析（铁律 2）', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    overlay.fill('<img src=x onerror="alert(1)">');

    const root = panel();
    // 尖括号原样显示，没有真的生成 img 节点
    expect(root?.textContent).toContain('<img');
    expect(root?.querySelector('img')).toBeNull();
  });

  it('close 移除面板', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    overlay.close();

    expect(overlay.visible).toBe(false);
    expect(panel()).toBeNull();
  });

  it('重复 open 只保留一个面板', () => {
    const overlay = makeOverlay();

    overlay.open(makeRect());
    overlay.open(makeRect());

    expect(document.querySelectorAll(`#${EXPLAIN_OVERLAY_ID}`)).toHaveLength(1);
  });

  it('close 后再 fill 不抛错', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());
    overlay.close();

    expect(() => {
      overlay.fill('x');
    }).not.toThrow();
  });
});

describe('ExplainOverlay — 关闭方式', () => {
  it('Esc 关闭', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(overlay.visible).toBe(false);
  });

  it('点击面板外部关闭', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(overlay.visible).toBe(false);
  });

  it('点击面板内部不关闭', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    panel()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(overlay.visible).toBe(true);
  });

  it('关闭后不再响应 Esc', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());
    overlay.close();

    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }).not.toThrow();
  });

  it('关闭按钮可关闭面板', () => {
    const overlay = makeOverlay();
    overlay.open(makeRect());

    const button = panel()?.querySelector('button');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(overlay.visible).toBe(false);
  });
});

describe('ExplainOverlay — 定位', () => {
  it('默认落在选区下方', () => {
    stubViewport(1000, 800);

    makeOverlay().open(makeRect({ top: 100, bottom: 120, left: 40 }));

    const style = panel()?.style;
    expect(style?.top).toBe('128px');
    expect(style?.left).toBe('40px');
  });

  it('下方空间不足时翻到选区上方', () => {
    stubViewport(1000, 200);

    makeOverlay().open(makeRect({ top: 180, bottom: 200 }));

    const top = Number.parseInt(panel()?.style.top ?? '0', 10);
    expect(top).toBeLessThan(180);
  });

  it('右侧空间不足时向左收，不超出视口', () => {
    stubViewport(300, 800);

    makeOverlay().open(makeRect({ left: 280, right: 300, width: 20 }));

    const left = Number.parseInt(panel()?.style.left ?? '0', 10);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left).toBeLessThanOrEqual(288);
  });
});
