/**
 * Translator：Block → Context Group → Batch → 线上请求（方案第 55、86.7 节）。
 *
 * 职责边界：
 *   - 决定「**发什么**」：上下文分组、批次划分、优先级排序、线上格式映射
 *   - **不负责**并发、重试与降级（那是 `core/queue`，唯一调度点）
 *   - **不负责**写 DOM（那是 `core/renderer`）
 *
 * 本模块只产出纯数据，不发请求。
 */

export {
  type BatchOptions,
  itemWeight,
  planBatches,
  type TranslationBatch,
} from './batching';
export {
  buildContextGroups,
  type ContextGroup,
  type ContextGroupOptions,
  indexContextByBlock,
} from './context';
export {
  isNavigationBlock,
  type PriorityOptions,
  type Rect,
  sortByPriority,
  viewportDistance,
} from './priority';
export {
  requestConfig,
  requestExplain,
  requestHealth,
  requestNote,
  requestSummary,
  requestTranslation,
  requestUsage,
  type ServerClientOptions,
  ServerError,
  updateConfig,
} from './server-client';
export {
  buildTasks,
  fetchHealthViaBackground,
  type PlannedBatch,
  planTranslation,
  sendViaBackground,
  type TranslationPlan,
  type TranslatorOptions,
} from './translator';
export {
  fromWireResponse,
  fromWireResult,
  isWireTranslateResponse,
  toWireItem,
  toWireRequest,
} from './wire';
