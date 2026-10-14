/**
 * OpenCode 日志适配器。
 *
 * 只支持这一个宿主。同时支持所有客户端会让每个客户端都只支持一半 ——
 * 真正的成本不在读文件，在于弄清每个宿主怎么表示"工具调用失败了"。
 *
 * ============================================================
 * 关于 OpenCode 的存储格式（截至 1.18，schema 是内部的、不稳定）
 * ============================================================
 *  - 1.17 起：单一 SQLite 文件 opencode.db
 *      session(id, project_id, parent_id, directory, title, version, slug,
 *              path, model JSON, time_created ms, time_updated, time_archived, ...)
 *      message(id, session_id, time_created, data JSON{role, modelID, providerID, ...})
 *      part(id, message_id, session_id, time_created, data JSON{type, text, ...})
 *    part 的 type 包括 text / reasoning / tool / patch / file / step-start / step-finish
 *  - 1.17 之前：JSON 文件树
 *      storage/session/{projectHash}/{sessionID}.json
 *      storage/message/{sessionID}/msg_{messageID}.json
 *      storage/part/{sessionID}/{messageID}/{partID}.json
 *  - 大工具输出旁路到 tool-output/tool_<id>，被 part 引用
 *
 * 因为 schema 不保证稳定，下面所有 JSON 字段访问都是防御式的：
 * 读不到就记进 warnings，不猜、不静默填默认值。
 * 特别是 session.model 是 JSON 对象不是字符串。
 *
 * ============================================================
 * 原始记录 vs 推断元数据
 * ============================================================
 * 原样保留（写进 events 主字段与 source_ref）：
 *   用户与助手原文、工具参数 / 返回 / 错误、
 *   宿主的 session / message / part id、宿主自己的时间戳、模型标识。
 * 我们推断的（只进主字段，并在 source_ref.inferred 里标明）：
 *   seq（宿主没有全局序号）、kind 映射、outcome 判定、
 *   仓库 / 分支 / commit（来自 session.directory 处的 git，不是日志内容）。
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db/open.ts';
import { Ingestor } from '../ingest/events.ts';
import type { EventInput, Role } from '../types.ts';

export const SOURCE = 'opencode';

export interface OpenCodeOptions {
  /** opencode.db 路径。不给则按官方规则自动定位。 */
  dbPath?: string;
  /** 旧版 JSON 布局的 storage 目录。与 dbPath 二选一。 */
  storageDir?: string;
  /** 只导入这些 session id */
  sessions?: string[];
  /** 只导入工作目录匹配该前缀的 session（按项目过滤） */
  directoryPrefix?: string;
  /** 只导入这个时间之后的（增量追加） */
  sinceTs?: number;
  /** 是否尝试从 session.directory 读 git 信息。默认 true。 */
  readGit?: boolean;
  /** 跳过 reasoning part。默认 false —— 推理过程里常有"为什么不这么做"。 */
  skipReasoning?: boolean;
}

export interface ImportReport {
  source: 'opencode';
  layout: 'sqlite' | 'json' | 'none';
  hostPath: string | null;
  hostVersions: string[];
  sessions: number;
  messages: number;
  parts: number;
  /** 实际写入 tasklog 的事件数 */
  events: number;
  inserted: number;
  skipped: number;
  /** 按 part type 统计，用来发现没被映射的新类型 */
  partTypes: Record<string, number>;
  unmappedTypes: string[];
  repos: Array<{ directory: string; branch: string | null; head: string | null }>;
  warnings: string[];
}

// ============================================================
// 定位
// ============================================================

