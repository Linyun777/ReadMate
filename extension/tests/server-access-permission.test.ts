import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { originPatternFor } from '@/core/settings/host-permission';
import { DEFAULT_SERVER_URL } from '@/shared/constants';

import { EXTENSION_ROOT, readSource } from './source-scan';

/**
 * 守卫测试：**默认服务地址必须落在 manifest 的 host 权限里**。
 *
 * `http://127.0.0.1:8000` 这个事实存了三份：`shared/constants.ts` 的
 * `DEFAULT_SERVER_URL`（设置与回落值的来源）、`wxt.config.ts` 的
 * `host_permissions`（浏览器据此放行请求）、设置页的输入框 placeholder。
 * 前两份**必须一致**：地址改了而权限没跟着改，扩展发不出任何请求，
 * 而报错只有一句 `TypeError: Failed to fetch`（2026-10-02 实测，
 * 见 `core/settings/host-permission.ts` 文件头）。
 *
 * 第二条断言钉的是另一半：**自定义地址得能补授权限**。设置页允许把
 * 地址改成局域网里的另一台机器，靠的是 `optional_host_permissions`
 * 在用户点保存时补授——那两项被删掉，功能会静默失效（页面还是能保存，
 * 只是永远连不上）。可选权限不产生安装提示，所以这里放宽到「任意站点」
 * 是刻意的，别当成过度授权。
 */

const CONFIG_FILE = path.join(EXTENSION_ROOT, 'wxt.config.ts');

/** 从 `wxt.config.ts` 里取一个字面量字符串数组（键写在行首）。 */
function configArray(key: string): string[] {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*\\[([^\\]]*)\\]`, 'm').exec(
    readSource(CONFIG_FILE),
  );

  if (match?.[1] === undefined) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
}

describe('默认服务地址与 manifest 的 host 权限一致', () => {
  it('DEFAULT_SERVER_URL 的源在 host_permissions 里', () => {
    expect(configArray('host_permissions')).toContain(originPatternFor(DEFAULT_SERVER_URL));
  });

  it('optional_host_permissions 覆盖任意 http(s) 站点（自定义地址要靠它补授）', () => {
    const optional = configArray('optional_host_permissions');

    expect(optional).toContain('http://*/*');
    expect(optional).toContain('https://*/*');
  });

  it('解析确实拿到了东西（防止守卫本身失效）', () => {
    expect(configArray('permissions')).toContain('storage');
    expect(configArray('host_permissions').length).toBeGreaterThan(0);
  });
});
