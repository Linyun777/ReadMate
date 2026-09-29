/**
 * SPA 路由变化监听（方案第 74 节）。
 *
 * 只负责「URL 变了」这一件事；清理旧状态与重新分段由 `core/controller` 负责。
 */

export {
  DEFAULT_ROUTE_FLUSH_MS,
  DEFAULT_ROUTE_POLL_MS,
  RouteWatcher,
  type RouteWatcherOptions,
} from './route-watcher';