/** 按 OpenCode 官方规则定位 DB。`opencode db path` 也能打印。 */
export function locateOpenCodeDb(): string | null {
  const env = process.env.OPENCODE_DATA;
  const candidates = [
    env ? join(env, 'opencode.db') : null,
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db') : null,
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : null,
  ].filter((x): x is string => !!x);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function locateOpenCodeStorage(): string | null {
  const env = process.env.OPENCODE_DATA;
  const candidates = [
    env ? join(env, 'storage') : null,
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'storage') : null,
    join(homedir(), '.local', 'share', 'opencode', 'storage'),
  ].filter((x): x is string => !!x);
  return candidates.find((p) => existsSync(p) && existsSync(join(p, 'session'))) ?? null;
}

/**
 * 只读打开 OpenCode 的库。
 *
 * 这里有个必须说清楚的取舍：
 *
 *  - 普通 readonly 能看到 -wal 里尚未 checkpoint 的最新写入，但当进程
 *    没有权限创建 -shm、或库正被独占时会直接 "unable to open database file"。
 *  - immutable=1 一定能打开，代价是 SQLite 会完全忽略 -wal ——
 *    于是最近一段还没 checkpoint 的会话会静默读不到。
 *
 * 静默少读一截历史，比报错更危险。所以顺序是：先试 readonly，
 * 不行再退 immutable，且一旦退到 immutable 且 -wal 非空就必须发警告。
 */
function openHostDb(
  path: string,
  warnings: string[],
): { db: Database.Database; mode: 'readonly' | 'immutable' } {
  const abs = resolve(path);
  try {
    const db = new Database(abs, { readonly: true });
    db.prepare(`SELECT 1`).get();
    return { db, mode: 'readonly' };
  } catch (e) {
    const walSize = (() => {
      try {
        return existsSync(`${abs}-wal`) ? statSync(`${abs}-wal`).size : 0;
      } catch {
        return 0;
      }
    })();
    const db = new Database(`file:${abs}?immutable=1`, {
      readonly: true,
      uriPath: true,
    } as never);
    if (walSize > 0) {
      warnings.push(
        `普通只读打开失败（${(e as Error).message}），已退回 immutable=1。` +
          `但 ${abs}-wal 还有 ${walSize} 字节未 checkpoint，这部分最近的会话读不到。` +
          `要拿全请先退出 OpenCode，或执行 sqlite3 "${abs}" "PRAGMA wal_checkpoint(TRUNCATE);" 后再导。`,
      );
    }
    return { db, mode: 'immutable' };
  }
}

// ============================================================
// 防御式解析
// ============================================================

function parseJson(s: unknown, warnings: string[], what: string): Record<string, unknown> {
  if (typeof s !== 'string' || s.length === 0) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    warnings.push(`${what} 的 JSON 解析失败，已跳过该字段`);
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * session.model 在 1.18 是 JSON 对象，早期版本里是裸字符串。
 *
 * 注意从 SQLite 列读出来时两种情况都是 string，必须先试着当 JSON 解，
 * 解不开才当成裸模型名 —— 直接 `typeof raw === 'string'` 就返回，
 * 会把整段 JSON 原样当成模型名存进去。
 */
function modelLabel(raw: unknown, warnings: string[]): string | null {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    if (t.startsWith('{')) {
      try {
        const v = JSON.parse(t);
        if (v && typeof v === 'object') obj = v as Record<string, unknown>;
      } catch {
        warnings.push('session.model 看起来是 JSON 但解析失败，按裸字符串处理');
      }
    }
    if (!obj) return t;
  } else {
    return null;
  }
  const id = str(obj.id) ?? str(obj.modelID);
  const prov = str(obj.providerID) ?? str(obj.provider);
  if (!id && !prov) return null;
  return [prov, id].filter(Boolean).join('/');
}

/** 把宿主角色映射到 tasklog 的 role，认不出来的一律 system 并记警告 */
function toRole(raw: unknown, warnings: string[]): Role {
  const r = (str(raw) ?? '').toLowerCase();
  if (r === 'user') return 'user';
  if (r === 'assistant') return 'assistant';
  if (r === 'system') return 'system';
  if (r === 'tool') return 'tool';
  if (r) warnings.push(`未知 message.role="${r}"，按 system 处理`);
  return 'system';
}

