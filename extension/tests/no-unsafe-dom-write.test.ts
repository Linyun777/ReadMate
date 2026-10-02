import { describe, expect, it } from 'vitest';

import { collectProductionFiles, readSource, relativeFromRoot } from './source-scan';

/**
 * 守卫测试：**生产代码不得把字符串当 HTML 写进 DOM**（`AGENTS.md` 第 2 节铁律 2）。
 *
 * 铁律 2 的另一半是「LLM 输出 = 不可信输入」——译文、解释、总结、笔记
 * 全都要走 `textContent` / `createTextNode`，或走 `DOMParser` + 净化。
 * 这条规则此前只靠自觉：**没有任何测试会因为有人写 `el.innerHTML = x` 而失败**。
 *
 * ## 判据是「使用形态」，不是关键词
 *
 * 本仓库的注释里**大量**出现 `innerHTML`（`core/reader/sanitize.ts` 整整一节在解释
 * 「为什么不用 innerHTML」）。所以判据不看关键词，看**赋值或调用的形状**
 * （`.innerHTML =`、`insertAdjacentHTML(`）——注释里提到它不会误报，
 * 也不用为此写一个能懂字符串与注释的解析器。
 *
 * ## 只管「写」，不管「读」
 *
 * `const html = el.innerHTML` 是读，不注入，不拦。
 * 风险全在写这一侧。
 */

interface ForbiddenShape {
  label: string;
  pattern: RegExp;
}

const FORBIDDEN: ForbiddenShape[] = [
  { label: 'innerHTML 赋值（把字符串当 HTML 塞进 DOM）', pattern: /(?:\.|\b)innerHTML\s*=[^=]/ },
  { label: 'outerHTML 赋值（同上，且会连自己一起替换）', pattern: /(?:\.|\b)outerHTML\s*=[^=]/ },
  {
    label: 'insertAdjacentHTML(...)（把字符串当 HTML 插进 DOM）',
    pattern: /insertAdjacentHTML\s*\(/,
  },
  {
    label: 'createContextualFragment(...)（把字符串解析成节点，绕过净化）',
    pattern: /createContextualFragment\s*\(/,
  },
  { label: 'document.write(...) / document.writeln(...)', pattern: /document\.write(?:ln)?\s*\(/ },
  { label: 'dangerouslySetInnerHTML（React 里的同一件事）', pattern: /dangerouslySetInnerHTML/ },
  { label: 'eval(...)（把字符串当代码执行）', pattern: /(?<![\w.$])eval\s*\(/ },
  { label: 'new Function(...)（同一件事，换个写法）', pattern: /new\s+Function\s*\(/ },
];

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

describe('铁律 2：生产代码不把字符串当 HTML 写进 DOM', () => {
  it('core / entrypoints / shared / adapters 下没有禁用形态', () => {
    const offenders: string[] = [];

    for (const file of collectProductionFiles()) {
      const source = readSource(file);
      for (const rule of FORBIDDEN) {
        for (const match of source.matchAll(new RegExp(rule.pattern.source, 'g'))) {
          const line = lineOf(source, match.index);
          offenders.push(`${relativeFromRoot(file)}:${line} —— ${rule.label}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('扫描确实覆盖到了文件（防止守卫本身失效）', () => {
    expect(collectProductionFiles().length).toBeGreaterThan(20);
  });

  it('判据能命中坏形状、且不误伤注释', () => {
    const bad = [
      'element.innerHTML = userInput;',
      "element.innerHTML = '';",
      "node.insertAdjacentHTML('beforeend', html);",
      'container.outerHTML = html;',
      "document.write('<script>x</script>');",
      'const div = { dangerouslySetInnerHTML: { __html: html } };',
      "eval('1 + 1');",
      'new Function("return 1")();',
      'range.createContextualFragment(html);',
      'target.innerHTML=payload;',
    ];
    const harmless = [
      '// 为什么不用 innerHTML：会把不可信输入当结构解析',
      ' * 铁律 2 禁止 `innerHTML`，一律 `textContent`（第 2 条）',
      ' * 全程不碰 `innerHTML`，从机制上堵死这条路。',
      "if (el.innerHTML === '') return;",
      'const snapshot = el.innerHTML;',
      '// 这里的 evaluate(...) 是 Playwright 的方法，不是 eval',
    ];

    for (const shape of FORBIDDEN) {
      const pattern = new RegExp(shape.pattern.source, 'g');
      const hits = bad.filter((sample) => [...sample.matchAll(pattern)].length > 0);

      // 每条判据至少要命中它对应的那个坏样本（否则这条判据是失效的）
      expect(hits.length, `判据「${shape.label}」连坏样本都命中不了`).toBeGreaterThan(0);
    }

    const falsePositives: string[] = [];
    for (const shape of FORBIDDEN) {
      const pattern = new RegExp(shape.pattern.source, 'g');
      for (const sample of harmless) {
        if ([...sample.matchAll(pattern)].length > 0) {
          falsePositives.push(`判据「${shape.label}」误伤：${sample}`);
        }
      }
    }

    expect(falsePositives).toEqual([]);
  });
});
