import { beforeEach, describe, expect, it } from 'vitest';

import { PLUGIN_NODE_ATTR } from '@/shared/constants';

import {
  type MutationObserverFactory,
  type MutationObserverLike,
  type MutationRecordLike,
  MutationWatcher,
} from './mutation-watcher';

/** 假的 MutationObserver，可手动触发回调。 */
function makeFakeObserver() {
  const state = {
    observed: null as Node | null,
    options: null as MutationObserverInit | null,
    disconnected: false,
    takeRecordsCalls: 0,
  };
  let trigger: ((records: MutationRecordLike[]) => void) | null = null;

  const factory: MutationObserverFactory = (callback) => {
    trigger = callback;

    const observer: MutationObserverLike = {
      observe: (target, options) => {
        state.observed = target;
        state.options = options;
      },
      disconnect: () => {
        state.disconnected = true;
      },
      takeRecords: () => {
        state.takeRecordsCalls += 1;
        return [];
      },
    };

    return observer;
  };

  return {
    factory,
    state,
    fire: (records: MutationRecordLike[]) => trigger?.(records),
  };
}

function childList(target: Node, added: Node[]): MutationRecordLike {
  return { type: 'childList', target, addedNodes: added };
}

function characterData(target: Node): MutationRecordLike {
  return { type: 'characterData', target, addedNodes: [] };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeWatcher(fake: ReturnType<typeof makeFakeObserver>, flushDelayMs = 0): MutationWatcher {
  return new MutationWatcher({ createObserver: fake.factory, flushDelayMs });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('MutationWatcher · 观察配置', () => {
  it('观察 body，并同时开启 childList / subtree / characterData', () => {
    const fake = makeFakeObserver();
    makeWatcher(fake).start(() => {});

    expect(fake.state.observed).toBe(document.body);
    expect(fake.state.options).toMatchObject({
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  it('stop 会断开观察器', () => {
    const fake = makeFakeObserver();
    const watcher = makeWatcher(fake);

    watcher.start(() => {});
    watcher.stop();

    expect(fake.state.disconnected).toBe(true);
    expect(watcher.running).toBe(false);
  });

  it('重复 start 会先停掉上一次', () => {
    const fake = makeFakeObserver();
    const watcher = makeWatcher(fake);

    watcher.start(() => {});
    watcher.start(() => {});

    expect(fake.state.disconnected).toBe(true);
  });
});

describe('MutationWatcher · 变动归集', () => {
  it('新增块级元素时回调该元素自身', async () => {
    const container = document.createElement('div');
    document.body.append(container);

    const paragraph = document.createElement('p');
    paragraph.textContent = 'New paragraph.';
    container.append(paragraph);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(container, [paragraph])]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([paragraph]);
  });

  it('新增文本节点时回调其所在块级容器', async () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Existing.';
    document.body.append(paragraph);

    const text = document.createTextNode(' appended');
    paragraph.append(text);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(paragraph, [text])]);
    await settle();

    expect(received[0]).toEqual([paragraph]);
  });

  it('characterData 变更被捕获，并回调其容器（SPA 原地更新）', async () => {
    const paragraph = document.createElement('p');
    const text = document.createTextNode('Original text.');
    paragraph.append(text);
    document.body.append(paragraph);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    text.data = 'Updated text.';
    fake.fire([characterData(text)]);
    await settle();

    expect(received[0]).toEqual([paragraph]);
  });

  it('嵌套的根只保留最外层', async () => {
    const outer = document.createElement('div');
    const inner = document.createElement('p');
    outer.append(inner);
    document.body.append(outer);

    const outerText = document.createTextNode('outer text');
    const innerText = document.createTextNode('inner text');
    outer.append(outerText);
    inner.append(innerText);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(outer, [outerText]), childList(inner, [innerText])]);
    await settle();

    expect(received[0]).toEqual([outer]);
  });

  it('同一容器在多个记录里只回调一次', async () => {
    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    const first = document.createTextNode('a');
    const second = document.createTextNode('b');
    paragraph.append(first, second);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(paragraph, [first]), childList(paragraph, [second])]);
    await settle();

    expect(received[0]).toEqual([paragraph]);
  });

  it('合并窗口内的多批记录合并成一次回调', async () => {
    const first = document.createElement('p');
    const second = document.createElement('p');
    document.body.append(first, second);

    const firstText = document.createTextNode('a');
    const secondText = document.createTextNode('b');
    first.append(firstText);
    second.append(secondText);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake, 10).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(first, [firstText])]);
    fake.fire([childList(second, [secondText])]);
    await settle(40);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([first, second]);
  });

  it('已从 DOM 移除的节点被跳过（去抖期间被删掉的内容）', async () => {
    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    // 创建时挂上，随后被移除——处理时 parentElement 已经是 null
    const detached = document.createTextNode('gone');
    paragraph.append(detached);
    detached.remove();

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(paragraph, [detached])]);
    await settle();

    expect(received).toEqual([]);
  });

  it('没有可归集的节点时不回调', async () => {
    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([{ type: 'childList', target: document.body, addedNodes: [] }]);
    await settle();

    expect(received).toEqual([]);
  });
});

describe('MutationWatcher · 忽略插件自身节点（方案第 13.2 节）', () => {
  it('带 data-ai-translator 的节点被忽略', async () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Original.';
    document.body.append(paragraph);

    const holder = document.createElement('div');
    holder.setAttribute(PLUGIN_NODE_ATTR, 'true');
    holder.textContent = '译文';
    paragraph.after(holder);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(paragraph.parentElement ?? document.body, [holder])]);
    await settle();

    expect(received).toEqual([]);
  });

  it('插件节点的后代也被忽略', async () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Original.';
    document.body.append(paragraph);

    const holder = document.createElement('div');
    holder.setAttribute(PLUGIN_NODE_ATTR, 'true');
    const inner = document.createElement('span');
    inner.textContent = '译文';
    holder.append(inner);
    paragraph.after(holder);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    makeWatcher(fake).start((roots) => {
      received.push(roots);
    });

    fake.fire([childList(holder, [inner])]);
    await settle();

    expect(received).toEqual([]);
  });
});

describe('MutationWatcher · 暂停与恢复', () => {
  it('暂停期间不回调', async () => {
    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    const watcher = makeWatcher(fake);
    watcher.start((roots) => {
      received.push(roots);
    });

    watcher.pause();
    fake.fire([childList(paragraph, [document.createTextNode('x')])]);
    await settle();

    expect(received).toEqual([]);
    expect(watcher.paused).toBe(true);
  });

  it('resume 会 takeRecords 丢弃渲染期间积累的记录', () => {
    const fake = makeFakeObserver();
    const watcher = makeWatcher(fake);
    watcher.start(() => {});

    watcher.pause();
    watcher.resume();

    expect(fake.state.takeRecordsCalls).toBe(1);
    expect(watcher.paused).toBe(false);
  });

  it('恢复后新的变动仍会被捕获', async () => {
    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    const text = document.createTextNode('x');
    paragraph.append(text);

    const fake = makeFakeObserver();
    const received: Element[][] = [];
    const watcher = makeWatcher(fake);
    watcher.start((roots) => {
      received.push(roots);
    });

    watcher.pause();
    watcher.resume();
    fake.fire([childList(paragraph, [text])]);
    await settle();

    expect(received[0]).toEqual([paragraph]);
  });
});