// ============================================================
// 工具 part 的解析
// ============================================================

interface ToolInfo {
  name: string | null;
  callId: string | null;
  args: unknown;
  output: string | null;
  error: string | null;
  /** 宿主自己报的状态字符串，原样保留 */
  rawStatus: string | null;
}

/**
 * OpenCode 的 tool part 形如
 *   { type:'tool', tool:'bash', callID:'...', state:{ status:'completed'|'error',
 *     input:{...}, output:'...', error:'...', metadata:{...} } }
 * 不同版本里 state 的键名出现过 input/args、output/result 的差异，都兜住。
 */
function parseToolPart(data: Record<string, unknown>, warnings: string[]): ToolInfo {
  const state = (data.state && typeof data.state === 'object'
    ? (data.state as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const name = str(data.tool) ?? str(data.toolName) ?? str(state.tool);
  const callId = str(data.callID) ?? str(data.callId) ?? str(data.id);
  const args = state.input ?? state.args ?? data.input ?? data.args ?? null;

  let output = str(state.output) ?? str(state.result) ?? null;
  if (output === null && state.output !== undefined && state.output !== null) {
    output = JSON.stringify(state.output);
  }
  const error = str(state.error) ?? (state.error ? JSON.stringify(state.error) : null);
  const rawStatus = str(state.status);
  if (!name) warnings.push('tool part 缺少工具名');
  return { name, callId, args, output, error, rawStatus };
}

/**
 * 判定成功还是失败。
 *
 * 这是推断，不是原始记录：宿主只给了一个 status 字符串，
 * 不同版本用过 completed / success / error / failed。认不出来就留 null，
 * 不要默认当成功 —— 把失败记成成功，正是这套日志最不能出的错。
 */
function toOutcome(rawStatus: string | null, hasError: boolean): 'ok' | 'error' | null {
  if (hasError) return 'error';
  if (!rawStatus) return null;
  const s = rawStatus.toLowerCase();
  if (['completed', 'success', 'succeeded', 'done', 'ok'].includes(s)) return 'ok';
  if (['error', 'failed', 'failure', 'aborted', 'cancelled', 'canceled'].includes(s)) return 'error';
  return null;
}

// ============================================================
// git：可靠才记，不可靠就留空
// ============================================================

function gitInfo(dir: string): { branch: string | null; head: string | null } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  };
  if (!existsSync(dir)) return { branch: null, head: null };
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { branch: null, head: null };
  return { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), head: run(['rev-parse', 'HEAD']) };
}

// ============================================================
// 主入口
// ============================================================

interface RawSession {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  parentId: string | null;
  timeCreated: number | null;
  model: string | null;
}
interface RawMessage {
  id: string;
  sessionId: string;
  timeCreated: number | null;
  data: Record<string, unknown>;
}
interface RawPart {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number | null;
  data: Record<string, unknown>;
}

