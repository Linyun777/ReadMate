/**
 * SPA 路由变化监听（方案第 74 节）。
 *
 * Route 改变后需要：清理旧状态 → 重新分段。
 * 适用于 Twitter / Reddit / GitHub 这类前端路由的站点。
 *
 * ## 为什么用「URL 轮询」而不是 hook `history`
 *
 * content script 运行在**隔离世界**，与页面主世界不共享 `history` 对象——
 * 在这里改写 `history.pushState` 只能拦截隔离世界自己的调用，
 * 页面（主世界）的调用完全不受影响。
 *
 * 要真正 hook 就得往主世界注入脚本（`world: 'MAIN'` 或 `<script>` 标签），
 * 前者要求 Chrome 111+，后者在带 CSP 的站点上会被拦。
 *
 * 轮询 `location.href` 没有这些问题：一次字符串比较，代价可忽略，
 * 而且能覆盖**所有**导航方式（pushState / replaceState / popstate / hash 变化）。
 * `popstate` 额外监听一次，是为了让前进/后退能立即响应，不必等下一个轮询周期。
 */

export interface RouteWatcherOptions {
  /** 轮询间隔（毫秒）。默认 500 */
  pollIntervalMs?: number;
  /** 变化后的合并窗口（毫秒）。SPA 常在短时间内多次改写 URL */
  flushDelayMs?: number;
  /** 取当前 URL。默认读 `location.href`，测试可注入 */
  getUrl?: () => string;
}

export const DEFAULT_ROUTE_POLL_MS = 500;
export const DEFAULT_ROUTE_FLUSH_MS = 100;

function defaultGetUrl(): string {
  return globalThis.location?.href ?? '';
}

export class RouteWatcher {
  readonly #pollIntervalMs: number;
  readonly #flushDelayMs: number;
  readonly #getUrl: () => string;

  #lastUrl = '';
  #pendingUrl: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #onChange: ((url: string) => void) | null = null;
  #popstateHandler: (() => void) | null = null;

  constructor(options: RouteWatcherOptions = {}) {
    this.#pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_ROUTE_POLL_MS);
    this.#flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_ROUTE_FLUSH_MS);
    this.#getUrl = options.getUrl ?? defaultGetUrl;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /** 开始监听。重复调用会先停掉上一次。 */
  start(onChange: (url: string) => void): void {
    this.stop();

    this.#onChange = onChange;
    this.#lastUrl = this.#getUrl();

    this.#timer = setInterval(() => {
      this.checkNow();
    }, this.#pollIntervalMs);

    // 前进/后退能立即感知，不必等下一个轮询周期
    if (typeof globalThis.addEventListener === 'function') {
      this.#popstateHandler = () => {
        this.checkNow();
      };
      globalThis.addEventListener('popstate', this.#popstateHandler);
    }
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#popstateHandler !== null && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('popstate', this.#popstateHandler);
      this.#popstateHandler = null;
    }

    this.#onChange = null;
  }

  /**
   * 立即检查一次 URL 是否变化。轮询与 `popstate` 都走这里。
   *
   * 测试可直接调用，不必等定时器。
   */
  checkNow(): void {
    const url = this.#getUrl();
    if (url === this.#lastUrl) {
      return;
    }

    this.#lastUrl = url;
    this.#pendingUrl = url;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) {
      return;
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;

      const url = this.#pendingUrl;
      this.#pendingUrl = null;

      if (url !== null) {
        this.#onChange?.(url);
      }
    }, this.#flushDelayMs);
  }
}
