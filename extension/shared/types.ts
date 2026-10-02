/**
 * 跨模块共享类型。
 *
 * 依据：方案第 44 节（TypeScript 重点约束的类型清单）、第 86.1 节（占位符方案）、
 *       第 86.5 节（API Schema）、第 11 节（节点状态）、第 75 节（页面状态生命周期）。
 *
 * 约定：所有跨模块的类型集中在本文件，不重复定义（AGENTS.md §6）。
 */

/* ------------------------------------------------------------------ *
 * 翻译状态与显示模式
 * ------------------------------------------------------------------ */

export type TranslationStatus = 'UNTRANSLATED' | 'QUEUED' | 'TRANSLATING' | 'TRANSLATED' | 'FAILED';

/** 页面级状态，用于 Popup 展示（方案第 75 节） */
export type PageState = 'IDLE' | 'SCANNING' | 'TRANSLATING' | 'ACTIVE' | 'PAUSED' | 'RESTORED';

export type DisplayMode = 'original' | 'bilingual' | 'chinese';

export type TranslationStyle = 'natural' | 'technical' | 'academic' | 'literal';

/* ------------------------------------------------------------------ *
 * 分段与占位符（方案第 86.1 节）
 * ------------------------------------------------------------------ */

export type BlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'inline';

export type PlaceholderKind = 'pair' | 'atom';

/**
 * 占位符与 DOM 的绑定。
 *
 * pair：形如 `<0> ... </0>`，包裹一个 inline 元素（a / strong / em / code / span ...）
 * atom：形如 `<0/>`，替换一个不可翻译的独立结构（br / CSS 保留的换行 / 内联 SVG ...）
 */
export interface PlaceholderBinding {
  index: number;
  kind: PlaceholderKind;
  /** pair 占位符对应的 inline 元素 */
  element?: Element;
  /** atom 占位符对应的原始节点 */
  node?: Node;
}

/**
 * 翻译单元。对应 API 的 `items[].id`。
 *
 * `range`：**只在容器被拆成多段时存在**（超长容器，见
 * `core/segmenter/blocks.ts` 的 `planChunks`）。切点只在子节点之间，
 * 绝不切开文本节点——否则原文无法逐字节恢复（铁律 4）。
 *
 * 为什么需要它：一个 3000+ 字符的容器会长出 1000+ output token 的译文，
 * 整块一次性到达，首屏要等几十秒。拆段后每段译文短、**先到的先渲染**。
 */
export interface BlockRange {
  /** 本段包含的容器直接子节点。按文档顺序，切成若干互不重叠的连续段 */
  nodes: Node[];
}

/**
 * 翻译单元。对应 API 的 `items[].id`。
 *
 * 两个文本字段的分工：
 *
 * - `text`：**含占位符**，是提交给模型的内容，也是缓存键的依据
 *   （它才是真正决定译文的东西——同一段 DOM 结构变化会体现在占位符上）
 * - `plainText`：不含占位符、且**排除不可翻译内容**（`code` / `pre` 等）的纯文本，
 *   仅用于「这段值不值得翻译」的判定与日志。因此它可能比页面上看到的文本短。
 *
 * 注意：本结构**不是可序列化的数据传输对象**——`element` 与 `placeholders`
 * 持有 DOM 引用。真正发给 FastAPI 的只有 `{ id, text }`。
 */
export interface TranslationBlock {
  id: string;
  nodeIds: string[];
  text: string;
  plainText: string;
  tagName?: string;
  blockType: BlockType;
  placeholders: PlaceholderBinding[];
  /** Block 的 DOM 容器。Renderer 用它回填译文、插入双语节点、恢复原文 */
  element: Element;
  /**
   * 容器被拆成多段时的节点范围。缺失表示「本块管整个容器」。
   *
   * ⚠️ 有了它之后，**块的身份是「容器 + 首个节点」**——见
   * `core/store/page-store.ts` 的 `blockAnchor`。
   */
  range?: BlockRange;
}

/* ------------------------------------------------------------------ *
 * 页面状态与 Block 条目（方案第 11、75 节）
 * ------------------------------------------------------------------ */

/**
 * Block 在页面上的完整状态。
 *
 * 分工：`TranslationBlock` 描述「翻译什么」，`BlockEntry` 描述
 * 「它在页面上的位置、当前状态与结果」。
 */