export function importOpenCode(
  db: DB,
  tasklogDbPath: string,
  opts: OpenCodeOptions = {},
): ImportReport {
  const warnings: string[] = [];
  const report: ImportReport = {
    source: SOURCE,
    layout: 'none',
    hostPath: null,
    hostVersions: [],
    sessions: 0,
    messages: 0,
    parts: 0,
    events: 0,
    inserted: 0,
    skipped: 0,
    partTypes: {},
    unmappedTypes: [],
    repos: [],
    warnings,
  };

  const dbPath = opts.dbPath ?? (opts.storageDir ? null : locateOpenCodeDb());
  const storageDir = opts.storageDir ?? (dbPath ? null : locateOpenCodeStorage());

  let sessions: RawSession[] = [];
  let messages: RawMessage[] = [];
  let parts: RawPart[] = [];

  if (dbPath && existsSync(dbPath)) {
    report.layout = 'sqlite';
    report.hostPath = resolve(dbPath);
    ({ sessions, messages, parts } = readSqlite(dbPath, warnings));
  } else if (storageDir && existsSync(storageDir)) {
    report.layout = 'json';
    report.hostPath = resolve(storageDir);
    ({ sessions, messages, parts } = readJsonTree(storageDir, warnings));
  } else {
    warnings.push(
      '没找到 OpenCode 数据。给 dbPath（1.17+ 的 opencode.db）或 storageDir（旧版 storage 目录）。',
    );
    return report;
  }

  // ---- 过滤 ----
  let keep = sessions;
  if (opts.sessions?.length) {
    const want = new Set(opts.sessions);
    keep = keep.filter((s) => want.has(s.id));
  }
  if (opts.directoryPrefix) {
    const pre = resolve(opts.directoryPrefix);
    keep = keep.filter((s) => s.directory && resolve(s.directory).startsWith(pre));
  }
  const keepIds = new Set(keep.map((s) => s.id));
  report.sessions = keep.length;
  report.hostVersions = [...new Set(keep.map((s) => s.version).filter((v): v is string => !!v))];

  const msgById = new Map(messages.filter((m) => keepIds.has(m.sessionId)).map((m) => [m.id, m]));
  report.messages = msgById.size;

  // ---- git（推断元数据，与日志内容分开）----
  if (opts.readGit !== false) {
    const dirs = [...new Set(keep.map((s) => s.directory).filter((d): d is string => !!d))];
    for (const d of dirs) {
      const g = gitInfo(d);
      report.repos.push({ directory: d, ...g });
    }
  }
  const gitByDir = new Map(report.repos.map((r) => [r.directory, r]));

  // ---- 排序：按 (message.time_created, part 在该 message 内的顺序) ----
  const relevant = parts.filter((p) => keepIds.has(p.sessionId) && msgById.has(p.messageId));
  const orderInMsg = new Map<string, number>();
  for (const p of relevant) {
    const n = orderInMsg.get(p.messageId) ?? 0;
    orderInMsg.set(p.messageId, n + 1);
  }
  const partIndex = new Map<string, number>();
  {
    const counter = new Map<string, number>();
    for (const p of relevant) {
      const n = counter.get(p.messageId) ?? 0;
      counter.set(p.messageId, n + 1);
      partIndex.set(p.id, n);
    }
  }
  const tsOf = (p: RawPart): number => {
    const m = msgById.get(p.messageId);
    return p.timeCreated ?? m?.timeCreated ?? 0;
  };
  relevant.sort((a, b) => {
    const ma = msgById.get(a.messageId)!;
    const mb = msgById.get(b.messageId)!;
    const ta = ma.timeCreated ?? tsOf(a);
    const tb = mb.timeCreated ?? tsOf(b);
    if (ta !== tb) return ta - tb;
    if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1;
    return (partIndex.get(a.id) ?? 0) - (partIndex.get(b.id) ?? 0);
  });
  report.parts = relevant.length;

  // ---- 映射成 tasklog 事件 ----
  const KNOWN = new Set([
    'text',
    'reasoning',
    'tool',
    'patch',
    'file',
    'step-start',
    'step-finish',
    'snapshot',
    'agent',
  ]);
  const unmapped = new Set<string>();
  const seqBySession = new Map(
    (db.prepare(`SELECT session_id, MAX(seq) + 1 AS next_seq FROM events GROUP BY session_id`)
      .all() as Array<{ session_id: string; next_seq: number }>)
      .map((r) => [r.session_id, r.next_seq] as const),
  );
  const nextSeq = (sid: string): number => {
    const n = seqBySession.get(sid) ?? 0;
    seqBySession.set(sid, n + 1);
    return n;
  };
  const sessionById = new Map(keep.map((s) => [s.id, s]));
  const out: EventInput[] = [];

  for (const p of relevant) {
    const msg = msgById.get(p.messageId)!;
    const ses = sessionById.get(p.sessionId);
    const type = str(p.data.type) ?? 'unknown';
    report.partTypes[type] = (report.partTypes[type] ?? 0) + 1;
    if (!KNOWN.has(type)) unmapped.add(type);

    const ts = tsOf(p);
    if (opts.sinceTs !== undefined && ts < opts.sinceTs) continue;
    const role = toRole(msg.data.role, warnings);
    const git = ses?.directory ? gitByDir.get(ses.directory) : undefined;

    /** 原始标识原样保留；推断出来的单独放 inferred 子对象 */
    const ref = (inferred: Record<string, unknown>): Record<string, unknown> => ({
      host: 'opencode',
      hostLayout: report.layout,
      hostVersion: ses?.version ?? null,
      sessionId: p.sessionId,
      sessionTitle: ses?.title ?? null,
      parentSessionId: ses?.parentId ?? null,
      messageId: p.messageId,
      partId: p.id,
      partType: type,
      model: ses?.model ?? null,
      messageTimeCreated: msg.timeCreated,
      partTimeCreated: p.timeCreated,
      directory: ses?.directory ?? null,
      git: git ? { branch: git.branch, head: git.head } : null,
      inferred,
    });

    if (type === 'text' || type === 'reasoning') {
      if (type === 'reasoning' && opts.skipReasoning) continue;
      const text = str(p.data.text);
      if (!text || text.trim() === '') continue;
      // synthetic 是宿主自己生成的提示，不是人写的；保留但标出来
      const synthetic = p.data.synthetic === true;
      out.push({
        sessionId: p.sessionId,
        seq: nextSeq(p.sessionId),
        ts,
        role,
        kind: 'text',
        text,
        source: SOURCE,
        sourceId: p.id,
        sourceRef: ref({ seq: 'assigned at import', role: `mapped from message.role`, synthetic, reasoning: type === 'reasoning' }),
      });
      continue;
    }

    if (type === 'tool') {
      const t = parseToolPart(p.data, warnings);
      const callId = t.callId ?? p.id;
      // 一个 tool part 拆成调用与结果两条事件：
      // 参数和返回分开存，才能在 resume 时判断"这次失败后来有没有同样的重做成功"
      out.push({
        sessionId: p.sessionId,
        seq: nextSeq(p.sessionId),
        ts,
        role: 'assistant',
        kind: 'tool_call',
        toolName: t.name,
        callId,
        args: t.args ?? undefined,
        text: null,
        source: SOURCE,
        sourceId: `${p.id}:call`,
        sourceRef: ref({ splitFrom: p.id, part: 'call', rawStatus: t.rawStatus }),
      });
      const body = t.error ?? t.output;
      if (body !== null || t.rawStatus) {
        out.push({
          sessionId: p.sessionId,
          seq: nextSeq(p.sessionId),
          ts,
          role: 'tool',
          kind: t.error ? 'error' : 'tool_result',
          toolName: t.name,
          callId,
          text: body,
          outcome: toOutcome(t.rawStatus, !!t.error),
          source: SOURCE,
          sourceId: `${p.id}:result`,
          sourceRef: ref({
            splitFrom: p.id,
            part: 'result',
            rawStatus: t.rawStatus,
            outcomeInferredFrom: t.error ? 'state.error' : 'state.status',
          }),
        });
      }
      continue;
    }

    if (type === 'patch' || type === 'file') {
      const files = Array.isArray(p.data.files) ? p.data.files : [];
      const text =
        str(p.data.text) ??
        str(p.data.filename) ??
        str(p.data.url) ??
        (files.length ? files.map(String).join('\n') : null) ??
        JSON.stringify(p.data).slice(0, 2000);
      out.push({
        sessionId: p.sessionId,
        seq: nextSeq(p.sessionId),
        ts,
        role,
        kind: 'text',
        toolName: type,
        text,
        source: SOURCE,
        sourceId: p.id,
        sourceRef: ref({ kind: `mapped ${type} -> text` }),
      });
      continue;
    }

    // step-start / step-finish / snapshot / 未知类型：不丢，但只留一行痕迹，
    // 以便事后能发现"这里本来有东西，我们当时没解析"
    if (type === 'step-start' || type === 'step-finish') continue;
    out.push({
      sessionId: p.sessionId,
      seq: nextSeq(p.sessionId),
      ts,
      role: 'system',
      kind: 'text',
      text: `[opencode ${type}] ${JSON.stringify(p.data).slice(0, 1000)}`,
      source: SOURCE,
      sourceId: p.id,
      sourceRef: ref({ kind: `unmapped part type ${type}, stored verbatim` }),
    });
  }

  report.unmappedTypes = [...unmapped];
  if (unmapped.size) {
    warnings.push(
      `出现未映射的 part 类型：${[...unmapped].join(', ')}。已原样存为 system 文本，` +
        `建议升级适配器 —— OpenCode 的 schema 是内部的，会变。`,
    );
  }

  // ---- 写入 ----
  const ing = new Ingestor(db, tasklogDbPath);
  const stats = ing.addMany(out);
  report.events = out.length;
  report.inserted = stats.inserted;
  report.skipped = stats.skipped;

  // ---- 记录导入状态，支持增量追加 ----
  const upsert = db.prepare(/* sql */ `
    INSERT INTO import_state (source, scope, last_source_id, last_ts, n_events, host_version, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, scope) DO UPDATE SET
      last_source_id = excluded.last_source_id,
      last_ts        = MAX(COALESCE(import_state.last_ts, 0), excluded.last_ts),
      n_events       = import_state.n_events + excluded.n_events,
      host_version   = excluded.host_version,
      imported_at    = excluded.imported_at
  `);
  const now = Date.now();
  const bySession = new Map<string, EventInput[]>();
  for (const e of out) {
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId)!.push(e);
  }
  const tx = db.transaction(() => {
    for (const [sid, evs] of bySession) {
      const last = evs[evs.length - 1]!;
      upsert.run(
        SOURCE,
        sid,
        last.sourceId ?? null,
        last.ts,
        evs.length,
        sessionById.get(sid)?.version ?? null,
        now,
      );
    }
  });
  tx();

  return report;
}

