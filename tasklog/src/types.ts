/**
 * 核心类型。对应 design/agent-memory-design.md 第 3 节。
 *
 * 设计原则：没有 Memory 类型，没有 Summary 类型。
 * 全部是事实（events）加索引（tasks / symbols / fts）。
 */

export type Role = 'user' | 'assistant' | 'tool' | 'system';

/**
 * 事件种类。最细粒度单元是事件，不是对话 —— coding agent 一轮里
 * 文本部分常是客套话，有判别力的内容在 tool_call 的参数和 tool_result 里。
 */
export type EventKind = 'text' | 'tool_call' | 'tool_result' | 'error';

export type Outcome = 'ok' | 'error';

export interface EventInput {
  sessionId: string;
  /** 会话内单调序号。与 sessionId 构成唯一键，重复写入幂等。 */
  seq: number;
  /** epoch ms。最细粒度时间戳。 */
  ts: number;
  role: Role;
  kind: EventKind;
  toolName?: string | null;
  /** tool_result 借此指回它的 tool_call */
  callId?: string | null;
  /** tool_call 的完整参数 */
  args?: unknown;
  /** 文本内容。大结果只存摘要行，原文走 blobRef。 */
  text?: string | null;
  /** 大结果的落盘路径 */
  blobRef?: string | null;
  /** 原始结果字节数（即使内容落盘也记录） */
  nbytes?: number | null;
  outcome?: Outcome | null;

  // ---- 来源标识：严格区分"原始记录"与"我们推断出来的" ----
  /** 宿主名，如 'opencode'。来自哪个系统的原始日志。 */
  source?: string | null;
  /**
   * 宿主里这条记录的稳定 id（OpenCode 的 part id）。
   * 这是导入幂等的真正依据 —— seq 是我们算的，会随宿主补写而整体位移。
   */
  sourceId?: string | null;
  /**
   * 宿主的完整原始标识与时间戳，原样保留，不做归一化。
   * 任何推断出来的字段（seq、kind 映射、outcome 判定）都不写进这里，
   * 以便事后能分辨哪些是日志里本来就有的、哪些是导入器猜的。
   */
  sourceRef?: Record<string, unknown> | null;
}

export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  ts: number;
  task_id: number | null;
  role: Role;
  kind: EventKind;
  tool_name: string | null;
  call_id: string | null;
  args_json: string | null;
  text: string | null;
  blob_ref: string | null;
  nbytes: number | null;
  outcome: Outcome | null;
  source?: string | null;
  source_id?: string | null;
  source_ref?: string | null;
}

/**
 * 任务状态。
 *
 * unknown 是默认值，也是绝大多数任务的真实状态：
 * 有 commit 不证明任务完成，没 commit 不证明被放弃。
 * 只有 setTaskStatus 能把它改成别的值，并记下 status_source。
 */
export type TaskStatus = 'unknown' | 'open' | 'done' | 'abandoned';

/**
 * 边界来源。必须保留：边界是推断出来的、允许事后修订。
 * 原文是事实，边界只是索引 —— 索引错了可以重建。
 * 这是本方案相对压缩方案的核心退路。
 */
export type BoundarySource = 'git' | 'heuristic' | 'user';

export interface TaskRow {
  id: number;
  title: string | null;
  started_ts: number;
  ended_ts: number | null;
  status: TaskStatus;
  branch: string | null;
  commit_sha: string | null;
  boundary_src: BoundarySource;
}

/** parent: 嵌套；continues: 回溯续做；supersedes: src 取代 dst */
export type TaskRel = 'parent' | 'continues' | 'supersedes';

/**
 * 符号类型。这是日志与代码之间的确定性 join key。
 * 一个事件的可检索内容不是它那句自然语言，而是它碰过哪些东西。
 */
export type SymbolKind = 'path' | 'ident' | 'errcode' | 'sha' | 'test';

export interface ExtractedSymbol {
  sym: string;
  kind: SymbolKind;
}

export interface GitCommit {
  sha: string;
  ts: number;
  author: string;
  subject: string;
  body: string;
  branch: string | null;
  files: string[];
  /** 从 message 解析出的被回滚 commit（Revert "..." / This reverts commit <sha>） */
  revertsSha: string | null;
}

/** 查询返回里必须带的定位符，否则 agent 只能整段灌 */
export interface Locator {
  taskId: number | null;
  sessionId: string;
  seq: number;
  eventId: number;
}
