/**
 * 任务划分与回填。
 *
 * 边界来源按可信度排序：
 *   1. git commit / 分支切换  (boundary_src='git')
 *   2. 时间间隔、文件集合突变  (boundary_src='heuristic')
 *   3. 用户显式标注            (boundary_src='user')
 *
 * 不采用"每轮询问任务是否结束"：任务是嵌套的、会回溯的，且打断有成本。
 * 边界允许事后修订 —— 原文是事实，边界只是索引，索引错了可以重建。
 */

import type { DB } from '../db/open.ts';

export interface SegmentOptions {
  /** 超过这个静默时长视为新任务（毫秒）。默认 45 分钟。 */
  gapMs?: number;
  /** 文件集合 Jaccard 低于此值视为换了主题。 */
  jaccardSplit?: number;
  /** 文件集合 Jaccard 高于此值且非相邻，建 continues 边。 */
  jaccardContinues?: number;
}

export interface SegmentResult {
  tasks: number;
  assigned: number;
  edges: { supersedes: number; continues: number };
  fromGit: number;
  fromHeuristic: number;
  /** 沿用已有身份的任务数（重分段不新建行） */
  reused: number;
  /** 本次新建的任务数 */
  created: number;
  /** 本次退役（保留行、标 retired_at）的任务数 */
  retired: number;
  /** 被用户锁定、整段跳过重分段的任务数 */
  locked: number;
}

/** 分段证据：与"任务是否完成"分开记录，可审计 */
export interface BoundaryEvidence {
  /** 触发本段结束的原因 */
  closedBy: 'commit' | 'time_gap' | 'end_of_log' | 'user';
  commitSha?: string;
  commitSubject?: string;
  /** 触发切分的静默时长（毫秒） */
  gapMs?: number;
  nEvents: number;
  firstEventId: number;
  lastEventId: number;
  segmentedAt: number;
}

interface EvRow {
  id: number;
  ts: number;
  session_id: string;
  seq: number;
  task_id: number | null;
}

interface CommitRow {
  sha: string;
  ts: number;
  subject: string;
  branch: string | null;
  files_json: string;
  reverts_sha: string | null;
}

/**
 * 重建任务划分。
 *
 * 和 v1 的关键差别（见 design 第 12.3 节）：
 *   1. 不再 `DELETE FROM tasks` —— 任务身份由 stable_key 维持，按键 upsert。
 *      旧的 task_id 永远可解析：不再出现的段标 retired_at 并指向继任者。
 *   2. 用户修订过的任务（locked / boundary_src='user'）整段跳过重分段，
 *      其事件不进入重算输入。人工修订是比启发式更高可信度的证据。
 *   3. status 不由分段证据推出。commit 只证明"这里有过一次提交"，
 *      既不证明任务完成，也不证明没提交的段被放弃。
 */