/** 上次导入到哪里了，用于增量追加 */
export function lastImportedTs(db: DB, source = SOURCE): number | null {
  const r = db
    .prepare(`SELECT MAX(last_ts) t FROM import_state WHERE source = ?`)
    .get(source) as { t: number | null } | undefined;
  return r?.t ?? null;
}

// ============================================================
// 两种布局的读取
// ============================================================

function readSqlite(
  path: string,
  warnings: string[],
): { sessions: RawSession[]; messages: RawMessage[]; parts: RawPart[] } {
  let host: Database.Database;
  try {
    host = openHostDb(path, warnings).db;
  } catch (e) {
    warnings.push(
      `只读打开 ${path} 失败（${(e as Error).message}）。` +
        `请先退出 OpenCode，或把 opencode.db / -wal / -shm 三个文件一起复制出来再导。`,
    );
    return { sessions: [], messages: [], parts: [] };
  }

  const tables = new Set(
    (host.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  for (const t of ['session', 'message', 'part']) {
    if (!tables.has(t)) {
      warnings.push(`宿主库缺少表 ${t}，可能是不兼容的 OpenCode 版本`);
      host.close();
      return { sessions: [], messages: [], parts: [] };
    }
  }

  const cols = (t: string): Set<string> =>
    new Set(
      (host.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((r) => r.name),
    );
  const sc = cols('session');
  const pick = (want: string, fallback: string | null = null): string =>
    sc.has(want) ? want : (fallback && sc.has(fallback) ? fallback : `NULL AS ${want}`);

  const sessions = (
    host
      .prepare(
        `SELECT id,
                ${pick('directory')} AS directory,
                ${pick('title')} AS title,
                ${pick('version')} AS version,
                ${pick('parent_id', 'parentID')} AS parent_id,
                ${pick('time_created')} AS time_created,
                ${pick('model')} AS model
           FROM session`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    directory: str(r.directory),
    title: str(r.title),
    version: str(r.version),
    parentId: str(r.parent_id),
    timeCreated: num(r.time_created),
    model: modelLabel(r.model, warnings),
  }));

  const messages = (
    host
      .prepare(`SELECT id, session_id, time_created, data FROM message`)
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    sessionId: String(r.session_id),
    timeCreated: num(r.time_created),
    data: parseJson(r.data, warnings, `message ${String(r.id)}.data`),
  }));

  const parts = (
    host
      .prepare(`SELECT id, message_id, session_id, time_created, data FROM part`)
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    messageId: String(r.message_id),
    sessionId: String(r.session_id),
    timeCreated: num(r.time_created),
    data: parseJson(r.data, warnings, `part ${String(r.id)}.data`),
  }));

  host.close();
  return { sessions, messages, parts };
}

