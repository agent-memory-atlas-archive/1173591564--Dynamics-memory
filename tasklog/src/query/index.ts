/**
 * 五个查询接口。对应 design/agent-memory-design.md 第 5 节。
 *
 * 共同约束：每个返回都必须带定位符（taskId + sessionId + seq + eventId），
 * 否则 agent 只能整段灌 —— 而整段灌会撞上长上下文衰减。
 *
 * 裁剪规则（第 8 节，机械、零 LLM）：
 *   成功路径只给结果，失败路径给全过程。
 *   成功路径的过程在代码里（代码就是它的产物）；失败路径在世界上不留痕迹，
 *   只有日志有 —— 那才是日志不可替代的部分。
 */

import type { DB } from '../db/open.ts';
import type { EventRow, Locator, SymbolKind, TaskStatus } from '../types.ts';

// ============================================================
// 公共辅助
// ============================================================

export interface EventBrief {
  eventId: number;
  taskId: number | null;
  sessionId: string;
  seq: number;
  ts: number;
  role: string;
  kind: string;
  tool?: string | null;
  outcome?: string | null;
  /** 机械生成的一行摘要，不调用模型 */
  line: string;
  /** 有原文落盘时给出，可用 read_blob 取回 */
  blob?: string | null;
}

function oneLine(s: string | null | undefined, max = 160): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** 优先展示的参数字段，按信息量排序（command/pattern 比 path 更能标识一次调用） */
const ARG_KEYS = [
  'command', 'cmd', 'pattern', 'query', 'q',
  'path', 'file', 'file_path', 'filePath', 'url', 'old', 'new',
];

function argSummary(argsJson: string | null, maxFields = 2, width = 70): string {
  if (!argsJson) return '';
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return oneLine(argsJson, width);
  }
  if (typeof o !== 'object' || o === null) return oneLine(argsJson, width);
  const picked: string[] = [];
  for (const k of ARG_KEYS) {
    if (picked.length >= maxFields) break;
    const v = o[k];
    if (typeof v === 'string' && v.trim()) picked.push(oneLine(v, Math.floor(width / maxFields)));
  }
  if (picked.length === 0) return oneLine(argsJson, width);
  return picked.join(', ');
}

/**
 * 调用签名：用于判断"同一件事"是否后来成功了。
 * 只比 tool_name 太松 —— `npm test` 失败后 `npm run build` 成功，
 * 不代表测试的问题解决了。
 */
export function callSignature(toolName: string | null, argsJson: string | null): string {
  const t = toolName ?? 'tool';
  if (!argsJson) return t;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return `${t}|${argsJson.slice(0, 60)}`;
  }
  for (const k of ['command', 'cmd']) {
    const v = o[k];
    if (typeof v === 'string') {
      // 归一化：保留命令的前 4 个 token（npm test -- login），丢掉易变尾巴
      return `${t}|${v.trim().split(/\s+/).slice(0, 4).join(' ')}`;
    }
  }
  for (const k of ['path', 'file', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
    const v = o[k];
    if (typeof v === 'string') return `${t}|${v}`;
  }
  return `${t}|${JSON.stringify(o).slice(0, 60)}`;
}

/** 骨架行：纯机械拼接，绝不调用模型。 */
function skeletonLine(e: EventRow, max = 160): string {
  switch (e.kind) {
    case 'tool_call':
      return `${e.tool_name ?? 'tool'}(${argSummary(e.args_json, 2, Math.min(90, max - 12))})`;
    case 'tool_result': {
      const size = e.nbytes ? ` ${e.nbytes}B` : '';
      // 大结果：骨架里不铺原文，只给体积与 blob 句柄
      if (e.blob_ref) {
        const h = (e.blob_ref.split(/[/\\]/).pop() ?? '').replace(/\.txt$/, '').slice(0, 16);
        const lines = e.text ? (e.text.match(/共 (\d+) 行/)?.[1] ?? null) : null;
        return `→ ${e.outcome === 'error' ? 'ERROR' : 'ok'}${size}${lines ? ` ${lines} 行` : ''} [blob ${h}]`;
      }
      return e.outcome === 'error'
        ? `→ ERROR ${oneLine(e.text, max - 10)}`
        : `→ ok${size} ${oneLine(e.text, max - 16)}`;
    }
    case 'error':
      return `✗ ${oneLine(e.text, max - 3)}`;
    default:
      return `${e.role}: ${oneLine(e.text, max - 12)}`;
  }
}

function toBrief(e: EventRow, max = 160): EventBrief {
  return {
    eventId: e.id,
    taskId: e.task_id,
    sessionId: e.session_id,
    seq: e.seq,
    ts: e.ts,
    role: e.role,
    kind: e.kind,
    tool: e.tool_name,
    outcome: e.outcome,
    line: skeletonLine(e, max),
    blob: e.blob_ref ? (e.blob_ref.split(/[/\\]/).pop() ?? '').replace(/\.txt$/, '').slice(0, 16) : null,
  };
}

