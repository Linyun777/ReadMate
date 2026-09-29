/**
 * DOM 变动监听：动态内容接入翻译链路（方案第 13 节）。
 *
 * 只负责「发现变动、归到该重新分段的容器」；
 * 分段与翻译分别由 `core/segmenter` 与 `core/queue` 负责。
 */

export {
  DEFAULT_MUTATION_FLUSH_MS,
  type MutationObserverFactory,
  type MutationObserverLike,
  type MutationRecordLike,
  MutationWatcher,
  type MutationWatcherOptions,
} from './mutation-watcher';
