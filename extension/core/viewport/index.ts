/**
 * 视口追踪：决定「哪些 Block 现在值得翻译」（方案第 65、66 节）。
 *
 * 属于调度范畴（**何时发**），因此与 `core/queue` 同侧；
 * 但不与 queue 耦合——它只产出「现在该翻哪些 Block」的批次。
 */

export {
  DEFAULT_FLUSH_DELAY_MS,
  DEFAULT_LOOKAHEAD_SCREENS,
  type ObserverEntryLike,
  type ObserverFactory,
  type ObserverLike,
  ViewportTracker,
  type ViewportTrackerOptions,
} from './viewport-tracker';
