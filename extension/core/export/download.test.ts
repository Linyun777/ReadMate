import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadTextFile, sanitizeFilename } from './download';

/**
 * 通用下载（方案第 32 节）。
 *
 * 两个纯函数都容易被忽略，但各有真实代价：
 *   - `sanitizeFilename` 决定**用户机器上落地的文件名**。放行 `/` 会让路径
 *     变成目录分隔符，`:` `*` `?` `"` `<` `>` `|` 在 Windows 上直接非法。
 *   - `downloadTextFile` 的 blob URL **不能立刻 revoke**，否则部分浏览器
 *     还没读到内容就把地址失效了 —— 下载出一个空文件。
 */

/** jsdom 不一定实现 object URL，两个都自己装，顺便记录调用。 */
function stubObjectUrls() {
  const created: Blob[] = [];
  const revoked: string[] = [];

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      created.push(blob);
      return `blob:test-${created.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });

  return { created, revoked };
}

/** 记录 `<a download>` 被点了几次、用的什么文件名。 */
function stubAnchorClick() {
  const clicked: string[] = [];

  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    configurable: true,
    writable: true,
    value(this: HTMLAnchorElement) {
      clicked.push(this.download);
    },
  });

  return clicked;
}

describe('sanitizeFilename · 文件名净化', () => {
  it('把路径分隔符与 Windows 非法字符都换成下划线', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('截断到 80 字符', () => {
    expect(sanitizeFilename('x'.repeat(100))).toBe('x'.repeat(80));
    expect(sanitizeFilename('x'.repeat(80))).toBe('x'.repeat(80));
  });

  it('去掉首尾空白', () => {
    expect(sanitizeFilename('   流式渲染   ')).toBe('流式渲染');
  });

  it.each([
    ['空字符串', ''],
    ['只有一个斜杠', '/'],
    ['全是分隔线', '---'],
    ['全是下划线', '___'],
  ])('%s 时回落到默认名', (_label, input) => {
    expect(sanitizeFilename(input)).toBe('export');
  });

  it('回落名可以自定义（笔记与总结各传各的）', () => {
    expect(sanitizeFilename('/', 'note')).toBe('note');
    expect(sanitizeFilename('/', 'summary')).toBe('summary');
  });

  it('中文与全角标点原样保留', () => {
    expect(sanitizeFilename('流式渲染笔记（2026）')).toBe('流式渲染笔记（2026）');
  });
});

describe('downloadTextFile · 触发下载', () => {
  let created: Blob[];
  let revoked: string[];
  let clicked: string[];

  beforeEach(() => {
    ({ created, revoked } = stubObjectUrls());
    clicked = stubAnchorClick();
  });

  it('点一下临时 <a>，返回实际文件名', () => {
    const used = downloadTextFile('note.md', '# 笔记', document);

    expect(used).toBe('note.md');
    expect(clicked).toEqual(['note.md']);
  });

  it('摘掉临时节点，不在页面里留垃圾', () => {
    const before = document.body.children.length;

    downloadTextFile('note.md', '# 笔记', document);

    expect(document.body.children.length).toBe(before);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('默认 MIME 是 Markdown，可以覆盖', () => {
    downloadTextFile('note.md', '# 笔记', document);
    expect(created[0]?.type).toBe('text/markdown;charset=utf-8');

    downloadTextFile('note.txt', '# 笔记', document, 'text/plain');
    expect(created[1]?.type).toBe('text/plain');
  });

  it('⭐ 延后释放 blob URL —— 立刻 revoke 会让下载拿不到内容', () => {
    vi.useFakeTimers();

    try {
      downloadTextFile('note.md', '# 笔记', document);
      expect(revoked).toEqual([]);

      vi.advanceTimersByTime(10_000);
      expect(revoked).toEqual(['blob:test-1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