function readJsonTree(
  root: string,
  warnings: string[],
): { sessions: RawSession[]; messages: RawMessage[]; parts: RawPart[] } {
  const sessions: RawSession[] = [];
  const messages: RawMessage[] = [];
  const parts: RawPart[] = [];
  const readJsonFile = (p: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'));
      return v && typeof v === 'object' ? v : null;
    } catch {
      warnings.push(`读不动 ${p}`);
      return null;
    }
  };
  const lsDirs = (p: string): string[] => {
    try {
      return readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory());
    } catch {
      return [];
    }
  };
  const lsFiles = (p: string, ext = '.json'): string[] => {
    try {
      return readdirSync(p).filter((f) => f.endsWith(ext));
    } catch {
      return [];
    }
  };

  for (const projHash of lsDirs(join(root, 'session'))) {
    for (const f of lsFiles(join(root, 'session', projHash))) {
      const j = readJsonFile(join(root, 'session', projHash, f));
      if (!j) continue;
      const id = str(j.id) ?? f.replace(/\.json$/, '');
      const time = (j.time && typeof j.time === 'object' ? j.time : {}) as Record<string, unknown>;
      sessions.push({
        id,
        directory: str(j.directory),
        title: str(j.title),
        version: str(j.version),
        parentId: str(j.parentID) ?? str(j.parent_id),
        timeCreated: num(time.created) ?? num(j.time_created),
        model: modelLabel(j.model, warnings),
      });
    }
  }

  for (const sid of lsDirs(join(root, 'message'))) {
    for (const f of lsFiles(join(root, 'message', sid))) {
      const j = readJsonFile(join(root, 'message', sid, f));
      if (!j) continue;
      const time = (j.time && typeof j.time === 'object' ? j.time : {}) as Record<string, unknown>;
      messages.push({
        id: str(j.id) ?? f.replace(/^msg_/, '').replace(/\.json$/, ''),
        sessionId: str(j.sessionID) ?? sid,
        timeCreated: num(time.created) ?? num(j.time_created),
        data: j,
      });
    }
  }

  for (const sid of lsDirs(join(root, 'part'))) {
    for (const mid of lsDirs(join(root, 'part', sid))) {
      for (const f of lsFiles(join(root, 'part', sid, mid))) {
        const j = readJsonFile(join(root, 'part', sid, mid, f));
        if (!j) continue;
        const time = (j.time && typeof j.time === 'object' ? j.time : {}) as Record<
          string,
          unknown
        >;
        parts.push({
          id: str(j.id) ?? f.replace(/\.json$/, ''),
          messageId: str(j.messageID) ?? mid,
          sessionId: str(j.sessionID) ?? sid,
          timeCreated: num(time.created) ?? num(j.time_created),
          data: j,
        });
      }
    }
  }

  return { sessions, messages, parts };
}