function locator(e: EventRow): Locator {
  return { taskId: e.task_id, sessionId: e.session_id, seq: e.seq, eventId: e.id };
}

/** 被 supersedes 指向的任务 id 集合。检索默认排除它们。 */
function supersededTaskIds(db: DB): Set<number> {
  const rows = db
    .prepare(`SELECT DISTINCT dst FROM task_edges WHERE rel = 'supersedes'`)
    .all() as Array<{ dst: number }>;
  return new Set(rows.map((r) => r.dst));
}

/** FTS5 trigram 查询串转义。少于 3 字符时调用方应回退 LIKE。 */
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

// ============================================================
// 1. list_tasks —— 目录。第一次查询的落脚点。
//    没有它，agent 第一次查询无从下手，只能瞎猜关键词。
// ============================================================

export interface TaskBrief {
  taskId: number;
  /** 稳定身份键，重分段不变。旧引用靠它追踪。 */
  stableKey: string | null;
  title: string | null;
  status: TaskStatus;
  /** 状态是谁定的：none=从未确认，inferred=程序推断，user=人确认过 */
  statusSource: 'none' | 'inferred' | 'user';
  startedTs: number;
  endedTs: number | null;
  branch: string | null;
  commit: string | null;
  boundarySrc: string;
  /** 分段依据的原始证据，与 status 分开。null 表示该任务早于本字段引入。 */
  boundaryEvidence: unknown;
  /** 用户修订过、不参与重分段 */
  locked: boolean;
  /** 已退役的任务仍可解析，指向继任者 */
  retiredAt: number | null;
  successorId: number | null;
  events: number;
  errors: number;
  topPaths: string[];
  superseded: boolean;
  supersededBy?: number[];
}

export interface ListTasksArgs {
  status?: TaskStatus | 'any';
  /** 标题或所含路径的模糊匹配 */
  q?: string;
  /** 只要触碰过该路径/符号的任务 */
  touching?: string;
  sinceTs?: number;
  /** 时间上界，**不含**（`started_ts < untilTs`）。评估防泄漏用。 */
  untilTs?: number;
  /** @deprecated 默认即包含；要排除请用 onlyCurrent */
  includeSuperseded?: boolean;
  /** 只要仍然有效的任务（排除被 supersedes 指向的）。默认 false。 */
  onlyCurrent?: boolean;
  /** 是否包含已退役的任务行。默认 false。 */
  includeRetired?: boolean;
  limit?: number;
}

