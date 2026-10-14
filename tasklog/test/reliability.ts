/**
 * 可靠性回归测试。先写失败测试，再修实现。
 *
 * 覆盖跨会话使用会踩到的 8 类问题（见 design/agent-memory-design.md 第 12 节）：
 *   R1 跨 session 排序与稳定游标
 *   R2 真正的任务尾部 + 骨架截断明示
 *   R3 旧任务可恢复
 *   R4 索引重建必须读 blob 原文
 *   R5 任务身份稳定 + 用户修订不被抹
 *   R6 分段证据 != 完成状态
 *   R7 被 revert 的任务仍有历史价值，不默认藏掉
 *   R8 blob 范围读取
 *   R9 重复导入幂等
 *
 * 这些测试只证明实现行为，不证明记忆有效。
 */

import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db/open.ts';
import { Ingestor, reindexSymbols, readBlob, type BlobSlice } from '../src/ingest/events.ts';
import { rebuildTasks, reassign } from '../src/tasks/segment.ts';
import {
  listTasks,
  searchHistory,
  symbolHistory,
  resumeTask,
  readEvents,
  getTask,
} from '../src/query/index.ts';
import type { EventInput } from '../src/types.ts';

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
function section(s: string): void {
  console.log(`\n${s}`);
}

const TMP = mkdtempSync(resolve('.tmp-reliability-'));
const DB_PATH = join(TMP, 'log.db');

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const MIN = 60_000;

// ============================================================
// fixture：三个 session 时间交错 + 一个长任务 + 大 blob
// ============================================================
const events: EventInput[] = [];

/** session A / B / C 的事件在时间轴上交替出现 —— 真实多会话并发的样子 */
const sessions = ['ses_A', 'ses_B', 'ses_C'];
const seqOf: Record<string, number> = { ses_A: 0, ses_B: 0, ses_C: 0 };

for (let i = 0; i < 30; i++) {
  const s = sessions[i % 3]!;
  events.push({
    sessionId: s,
    seq: seqOf[s]!++,
    ts: T0 + i * MIN,
    role: i % 2 === 0 ? 'user' : 'assistant',
    kind: 'text',
    text: `[${s}] 交错事件 ${i} interleaved_marker_${i}`,
  });
}

/** 长任务：600 个事件，远超旧实现 400 条的骨架上限 */
const LONG_T = T0 + 10 * 60 * MIN;
for (let i = 0; i < 600; i++) {
  events.push({
    sessionId: 'ses_LONG',
    seq: i,
    ts: LONG_T + i * 1000,
    role: 'assistant',
    kind: 'tool_call',
    toolName: 'read_file',
    callId: `lc${i}`,
    args: { path: `src/mod_${i}.ts` },
    text: `long_task_step_${i}`,
  });
}
/** 尾部放一个只在最后出现的标记 */
events.push({
  sessionId: 'ses_LONG',
  seq: 600,
  ts: LONG_T + 600 * 1000,
  role: 'assistant',
  kind: 'text',
  text: 'FINAL_TAIL_MARKER 这是真正的最后一条',
});

/** 大结果：>4KB，关键符号 deep_symbol_xyz 只出现在尾部（会被摘要截断掉） */
const bigBody =
  Array.from({ length: 300 }, (_, i) => `[build] step ${i} compiling module_${i}.ts ... ok`).join(
    '\n',
  ) + '\n最后一行才出现 deep_symbol_xyz 与 src/deep/buried.ts';
events.push({
  sessionId: 'ses_BIG',
  seq: 0,
  ts: T0 + 20 * 60 * MIN,
  role: 'tool',
  kind: 'tool_result',
  toolName: 'bash',
  callId: 'big1',
  text: bigBody,
  outcome: 'ok',
});

/** 被 revert 的任务里有一条「理由」，历史上仍然最相关 */
events.push(
  {
    sessionId: 'ses_REV',
    seq: 0,
    ts: T0 + 30 * 60 * MIN,
    role: 'user',
    kind: 'text',
    text: '把端口从 8080 改成 9090，config/server.yaml',
  },
  {
    sessionId: 'ses_REV',
    seq: 1,
    ts: T0 + 30 * 60 * MIN + 1000,
    role: 'assistant',
    kind: 'text',
    text: '已改 config/server.yaml，端口现在是 9090。REASON_MARKER 之所以选 9090 是因为 8080 被旧网关占用。',
  },
  {
    sessionId: 'ses_REV',
    seq: 2,
    ts: T0 + 40 * 60 * MIN,
    role: 'user',
    kind: 'text',
    text: '改回去，9090 跟新网关冲突 config/server.yaml',
  },
);

