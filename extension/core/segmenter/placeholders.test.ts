import { beforeEach, describe, expect, it } from 'vitest';

import type { PlaceholderBinding } from '@/shared/types';

import { buildPlaceholderText, validatePlaceholders } from './placeholders';

/** 把 HTML 挂到 body 上，返回第一个元素。 */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild;
  if (!element) {
    throw new Error(`HTML 未产生元素：${html}`);
  }
  return element as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('buildPlaceholderText — 占位符构建（方案第 86.1 节）', () => {
  it('inline 元素生成成对占位符', () => {
    const result = buildPlaceholderText(mount('<p>Hello <strong>world</strong>!</p>'));

    expect(result.text).toBe('Hello <0>world</0>!');
    expect(result.plainText).toBe('Hello world!');
    expect(result.placeholders).toHaveLength(1);
    expect(result.placeholders[0]).toMatchObject({ index: 0, kind: 'pair' });
  });

  it('<br> 生成原子占位符', () => {
    const result = buildPlaceholderText(mount('<p>Line one<br>Line two</p>'));

    expect(result.text).toBe('Line one<0/>Line two');
    expect(result.plainText).toBe('Line oneLine two');
    expect(result.placeholders).toHaveLength(1);
    expect(result.placeholders[0]).toMatchObject({ index: 0, kind: 'atom' });
  });

  it('⭐ 行内 CODE 用成对占位符，内容对模型可见', () => {
    // 曾经是原子占位符 `<0/>`——元素保住了，但内容不发给模型，
    // 模型看到一个空占位符就容易直接丢掉，译文里就少了那个函数名。
    // 改成成对占位符后模型看得到 `npm i`，能自然放置也不会丢。
    const result = buildPlaceholderText(mount('<p>Use <code>npm i</code> now</p>'));

    expect(result.text).toBe('Use <0>npm i</0> now');
    expect(result.plainText).toBe('Use npm i now');
    expect(result.placeholders).toHaveLength(1);
    expect(result.placeholders[0]).toMatchObject({ index: 0, kind: 'pair' });
  });

  it('嵌套 inline 元素生成嵌套占位符', () => {
    const result = buildPlaceholderText(mount('<p><a href="#x"><strong>x</strong></a></p>'));

    expect(result.text).toBe('<0><1>x</1></0>');
    expect(result.placeholders.map((item) => item.kind)).toEqual(['pair', 'pair']);
  });

  it('折叠被页面忽略的空白（含源码缩进与换行）', () => {
    const result = buildPlaceholderText(
      mount('<p>\n  Hello\n  <strong>world</strong>\n  again\n</p>'),
    );

    expect(result.text).toBe('Hello <0>world</0> again');
    expect(result.plainText).toBe('Hello world again');
  });

  it('块级后代不纳入本 Block', () => {
    const result = buildPlaceholderText(mount('<div>before<p>inside</p>after</div>'));

    // 源码中 "before" 与 "after" 之间没有空白，折叠后自然连在一起
    expect(result.text).toBe('beforeafter');
    expect(result.plainText).toBe('beforeafter');
    expect(result.placeholders).toHaveLength(0);
  });

  it('块级后代两侧的空白正常保留', () => {
    const result = buildPlaceholderText(mount('<div>before <p>inside</p> after</div>'));

    expect(result.text).toBe('before after');
    expect(result.placeholders).toHaveLength(0);
  });

  it('white-space: pre-wrap 时换行转为原子占位符', () => {
    const style = document.createElement('style');
    style.textContent = '.pre { white-space: pre-wrap; }';
    document.head.append(style);

    const result = buildPlaceholderText(mount('<p class="pre">Line one\nLine two</p>'));

    expect(result.text).toBe('Line one<0/>Line two');
    expect(result.plainText).toBe('Line oneLine two');
    expect(result.placeholders[0]).toMatchObject({ index: 0, kind: 'atom' });
  });

  it('占位符索引在 Block 内从 0 连续递增', () => {
    const result = buildPlaceholderText(mount('<p>a<strong>b</strong>c<em>d</em>e<br>f</p>'));

    expect(result.text).toBe('a<0>b</0>c<1>d</1>e<2/>f');
    expect(result.placeholders.map((item) => item.index)).toEqual([0, 1, 2]);
  });
});

describe('validatePlaceholders — 结构校验', () => {
  const pairs: PlaceholderBinding[] = [
    { index: 0, kind: 'pair' },
    { index: 1, kind: 'atom' },
  ];

  it('合法译文通过校验', () => {
    expect(validatePlaceholders('你好 <0>世界</0><1/>结束', pairs)).toEqual({ ok: true });
  });

  it('缺少占位符', () => {
    const result = validatePlaceholders('你好 <0>世界</0>结束', pairs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('索引不一致');
      expect(result.reason).toContain('缺少 <1>');
    }
  });

  it('多出占位符', () => {
    const result = validatePlaceholders('<0>a</0><1/><2/>', pairs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('多出 <2>');
    }
  });

  it('占位符重复', () => {
    const result = validatePlaceholders('<0>a</0><0>b</0><1/>', pairs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('重复');
    }
  });

  it('出现请求之外的索引', () => {
    const result = validatePlaceholders('<0>a</0><1/><2/>', pairs);
    expect(result.ok).toBe(false);
  });

  it('成对占位符未闭合', () => {
    const result = validatePlaceholders('<0>a<1/>', pairs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('未闭合');
    }
  });

  it('成对占位符交叉嵌套', () => {
    const nested: PlaceholderBinding[] = [
      { index: 0, kind: 'pair' },
      { index: 1, kind: 'pair' },
    ];
    const result = validatePlaceholders('<0><1>a</0></1>', nested);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('配对错误');
    }
  });

  it('允许重排占位符（模型会为符合目标语言语序而调整顺序）', () => {
    const result = validatePlaceholders('<1/><0>a</0>', pairs);

    expect(result).toEqual({ ok: true });
  });

  it('原子占位符不需要闭合', () => {
    const atoms: PlaceholderBinding[] = [{ index: 0, kind: 'atom' }];
    expect(validatePlaceholders('前<0/>后', atoms)).toEqual({ ok: true });
  });
});