export function listTasks(db: DB, args: ListTasksArgs = {}): TaskBrief[] {
  const limit = Math.min(args.limit ?? 30, 200);
  const sup = supersededTaskIds(db);

  const where: string[] = [];
  const params: unknown[] = [];
  if (args.status && args.status !== 'any') {
    where.push(`t.status = ?`);
    params.push(args.status);
  }
  if (args.sinceTs) {
    where.push(`t.started_ts >= ?`);
    params.push(args.sinceTs);
  }
  if (args.untilTs !== undefined) {
    // 严格小于：untilTs 是切点，切点当刻及之后都算"未来"。
    // 全库统一这个语义 —— 同名参数在不同接口含义不同，
    // 在防泄漏场景会直接变成漏判。
    where.push(`t.started_ts < ?`);
    params.push(args.untilTs);
  }
  if (args.q) {
    where.push(`(t.title LIKE ? OR t.commit_sha LIKE ?)`);
    params.push(`%${args.q}%`, `${args.q}%`);
  }
  if (args.touching) {
    where.push(/* sql */ `EXISTS (
      SELECT 1 FROM symbols s JOIN events e ON e.id = s.event_id
       WHERE e.task_id = t.id AND LOWER(s.sym) = LOWER(?)
    )`);
    params.push(args.touching);
  }
  if (!args.includeRetired) where.push(`t.retired_at IS NULL`);

  const rows = db
    .prepare(
      /* sql */ `
      SELECT t.*,
             (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id) AS n_events,
             (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id AND e.outcome='error') AS n_err
        FROM tasks t
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.started_ts DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<
    Record<string, unknown> & { id: number; n_events: number; n_err: number }
  >;

  const pathStmt = db.prepare(/* sql */ `
    SELECT s.sym, COUNT(*) n FROM symbols s JOIN events e ON e.id = s.event_id
     WHERE e.task_id = ? AND s.kind = 'path'
     GROUP BY s.sym ORDER BY n DESC LIMIT 5`);
  const bySt = db.prepare(`SELECT src FROM task_edges WHERE dst = ? AND rel='supersedes'`);

  const out: TaskBrief[] = [];
  for (const r of rows) {
    const superseded = sup.has(r.id);
    // 被取代 != 无价值。被取代的任务里往往正好存着"为什么当时那样做、
    // 后来为什么推翻"，默认藏掉等于把最该读的那段删了。
    if (superseded && args.onlyCurrent) continue;
    out.push(rowToBrief(r, superseded, pathStmt, bySt));
  }
  return out;
}

function rowToBrief(
  r: Record<string, unknown> & { id: number; n_events: number; n_err: number },
  superseded: boolean,
  pathStmt: { all: (id: number) => unknown[] },
  bySt: { all: (id: number) => unknown[] },
): TaskBrief {
  return {
    taskId: r.id,
    stableKey: (r.stable_key as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    status: r.status as TaskStatus,
    statusSource: (r.status_source as 'none' | 'inferred' | 'user') ?? 'none',
    startedTs: r.started_ts as number,
    endedTs: (r.ended_ts as number | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    commit: r.commit_sha ? String(r.commit_sha).slice(0, 10) : null,
    boundarySrc: r.boundary_src as string,
    boundaryEvidence: r.boundary_evidence ? safeParse(String(r.boundary_evidence)) : null,
    locked: Number(r.locked ?? 0) === 1,
    retiredAt: (r.retired_at as number | null) ?? null,
    successorId: (r.successor_id as number | null) ?? null,
    events: r.n_events,
    errors: r.n_err,
    topPaths: (pathStmt.all(r.id) as Array<{ sym: string }>).map((x) => x.sym),
    superseded,
    ...(superseded
      ? { supersededBy: (bySt.all(r.id) as Array<{ src: number }>).map((x) => x.src) }
      : {}),
  };
}

/**
 * 按 id 直查任务，包括已退役的。
 *
 * 旧 task_id 必须永远能解析 —— 它可能被写进笔记或别的会话的引用里。
 * 退役的任务返回时带 retiredAt 与 successorId，调用方自行决定跟不跟过去。
 */
export function getTask(db: DB, taskId: number): TaskBrief | null {
  const r = db
    .prepare(
      /* sql */ `
      SELECT t.*,
             (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id) AS n_events,
             (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id AND e.outcome='error') AS n_err
        FROM tasks t WHERE t.id = ?`,
    )
    .get(taskId) as
    | (Record<string, unknown> & { id: number; n_events: number; n_err: number })
    | undefined;
  if (!r) return null;
  const pathStmt = db.prepare(/* sql */ `
    SELECT s.sym, COUNT(*) n FROM symbols s JOIN events e ON e.id = s.event_id
     WHERE e.task_id = ? AND s.kind = 'path'
     GROUP BY s.sym ORDER BY n DESC LIMIT 5`);
  const bySt = db.prepare(`SELECT src FROM task_edges WHERE dst = ? AND rel='supersedes'`);
  return rowToBrief(r, supersededTaskIds(db).has(r.id), pathStmt, bySt);
}

// ============================================================
// 2. search_history —— 点查历史："为什么这样决策"
//    返回形态就是两段式检索本身：事件级精确命中（高精度小粒度），
//    同时带出所属任务（粗粒度容器），任务内其他内容由 agent 用
//    read_events 按需补全。扩展依据是任务归属而非时间邻接。
// ============================================================

export interface SearchHit {
  locator: Locator;
  ts: number;
  score: number;
  matchedBy: ('symbol' | 'fts' | 'vector')[];
  vectorSpan?: { charFrom: number; charTo: number; byteFrom: number; byteTo: number };
  lexicalSpan?: { charFrom: number; charTo: number; byteFrom: number; byteTo: number };
  brief: EventBrief;
  /**
   * 这条命中现在是否仍然成立。
   * superseded 不代表没用：它是"当初这么做、后来被推翻"的唯一记录。
   * 调用方要把它当历史读，而不是当现状读。
   */
  currentValidity: 'current' | 'superseded';
  supersededBy?: number[];
  task: {
    taskId: number | null;
    title: string | null;
    status: string | null;
    statusSource: string | null;
    commit: string | null;
    superseded: boolean;
    /** 与命中级 currentValidity 同值，便于只看 task 字段的调用方 */
    currentValidity: 'current' | 'superseded';
    retired: boolean;
    /** 任务内事件总数，提示 agent 还能展开多少 */
    events: number;
    seqRange: [number, number] | null;
  };
}

export interface SearchArgs {
  query?: string;
  symbols?: string[];
  taskId?: number;
  kinds?: SymbolKind[];
  k?: number;
  /** @deprecated 默认即包含；要排除请用 onlyCurrent */
  includeSuperseded?: boolean;
  /** 只要仍然有效的内容，排除被 supersedes 指向的任务。默认 false。 */
  onlyCurrent?: boolean;
  /**
   * 时间上界（不含）。评估时的防泄漏靠它。
   *
   * 必须下压到候选生成阶段，不能等打完分再过滤：
   * top-k 在过滤前算的话，未来的事件会先占掉名额，
   * 过滤后返回的条数少于 k，而调用方看不出少了。
   */
  untilTs?: number;
  sinceTs?: number;
  vectorHits?: Array<{ eventId: number; score: number; charFrom: number; charTo: number; byteFrom: number; byteTo: number }>;
}

export function searchHistory(db: DB, args: SearchArgs): SearchHit[] {
  const k = Math.min(args.k ?? 8, 50);
  const sup = supersededTaskIds(db);
  const scores = new Map<number, { s: number; by: Set<'symbol' | 'fts' | 'vector'> }>();

  const bump = (id: number, s: number, by: 'symbol' | 'fts' | 'vector') => {
    const cur = scores.get(id) ?? { s: 0, by: new Set<'symbol' | 'fts' | 'vector'>() };
    cur.s += s;
    cur.by.add(by);
    scores.set(id, cur);
  };

  // --- 主路：符号倒排（coding 场景的精确匹配） ---
  const symTerms = new Set<string>(args.symbols ?? []);
  if (args.query) for (const t of tokenizeQuery(args.query)) symTerms.add(t);

  // 时间窗下压到候选生成阶段
  const timeCond: string[] = [];
  const timeParams: unknown[] = [];
  if (args.untilTs !== undefined) {
    timeCond.push('e.ts < ?');
    timeParams.push(args.untilTs);
  }
  if (args.sinceTs !== undefined) {
    timeCond.push('e.ts >= ?');
    timeParams.push(args.sinceTs);
  }
  if (args.taskId !== undefined) {
    timeCond.push('e.task_id = ?');
    timeParams.push(args.taskId);
  }
  const timeJoin = timeCond.length
    ? ` JOIN events e ON e.id = s.event_id AND ${timeCond.join(' AND ')}`
    : '';

  if (symTerms.size > 0) {
    const kindFilter = args.kinds?.length
      ? ` AND s.kind IN (${args.kinds.map(() => '?').join(',')})`
      : '';
    const stmt = db.prepare(/* sql */ `
      SELECT s.event_id AS id, s.kind
        FROM symbols s${timeJoin}
       WHERE LOWER(s.sym) = LOWER(?)${kindFilter}`);
    const kindWeight: Record<string, number> = { path: 3, errcode: 3, test: 2.5, sha: 2, ident: 2 };
    for (const t of symTerms) {
      const rows = stmt.all(...timeParams, t, ...(args.kinds ?? [])) as Array<{
        id: number;
        kind: string;
      }>;
      for (const r of rows) bump(r.id, kindWeight[r.kind] ?? 1, 'symbol');
    }
  }

  // --- 兜底：FTS（接"说不出关键词"的查询） ---
  if (args.query && args.query.trim().length >= 3) {
    try {
      const ftsTime = timeCond.length
        ? ` AND f.rowid IN (SELECT e.id FROM events e WHERE ${timeCond.join(' AND ')})`
        : '';
      const rows = db
        .prepare(
          /* sql */ `
        SELECT f.rowid AS id, bm25(events_fts) AS rank
          FROM events_fts f WHERE events_fts MATCH ?${ftsTime}
         ORDER BY rank LIMIT 200`,
        )
        .all(ftsPhrase(args.query.trim()), ...timeParams) as Array<{ id: number; rank: number }>;
      for (const r of rows) bump(r.id, Math.max(0.2, 2 / (1 + Math.abs(r.rank))), 'fts');
    } catch {
      // trigram 对过短或全符号查询可能抛错，忽略
    }
  }

  const lexicalSpans = new Map<number, { charFrom: number; charTo: number; byteFrom: number; byteTo: number }>();
  const short = args.query?.trim();
  if (short && [...short].length < 3) {
    const filters = timeCond.length ? ` AND ${timeCond.join(' AND ')}` : '';
    if (db.prepare(`SELECT name FROM sqlite_master WHERE name='event_chunks'`).get()) {
      const rows = db.prepare(`SELECT c.event_id AS id,c.char_from,c.char_to,c.byte_from,c.byte_to FROM event_chunks c JOIN (SELECT MIN(c.id) chunk_id FROM event_chunks c JOIN events e ON e.id=c.event_id WHERE instr(c.text,?)>0${filters} GROUP BY c.event_id ORDER BY MAX(e.ts) DESC,c.event_id DESC LIMIT 800) hits ON c.id=hits.chunk_id`).all(short, ...timeParams) as Array<{ id: number; char_from: number; char_to: number; byte_from: number; byte_to: number }>;
      for (const row of rows) {
        bump(row.id, 0.5, 'fts');
        lexicalSpans.set(row.id, { charFrom: row.char_from, charTo: row.char_to, byteFrom: row.byte_from, byteTo: row.byte_to });
      }
    } else {
      const rows = db.prepare(`SELECT e.id FROM events e WHERE instr(COALESCE(e.text,''),?)>0${filters} ORDER BY e.ts DESC,e.id DESC LIMIT 800`).all(short, ...timeParams) as Array<{ id: number }>;
      for (const row of rows) bump(row.id, 0.5, 'fts');
    }
  }
  if (args.query && args.query.trim().length >= 3 && db.prepare(`SELECT name FROM sqlite_master WHERE name='chunks_fts'`).get()) {
    const filters = ['chunks_fts MATCH ?', ...timeCond];
    const params: unknown[] = [ftsPhrase(args.query.trim()), ...timeParams];
    if (args.taskId !== undefined) { filters.push('e.task_id=?'); params.push(args.taskId); }
    const rows = db.prepare(`SELECT c.event_id AS id,c.char_from,c.char_to,c.byte_from,c.byte_to,bm25(chunks_fts) AS rank FROM chunks_fts JOIN event_chunks c ON c.id=chunks_fts.rowid JOIN events e ON e.id=c.event_id WHERE ${filters.join(' AND ')} ORDER BY rank LIMIT 800`).all(...params) as Array<{ id: number; char_from: number; char_to: number; byte_from: number; byte_to: number; rank: number }>;
    for (const row of rows) {
      if (lexicalSpans.has(row.id)) continue;
      lexicalSpans.set(row.id, { charFrom: row.char_from, charTo: row.char_to, byteFrom: row.byte_from, byteTo: row.byte_to });
      if (!scores.get(row.id)?.by.has('fts')) bump(row.id, Math.max(0.2, 2 / (1 + Math.abs(row.rank))), 'fts');
    }
  }
  if (args.vectorHits?.length) {
    [...scores.entries()].sort((a, b) => b[1].s - a[1].s).forEach(([, value], i) => { value.s = 1 / (60 + i + 1); });
    args.vectorHits.forEach((hit, i) => bump(hit.eventId, 1 / (60 + i + 1), 'vector'));
  }
  if (scores.size === 0) return [];

  const getEv = db.prepare(`SELECT * FROM events WHERE id = ?`);
  const taskStmt = db.prepare(
    `SELECT id, title, status, status_source, commit_sha, retired_at FROM tasks WHERE id = ?`,
  );
  const taskStat = db.prepare(
    `SELECT COUNT(*) n, MIN(seq) lo, MAX(seq) hi FROM events WHERE task_id = ?`,
  );

  const ranked = [...scores.entries()].sort((a, b) => b[1].s - a[1].s);
  const out: SearchHit[] = [];
  for (const [eventId, sc] of ranked) {
    if (out.length >= k) break;
    const e = getEv.get(eventId) as EventRow | undefined;
    if (!e) continue;
    if (args.untilTs !== undefined && e.ts >= args.untilTs) continue;
    if (args.sinceTs !== undefined && e.ts < args.sinceTs) continue;
    if (args.taskId !== undefined && e.task_id !== args.taskId) continue;
    const isSup = e.task_id !== null && sup.has(e.task_id);
    // 只有显式要求 only_current 才排除。默认把被取代的内容也端出来并标注 ——
    // "当初为什么这么做、后来为什么改"几乎总是落在被取代的那一段里。
    if (isSup && args.onlyCurrent) continue;

    const t = e.task_id
      ? (taskStmt.get(e.task_id) as
          | {
              id: number;
              title: string | null;
              status: string;
              status_source: string;
              commit_sha: string | null;
              retired_at: number | null;
            }
          | undefined)
      : undefined;
    const st = e.task_id
      ? (taskStat.get(e.task_id) as { n: number; lo: number | null; hi: number | null })
      : { n: 0, lo: null, hi: null };

    const vectorHit = args.vectorHits?.find((h) => h.eventId === eventId);
    out.push({
      locator: locator(e),
      ts: e.ts,
      score: Number(sc.s.toFixed(3)),
      matchedBy: [...sc.by],
      ...(lexicalSpans.has(eventId) ? { lexicalSpan: lexicalSpans.get(eventId)! } : {}),
      ...(vectorHit ? { vectorSpan: { charFrom: vectorHit.charFrom, charTo: vectorHit.charTo, byteFrom: vectorHit.byteFrom, byteTo: vectorHit.byteTo } } : {}),
      brief: toBrief(e),
      currentValidity: isSup ? 'superseded' : 'current',
      ...(isSup
        ? {
            supersededBy: (
              db
                .prepare(`SELECT src FROM task_edges WHERE dst = ? AND rel='supersedes'`)
                .all(e.task_id) as Array<{ src: number }>
            ).map((x) => x.src),
          }
        : {}),
      task: {
        taskId: e.task_id,
        title: t?.title ?? null,
        status: t?.status ?? null,
        statusSource: t?.status_source ?? null,
        commit: t?.commit_sha ? t.commit_sha.slice(0, 10) : null,
        superseded: isSup,
        currentValidity: isSup ? 'superseded' : 'current',
        retired: t?.retired_at != null,
        events: st.n,
        seqRange: st.lo !== null && st.hi !== null ? [st.lo, st.hi] : null,
      },
    });
  }
  return out;
}

/** 从自然语言查询里挑出像符号的 token（零 LLM） */
function tokenizeQuery(q: string): string[] {
  const out = new Set<string>();
  const re = /[A-Za-z_][\w./-]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const t = m[0].replace(/[.,;:]+$/, '');
    if (t.length >= 3) out.add(t);
  }
  return [...out];
}

// ============================================================
// 3. symbol_history —— 某符号的全部历史。纯倒排。
//    这正是向量在 coding 场景干不了的活：
//    get_user_id 与 get_user_ids 的 embedding 几乎重合，倒排里是两个 key。
// ============================================================

export interface SymbolHistoryResult {
  symbol: string;
  kinds: string[];
  total: number;
  timeline: Array<
    EventBrief & {
      taskTitle: string | null;
      superseded: boolean;
      currentValidity: 'current' | 'superseded';
    }
  >;
  /** 因 onlyCurrent 被滤掉的条数，让调用方知道自己看的不是全部 */
  filteredOut: number;
}

export function symbolHistory(
  db: DB,
  sym: string,
  opts: {
    kind?: SymbolKind;
    limit?: number;
    /** @deprecated 默认即包含 */
    includeSuperseded?: boolean;
    onlyCurrent?: boolean;
    /** 时间上界（不含）。评估防泄漏用。 */
    untilTs?: number;
    sinceTs?: number;
  } = {},
): SymbolHistoryResult {
  const limit = Math.min(opts.limit ?? 40, 300);
  const sup = supersededTaskIds(db);
  const kindCond = opts.kind ? ` AND s.kind = ?` : '';
  const params: unknown[] = [sym];
  if (opts.kind) params.push(opts.kind);
  const timeCond: string[] = [];
  const timeParams: unknown[] = [];
  if (opts.untilTs !== undefined) {
    timeCond.push('e.ts < ?');
    timeParams.push(opts.untilTs);
  }
  if (opts.sinceTs !== undefined) {
    timeCond.push('e.ts >= ?');
    timeParams.push(opts.sinceTs);
  }
  const timeWhere = timeCond.length ? ` AND ${timeCond.join(' AND ')}` : '';

  const kinds = (
    db
      .prepare(`SELECT DISTINCT kind FROM symbols WHERE LOWER(sym) = LOWER(?)`)
      .all(sym) as Array<{ kind: string }>
  ).map((r) => r.kind);

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM symbols s JOIN events e ON e.id = s.event_id
          WHERE LOWER(s.sym) = LOWER(?)${kindCond}${timeWhere}`,
      )
      .get(...params, ...timeParams) as { n: number }
  ).n;

  const rows = db
    .prepare(
      /* sql */ `
      SELECT e.*, t.title AS task_title
        FROM symbols s
        JOIN events e ON e.id = s.event_id
        LEFT JOIN tasks t ON t.id = e.task_id
       WHERE LOWER(s.sym) = LOWER(?)${kindCond}${timeWhere}
       ORDER BY e.ts ASC, e.id ASC
       LIMIT ?`,
    )
    .all(...params, ...timeParams, limit) as Array<EventRow & { task_title: string | null }>;

  const kept = rows.filter(
    (e) => !opts.onlyCurrent || e.task_id === null || !sup.has(e.task_id),
  );
  const timeline = kept.map((e) => {
    const isSup = e.task_id !== null && sup.has(e.task_id);
    return {
      ...toBrief(e),
      taskTitle: e.task_title,
      superseded: isSup,
      currentValidity: (isSup ? 'superseded' : 'current') as 'current' | 'superseded',
    };
  });

  return { symbol: sym, kinds, total, timeline, filteredOut: rows.length - kept.length };
}

