import { describe, expect, it } from 'vitest';

import type { TranslationRequest, WireTranslateResponse } from '@/shared/types';

import {
  fromWireResponse,
  fromWireResult,
  isWireTranslateResponse,
  toWireItem,
  toWireRequest,
} from './wire';

const baseRequest: TranslationRequest = {
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  style: 'technical',
  items: [{ id: 'block-001', text: 'Hello <0>world</0>!' }],
};

describe('toWireRequest — camelCase → snake_case', () => {
  it('字段名映射正确', () => {
    const wire = toWireRequest({
      ...baseRequest,
      contextId: 'ctx-001',
      context: 'Article context.',
    });

    expect(wire).toEqual({
      source_language: 'auto',
      target_language: 'zh-CN',
      style: 'technical',
      context_id: 'ctx-001',
      context: 'Article context.',
      items: [{ id: 'block-001', text: 'Hello <0>world</0>!' }],
    });
  });

  it('无上下文时不带 context 字段（而不是 null）', () => {
    const wire = toWireRequest(baseRequest);

    expect('context_id' in wire).toBe(false);
    expect('context' in wire).toBe(false);
  });

  it('多个条目全部映射', () => {
    const wire = toWireRequest({
      ...baseRequest,
      items: [
        { id: 'block-001', text: 'First.' },
        { id: 'block-002', text: 'Second.' },
      ],
    });

    expect(wire.items).toHaveLength(2);
    expect(wire.items[1]).toEqual({ id: 'block-002', text: 'Second.' });
  });

  it('保留占位符原文', () => {
    const wire = toWireRequest(baseRequest);

    expect(wire.items[0]?.text).toBe('Hello <0>world</0>!');
  });
});

describe('toWireItem', () => {
  it('只保留 id 与 text', () => {
    expect(toWireItem({ id: 'block-001', text: 'Text.' })).toEqual({
      id: 'block-001',
      text: 'Text.',
    });
  });
});

describe('fromWireResponse — snake_case → camelCase', () => {
  const wireResponse: WireTranslateResponse = {
    context_id: 'ctx-001',
    prompt_version: 'v1',
    model: 'deepseek-chat',
    items: [{ id: 'block-001', source: 'Hello.', translation: '你好。' }],
  };

  it('字段名映射正确', () => {
    expect(fromWireResponse(wireResponse)).toEqual({
      contextId: 'ctx-001',
      promptVersion: 'v1',
      model: 'deepseek-chat',
      items: [{ id: 'block-001', source: 'Hello.', translation: '你好。' }],
    });
  });

  it('context_id 为 null 时不带 contextId', () => {
    const mapped = fromWireResponse({ ...wireResponse, context_id: null });

    expect('contextId' in mapped).toBe(false);
  });

  it('保留译文中的占位符', () => {
    const mapped = fromWireResponse({
      ...wireResponse,
      items: [{ id: 'block-001', source: 'See <0>docs</0>.', translation: '见<0>文档</0>。' }],
    });

    expect(mapped.items[0]?.translation).toBe('见<0>文档</0>。');
  });
});

describe('fromWireResult', () => {
  it('逐字段映射', () => {
    expect(fromWireResult({ id: 'a', source: 'b', translation: 'c' })).toEqual({
      id: 'a',
      source: 'b',
      translation: 'c',
    });
  });
});

describe('isWireTranslateResponse — 防御性校验', () => {
  const valid = {
    context_id: null,
    prompt_version: 'v1',
    model: 'mock',
    items: [{ id: 'a', source: 'b', translation: 'c' }],
  };

  it('合法结构通过', () => {
    expect(isWireTranslateResponse(valid)).toBe(true);
  });

  it('非对象被拒', () => {
    expect(isWireTranslateResponse(null)).toBe(false);
    expect(isWireTranslateResponse('text')).toBe(false);
    expect(isWireTranslateResponse(42)).toBe(false);
  });

  it('缺少 items 被拒', () => {
    const { items: _items, ...withoutItems } = valid;

    expect(isWireTranslateResponse(withoutItems)).toBe(false);
  });

  it('items 不是数组被拒', () => {
    expect(isWireTranslateResponse({ ...valid, items: 'nope' })).toBe(false);
  });

  it('缺少 prompt_version 或 model 被拒', () => {
    const { prompt_version: _pv, ...withoutVersion } = valid;

    expect(isWireTranslateResponse(withoutVersion)).toBe(false);
    expect(isWireTranslateResponse({ ...valid, model: undefined })).toBe(false);
  });

  it('items 元素缺字段被拒', () => {
    expect(isWireTranslateResponse({ ...valid, items: [{ id: 'a', source: 'b' }] })).toBe(false);
    expect(
      isWireTranslateResponse({ ...valid, items: [{ id: 'a', source: 'b', translation: 1 }] }),
    ).toBe(false);
  });
});
