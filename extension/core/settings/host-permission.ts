/**
 * 服务地址对应的 host 权限。
 *
 * ## 为什么需要这个模块
 *
 * `host_permissions` 是**安装时**固定的（`wxt.config.ts` 里只有
 * `http://127.0.0.1:8000/*`）——manifest 定下来就改不了，浏览器没给
 * 「运行时改 manifest」的口子。而设置页允许用户把服务地址改成别的
 * （局域网里另一台机器、换个端口）。
 *
 * 2026-10-02 实测（同样的构建，只差一份 host 权限）：
 *
 * ```text
 * 没有权限：后台 Service Worker 的 fetch → TypeError: Failed to fetch
 * 有权限：  同一个地址 → 200
 * ```
 *
 * 服务端没有 CORS 中间件（`server/app/main.py` 里没有 CORSMiddleware），
 * 而扩展的 fetch 在缺少 host 权限时会退化成普通跨源请求——于是被拦。
 * 症状是「地址填对了、按钮点了、就是连不上」，而且报错里没有任何
 * 指向权限的线索。
 *
 * 所以改地址时要在**用户点按钮的那一刻**补授权限：`wxt.config.ts` 里
 * 用 `optional_host_permissions` 声明「可能访问任意 http(s) 站点」——
 * 它**不产生安装时的权限提示**（可选权限只在真的请求时才弹一次），
 * 符合方案第 22 节的「最小权限」。
 *
 * ⚠️ `chrome.permissions.request` **必须在用户手势里调用**（按钮点击），
 * 否则 Chrome 直接拒绝。所以这里只做「查 + 请求」，调用时机由入口决定。
 */

/** 只用到两个方法——注入替身就能在 jsdom 里测（那边没有 `chrome`）。 */
export interface PermissionsApi {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
}

export type ServerAccess =
  /** 已经在 host_permissions 里，不需要任何动作 */
  | { kind: 'covered'; pattern: string }
  /** 刚刚补授成功 */
  | { kind: 'granted'; pattern: string }
  /** 用户拒绝，或浏览器不给（不是用户手势时也会走到这里） */
  | { kind: 'denied'; pattern: string }
  /**
   * 不是合法的 http(s) 地址，扩展永远发不出去。
   *
   * ⚠️ 设置页的流程**到不了**这一档：`saveSettings` 已经把非法地址回落成
   * 默认值了（那件事由 `serverUrlWasReplaced` 讲给用户听）。留着是给
   * 别的调用方兜底——不要因为「测不到」就删掉它。
   */
  | { kind: 'invalid' };

/**
 * 把服务地址折成 host 权限的匹配模式（`origin/*`）。
 *
 * 非法地址、以及 `file:` / `chrome-extension:` 之类的协议返回 null——
 * 那些不是「请求一个服务」，放行它们也没有意义。
 */
export function originPatternFor(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // origin 已经带上了端口（URL 会把默认端口归一化掉，不用自己拼）
  return `${url.origin}/*`;
}

/** 查一次、必要时请求一次。**要在用户手势里调**（见文件头）。 */
export async function ensureServerAccess(
  serverUrl: string,
  permissions: PermissionsApi,
): Promise<ServerAccess> {
  const pattern = originPatternFor(serverUrl);
  if (pattern === null) return { kind: 'invalid' };

  if (await permissions.contains({ origins: [pattern] })) return { kind: 'covered', pattern };

  // 请求可能直接抛，两种情形：不在用户手势里（Chrome 会拒绝），
  // 或这个源没写进 `optional_host_permissions`（配置错误）。两种都表现为
  // 「现在没有权限」，而抛出去只会变成一条没人看得懂的报错——所以收成 denied。
  // 配置错误那一侧由 `extension/tests/server-access-permission.test.ts` 守栏，
  // 不会靠用户来发现。
  //
  // ⚠️ 反过来，**请求被接受但用户还没点**时不会抛也不会返回，而是挂着等
  // 浏览器弹窗的结果。所以 denied 只代表「没拿到」，不代表「被拒了」。
  try {
    const granted = await permissions.request({ origins: [pattern] });
    return granted ? { kind: 'granted', pattern } : { kind: 'denied', pattern };
  } catch {
    return { kind: 'denied', pattern };
  }
}

/**
 * 用户填的地址被规范化掉时的提示（`saveSettings` 会把非法地址回落成默认值）。
 *
 * 为什么需要它：`saveSettings` 是**静默**回落的，界面只会说「已保存」——
 * 用户打了 `127.0.0.1:8000`（漏了协议）这类错，会以为地址已经生效，
 * 然后对着一个连不上的服务排查半天。这里只做「有没有被换掉」的判断，
 * 措辞交给调用方。
 *
 * 判据是**源**而不是字符串：`http://127.0.0.1:8000/` 去尾斜杠不算被换掉。
 */
export function serverUrlWasReplaced(typed: string, saved: string): boolean {
  if (typed.trim() === '') return false;
  // 两个都非法、或者规范化后是同一个源，都不算「被换掉」
  return originPatternFor(typed) !== originPatternFor(saved);
}

/**
 * 状态栏文案。
 *
 * 放在这里而不是入口里：入口的 DOM 接线单测盖不到，「什么样算成功、
 * 什么样必须报错」这种判断题得有测试钉住（`AGENTS.md` 第 3.3 节）。
 */
export function serverAccessMessage(
  access: ServerAccess,
  serverUrl: string,
): { text: string; isError: boolean } {
  switch (access.kind) {
    case 'covered':
      return { text: `已保存 · ${serverUrl}`, isError: false };
    case 'granted':
      return { text: `已保存 · ${serverUrl}（已授权访问该地址）`, isError: false };
    case 'denied':
      return {
        text: `已保存，但浏览器没给 ${access.pattern} 的访问权限——扩展发不出请求。再点一次「保存」可以重新授权。`,
        isError: true,
      };
    case 'invalid':
      return {
        text: `已保存，但「${serverUrl}」不是合法的 http/https 地址，扩展访问不到。`,
        isError: true,
      };
  }
}