// ============================================================
// 4. resume_task —— 状态重建："继续完成 XX"
//    不能退化成 search 的一种用法：状态重建要的是完整性和未闭合项，
//    不是相关性。用 top-k 恢复状态会恢复出一个有洞的心智模型，
//    而 agent 不会知道有洞。
// ============================================================

export interface OpenItem {
  kind: 'unresolved_error' | 'todo' | 'dangling_call';
  locator: Locator;
  detail: string;
}

export interface ResumeResult {
  task: TaskBrief | null;
  /** 时间线骨架：每个事件一行 */
  skeleton: EventBrief[];
  /** 骨架是否被截断（任务比 skeletonLimit 长） */
  skeletonTruncated: boolean;
  /** 任务内事件总数 */
  totalEvents: number;
  /** 骨架被截断时，从这里继续读；未截断为 null */
  skeletonNextCursor: string | null;
  /** 尾部原文 —— 始终是真正的最后 N 条，与骨架是否截断无关 */
  tail: Array<EventBrief & { fullText: string | null }>;
  /** 显式未闭合项 */
  openItems: OpenItem[];
  related: { supersedes: number[]; supersededBy: number[]; continues: number[] };
  hint: string;
}

export function resumeTask(
  db: DB,
  taskId: number,
  opts: { tail?: number; skeletonLimit?: number } = {},
): ResumeResult {
  const tailN = Math.min(opts.tail ?? 12, 60);
  const skelN = Math.min(opts.skeletonLimit ?? 400, 2000);

  // 按 id 直查。不要用 listTasks(limit).find()：旧任务排在列表之外就 resume 不到，
  // 而"恢复一个很久以前的任务"恰恰是这个接口存在的理由。
  const brief = getTask(db, taskId) ?? undefined;

  const totalEvents = (
    db.prepare(`SELECT COUNT(*) n FROM events WHERE task_id = ?`).get(taskId) as { n: number }
  ).n;

  // 骨架：从头取 skelN 条
  const head = db
    .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY ts ASC, id ASC LIMIT ?`)
    .all(taskId, skelN) as EventRow[];

  // 尾部：独立一次倒序查询再反转。
  // v1 在这里取 head.slice(-tailN)，于是长任务拿到的是"前 400 条的尾部" ——
  // 看起来像最后状态，其实是任务中段，最容易让人据此做出错误判断。
  const tailRows = (
    db
      .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(taskId, tailN) as EventRow[]
  ).reverse();

  const skeletonTruncated = totalEvents > head.length;
  const lastSkel = head[head.length - 1];

  // --- 裁剪规则：成功路径只给结果，失败路径给全过程 ---
  const status = brief?.status;
  const failing =
    status === 'abandoned' || status === 'open' || status === 'unknown' || (brief?.errors ?? 0) > 0;
  const skeleton = head.map((e) => toBrief(e, failing ? 300 : 160));

  // 未闭合项检测要看全任务，不能只看骨架窗口
  const all =
    skeletonTruncated
      ? (db
          .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY ts ASC, id ASC`)
          .all(taskId) as EventRow[])
      : head;

  const tail = tailRows.map((e) => ({ ...toBrief(e, 400), fullText: e.text }));

  // --- 未闭合项检测（机械） ---
  const openItems: OpenItem[] = [];

  // (a) 报错之后，没有"同一件事"的成功重做
  //     签名取自对应 tool_call 的参数：npm test 失败后 npm build 成功，
  //     不算这个问题解决了。
  const callById = new Map<string, EventRow>();
  for (const e of all) if (e.kind === 'tool_call' && e.call_id) callById.set(e.call_id, e);

  const sigOf = (e: EventRow): string => {
    const origin = e.call_id ? callById.get(e.call_id) : undefined;
    return callSignature(e.tool_name, origin?.args_json ?? e.args_json);
  };

  const errors = all.filter((e) => e.outcome === 'error');
  const after = (a: EventRow, b: EventRow) => a.ts > b.ts || (a.ts === b.ts && a.id > b.id);
  for (const err of errors) {
    const sig = sigOf(err);
    // 用 (ts, id) 判先后，不用 seq —— 同一任务可能横跨多个会话
    const laterOk = all.some((e) => after(e, err) && e.outcome === 'ok' && sigOf(e) === sig);
    if (!laterOk) {
      openItems.push({
        kind: 'unresolved_error',
        locator: locator(err),
        detail: `${sig} → ${oneLine(err.text, 200)}`,
      });
    }
  }

  // (b) 文本里的 TODO / FIXME / 待办
  const todoRe = /\b(TODO|FIXME|XXX|HACK)\b[:：]?\s*([^\n]{0,160})|(?:待办|待修|未完成)[:：]\s*([^\n]{0,160})/gi;
  for (const e of all) {
    if (!e.text) continue;
    todoRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = todoRe.exec(e.text)) !== null) {
      openItems.push({
        kind: 'todo',
        locator: locator(e),
        detail: oneLine(m[0], 200),
      });
      if (openItems.length > 60) break;
    }
  }

  // (c) 发出了 tool_call 但没有对应 tool_result
  const callIds = new Map<string, EventRow>();
  for (const e of all) if (e.kind === 'tool_call' && e.call_id) callIds.set(e.call_id, e);
  for (const e of all) if (e.kind === 'tool_result' && e.call_id) callIds.delete(e.call_id);
  for (const [cid, e] of callIds) {
    openItems.push({
      kind: 'dangling_call',
      locator: locator(e),
      detail: `${e.tool_name ?? 'tool'} 调用未见返回 (call_id=${cid})`,
    });
  }

  const edgesOut = db
    .prepare(`SELECT dst, rel FROM task_edges WHERE src = ?`)
    .all(taskId) as Array<{ dst: number; rel: string }>;
  const edgesIn = db
    .prepare(`SELECT src, rel FROM task_edges WHERE dst = ?`)
    .all(taskId) as Array<{ src: number; rel: string }>;

  const hints: string[] = [];
  if (openItems.length > 0) {
    hints.push(`有 ${openItems.length} 个未闭合项。先处理它们，再看 tail 的最后状态。`);
  } else {
    hints.push('未检出未闭合项。tail 是该任务最后的状态。');
  }
  if (skeletonTruncated) {
    hints.push(
      `骨架只给了前 ${head.length} / ${totalEvents} 条；` +
        `中间 ${totalEvents - head.length - tail.length} 条未展示，` +
        `用 read_events(task_id=${taskId}, cursor="${lastSkel ? encodeCursor(lastSkel) : ''}") 继续读。`,
    );
  }
  if (brief && brief.status === 'unknown') {
    hints.push('该任务状态为 unknown：分段只能证明边界，不能证明完成或放弃，请据 tail 自行判断。');
  }

  return {
    task: brief ?? null,
    skeleton,
    skeletonTruncated,
    totalEvents,
    skeletonNextCursor: skeletonTruncated && lastSkel ? encodeCursor(lastSkel) : null,
    tail,
    openItems,
    related: {
      supersedes: edgesOut.filter((e) => e.rel === 'supersedes').map((e) => e.dst),
      supersededBy: edgesIn.filter((e) => e.rel === 'supersedes').map((e) => e.src),
      continues: edgesOut.filter((e) => e.rel === 'continues').map((e) => e.dst),
    },
    hint: hints.join(' '),
  };
}

