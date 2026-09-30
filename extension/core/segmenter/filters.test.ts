import { beforeEach, describe, expect, it } from 'vitest';

import {
  hasIgnoredAncestor,
  isEditable,
  isHidden,
  isIgnoredElement,
  isInteractiveControl,
  isTooShort,
  looksLikeTargetLanguage,
  shouldSkipElement,
  shouldTranslateText,
} from './filters';

describe('isTooShort — 脚本感知的长度规则', () => {
  it('拉丁文本少于 2 个字符视为过短', () => {
    expect(isTooShort('a')).toBe(true);
    expect(isTooShort(' a ')).toBe(true);
  });

  it('拉丁文本 2 个及以上字符不算过短', () => {
    expect(isTooShort('ab')).toBe(false);
    expect(isTooShort('AI')).toBe(false);
  });

  it('表意文字单字即可承载语义，不应被判为过短', () => {
    expect(isTooShort('情報')).toBe(false);
    expect(isTooShort('ニ')).toBe(false);
    expect(isTooShort('한')).toBe(false);
  });
});

describe('shouldTranslateText — 忽略特殊文本（方案第 9.4 节）', () => {
  const zh = 'zh-CN';

  it('空白', () => {
    expect(shouldTranslateText('   ', zh)).toBe(false);
    expect(shouldTranslateText('', zh)).toBe(false);
  });

  it('纯数字与数字符号', () => {
    expect(shouldTranslateText('2026', zh)).toBe(false);
    expect(shouldTranslateText('1,234.56', zh)).toBe(false);
    expect(shouldTranslateText('50%', zh)).toBe(false);
    expect(shouldTranslateText('2024-2026', zh)).toBe(false);
  });

  it('URL 与邮箱', () => {
    expect(shouldTranslateText('https://openai.com', zh)).toBe(false);
    expect(shouldTranslateText('www.example.com', zh)).toBe(false);
    expect(shouldTranslateText('hello@example.com', zh)).toBe(false);
  });

  it('单个符号与 Emoji', () => {
    expect(shouldTranslateText('→', zh)).toBe(false);
    expect(shouldTranslateText('+', zh)).toBe(false);
    expect(shouldTranslateText('🎉', zh)).toBe(false);
  });

  it('正常英文文本应翻译', () => {
    expect(shouldTranslateText('Hello world', zh)).toBe(true);
    expect(shouldTranslateText('AI engineering is changing software development.', zh)).toBe(true);
  });

  it('混合段落里若只剩数字 / URL / 符号，则跳过', () => {
    expect(shouldTranslateText('2026 https://example.com hello@example.com 42 → +', zh)).toBe(
      false,
    );
    expect(shouldTranslateText('1,234.56 — 2024-2026', zh)).toBe(false);
  });

  it('混合段落里只要还有可翻译内容就保留', () => {
    expect(shouldTranslateText('Hello → world', zh)).toBe(true);
    expect(shouldTranslateText('© 2026 Example Inc. All rights reserved.', zh)).toBe(true);
  });

  it('已是目标语言的文本应跳过', () => {
    expect(shouldTranslateText('这是一段中文', zh)).toBe(false);
  });

  it('表意文字短文本不应被过短规则误杀（参考研究建议 8）', () => {
    expect(shouldTranslateText('ニュース', zh)).toBe(true);
  });

  it('目标语言为英文时不启用中文检测', () => {
    expect(looksLikeTargetLanguage('这是一段中文', 'en')).toBe(false);
  });
});

describe('isHidden — 不可见元素', () => {
  it('hidden 属性', () => {
    const element = document.createElement('p');
    element.setAttribute('hidden', '');
    expect(isHidden(element)).toBe(true);
  });

  it('aria-hidden', () => {
    const element = document.createElement('p');
    element.setAttribute('aria-hidden', 'true');
    expect(isHidden(element)).toBe(true);
  });

  it('display:none（来自样式表）', () => {
    const style = document.createElement('style');
    style.textContent = '.is-hidden { display: none; }';
    document.head.append(style);

    const element = document.createElement('p');
    element.className = 'is-hidden';
    document.body.append(element);

    expect(isHidden(element)).toBe(true);
  });

  it('普通元素不隐藏', () => {
    expect(isHidden(document.createElement('p'))).toBe(false);
  });
});

