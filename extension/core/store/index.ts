/**
 * 页面状态存储：Block ↔ DOM 绑定、状态机与进度统计。
 *
 * 消费者：
 *   - `core/translator` 读取待翻译的 Block，回写译文
 *   - `core/renderer` 依据状态与译文写 DOM
 *   - `core/queue` 按状态调度
 *   - `entrypoints/popup` 通过消息读取 `stats()` 展示进度
 */

export { getPageStore, PageStore, resetPageStore } from './page-store';
