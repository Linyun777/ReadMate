/**
 * 阅读视图（方案第 62 节）。
 *
 * ## 为什么是独立页面
 *
 * Readability 的产物是**重新生成的 HTML**，与铁律 3「不重建网页 DOM 结构」冲突。
 * 做成独立页面就绕开了这个冲突：原页面完全不被触碰，
 * 这里渲染的是一份**副本**。
 *
 * ## 翻译怎么走
 *
 * 本页是扩展页面，可以直接复用 `PageController`——它内部的
 * `streamTranslationViaBackground` 会经 background 转发（方案第 86.7 节）。
 * 也就是说：**阅读视图对翻译链路而言就是一个普通页面**，不需要任何特化。
 */

import { PageController } from '@/core/controller';
import { sendToBackground } from '@/core/messaging/client';
import { createMessage } from '@/core/messaging/protocol';
import { downloadNote } from '@/core/note';
import { loadReaderPayload, mountArticle, sanitizeArticle } from '@/core/reader';
import type { FetchNoteMessage, WireNoteResponse } from '@/shared/types';

function pick<T extends HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`#${id}`);
}

const statusEl = pick<HTMLElement>('reader-status');
const titleEl = pick<HTMLElement>('reader-title');
const bodyEl = pick<HTMLElement>('reader-body');
const emptyEl = pick<HTMLElement>('reader-empty');
const sourceLink = pick<HTMLAnchorElement>('reader-source');
const translateButton = pick<HTMLButtonElement>('reader-translate');
const noteButton = pick<HTMLButtonElement>('reader-note');
const notePanel = pick<HTMLElement>('reader-note-panel');
const notePositioning = pick<HTMLElement>('reader-note-positioning');
const noteModel = pick<HTMLElement>('reader-note-model');
const noteExport = pick<HTMLButtonElement>('reader-note-export');
const noteConceptsBlock = pick<HTMLElement>('reader-note-concepts-block');
const noteConcepts = pick<HTMLElement>('reader-note-concepts');
const noteOutline = pick<HTMLElement>('reader-note-outline');
const noteTakeawaysBlock = pick<HTMLElement>('reader-note-takeaways-block');
const noteTakeaways = pick<HTMLElement>('reader-note-takeaways');

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

/** 正文渲染完成后创建的控制器。翻译按钮与它绑定。 */
let controller: PageController | null = null;

/**
 * 提取结果。总结与导出都要用——**不重新提取**，
 * 那份文本就在手上，再跑一次 Readability 只会得到同样的东西。
 */
let article: { title: string; text: string; url: string } | null = null;

async function bootstrap(): Promise<void> {
  const payload = await loadReaderPayload();

  if (payload === null || bodyEl === null || titleEl === null) {
    emptyEl?.removeAttribute('hidden');
    translateButton?.setAttribute('disabled', '');
    return;
  }

  titleEl.textContent = payload.title;
  document.title = `${payload.title} · 阅读模式`;

  article = { title: payload.title, text: payload.text, url: payload.url };

  if (sourceLink) {
    sourceLink.href = payload.url;
    sourceLink.removeAttribute('hidden');
  }

  // 净化后**移动**节点，全程不使用 innerHTML（铁律 2）
  const sanitized = sanitizeArticle(payload.content);
  if (sanitized === null) {
    emptyEl?.removeAttribute('hidden');
    translateButton?.setAttribute('disabled', '');
    return;
  }

  mountArticle(sanitized, bodyEl);

  controller = new PageController();
  setStatus('已提取正文');
}

/**
 * 渲染学习笔记。
 *
 * 与总结的渲染差别不只是字段更多：**笔记有层级**
 * （概念是键值对、大纲有分节），所以用 `dl` 与嵌套的列表，
 * 而不是压成一列。
 *
 * 全部走 `textContent` —— 笔记来自模型，属于不可信输入（铁律 2）。
 */
