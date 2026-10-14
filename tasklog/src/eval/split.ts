/**
 * 时间切分与泄漏检查。
 *
 * 这是整组评估的地基：防泄漏做不到，后面所有数字都是假的。
 *
 * 核心约束：对第 N 个 pilot 任务，可见历史只到该任务**开始之前**，
 * 且必须排除该任务自己的解法、测试结果与 commit。
 *
 * 实现方式是在数据层硬切（`untilTs` 下压到每一次查询），
 * 不是靠提示模型"请不要看未来"。模型会看的。
 */

import type { DB } from '../db/open.ts';

export interface CutPoint {
  /** pilot 任务的标识 */
  taskKey: string;
  /** 该任务开始的时间；严格早于它的内容才可见 */
  startTs: number;
  /** 该任务结束的时间（仅用于取 ground truth，绝不暴露给被测 agent） */
  endTs: number | null;
  /** 该任务对应的 commit（ground truth 的一部分） */
  commitSha?: string | null;
}

export interface LeakProbe {
  /** 人类可读的说明 */
  what: string;
  /** 这些字符串一旦出现在给 agent 的上下文里，就是泄漏 */
  needles: string[];
}

export interface LeakReport {
  ok: boolean;
  cutTs: number;
  /** 超出时间边界的事件 */
  futureEvents: Array<{ eventId: number; ts: number; sessionId: string }>;
  /** 命中泄漏探针的位置 */
  hits: Array<{ probe: string; needle: string; where: string; excerpt: string }>;
}

/**
 * 从历史里挑出可以当 pilot 的任务。
 *
 * 注意这只是**候选**。哪个任务属于五类里的哪一类、ground truth 是什么，
 * 必须人工确认 —— 自动判定等于让被测系统自己出题。
 */
export interface PilotCandidate {
  taskId: number;
  stableKey: string | null;
  title: string | null;
  startTs: number;
  endTs: number | null;
  events: number;
  errors: number;
  commitSha: string | null;
  /** 该任务之前已有多少历史事件，太少就不值得做 pilot */
  priorEvents: number;
  priorSpanDays: number;
  /** 机械信号，仅供人工挑选时参考，不构成分类 */
  signals: {
    hasUnresolvedError: boolean;
    hasTodo: boolean;
    isSuperseded: boolean;
    supersedesOther: boolean;
    touchesFilesSeenBefore: number;
  };
}

export function listPilotCandidates(
  db: DB,
  opts: { minPriorEvents?: number; minEvents?: number } = {},
): PilotCandidate[] {
  const minPrior = opts.minPriorEvents ?? 20;
  const minEvents = opts.minEvents ?? 3;

  const tasks = db
    .prepare(
      /* sql */ `
      SELECT t.id, t.stable_key, t.title, t.started_ts, t.ended_ts, t.commit_sha,
             (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id) n_events,
             (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id AND e.outcome='error') n_err
        FROM tasks t
       WHERE t.retired_at IS NULL
       ORDER BY t.started_ts ASC`,
    )
    .all() as Array<{
    id: number;
    stable_key: string | null;
    title: string | null;
    started_ts: number;
    ended_ts: number | null;
    commit_sha: string | null;
    n_events: number;
    n_err: number;
  }>;

  const priorStmt = db.prepare(
    `SELECT COUNT(*) n, MIN(ts) lo FROM events WHERE ts < ?`,
  );
  const supBy = db.prepare(`SELECT COUNT(*) n FROM task_edges WHERE dst = ? AND rel='supersedes'`);
  const supOf = db.prepare(`SELECT COUNT(*) n FROM task_edges WHERE src = ? AND rel='supersedes'`);
  const todoStmt = db.prepare(
    `SELECT COUNT(*) n FROM events WHERE task_id = ? AND text LIKE '%TODO%'`,
  );
  const seenBefore = db.prepare(/* sql */ `
    SELECT COUNT(DISTINCT s.sym) n
      FROM symbols s JOIN events e ON e.id = s.event_id
     WHERE e.task_id = ? AND s.kind = 'path'
       AND EXISTS (
         SELECT 1 FROM symbols s2 JOIN events e2 ON e2.id = s2.event_id
          WHERE s2.sym = s.sym AND e2.ts < ?
       )`);

  const out: PilotCandidate[] = [];
  for (const t of tasks) {
    if (t.n_events < minEvents) continue;
    const prior = priorStmt.get(t.started_ts) as { n: number; lo: number | null };
    if (prior.n < minPrior) continue;
    out.push({
      taskId: t.id,
      stableKey: t.stable_key,
      title: t.title,
      startTs: t.started_ts,
      endTs: t.ended_ts,
      events: t.n_events,
      errors: t.n_err,
      commitSha: t.commit_sha,
      priorEvents: prior.n,
      priorSpanDays:
        prior.lo != null ? Math.round(((t.started_ts - prior.lo) / 86_400_000) * 10) / 10 : 0,
      signals: {
        hasUnresolvedError: t.n_err > 0,
        hasTodo: (todoStmt.get(t.id) as { n: number }).n > 0,
        isSuperseded: (supBy.get(t.id) as { n: number }).n > 0,
        supersedesOther: (supOf.get(t.id) as { n: number }).n > 0,
        touchesFilesSeenBefore: (seenBefore.get(t.id, t.started_ts) as { n: number }).n,
      },
    });
  }
  return out;
}

