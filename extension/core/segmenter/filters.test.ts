import { describe, expect, it } from 'vitest';

import {
  isEditable,
  isHidden,
  isTooShort,
  looksLikeTargetLanguage,
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