function renderNote(note: WireNoteResponse): void {
  if (notePositioning) {
    notePositioning.textContent = note.positioning;
  }

  if (noteConcepts && noteConceptsBlock) {
    noteConcepts.replaceChildren();

    for (const concept of note.concepts) {
      const term = document.createElement('dt');
      term.textContent = concept.term;

      const explanation = document.createElement('dd');
      explanation.textContent = concept.explanation;

      noteConcepts.append(term, explanation);
    }

    // 没有概念时整块隐藏——空标题比没有标题更难看
    noteConceptsBlock.hidden = note.concepts.length === 0;
  }

  if (noteOutline) {
    noteOutline.replaceChildren();

    for (const section of note.outline) {
      const heading = document.createElement('h2');
      heading.className = 'note__heading';
      heading.textContent = section.heading;

      const list = document.createElement('ul');
      list.className = 'note__points';
      for (const point of section.points) {
        const item = document.createElement('li');
        item.textContent = point;
        list.append(item);
      }

      noteOutline.append(heading, list);
    }
  }

  if (noteTakeaways && noteTakeawaysBlock) {
    noteTakeaways.replaceChildren();

    for (const takeaway of note.takeaways) {
      const item = document.createElement('li');
      item.textContent = takeaway;
      noteTakeaways.append(item);
    }

    noteTakeawaysBlock.hidden = note.takeaways.length === 0;
  }

  if (noteModel) {
    // 笔记与总结共用「理解型」模型配置，看到名字才知道这段是谁写的
    noteModel.textContent = note.model;
  }

  notePanel?.removeAttribute('hidden');
}

/**
 * 生成学习笔记。
 *
 * 与「总结」不是同一个东西：总结是压缩（读完知道大概），
 * 笔记是重组（日后能捡起来）。这里用 Readability 提取的正文，
 * 已经剥掉导航与广告——是三条入口里最干净的输入。
 */
noteButton?.addEventListener('click', () => {
  const current = article;
  if (current === null) {
    setStatus('没有可做笔记的正文');
    return;
  }

  const button = noteButton;
  button.disabled = true;
  setStatus('正在生成笔记…');

  void sendToBackground<WireNoteResponse>(
    createMessage<FetchNoteMessage>({
      type: 'FETCH_NOTE',
      payload: { text: current.text, title: current.title, url: current.url },
    }),
  ).then(
    (response) => {
      if (response.ok && response.data !== undefined) {
        renderNote(response.data);
        setStatus('笔记已生成');
      } else {
        setStatus(`生成失败：${response.error ?? '未知错误'}`);
      }
      button.disabled = false;
    },
    (error: unknown) => {
      setStatus(`生成失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

noteExport?.addEventListener('click', () => {
  const current = article;
  const positioning = notePositioning?.textContent ?? '';

  if (current === null || positioning === '') {
    return;
  }

  const concepts: { term: string; explanation: string }[] = [];
  const terms = Array.from(noteConcepts?.querySelectorAll('dt') ?? []);
  const explanations = Array.from(noteConcepts?.querySelectorAll('dd') ?? []);
  for (let index = 0; index < terms.length; index += 1) {
    concepts.push({
      term: terms[index]?.textContent ?? '',
      explanation: explanations[index]?.textContent ?? '',
    });
  }

  const outline: { heading: string; points: string[] }[] = [];
  for (const block of Array.from(noteOutline?.children ?? [])) {
    if (block.tagName !== 'H2') {
      continue;
    }

    const list = block.nextElementSibling;
    outline.push({
      heading: block.textContent ?? '',
      points: Array.from(list?.querySelectorAll('li') ?? []).map((item) => item.textContent ?? ''),
    });
  }

  const filename = downloadNote(
    {
      note: {
        positioning,
        concepts,
        outline,
        takeaways: Array.from(noteTakeaways?.querySelectorAll('li') ?? []).map(
          (item) => item.textContent ?? '',
        ),
        model: noteModel?.textContent ?? '',
        prompt_version: '',
      },
      source: current.text,
      url: current.url,
      title: current.title,
      exportedAt: new Date().toISOString(),
    },
    document,
  );

  setStatus(`已导出 ${filename}`);
});

translateButton?.addEventListener('click', () => {
  const button = translateButton;
  const active = controller;

  if (active === null) {
    return;
  }

  button.disabled = true;
  setStatus('正在翻译…');

  void active.translate().then(
    (result) => {
      setStatus(`已翻译 ${result.translatedItems}/${result.blocks} 段`);
      button.disabled = false;
    },
    (error: unknown) => {
      setStatus(`失败：${error instanceof Error ? error.message : String(error)}`);
      button.disabled = false;
    },
  );
});

void bootstrap();