export function rebuildTasks(db: DB, opts: SegmentOptions = {}): SegmentResult {
  const gapMs = opts.gapMs ?? 45 * 60 * 1000;
  const jSplit = opts.jaccardSplit ?? 0.15;
  const jCont = opts.jaccardContinues ?? 0.6;
  const now = Date.now();

  const result: SegmentResult = {
    tasks: 0,
    assigned: 0,
    edges: { supersedes: 0, continues: 0 },
    fromGit: 0,
    fromHeuristic: 0,
    reused: 0,
    created: 0,
    retired: 0,
    locked: 0,
  };

  // 锁定的任务：用户改过归属，不参与重算
  const lockedTasks = db
    .prepare(
      `SELECT id FROM tasks WHERE retired_at IS NULL AND (locked = 1 OR boundary_src = 'user')`,
    )
    .all() as Array<{ id: number }>;
  const lockedIds = new Set(lockedTasks.map((t) => t.id));
  result.locked = lockedIds.size;

  const allEvents = db
    .prepare(`SELECT id, ts, session_id, seq, task_id FROM events ORDER BY ts ASC, id ASC`)
    .all() as EvRow[];
  const events = allEvents.filter((e) => e.task_id == null || !lockedIds.has(e.task_id));
  if (allEvents.length === 0) return result;

  const commits = db
    .prepare(`SELECT sha, ts, subject, branch, files_json, reverts_sha FROM commits ORDER BY ts ASC`)
    .all() as CommitRow[];

  const tx = db.transaction(() => {
    // 只清推断出来的边。用户建立的边（note 以 'user:' 开头）保留。
    db.exec(`DELETE FROM task_edges WHERE note IS NULL OR note NOT LIKE 'user:%'`);

    if (events.length === 0) {
      result.tasks = (
        db.prepare(`SELECT COUNT(*) n FROM tasks WHERE retired_at IS NULL`).get() as { n: number }
      ).n;
      return;
    }

    // ---------- 第一刀：按 commit 时间切 ----------
    type Seg = {
      evIds: number[];
      startTs: number;
      endTs: number;
      commit: CommitRow | null;
      src: 'git' | 'heuristic';
      closedBy?: BoundaryEvidence['closedBy'];
      gap?: number;
    };
    const segs: Seg[] = [];

    if (commits.length > 0) {
      let ci = 0;
      let cur: Seg = {
        evIds: [],
        startTs: events[0]!.ts,
        endTs: events[0]!.ts,
        commit: null,
        src: 'git',
      };
      for (const ev of events) {
        // 该事件之前已经发生的 commit，全部用来封段
        while (ci < commits.length && commits[ci]!.ts <= ev.ts) {
          cur.commit = commits[ci]!;
          cur.endTs = commits[ci]!.ts;
          cur.closedBy = 'commit';
          if (cur.evIds.length > 0) segs.push(cur);
          ci++;
          cur = { evIds: [], startTs: ev.ts, endTs: ev.ts, commit: null, src: 'git' };
        }
        cur.evIds.push(ev.id);
        cur.endTs = ev.ts;
      }
      if (cur.evIds.length > 0) {
        cur.src = 'git';
        cur.closedBy = 'end_of_log';
        segs.push(cur);
      }
    } else {
      segs.push({
        evIds: events.map((e) => e.id),
        startTs: events[0]!.ts,
        endTs: events[events.length - 1]!.ts,
        commit: null,
        src: 'heuristic',
        closedBy: 'end_of_log',
      });
    }

    // ---------- 第二刀：段内按时间 gap 再切（heuristic） ----------
    const tsById = new Map(events.map((e) => [e.id, e.ts]));
    const refined: Seg[] = [];
    for (const seg of segs) {
      let bucket: number[] = [];
      let prevTs: number | null = null;
      for (const id of seg.evIds) {
        const ts = tsById.get(id)!;
        if (prevTs !== null && ts - prevTs > gapMs && bucket.length > 0) {
          refined.push({
            evIds: bucket,
            startTs: tsById.get(bucket[0]!)!,
            endTs: prevTs,
            commit: null,
            src: 'heuristic',
            closedBy: 'time_gap',
            gap: ts - prevTs,
          });
          bucket = [];
        }
        bucket.push(id);
        prevTs = ts;
      }
      if (bucket.length > 0) {
        refined.push({
          evIds: bucket,
          startTs: tsById.get(bucket[0]!)!,
          endTs: prevTs ?? seg.endTs,
          // 只有最后一个 bucket 继承 commit（commit 发生在段尾）
          commit: seg.commit,
          src: seg.commit ? 'git' : seg.src,
          closedBy: seg.commit ? 'commit' : seg.closedBy,
        });
      }
    }

    // ---------- 落 tasks：按 stable_key upsert，不删行 ----------
    const findByKey = db.prepare(
      `SELECT id, status, status_source, title FROM tasks WHERE stable_key = ?`,
    );
    const insTask = db.prepare(/* sql */ `
      INSERT INTO tasks (stable_key, title, started_ts, ended_ts, status, status_source,
                         branch, commit_sha, boundary_src, boundary_evidence, retired_at, successor_id)
      VALUES (?, ?, ?, ?, 'unknown', 'none', ?, ?, ?, ?, NULL, NULL)
    `);
    // 已存在的任务：只更新分段派生的字段。status / status_source 不碰 ——
    // 它们可能来自用户确认，重分段无权覆盖。
    const updTask = db.prepare(/* sql */ `
      UPDATE tasks
         SET started_ts = ?, ended_ts = ?, branch = ?, commit_sha = ?,
             boundary_src = CASE WHEN boundary_src = 'user' THEN 'user' ELSE ? END,
             boundary_evidence = ?, retired_at = NULL, successor_id = NULL
       WHERE id = ?
    `);
    const setTask = db.prepare(`UPDATE events SET task_id = ? WHERE id = ?`);

    const taskIds: number[] = [];
    const shaToTask = new Map<string, number>();
    const seenKeys = new Set<string>();

    refined.forEach((seg) => {
      // 稳定身份：段内首个事件 id。事件 id 单调且永不复用，
      // 所以只要这段的起点不变，task_id 就不变。
      const stableKey = `ev:${seg.evIds[0]}`;
      seenKeys.add(stableKey);

      const evidence: BoundaryEvidence = {
        closedBy: seg.closedBy ?? 'end_of_log',
        ...(seg.commit ? { commitSha: seg.commit.sha, commitSubject: seg.commit.subject } : {}),
        ...(seg.gap ? { gapMs: seg.gap } : {}),
        nEvents: seg.evIds.length,
        firstEventId: seg.evIds[0]!,
        lastEventId: seg.evIds[seg.evIds.length - 1]!,
        segmentedAt: now,
      };
      const evJson = JSON.stringify(evidence);

      const existing = findByKey.get(stableKey) as
        | { id: number; status: string; status_source: string; title: string | null }
        | undefined;

      let tid: number;
      if (existing) {
        updTask.run(
          seg.startTs,
          seg.endTs,
          seg.commit?.branch ?? null,
          seg.commit?.sha ?? null,
          seg.src,
          evJson,
          existing.id,
        );
        tid = existing.id;
        result.reused++;
      } else {
        const info = insTask.run(
          stableKey,
          seg.commit?.subject ?? null,
          seg.startTs,
          seg.endTs,
          seg.commit?.branch ?? null,
          seg.commit?.sha ?? null,
          seg.src,
          evJson,
        );
        tid = Number(info.lastInsertRowid);
        result.created++;
      }

      taskIds.push(tid);
      if (seg.commit) shaToTask.set(seg.commit.sha, tid);
      if (seg.src === 'git') result.fromGit++;
      else result.fromHeuristic++;
      for (const eid of seg.evIds) {
        setTask.run(tid, eid);
        result.assigned++;
      }
    });

    // ---------- 退役：不再出现的段保留行，指向继任者 ----------
    // 旧的 task_id 可能被写进过笔记、commit message、别的会话的引用里。
    // 删掉它等于让那些引用静默失效，所以只标记。
    const orphans = db
      .prepare(
        `SELECT id, stable_key FROM tasks
          WHERE retired_at IS NULL AND locked = 0 AND boundary_src <> 'user'
            AND stable_key IS NOT NULL`,
      )
      .all() as Array<{ id: number; stable_key: string }>;
    const retire = db.prepare(`UPDATE tasks SET retired_at = ?, successor_id = ? WHERE id = ?`);
    const taskOfEvent = db.prepare(`SELECT task_id FROM events WHERE id = ?`);
    for (const o of orphans) {
      if (seenKeys.has(o.stable_key)) continue;
      const firstEv = Number(o.stable_key.slice(3));
      const succ = taskOfEvent.get(firstEv) as { task_id: number | null } | undefined;
      retire.run(now, succ?.task_id ?? null, o.id);
      result.retired++;
    }

    result.tasks = taskIds.length + lockedIds.size;

    // ---------- 任务标题兜底：无 commit 的段取首条 user 文本 ----------
    const firstUserText = db.prepare(/* sql */ `
      SELECT text FROM events
       WHERE task_id = ? AND role = 'user' AND text IS NOT NULL AND TRIM(text) <> ''
       ORDER BY ts ASC LIMIT 1
    `);
    const updTitle = db.prepare(`UPDATE tasks SET title = ? WHERE id = ? AND title IS NULL`);
    for (const tid of taskIds) {
      const r = firstUserText.get(tid) as { text: string } | undefined;
      if (r?.text) updTitle.run(oneLine(r.text, 90), tid);
    }

    // ---------- supersedes：revert 是强信号 ----------
    const insEdge = db.prepare(
      `INSERT OR IGNORE INTO task_edges (src, dst, rel, note) VALUES (?, ?, ?, ?)`,
    );
    for (const c of commits) {
      if (!c.reverts_sha) continue;
      const srcTid = shaToTask.get(c.sha);
      if (!srcTid) continue;
      if (c.reverts_sha === 'unknown') {
        // 只有 "Revert ..." 字样：回滚目标用 subject 反查
        const target = c.subject.replace(/^revert[\s:"']+/i, '').replace(/["']$/, '').trim();
        const hit = commits.find((x) => x.sha !== c.sha && x.subject.trim() === target);
        const dst = hit ? shaToTask.get(hit.sha) : undefined;
        if (dst && dst !== srcTid) {
          insEdge.run(srcTid, dst, 'supersedes', 'revert by subject match');
          result.edges.supersedes++;
        }
        continue;
      }
      const dstSha = [...shaToTask.keys()].find((s) => s.startsWith(c.reverts_sha!));
      const dst = dstSha ? shaToTask.get(dstSha) : undefined;
      if (dst && dst !== srcTid) {
        insEdge.run(srcTid, dst, 'supersedes', `reverts ${c.reverts_sha.slice(0, 10)}`);
        result.edges.supersedes++;
      }
    }

    // ---------- continues：文件集合高度重叠且非相邻 ----------
    const fileSets = new Map<number, Set<string>>();
    const pathRows = db
      .prepare(
        /* sql */ `SELECT e.task_id AS tid, s.sym AS p
                   FROM symbols s JOIN events e ON e.id = s.event_id
                   WHERE s.kind = 'path' AND e.task_id IS NOT NULL`,
      )
      .all() as Array<{ tid: number; p: string }>;
    for (const r of pathRows) {
      if (!fileSets.has(r.tid)) fileSets.set(r.tid, new Set());
      fileSets.get(r.tid)!.add(r.p);
    }
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 2; j < taskIds.length; j++) {
        const a = fileSets.get(taskIds[i]!);
        const b = fileSets.get(taskIds[j]!);
        if (!a || !b || a.size < 2 || b.size < 2) continue;
        if (jaccard(a, b) >= jCont) {
          insEdge.run(taskIds[j]!, taskIds[i]!, 'continues', 'file-set overlap');
          result.edges.continues++;
        }
      }
    }

    void jSplit; // 文件集合突变切分留待接入 diff 粒度后启用
  });

  tx();
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 用户显式修订某段事件的任务归属。索引错了可以重建，这是本方案的退路。
 *
 * 修订同时把任务锁定：后续 rebuildTasks 不再碰它的事件归属。
 * 人工证据优先级高于启发式，不该被下一次重分段静默抹掉。
 */
export function reassign(db: DB, eventIds: number[], taskId: number): number {
  const upd = db.prepare(`UPDATE events SET task_id = ? WHERE id = ?`);
  const markUser = db.prepare(
    `UPDATE tasks SET boundary_src = 'user', locked = 1, retired_at = NULL,
            boundary_evidence = ? WHERE id = ?`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of eventIds) n += upd.run(taskId, id).changes;
    const span = db
      .prepare(`SELECT COUNT(*) n, MIN(id) lo, MAX(id) hi FROM events WHERE task_id = ?`)
      .get(taskId) as { n: number; lo: number | null; hi: number | null };
    const evidence: BoundaryEvidence = {
      closedBy: 'user',
      nEvents: span.n,
      firstEventId: span.lo ?? 0,
      lastEventId: span.hi ?? 0,
      segmentedAt: Date.now(),
    };
    markUser.run(JSON.stringify(evidence), taskId);
  });
  tx();
  return n;
}

/**
 * 显式设置任务状态。
 *
 * 这是唯一能把 status 写成 done / abandoned 的入口，且会记下 status_source。
 * 分段算法不写 status —— 有 commit 不等于任务完成，没 commit 不等于放弃。
 */
export function setTaskStatus(
  db: DB,
  taskId: number,
  status: 'unknown' | 'open' | 'done' | 'abandoned',
  source: 'user' | 'inferred' = 'user',
): boolean {
  const r = db
    .prepare(`UPDATE tasks SET status = ?, status_source = ?, locked = ? WHERE id = ?`)
    .run(status, source, source === 'user' ? 1 : 0, taskId);
  return r.changes > 0;
}

/** 用户显式建立任务关系边。note 带 user: 前缀，重分段不会删。 */
export function linkTasks(
  db: DB,
  src: number,
  dst: number,
  rel: 'parent' | 'continues' | 'supersedes' | 'derived_from',
  note = '',
): boolean {
  const r = db
    .prepare(`INSERT OR REPLACE INTO task_edges (src, dst, rel, note) VALUES (?, ?, ?, ?)`)
    .run(src, dst, rel, `user:${note}`);
  return r.changes > 0;
}
