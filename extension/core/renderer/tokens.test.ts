import { describe, expect, it } from 'vitest';

import { flattenTranslation, parseTranslation } from './tokens';

describe('parseTranslation', () => {
  it('无占位符时只有文本 token', () => {
    expect(parseTranslation('Hello world')).toEqual([{ kind: 'text', value: 'Hello world' }]);
  });

  it('成对占位符产生 open / close', () => {
    expect(parseTranslation('Hello <0>world</0>!')).toEqual([
      { kind: 'text', value: 'Hello ' },
      { kind: 'open', index: 0 },
      { kind: 'text', value: 'world' },
      { kind: 'close', index: 0 },
      { kind: 'text', value: '!' },
    ]);
  });

  it('原子占位符产生 atom', () => {
    expect(parseTranslation('Line one<0/>Line two')).toEqual([
      { kind: 'text', value: 'Line one' },
      { kind: 'atom', index: 0 },
      { kind: 'text', value: 'Line two' },
    ]);
  });

  it('嵌套占位符', () => {
    expect(parseTranslation('<0><1>x</1></0>')).toEqual([
      { kind: 'open', index: 0 },
      { kind: 'open', index: 1 },
      { kind: 'text', value: 'x' },
      { kind: 'close', index: 1 },
      { kind: 'close', index: 0 },
    ]);
  });

  it('占位符位于首尾时不产生空文本 token', () => {
    expect(parseTranslation('<0>a</0>')).toEqual([
      { kind: 'open', index: 0 },
      { kind: 'text', value: 'a' },
      { kind: 'close', index: 0 },
    ]);
  });

  it('保留重排后的顺序（不按索引排序）', () => {
    expect(parseTranslation('<1>a</1><0>b</0>')).toEqual([
      { kind: 'open', index: 1 },
      { kind: 'text', value: 'a' },
      { kind: 'close', index: 1 },
      { kind: 'open', index: 0 },
      { kind: 'text', value: 'b' },
      { kind: 'close', index: 0 },
    ]);
  });

  it('多次调用互不影响（正则状态不泄漏）', () => {
    const first = parseTranslation('a<0>b</0>');
    const second = parseTranslation('a<0>b</0>');

    expect(second).toEqual(first);
  });

  it('空字符串返回空数组', () => {
    expect(parseTranslation('')).toEqual([]);
  });

  it('多位索引', () => {
    expect(parseTranslation('<12>x</12>')).toEqual([
      { kind: 'open', index: 12 },
      { kind: 'text', value: 'x' },
      { kind: 'close', index: 12 },
    ]);
  });
});

describe('flattenTranslation', () => {
  it('去掉占位符，保留文本', () => {
    expect(flattenTranslation(parseTranslation('开始之前，请阅读<0>文档</0>。'))).toBe(
      '开始之前，请阅读文档。',
    );
  });

  it('重排后按译文顺序压平', () => {
    expect(flattenTranslation(parseTranslation('<0>LLM</0>通过<2>HTTP</2>返回<1>JSON</1>'))).toBe(
      'LLM通过HTTP返回JSON',
    );
  });

  it('原子占位符不产生字符', () => {
    expect(flattenTranslation(parseTranslation('第一行<0/>第二行'))).toBe('第一行第二行');
  });

  it('去掉首尾空白', () => {
    expect(flattenTranslation(parseTranslation('  Hello <0>world</0>  '))).toBe('Hello world');
  });
});