export interface BlockEntry {
  block: TranslationBlock;
  status: TranslationStatus;
  /** 译文（含占位符）。仅在 `TRANSLATED` 时存在 */
  translation?: string;
  /** 最近一次失败原因。仅在 `FAILED` 时存在 */
  error?: string;
}

/** 进度统计，供 Popup 展示（方案第 75 节）。 */
export interface BlockStats {
  total: number;
  untranslated: number;
  queued: number;
  translating: number;
  translated: number;
  failed: number;
  /** 已终结（translated + failed）占比，取值 0~1 */
  progress: number;
}

/* ------------------------------------------------------------------ *
 * 与 FastAPI 的接口契约（方案第 86.5 节）
 * ------------------------------------------------------------------ */

export interface TranslationItem {
  id: string;
  text: string;
}

export interface TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  style: TranslationStyle;
  /** 整篇文章共享的上下文标识（per-Article，方案第 86.6 节） */
  contextId?: string;
  /** 整篇文章共享的上下文文本 */
  context?: string;
  items: TranslationItem[];
}

export interface TranslationResult {
  id: string;
  source: string;
  translation: string;
}

export interface TranslationResponse {
  contextId?: string;
  promptVersion: string;
  model: string;
  items: TranslationResult[];
}

/* ------------------------------------------------------------------ *
 * 线上格式（wire format）
 *
 * 与 FastAPI 交换的实际结构，**snake_case**（方案第 16.2、86.5 节）。
 * 扩展内部用 camelCase，映射在 `core/translator/wire.ts`。
 *
 * 放在 shared 而非 translator 模块内，是因为它需要同时被
 * content script（映射）与 background（转发）使用。
 * ------------------------------------------------------------------ */

export interface WireTranslationItem {
  id: string;
  text: string;
}

export interface WireTranslateRequest {
  source_language: string;
  target_language: string;
  style: string;
  context_id?: string;
  context?: string;
  items: WireTranslationItem[];
}

export interface WireTranslationResult {
  id: string;
  source: string;
  translation: string;
}

export interface WireTranslateResponse {
  context_id: string | null;
  prompt_version: string;
  model: string;
  items: WireTranslationResult[];
}

/**
 * 发送一次翻译请求。
 *
 * 生产实现由 background 转发（`core/translator/server-client`），
 * 测试与本地调试可注入替身。
 */
export type SendTranslationRequest = (
  payload: WireTranslateRequest,
) => Promise<WireTranslateResponse>;

/* ------------------------------------------------------------------ *
 * 流式翻译（方案第 86.9 节）
 * ------------------------------------------------------------------ */

/**
 * 后端下发的一个流式事件，也是 background 通过 Port 回传给
 * content script 的单位。
 *
 * `item` 一定是**完整且已校验占位符**的条目——后端保证不会下发半截内容。
 */
export type TranslationStreamEvent =
  | { type: 'item'; id: string; source: string; translation: string }
  | { type: 'done'; prompt_version: string; model: string }
  | { type: 'error'; reason: string };

/**
 * 流式翻译的接收端。
 *
 * 与 `SendTranslationRequest` 的区别：条目**边到边回调**，
 * 而不是等全部完成才返回。
 */
export interface TranslationStreamSink {
  onItem(item: TranslationStreamItem): void;
  onDone(meta: TranslationStreamMeta): void;
  onError(reason: string): void;
}

export interface TranslationStreamItem {
  id: string;
  source: string;
  translation: string;
}

export interface TranslationStreamMeta {
  promptVersion: string;
  model: string;
}

/** 发起一次流式翻译，返回可用于取消的句柄。 */
export type StreamTranslationRequest = (
  payload: WireTranslateRequest,
  sink: TranslationStreamSink,
) => { cancel(): void };

/** content script 在收到命令时回传的页面状态。 */
export interface ContentScriptState {
  state: PageState;
  /** 当前页面标题，用于在 Popup 上确认「连到了哪个页面」 */
  title: string;
  /** 当前显示模式。Popup 据此同步单选按钮 */
  mode: DisplayMode;
  /** 进度统计。Popup 据此展示「已翻译 N/M 段」 */
  stats: BlockStats;
  /**
   * 一条失败原因（可能缺省）。
   *
   * ⚠️ 可选是**刻意的**：扩展重新加载后，已打开页面里还跑着旧版本的
   * content script（见 `shared/extension-context.ts`），它不会带这个字段。
   * 界面一律按「可能没有」处理，不要写 `state.failureReason.length`。
   */
  failureReason?: string;
}