// ============================================================
// 5. read_events —— 分页读原文
//    必须是工具式分页读，不是一次性灌入：长上下文在 32K 之后会衰减。
// ============================================================

export interface ReadArgs {
  taskId?: number;
  sessionId?: string;
  seqFrom?: number;
  seqTo?: number;
  limit?: number;
  /**
   * 跨会话游标，形如 "{ts}.{id}"。由上一页的 nextCursor 原样回传。
   * 不要用 seq 分页：seq 只在 session 内唯一，多会话交错时既会漏也会重。
   */
  cursor?: string;
  sinceTs?: number;
  /** 时间上界，**不含**（`ts < untilTs`）。全库统一此语义。 */
  untilTs?: number;
  /** 是否内联 blob 原文（默认否，避免一次拖回几十 KB） */
  inlineBlobs?: boolean;
}

export interface ReadResult {
  events: Array<EventBrief & { text: string | null; args: unknown }>;
  /** 下一页游标，读完为 null */
  nextCursor: string | null;
  /** @deprecated seq 跨会话无序，仅为兼容保留；请用 nextCursor */
  nextSeq: number | null;
  total: number;
}

/** 游标编码：(ts, id) 行值，SQLite 3.15+ 支持元组比较，走 idx_events_global */
function encodeCursor(e: { ts: number; id: number }): string {
  return `${e.ts}.${e.id}`;
}
function decodeCursor(c: string): { ts: number; id: number } | null {
  const m = /^(\d+)\.(\d+)$/.exec(c.trim());
  if (!m) return null;
  return { ts: Number(m[1]), id: Number(m[2]) };
}

