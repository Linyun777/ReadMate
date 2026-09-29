/**
 * 翻译队列：并发控制、重试调度、失败降级。
 *
 * **这是全项目唯一的调度点**（方案第 86.7 节）。
 * background 只做无状态请求转发，禁止在那里再实现并发或排队。
 */

export {
  countTranslated,
  type QueueRunResult,
  TranslationQueue,
  type TranslationQueueOptions,
} from './translation-queue';
