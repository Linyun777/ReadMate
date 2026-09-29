import { beforeEach, describe, expect, it } from 'vitest';

import type { TranslationBlock } from '@/shared/types';

import { isNavigationBlock, type Rect, sortByPriority, viewportDistance } from './priority';

function makeBlock(id: string, element: HTMLElement): TranslationBlock {
  return {
    id,
    nodeIds: [],
    text: id,
    plainText: id,
    tagName: element.tagName,
    blockType: 'paragraph',
    placeholders: [],
    element,
  };
}

/** 构造一个返回固定位置的测量函数（jsdom 的 getBoundingClientRect 全是 0）。 */
function measureAt(top: number, height = 100): () => Rect {
  return () => ({ top, bottom: top + height });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('viewportDistance', () => {
  it('在视口内返回 0', () => {
    const element = document.createElement('p');

    expect(viewportDistance(element, { viewportHeight: 800, measure: measureAt(100) })).toBe(0);
    expect(viewportDistance(element, { viewportHeight: 800, measure: measureAt(0) })).toBe(0);
    expect(viewportDistance(element, { viewportHeight: 800, measure: measureAt(750) })).toBe(0);
  });

  it('在视口下方返回正距离', () => {
    const element = document.createElement('p');

    expect(viewportDistance(element, { viewportHeight: 800, measure: measureAt(900) })).toBe(100);
  });

  it('在视口上方返回正距离（元素底边到视口顶边）', () => {
    const element = document.createElement('p');

    // top=-200, height=100 → bottom=-100 → 距离 100
    expect(viewportDistance(element, { viewportHeight: 800, measure: measureAt(-200) })).toBe(100);
  });

  it('距离始终非负，避免已滚过的内容被优先翻译', () => {
    const element = document.createElement('p');

    for (const top of [-1000, -200, 0, 400, 800, 2000]) {
      expect(
        viewportDistance(element, { viewportHeight: 800, measure: measureAt(top) }),
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('isNavigationBlock', () => {
  it('自身或祖先为 nav 时返回 true', () => {
    const nav = document.createElement('nav');
    const link = document.createElement('a');
    nav.append(link);
    document.body.append(nav);

    expect(isNavigationBlock(makeBlock('nav-1', link))).toBe(true);
    expect(isNavigationBlock(makeBlock('nav-2', nav))).toBe(true);
  });

  it('普通段落返回 false', () => {
    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    expect(isNavigationBlock(makeBlock('p-1', paragraph))).toBe(false);
  });
});

describe('sortByPriority', () => {
  it('视口内的排在前面', () => {
    const entries = [
      makeBlock('far', document.createElement('p')),
      makeBlock('visible', document.createElement('p')),
      makeBlock('near', document.createElement('p')),
    ];
    const positions: Record<string, number> = { far: 2000, visible: 100, near: 900 };

    const sorted = sortByPriority(entries, {
      viewportHeight: 800,
      measure: (element) => {
        const id = entries.find((entry) => entry.element === element)?.id ?? '';
        return { top: positions[id] ?? 0, bottom: (positions[id] ?? 0) + 100 };
      },
    });

    expect(sorted.map((entry) => entry.id)).toEqual(['visible', 'near', 'far']);
  });

  it('同距离时导航块优先', () => {
    const nav = document.createElement('nav');
    const link = document.createElement('a');
    nav.append(link);
    document.body.append(nav);

    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    const entries = [makeBlock('body-text', paragraph), makeBlock('nav-links', link)];

    const sorted = sortByPriority(entries, {
      viewportHeight: 800,
      measure: measureAt(100),
    });

    expect(sorted.map((entry) => entry.id)).toEqual(['nav-links', 'body-text']);
  });

  it('距离与导航都相同时保持文档顺序', () => {
    const entries = [
      makeBlock('first', document.createElement('p')),
      makeBlock('second', document.createElement('p')),
      makeBlock('third', document.createElement('p')),
    ];

    const sorted = sortByPriority(entries, { viewportHeight: 800, measure: measureAt(100) });

    expect(sorted.map((entry) => entry.id)).toEqual(['first', 'second', 'third']);
  });

  it('不修改入参', () => {
    const entries = [
      makeBlock('a', document.createElement('p')),
      makeBlock('b', document.createElement('p')),
    ];
    const original = [...entries];

    sortByPriority(entries, { viewportHeight: 800, measure: measureAt(5000) });

    expect(entries).toEqual(original);
  });

  it('空输入返回空数组', () => {
    expect(sortByPriority([], { viewportHeight: 800 })).toEqual([]);
  });
});