export function readEvents(db: DB, args: ReadArgs): ReadResult {
  const limit = Math.min(args.limit ?? 40, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.taskId !== undefined) {
    where.push('task_id = ?');
    params.push(args.taskId);
  }
  if (args.sessionId) {
    where.push('session_id = ?');
    params.push(args.sessionId);
  }
  if (args.seqFrom !== undefined) {
    where.push('seq >= ?');
    params.push(args.seqFrom);
  }
  if (args.seqTo !== undefined) {
    where.push('seq <= ?');
    params.push(args.seqTo);
  }
  if (args.sinceTs !== undefined) {
    where.push('ts >= ?');
    params.push(args.sinceTs);
  }
  if (args.untilTs !== undefined) {
    where.push('ts < ?'); // 严格小于，与 listTasks / searchHistory / symbolHistory 一致
    params.push(args.untilTs);
  }
  const countWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) n FROM events ${countWhere}`).get(...params) as { n: number }
  ).n;

  // 游标条件单独加在 count 之后，让 total 始终是全集大小
  const pageWhere = [...where];
  const pageParams = [...params];
  if (args.cursor) {
    const c = decodeCursor(args.cursor);
    if (c) {
      pageWhere.push('(ts, id) > (?, ?)');
      pageParams.push(c.ts, c.id);
    }
  }
  const w = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';

  // 全局时间序，不是 seq 序
  const rows = db
    .prepare(`SELECT * FROM events ${w} ORDER BY ts ASC, id ASC LIMIT ?`)
    .all(...pageParams, limit + 1) as EventRow[];

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];

  return {
    events: page.map((e) => ({
      ...toBrief(e, 400),
      text: e.text,
      args: e.args_json ? safeParse(e.args_json) : null,
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    nextSeq: hasMore ? (rows[limit]?.seq ?? null) : null,
    total,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ============================================================
// 遥测
// ============================================================

export interface Health {
  events: number;
  tasks: number;
  symbols: number;
  commits: number;
  orphanEvents: number;
  unindexedNonText: number;
  unindexedRate: number;
  supersededTasks: number;
  blobs: number;
}

export function health(db: DB): Health {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const n = (sql: string): number => (one<{ n: number }>(sql)).n;
  const totalNonText = n(`SELECT COUNT(*) n FROM events WHERE kind <> 'text'`);
  const unindexed = n(
    `SELECT COUNT(*) n FROM events e WHERE e.kind <> 'text'
       AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.event_id = e.id)`,
  );
  return {
    events: n(`SELECT COUNT(*) n FROM events`),
    tasks: n(`SELECT COUNT(*) n FROM tasks`),
    symbols: n(`SELECT COUNT(*) n FROM symbols`),
    commits: n(`SELECT COUNT(*) n FROM commits`),
    orphanEvents: n(`SELECT COUNT(*) n FROM events WHERE task_id IS NULL`),
    unindexedNonText: unindexed,
    unindexedRate: totalNonText ? Number((unindexed / totalNonText).toFixed(4)) : 0,
    supersededTasks: n(`SELECT COUNT(DISTINCT dst) n FROM task_edges WHERE rel='supersedes'`),
    blobs: n(`SELECT COUNT(*) n FROM events WHERE blob_ref IS NOT NULL`),
  };
}