/**
 * 检查一段要喂给 agent 的上下文有没有泄漏。
 *
 * 两道关：
 *   1. 时间关 —— 上下文里引用的事件 id 不得晚于切点
 *   2. 内容关 —— 不得出现 ground truth 的特征串（解法片段、测试输出、commit sha / message）
 *
 * 第 2 关必须人工给探针。自动从"未来"抽 n-gram 当探针会产生大量假阳性，
 * 反而让人忽略真的泄漏。
 */
export function checkLeak(
  db: DB,
  context: string,
  cut: CutPoint,
  probes: LeakProbe[],
  referencedEventIds: number[] = [],
): LeakReport {
  const futureEvents: LeakReport['futureEvents'] = [];
  if (referencedEventIds.length > 0) {
    const q = db.prepare(
      `SELECT id, ts, session_id FROM events WHERE id IN (${referencedEventIds
        .map(() => '?')
        .join(',')}) AND ts >= ?`,
    );
    for (const r of q.all(...referencedEventIds, cut.startTs) as Array<{
      id: number;
      ts: number;
      session_id: string;
    }>) {
      futureEvents.push({ eventId: r.id, ts: r.ts, sessionId: r.session_id });
    }
  }

  const hits: LeakReport['hits'] = [];
  const hay = context;
  for (const p of probes) {
    for (const n of p.needles) {
      if (!n || n.length < 6) continue; // 太短的串噪音太大
      const i = hay.indexOf(n);
      if (i >= 0) {
        hits.push({
          probe: p.what,
          needle: n,
          where: `offset ${i}`,
          excerpt: hay.slice(Math.max(0, i - 60), i + n.length + 60),
        });
      }
    }
  }

  return { ok: futureEvents.length === 0 && hits.length === 0, cutTs: cut.startTs, futureEvents, hits };
}

/**
 * 为一个 pilot 任务自动生成泄漏探针。
 *
 * 取的是该任务自己产生的东西：commit sha、commit message、
 * 它改动过而之前从没出现过的符号、它的测试输出里的特征行。
 * 这些是"未来"，被测 agent 在任务开始前不该知道。
 */
export function buildProbes(db: DB, cut: CutPoint): LeakProbe[] {
  const probes: LeakProbe[] = [];

  if (cut.commitSha) {
    const c = db
      .prepare(`SELECT sha, subject, body FROM commits WHERE sha = ?`)
      .get(cut.commitSha) as { sha: string; subject: string; body: string | null } | undefined;
    if (c) {
      probes.push({
        what: '该任务的 commit',
        needles: [c.sha, c.sha.slice(0, 10), c.subject].filter((x): x is string => !!x && x.length >= 6),
      });
    }
  }

  const taskEvents = db
    .prepare(`SELECT id FROM events WHERE ts >= ? AND (? IS NULL OR ts <= ?)`)
    .all(cut.startTs, cut.endTs, cut.endTs) as Array<{ id: number }>;
  if (taskEvents.length > 0) {
    const ids = taskEvents.map((e) => e.id);
    const novel = db
      .prepare(
        /* sql */ `
        SELECT DISTINCT s.sym
          FROM symbols s
         WHERE s.event_id IN (${ids.map(() => '?').join(',')})
           AND s.kind IN ('ident','test')
           AND NOT EXISTS (
             SELECT 1 FROM symbols s2 JOIN events e2 ON e2.id = s2.event_id
              WHERE s2.sym = s.sym AND e2.ts < ?
           )
         LIMIT 40`,
      )
      .all(...ids, cut.startTs) as Array<{ sym: string }>;
    if (novel.length > 0) {
      probes.push({
        what: '该任务首次引入的标识符（之前历史里不存在）',
        needles: novel.map((r) => r.sym).filter((x) => x.length >= 6),
      });
    }
  }

  return probes;
}