const db = openDb({ path: DB_PATH });
const ing = new Ingestor(db, DB_PATH);
const st1 = ing.addMany(events);
rebuildTasks(db);

console.log(`fixture: ${st1.inserted} 事件 / ${st1.symbols} 符号 / ${events.length} 输入`);

// ============================================================
section('[R1] 跨 session 排序与稳定游标');
// ============================================================
{
  // 全量（不限 session）必须按全局时间有序
  const all = readEvents(db, { limit: 1000 });
  const ordered = all.events.every(
    (e, i) => i === 0 || e.ts > all.events[i - 1]!.ts || (e.ts === all.events[i - 1]!.ts),
  );
  check('跨 session 全量按时间有序', ordered);

  // 分页：连续翻页不漏不重
  const seen: number[] = [];
  let cursor: string | null | undefined = undefined;
  let guard = 0;
  do {
    const page: any = readEvents(db, { limit: 37, cursor: cursor ?? undefined });
    for (const e of page.events) seen.push(e.eventId);
    cursor = page.nextCursor;
  } while (cursor && guard++ < 200);

  const total = (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
  check('游标分页覆盖全集', seen.length === total, `${seen.length}/${total}`);
  check('游标分页无重复', new Set(seen).size === seen.length, `unique=${new Set(seen).size}`);

  // 交错区段：A/B/C 三个 session 的事件必须交替出现，而不是按 session 分块
  const head = readEvents(db, { limit: 9 }).events;
  const sess = head.map((e) => e.sessionId);
  check('交错的 session 不被按 seq 分块', new Set(sess).size === 3, sess.join(','));
}

// ============================================================
section('[R2] 真正的任务尾部 + 骨架截断明示');
// ============================================================
{
  const longTask = listTasks(db, { status: 'any', limit: 500, includeSuperseded: true }).find(
    (t) => t.events > 500,
  );
  check('长任务已建立', !!longTask, `events=${longTask?.events}`);
  if (longTask) {
    const r: any = resumeTask(db, longTask.taskId, { tail: 5 });
    const tailTexts = r.tail.map((e: any) => e.line).join(' | ');
    check('尾部是真正最后几条', /FINAL_TAIL_MARKER/.test(tailTexts), tailTexts.slice(0, 120));
    check('骨架被截断时明示', r.skeletonTruncated === true, `skeletonTruncated=${r.skeletonTruncated}`);
    check(
      '截断时给出继续读取入口',
      typeof r.skeletonNextCursor === 'string' || typeof r.skeletonRange === 'object',
      JSON.stringify(Object.keys(r)),
    );
  }
}

// ============================================================
section('[R3] 旧任务可恢复（不靠最近 N 个任务列表）');
// ============================================================
{
  const oldest = db
    .prepare('SELECT id FROM tasks ORDER BY started_ts ASC LIMIT 1')
    .get() as { id: number };
  // 人为制造「任务很多」的情形
  const nTasks = (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
  const r = resumeTask(db, oldest.id);
  check('最早的任务仍能 resume', r.task !== null, `taskId=${oldest.id}, 任务总数=${nTasks}`);
  check('getTask 按 id 直查可用', getTask(db, oldest.id) !== null);
}

// ============================================================
section('[R4] 索引重建必须读 blob 原文');
// ============================================================
{
  const before = symbolHistory(db, 'deep_symbol_xyz');
  check('摘要截断掉的符号，首次写入时也应已索引', before.total > 0, `total=${before.total}`);

  const re = reindexSymbols(db);
  const after = symbolHistory(db, 'deep_symbol_xyz');
  check('重建索引后仍能命中 blob 深处的符号', after.total > 0, `total=${after.total}, 重建=${re.symbols}`);

  const afterPath = symbolHistory(db, 'src/deep/buried.ts');
  check('重建索引后命中 blob 深处的路径', afterPath.total > 0, `total=${afterPath.total}`);
}

// ============================================================
section('[R5] 任务身份稳定 + 用户修订不被抹');
// ============================================================
{
  const tasksBefore = listTasks(db, { status: 'any', limit: 1000, includeSuperseded: true });
  const probe = tasksBefore.find((t) => t.events >= 3 && t.events < 50)!;
  const evBefore = readEvents(db, { taskId: probe.taskId, limit: 500 }).events.map((e) => e.eventId);

  // 用户手工修订：把该任务的前两个事件挪到一个新任务里
  const moved = evBefore.slice(0, 2);
  const newTaskId = Number(
    (
      db
        .prepare(
          `INSERT INTO tasks (title, started_ts, ended_ts, boundary_src)
           VALUES ('用户手工切出的任务', ?, ?, 'user') RETURNING id`,
        )
        .get(T0, T0 + MIN) as { id: number }
    ).id,
  );
  reassign(db, moved, newTaskId);

  // 重新分段：不能抹掉用户修订
  rebuildTasks(db);

  const survived = getTask(db, newTaskId);
  check('重分段后用户修订的任务仍存在', survived !== null, `taskId=${newTaskId}`);
  if (survived) {
    const stillThere = readEvents(db, { taskId: newTaskId, limit: 10 }).events.map((e) => e.eventId);
    check(
      '重分段后用户指定的事件归属不变',
      moved.every((id) => stillThere.includes(id)),
      `期望 ${moved}, 实际 ${stillThere}`,
    );
  }

  // 旧定位符语义：原任务 id 要么仍可解析，要么能追到继任者
  const old = getTask(db, probe.taskId);
  check(
    '旧 task_id 仍可解析（或标记为已退役并给出继任者）',
    old !== null,
    `taskId=${probe.taskId}`,
  );
  if (old) {
    check(
      '旧 task_id 有稳定键可追踪',
      typeof (old as any).stableKey === 'string' && (old as any).stableKey.length > 0,
      JSON.stringify(Object.keys(old)),
    );
  }
}

// ============================================================
section('[R6] 分段证据 != 完成状态');
// ============================================================
{
  const all = listTasks(db, { status: 'any', limit: 1000, includeSuperseded: true });
  const noCommitNotLast = all.filter((t) => !t.commit).slice(1);
  check(
    '无 commit 的中间段不得被断言为 abandoned',
    !noCommitNotLast.some((t) => t.status === 'abandoned'),
    `有 ${noCommitNotLast.filter((t) => t.status === 'abandoned').length} 个被误判`,
  );
  check(
    '未经确认的任务状态为 unknown',
    all.some((t) => t.status === 'unknown'),
    `状态分布=${JSON.stringify(all.reduce<Record<string, number>>((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {}))}`,
  );
  check(
    '分段证据单独记录，可审计',
    all.every((t) => {
      const ev = (t as any).boundaryEvidence;
      return (
        ev !== null &&
        typeof ev === 'object' &&
        typeof ev.closedBy === 'string' &&
        typeof ev.nEvents === 'number' &&
        typeof ev.firstEventId === 'number'
      );
    }),
    JSON.stringify((all[0] as any)?.boundaryEvidence ?? null),
  );
  check(
    '状态来源可区分 inferred / user',
    all.every((t) => ['inferred', 'user', 'none'].includes((t as any).statusSource)),
    JSON.stringify(all.slice(0, 2).map((t: any) => t.statusSource)),
  );
}

// ============================================================
section('[R7] 被取代的任务仍有历史价值');
// ============================================================
{
  // 手工建立一条 supersedes 边模拟 revert
  const revTasks = listTasks(db, { status: 'any', limit: 1000, includeSuperseded: true }).filter(
    (t) => t.topPaths.some((p) => p.includes('server.yaml')),
  );
  if (revTasks.length >= 2) {
    const sorted = revTasks.sort((a, b) => a.startedTs - b.startedTs);
    db.prepare(
      `INSERT OR IGNORE INTO task_edges (src, dst, rel, note) VALUES (?, ?, 'supersedes', 'test')`,
    ).run(sorted[sorted.length - 1]!.taskId, sorted[0]!.taskId);
  }

  const hist = searchHistory(db, { query: 'REASON_MARKER', k: 10 });
  check(
    '历史查询默认能看到被取代任务里的理由',
    hist.length > 0,
    `命中 ${hist.length} 条`,
  );
  check(
    '被取代的命中带明确标注而不是消失',
    hist.length === 0 || hist.every((h) => typeof (h.task as any).currentValidity === 'string'),
    JSON.stringify(hist[0]?.task ?? {}),
  );

  const currentOnly = searchHistory(db, { query: 'config/server.yaml', k: 10, onlyCurrent: true });
  check(
    'only_current 才排除已失效的内容',
    currentOnly.every((h) => (h.task as any).currentValidity !== 'superseded'),
    `${currentOnly.length} 条`,
  );
}

// ============================================================
section('[R8] blob 范围读取');
// ============================================================
{
  const row = db.prepare(`SELECT blob_ref FROM events WHERE blob_ref IS NOT NULL LIMIT 1`).get() as
    | { blob_ref: string }
    | undefined;
  check('存在 blob', !!row);
  if (row) {
    const posixRef = row.blob_ref.replace(/\\/g, '/');
    const windowsRef = posixRef.replace(/\//g, '\\');
    check('POSIX blob 引用可读', typeof readBlob(DB_PATH, posixRef) === 'string');
    check('Windows blob 引用可读', typeof readBlob(DB_PATH, windowsRef) === 'string');
    const hash = (posixRef.split('/').pop() ?? '').replace(/\.txt$/, '');
    const brief = readEvents(db, { sessionId: 'ses_BIG' }).events.find((e) => e.blob);
    check('查询返回可回读的 blob 句柄', !!brief?.blob && readBlob(DB_PATH, brief.blob) !== null);
    const full = readBlob(DB_PATH, hash) as any;
    const totalBytes = typeof full === 'string' ? Buffer.byteLength(full, 'utf8') : full?.totalBytes;
    check('blob 总长可知', typeof totalBytes === 'number' && totalBytes > 4096, `${totalBytes}`);

    const tailPart: any = readBlob(DB_PATH, hash, { offset: Math.max(0, (totalBytes ?? 0) - 400) });
    const content = typeof tailPart === 'string' ? tailPart : tailPart?.content;
    check('可按 offset 读到 blob 尾部', /deep_symbol_xyz/.test(content ?? ''), (content ?? '').slice(-80));

    const mid: any = readBlob(DB_PATH, hash, { offset: 1000, length: 200 });
    const midC = typeof mid === 'string' ? mid : mid?.content;
    check('可按 offset+length 读中段', (midC ?? '').length <= 200 && (midC ?? '').length > 0);
    const unicodeText = '汉字原文'.repeat(1500);
    const unicode = ing.add({ sessionId: 'ses_UNICODE', seq: 0, ts: T0, role: 'tool', kind: 'tool_result', text: unicodeText });
    const unicodeRef = (db.prepare('SELECT blob_ref FROM events WHERE id=?').get(unicode.eventId) as { blob_ref: string }).blob_ref;
    let offset: number | null = 0, reconstructed = '', intact = true;
    while (offset !== null) {
      const slice: BlobSlice = readBlob(DB_PATH, unicodeRef, { offset, length: 257 })!;
      intact &&= !slice.content.includes('\ufffd') && (slice.nextOffset === null || slice.nextOffset > offset);
      reconstructed += slice.content;
      offset = slice.nextOffset;
    }
    check('中文原文分页不产生替换字符且游标前进', intact);
    check('中文原文多页拼接逐字一致', reconstructed === unicodeText);
  }
}

// ============================================================
section('[R9] 重复导入幂等');
// ============================================================
{
  const before = db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number };
  const symBefore = db.prepare('SELECT COUNT(*) n FROM symbols').get() as { n: number };
  const again = ing.addMany(events);
  const after = db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number };
  const symAfter = db.prepare('SELECT COUNT(*) n FROM symbols').get() as { n: number };
  check('重复导入不增加事件', before.n === after.n, `${before.n} -> ${after.n}`);
  check('重复导入不增加符号', symBefore.n === symAfter.n, `${symBefore.n} -> ${symAfter.n}`);
  check('重复导入全部计为 skipped', again.inserted === 0, `inserted=${again.inserted}`);
}

db.close();

// ============================================================
console.log(`\n==== ${pass} passed, ${failures.length} failed ====`);
if (failures.length) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
