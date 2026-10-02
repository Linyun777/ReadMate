import { describe, expect, it, vi } from 'vitest';

import {
  ensureServerAccess,
  originPatternFor,
  type PermissionsApi,
  serverAccessMessage,
  serverUrlWasReplaced,
} from './host-permission';

/**
 * 服务地址的 host 权限（见 `host-permission.ts` 文件头）。
 *
 * 这组测试盯的是**判断**，不是 chrome 的行为：
 * 「什么时候算已授权、什么时候必须报错、报错文案里有没有线索」。
 * 真实权限行为由 E2E 之外的实测确认（没权限 → `Failed to fetch`）。
 */

function fakePermissions(
  contains: boolean,
  request: boolean,
): PermissionsApi & {
  requestCalls: string[][];
} {
  const requestCalls: string[][] = [];
  return {
    requestCalls,
    contains: vi.fn(async () => contains),
    request: vi.fn(async (details: { origins: string[] }) => {
      requestCalls.push(details.origins);
      return request;
    }),
  };
}

describe('originPatternFor', () => {
  it('把地址折成 origin/* 的匹配模式', () => {
    expect(originPatternFor('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/*');
    expect(originPatternFor('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000/*');
    expect(originPatternFor('http://127.0.0.1:8000/api/v1/health')).toBe('http://127.0.0.1:8000/*');
    expect(originPatternFor('  http://127.0.0.1:8000  ')).toBe('http://127.0.0.1:8000/*');
    expect(originPatternFor('https://example.com')).toBe('https://example.com/*');
    expect(originPatternFor('http://localhost:8123')).toBe('http://localhost:8123/*');
  });

  it('默认端口会被归一化掉（避免拼出 http://host:80/* 这种对不上的模式）', () => {
    expect(originPatternFor('http://example.com:80')).toBe('http://example.com/*');
    expect(originPatternFor('https://example.com:443')).toBe('https://example.com/*');
  });

  it('非法地址与「不是请求服务」的协议都返回 null', () => {
    expect(originPatternFor('')).toBeNull();
    expect(originPatternFor('127.0.0.1:8000')).toBeNull();
    expect(originPatternFor('not a url')).toBeNull();
    expect(originPatternFor('file:///tmp/x')).toBeNull();
    expect(originPatternFor('chrome-extension://abc/x')).toBeNull();
  });
});

describe('ensureServerAccess', () => {
  it('已有权限时不弹授权', async () => {
    const permissions = fakePermissions(true, false);

    const access = await ensureServerAccess('http://127.0.0.1:8000', permissions);

    expect(access).toEqual({ kind: 'covered', pattern: 'http://127.0.0.1:8000/*' });
    expect(permissions.requestCalls).toEqual([]);
  });

  it('没有权限时请求，且只要这一个源', async () => {
    const permissions = fakePermissions(false, true);

    const access = await ensureServerAccess('http://192.168.1.5:8000', permissions);

    expect(access).toEqual({ kind: 'granted', pattern: 'http://192.168.1.5:8000/*' });
    expect(permissions.requestCalls).toEqual([['http://192.168.1.5:8000/*']]);
  });

  it('用户拒绝时如实返回 denied', async () => {
    const access = await ensureServerAccess(
      'http://192.168.1.5:8000',
      fakePermissions(false, false),
    );

    expect(access).toEqual({ kind: 'denied', pattern: 'http://192.168.1.5:8000/*' });
  });

  it('请求直接抛（不在用户手势里）也收成 denied，而不是把错误抛给界面', async () => {
    const permissions: PermissionsApi = {
      contains: async () => false,
      request: async () => {
        throw new Error('This function must be called during a user gesture');
      },
    };

    const access = await ensureServerAccess('http://192.168.1.5:8000', permissions);

    expect(access).toEqual({ kind: 'denied', pattern: 'http://192.168.1.5:8000/*' });
  });

  it('地址非法时连查都不查', async () => {
    const permissions = fakePermissions(true, true);

    const access = await ensureServerAccess('ftp://example.com', permissions);

    expect(access).toEqual({ kind: 'invalid' });
    expect(permissions.requestCalls).toEqual([]);
  });
});

describe('serverUrlWasReplaced', () => {
  it('打错的地址算被换掉（此时界面不能只说「已保存」）', () => {
    expect(serverUrlWasReplaced('不是地址', 'http://127.0.0.1:8000')).toBe(true);
    expect(serverUrlWasReplaced('127.0.0.1:8000', 'http://127.0.0.1:8000')).toBe(true);
    expect(serverUrlWasReplaced('ftp://example.com', 'http://127.0.0.1:8000')).toBe(true);
    expect(serverUrlWasReplaced('http://127.0.0.1:8123', 'http://127.0.0.1:8000')).toBe(true);
  });

  it('只是去掉了尾部斜杠不算被换掉', () => {
    expect(serverUrlWasReplaced('http://127.0.0.1:8000/', 'http://127.0.0.1:8000')).toBe(false);
    expect(serverUrlWasReplaced('  http://127.0.0.1:8000 ', 'http://127.0.0.1:8000')).toBe(false);
    expect(serverUrlWasReplaced('http://127.0.0.1:8123', 'http://127.0.0.1:8123')).toBe(false);
  });

  it('清空输入框是「用默认」，不算打错', () => {
    expect(serverUrlWasReplaced('', 'http://127.0.0.1:8000')).toBe(false);
    expect(serverUrlWasReplaced('   ', 'http://127.0.0.1:8000')).toBe(false);
  });
});

describe('serverAccessMessage', () => {
  it('成功时不报错', () => {
    expect(serverAccessMessage({ kind: 'covered', pattern: 'x' }, 'http://a')).toEqual({
      text: '已保存 · http://a',
      isError: false,
    });
    expect(serverAccessMessage({ kind: 'granted', pattern: 'x' }, 'http://a').isError).toBe(false);
  });

  it('没授权时把「缺的是哪个源」写进文案（否则又是一条无线索的报错）', () => {
    const message = serverAccessMessage(
      { kind: 'denied', pattern: 'http://192.168.1.5:8000/*' },
      'http://192.168.1.5:8000',
    );

    expect(message.isError).toBe(true);
    expect(message.text).toContain('http://192.168.1.5:8000/*');
  });

  it('地址非法时把用户填的原值回显出来', () => {
    const message = serverAccessMessage({ kind: 'invalid' }, '不是地址');

    expect(message.isError).toBe(true);
    expect(message.text).toContain('不是地址');
  });
});