export interface HealthResponse {
  status: string;
  provider: string;
  /** 翻译用的模型名。与翻译响应里的 `model` 一致，参与缓存键计算 */
  model: string;
  /**
   * 总结 / 学习笔记用的模型名。
   *
   * 仅用于展示与排查，**不参与缓存键**——所以它是可选的，
   * 服务端旧版本不返回它也不会出问题。
   */
  summaryModel?: string;
  promptVersion: string;
}

/* ------------------------------------------------------------------ *
 * 配置与缓存（方案第 23、86.8 节）
 * ------------------------------------------------------------------ */

/**
 * 扩展设置（方案第 39 节）。
 *
 * 持久化在 `chrome.storage.local`，刷新浏览器后仍在。
 *
 * **不含 API Key**：Key 只存在于服务端 `.env`（方案第 52 节原则三）。
 */
export interface ExtensionSettings {
  /** FastAPI 服务地址 */
  serverUrl: string;
  targetLanguage: string;
  style: TranslationStyle;
  /** 新页面默认使用的显示模式 */
  displayMode: DisplayMode;
  /**
   * 估算成本用的单价（元 / 百万 token）。留 0 表示不估算。
   *
   * **为什么单价在客户端而不是服务端**：token 数是事实，价格是外部输入
   * 且会变。把价格写进服务端 API，等于「官方一调价，API 就开始说谎」。
   * 所以 `/api/v1/usage` 只报 token，金额由扩展按用户填的单价算。
   */
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

/* ------------------------------------------------------------------ *
 * 运行时配置（模型服务）
 * ------------------------------------------------------------------ */

/** `GET /api/v1/config` 的响应。**不含 API Key**，只有一个「有没有」的布尔值。 */
export interface WireConfigResponse {
  provider: string;
  baseUrl: string;
  model: string;
  summaryModel: string;
  hasApiKey: boolean;
}

/**
 * `PUT /api/v1/config` 的请求体。
 *
 * 未传的字段保持不变；`apiKey` 传空串同样表示不修改。
 */
export interface WireConfigUpdate {
  baseUrl?: string;
  model?: string;
  summaryModel?: string;
  apiKey?: string;
}

/* ------------------------------------------------------------------ *
 * 用量（成本可见性）
 * ------------------------------------------------------------------ */

/** 按维度拆分的用量。 */
export interface WireUsageBucket {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** `GET /api/v1/usage` 的响应。**只含 token，不含金额。** */
export interface WireUsageResponse {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  by_endpoint: Record<string, WireUsageBucket>;
  by_model: Record<string, WireUsageBucket>;
  first_at: string | null;
  last_at: string | null;
  ledger_path: string;
}

/**
 * 参与缓存键计算的环境信息（方案第 86.8 节）。
 *
 * 由 `/api/v1/health` 提供。`provider` 与 `promptVersion` 是**必须项**：
 * 前者避免切换 Provider 后复用不兼容的译文，后者保证修改 Prompt 后旧缓存自动失效。
 *
 * **绝不包含 API Key。**
 */
export interface CacheContext {
  provider: string;
  model: string;
  promptVersion: string;
}

/** 一条缓存记录。存储键由 `cacheKey()` 生成，因此这里不再冗余存键。 */
export interface CacheEntry {
  /** 译文 */
  translation: string;
  /** 写入时间戳（毫秒） */
  createdAt: number;
  /** 最近命中时间戳（毫秒）。LRU 淘汰依据 */
  lastUsedAt: number;
}

export interface CacheStats {
  /** 条目数 */
  count: number;
  /** 估算体积（字节），按 JSON 序列化长度计 */
  bytes: number;
  /** 上限 */
  maxEntries: number;
  /** 过期天数 */
  ttlDays: number;
}

/** 导出 / 导入用的格式（方案第 86.8 节的「附带能力」）。 */
export interface CacheDump {
  version: number;
  exportedAt: number;
  entries: Record<string, CacheEntry>;
}

/* ------------------------------------------------------------------ *
 * 站点适配（方案第 64 节）
 * ------------------------------------------------------------------ */

export interface SiteAdapter {
  matches(url: URL): boolean;
  getRoot(): HTMLElement;
  shouldIgnore(node: Node): boolean;
}

/* ------------------------------------------------------------------ *
 * 消息协议（方案第 8.1、55 节）
 * ------------------------------------------------------------------ */

/**
 * 阅读视图的正文载荷（方案第 62 节）。
 *
 * 由 content script 提取、background 中转、阅读视图页消费。
 * 因为体积可能很大，走 `chrome.storage.session` 而不是消息体。
 */
export interface ReaderPayload {
  title: string;
  /** Readability 生成的正文 HTML */
  content: string;
  /**
   * 正文纯文本。
   *
   * 单独带一份而不是从 `content` 里剥标签：提取时 Readability 已经算好了
   * `textContent`，再剥一遍既浪费又容易和它的口径不一致。
   * 总结直接用这一份——HTML 标签对模型是噪声。
   */
  text: string;
  url: string;
}

/**
 * 请求打开阅读视图。
 *
 * content script 提取完正文后发这条消息，background 存下载荷并打开阅读视图页。
 * 提取本身必须在 content script 做——background 拿不到页面 DOM。
 */
/**
 * 请求在页面里提取正文并打开阅读视图。
 *
 * 由 Popup 发出，经 background 转发给 content script——
 * 提取必须在页面上下文里做（background 拿不到 DOM）。
 */
export interface ExtractReaderMessage extends BaseMessage {
  type: 'EXTRACT_READER';
}

export interface OpenReaderMessage extends BaseMessage {
  type: 'OPEN_READER_MODE';
  payload: ReaderPayload;
}

/* ------------------------------------------------------------------ *
 * AI 解释（方案第 29、41 节）
 * ------------------------------------------------------------------ */

/** 解释请求的线上格式（对应 `POST /api/v1/explain`）。 */
export interface WireExplainRequest {
  selection: string;
  context?: string;
  language?: string;
  url?: string;
}

export interface WireExplainResponse {
  explanation: string;
  model: string;
  prompt_version: string;
}

/**
 * 请求解释当前选中内容。
 *
 * 由 background 在右键菜单点击后发出，转发给 content script——
 * **选区与上下文只有 content script 能读到**。
 */
export interface ExplainSelectionMessage extends BaseMessage {
  type: 'EXPLAIN_SELECTION';
}

/** content script 交给 background 去请求服务端的载荷。 */
export interface FetchExplainMessage extends BaseMessage {
  type: 'FETCH_EXPLAIN';
  payload: WireExplainRequest;
}

/* ------------------------------------------------------------------ *
 * 页面总结（方案第 32 节的 V3 规划）
 * ------------------------------------------------------------------ */

/** 总结请求的线上格式（对应 `POST /api/v1/summary`）。 */
export interface WireSummaryRequest {
  text: string;
  title?: string;
  language?: string;
  url?: string;
}

export interface WireSummaryResponse {
  /** 一句话主旨 */
  gist: string;
  /** 关键点列表，可能为空 */
  points: string[];
  model: string;
  prompt_version: string;
}

/**
 * 请求总结当前页面。
 *
 * 正文由 content script 用 Readability 提取后交给 background 请求服务端——
 * 提取必须在页面上下文里做。
 */
export interface SummarizePageMessage extends BaseMessage {
  type: 'SUMMARIZE_PAGE';
}

/** content script 交给 background 去请求服务端的总结载荷。 */
export interface FetchSummaryMessage extends BaseMessage {
  type: 'FETCH_SUMMARY';
  payload: WireSummaryRequest;
}

/**
 * 总结当前选中的内容（方案第 32 节的第一层）。
 *
 * 与 `SUMMARIZE_PAGE` 的区别只在**取哪段文字**：
 * 那个走 Readability 提取整篇，这个用用户选中的部分。
 * 服务端与 Prompt 完全共用——「总结」这件事不因为来源不同而不同。
 */
export interface SummarizeSelectionMessage extends BaseMessage {
  type: 'SUMMARIZE_SELECTION';
}

/* ------------------------------------------------------------------ *
 * 学习笔记（方案第 32 节）
 * ------------------------------------------------------------------ */

/** 笔记请求的线上格式（对应 `POST /api/v1/note`）。 */
export interface WireNoteRequest {
  text: string;
  title?: string;
  language?: string;
  url?: string;
}

export interface WireNoteConcept {
  term: string;
  explanation: string;
}

export interface WireNoteSection {
  heading: string;
  points: string[];
}

/**
 * 学习笔记。
 *
 * 与 `WireSummaryResponse` 的区别不是字段多少，而是**目标不同**：
 * 总结是压缩（读完知道大概），笔记是重组（日后能捡起来）。
 */
export interface WireNoteResponse {
  /** 一句话定位：这是什么、讲什么 */
  positioning: string;
  /** 核心概念。日后真正要反复查的是术语 */
  concepts: WireNoteConcept[];
  /** 分节要点，保留文章的组织 */
  outline: WireNoteSection[];
  /** 值得记住的结论 */
  takeaways: string[];
  model: string;
  prompt_version: string;
}

/** content script 交给 background 去请求服务端的笔记载荷。 */
export interface FetchNoteMessage extends BaseMessage {
  type: 'FETCH_NOTE';
  payload: WireNoteRequest;
}

/** 读取服务端的累计用量。 */
export interface FetchUsageMessage extends BaseMessage {
  type: 'FETCH_USAGE';
}

export type MessageType =
  | 'TRANSLATE_PAGE'
  | 'SET_DISPLAY_MODE'
  | 'RESTORE_PAGE'
  | 'GET_PAGE_STATE'
  | 'FETCH_TRANSLATION'
  | 'FETCH_HEALTH'
  | 'OPEN_READER_MODE'
  | 'EXTRACT_READER'
  | 'EXPLAIN_SELECTION'
  | 'FETCH_EXPLAIN'
  | 'SUMMARIZE_PAGE'
  | 'FETCH_SUMMARY'
  | 'SUMMARIZE_SELECTION'
  | 'FETCH_NOTE'
  | 'FETCH_USAGE';

export interface BaseMessage {
  source: 'ai-web-translator';
  type: MessageType;
  requestId: string;
}

export interface TranslatePageMessage extends BaseMessage {
  type: 'TRANSLATE_PAGE';
}

export interface SetDisplayModeMessage extends BaseMessage {
  type: 'SET_DISPLAY_MODE';
  mode: DisplayMode;
}

export interface RestorePageMessage extends BaseMessage {
  type: 'RESTORE_PAGE';
}

export interface GetPageStateMessage extends BaseMessage {
  type: 'GET_PAGE_STATE';
}

/**
 * 由 content script 发往 background 的请求转发。
 *
 * background 是无状态转发层（方案第 86.7 节）：**只把 payload 原样发给 FastAPI**，
 * 不做排队、并发控制，也不做 camelCase ↔ snake_case 映射
 * （映射是翻译语义，属于 content script 的 `core/translator`）。
 */
export interface FetchTranslationMessage extends BaseMessage {
  type: 'FETCH_TRANSLATION';
  payload: WireTranslateRequest;
}

/**
 * 探测本地服务。
 *
 * content script 不能直接 fetch（受页面 CSP 的 `connect-src` 限制），
 * 但它需要 `provider` / `model` / `promptVersion` 来算缓存键（方案第 86.8 节），
 * 因此健康检查也必须经 background 转发。
 */
export interface FetchHealthMessage extends BaseMessage {
  type: 'FETCH_HEALTH';
}

export type ExtensionMessage =
  | TranslatePageMessage
  | SetDisplayModeMessage
  | RestorePageMessage
  | GetPageStateMessage
  | FetchTranslationMessage
  | FetchHealthMessage
  | OpenReaderMessage
  | ExtractReaderMessage
  | ExplainSelectionMessage
  | FetchExplainMessage
  | SummarizePageMessage
  | FetchSummaryMessage
  | SummarizeSelectionMessage
  | FetchNoteMessage
  | FetchUsageMessage;

export interface MessageResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /**
   * 该失败是否值得重试。
   *
   * 必须跨消息边界传递——`core/queue` 据此决定是否重试（方案第 73 节）。
   * 丢了它，网络错误与 429 都会被当成确定性失败而放弃重试。
   */
  retryable?: boolean;
}