describe('isEditable — 可编辑字段（参考研究建议 8）', () => {
  it('contenteditable', () => {
    const element = document.createElement('div');
    element.setAttribute('contenteditable', '');
    expect(isEditable(element)).toBe(true);
  });

  it('contenteditable="false" 不算可编辑', () => {
    const element = document.createElement('div');
    element.setAttribute('contenteditable', 'false');
    expect(isEditable(element)).toBe(false);
  });

  it('普通元素不可编辑', () => {
    expect(isEditable(document.createElement('p'))).toBe(false);
  });
});

describe('标签大小写 — SVG 命名空间', () => {
  /**
   * SVG 元素的 `tagName` 是**小写**（`style` / `svg` / `path`），
   * HTML 元素才是大写。忽略表存的是大写，不归一化就会让
   * `<svg><style>` 整棵子树漏过过滤——真实后果是 mermaid 图表的
   * CSS（几千字符）被当成正文送去翻译。
   */

  function makeSvgStyle(): Element {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = '#mermaid-x{font-family:inherit;fill:#333;}';
    svg.appendChild(style);
    document.body.appendChild(svg);
    return style;
  }

  it('svg 内的 style 标签名确实是小写（这就是漏过的原因）', () => {
    expect(makeSvgStyle().tagName).toBe('style');
  });

  it('svg 内的 style 应被整棵跳过', () => {
    const style = makeSvgStyle();
    expect(shouldSkipElement(style)).toBe(true);
    expect(hasIgnoredAncestor(style)).toBe(true);
  });

  it('HTML 的 STYLE 仍然被跳过（大写路径没被破坏）', () => {
    const style = document.createElement('style');
    style.textContent = 'p{color:red}';
    document.body.appendChild(style);
    expect(shouldSkipElement(style)).toBe(true);
  });
});

describe('isInteractiveControl / isIgnoredElement — 交互控件（2026-09-30）', () => {
  /** 取元素，取不到就失败——比 `!` 更容易在报错里看出问题。 */
  function requireElement(selector: string): Element {
    const element = document.querySelector(selector);
    if (element === null) {
      throw new Error(`未找到 ${selector}`);
    }
    return element;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('<button> 属于忽略元素', () => {
    expect(isIgnoredElement(document.createElement('button'))).toBe(true);
  });

  it('role="button" 的自定义控件属于忽略元素', () => {
    const element = document.createElement('div');
    element.setAttribute('role', 'button');

    expect(isInteractiveControl(element)).toBe(true);
    expect(isIgnoredElement(element)).toBe(true);
  });

  it('role 判定容忍大小写与首尾空白', () => {
    const element = document.createElement('div');
    element.setAttribute('role', '  Tab  ');

    expect(isInteractiveControl(element)).toBe(true);
  });

  it('正文元素与链接不受影响（role="link" 属于正文）', () => {
    const paragraph = document.createElement('p');
    const anchor = document.createElement('a');
    anchor.setAttribute('role', 'link');
    const nav = document.createElement('nav');

    expect(isIgnoredElement(paragraph)).toBe(false);
    expect(isIgnoredElement(anchor)).toBe(false);
    // 导航里的正文仍要翻译（方案第 65 节的「导航块优先」依赖这一点）
    expect(isIgnoredElement(nav)).toBe(false);
  });

  it('hasIgnoredAncestor 沿路径生效：按钮内部的文本被忽略', () => {
    document.body.innerHTML =
      '<div id="host"><p id="p">Copy <button id="btn" type="button">here</button></p></div>';

    expect(hasIgnoredAncestor(requireElement('#btn'))).toBe(true);
    // stopAt 指定为容器时，容器自身不参与判定
    const paragraph = requireElement('#p');
    expect(hasIgnoredAncestor(paragraph, paragraph)).toBe(false);
  });

  it('shouldSkipElement 对交互控件返回 true', () => {
    const button = document.createElement('button');
    const custom = document.createElement('div');
    custom.setAttribute('role', 'switch');

    expect(shouldSkipElement(button)).toBe(true);
    expect(shouldSkipElement(custom)).toBe(true);
  });
});
