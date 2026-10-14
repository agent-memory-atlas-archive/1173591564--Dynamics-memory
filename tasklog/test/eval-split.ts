/**
 * R12：时间切分与防泄漏。
 *
 * 这组测试检验的是整个评估的地基。防泄漏做不到，第 11 节所有数字都是假的。
 *
 * 关键检验点不是"过滤掉了未来事件"，而是**过滤发生在 top-k 之前**：
 * 如果先取 top-k 再滤时间，未来的事件会先占掉名额，
 * 返回条数静默变少，而调用方看不出来 —— 这种错比直接泄漏更难发现。
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db/open.ts';
import { Ingestor } from '../src/ingest/events.ts';
import { rebuildTasks } from '../src/tasks/segment.ts';
import { searchHistory, symbolHistory, listTasks, readEvents } from '../src/query/index.ts';
import { listPilotCandidates, buildProbes, checkLeak } from '../src/eval/split.ts';
import { buildArmA, buildArmB, buildArmC, estimateTokens } from '../src/eval/arms.ts';
import { createHistorySnapshot } from '../src/eval/history.ts';
import type { EventInput } from '../src/types.ts';

const TMP = mkdtempSync(join(process.cwd(), '.tmp-eval-'));
const DB_PATH = join(TMP, 'log.db');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
function section(s: string): void {
  console.log(`\n${s}`);
}

// ============================================================
// fixture：过去 + 未来各一段，共享同一个符号
// 说明：这是机制测试用的合成数据，不是真实轨迹。
// ============================================================
const db = openDb({ path: DB_PATH });
const ing = new Ingestor(db, DB_PATH);
const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);
const MIN = 60_000;
const CUT = T0 + 100 * MIN;

const events: EventInput[] = [];
let seq = 0;
// 过去：30 条，都提到 src/payment/charge.ts
for (let i = 0; i < 30; i++) {
  events.push({
    sessionId: 'ses_past',
    seq: seq++,
    ts: T0 + i * MIN,
    role: i % 2 === 0 ? 'user' : 'assistant',
    kind: 'text',
    text: `过去事件 ${i}：讨论 src/payment/charge.ts 的重试策略 PAST_MARKER_${i}`,
  });
}
// 未来：40 条，提到同一个文件 + 独有的解法符号
let seq2 = 0;
for (let i = 0; i < 40; i++) {
  events.push({
    sessionId: 'ses_future',
    seq: seq2++,
    ts: CUT + i * MIN,
    role: i % 2 === 0 ? 'user' : 'assistant',
    kind: 'text',
    text:
      `未来事件 ${i}：src/payment/charge.ts 最终改用 exponentialBackoffRetry ` +
      `FUTURE_SOLUTION_MARKER_${i}`,
  });
}
ing.addMany(events);
rebuildTasks(db, { gapMs: 30 * MIN });

// ============================================================
section('[R12-a] 时间下压发生在 top-k 之前');
// ============================================================
{
  const k = 10;
  const unbounded = searchHistory(db, { query: 'src/payment/charge.ts', k });
  const bounded = searchHistory(db, { query: 'src/payment/charge.ts', k, untilTs: CUT });

  check('不设上界时能命中未来事件', unbounded.some((h) => h.ts >= CUT),
    `${unbounded.filter((h) => h.ts >= CUT).length}/${unbounded.length} 条来自未来`);
  check('设了上界就一条未来事件都没有', bounded.every((h) => h.ts < CUT),
    JSON.stringify(bounded.filter((h) => h.ts >= CUT).map((h) => h.ts)));
  check(
    '下压后仍能取满 k 条（证明过滤在 top-k 之前）',
    bounded.length === k,
    `拿到 ${bounded.length}/${k} 条 —— 少于 k 说明未来事件先占了名额`,
  );
  check('泄漏串不出现在任何命中里',
    !bounded.some((h) => /FUTURE_SOLUTION_MARKER/.test(h.brief.line)));
}

// ============================================================
section('[R12-b] 其余查询接口同样下压');
// ============================================================
{
  const sh = symbolHistory(db, 'src/payment/charge.ts', { limit: 100, untilTs: CUT });
  check('symbol_history 时间线不含未来', sh.timeline.every((e) => e.ts < CUT),
    `${sh.timeline.filter((e) => e.ts >= CUT).length} 条越界`);
  check('symbol_history 的 total 也按窗口算', sh.total === 30, `total=${sh.total}`);

  const shAll = symbolHistory(db, 'src/payment/charge.ts', { limit: 100 });
  check('不设窗口时 total 是全量', shAll.total === 70, `total=${shAll.total}`);

  const re = readEvents(db, { untilTs: CUT, limit: 200 });
  check('read_events 不含未来', re.events.every((e) => e.ts < CUT));
  check('read_events 的 total 按窗口算', re.total === 30, `${re.total}`);

  const lt = listTasks(db, { untilTs: CUT, limit: 100 });
  check('list_tasks 不含切点之后开始的任务', lt.every((t) => t.startedTs < CUT),
    JSON.stringify(lt.map((t) => t.startedTs - CUT)));
}

// ============================================================
section('[R12-c] pilot 候选与泄漏探针');
// ============================================================
{
  const cands = listPilotCandidates(db, { minPriorEvents: 10, minEvents: 3 });
  check('能挑出 pilot 候选', cands.length > 0, `${cands.length} 个`);
  check('候选带"之前有多少历史"，太少的不值得做 pilot',
    cands.every((c) => c.priorEvents >= 10));
  check('候选只给机械信号，不自动分类',
    cands.every((c) => typeof c.signals === 'object' && !('taskType' in c)));

  const future = cands.find((c) => c.startTs >= CUT);
  check('未来那段被识别为候选', !!future, JSON.stringify(cands.map((c) => c.startTs - CUT)));

  if (future) {
    const cut = { taskKey: 'pilot1', startTs: future.startTs, endTs: future.endTs };
    const probes = buildProbes(db, cut);
    const needles = probes.flatMap((p) => p.needles);
    check('探针抓到了该任务首次引入的标识符',
      needles.some((n) => /exponentialBackoffRetry/i.test(n)),
      JSON.stringify(needles.slice(0, 5)));

    const clean = searchHistory(db, { query: 'charge.ts 重试', k: 8, untilTs: cut.startTs })
      .map((h) => h.brief.line)
      .join('\n');
    const r1 = checkLeak(db, clean, cut, probes);
    check('干净上下文通过泄漏检查', r1.ok, JSON.stringify(r1.hits.slice(0, 2)));

    const dirty = `${clean}\n顺便一提，最后用的是 exponentialBackoffRetry`;
    const r2 = checkLeak(db, dirty, cut, probes);
    check('被污染的上下文会被抓住', !r2.ok && r2.hits.length > 0,
      JSON.stringify(r2.hits.slice(0, 1)));

    const r3 = checkLeak(db, clean, cut, probes, [1, 40, 60]);
    check('引用了未来事件 id 也会被抓住', r3.futureEvents.length > 0,
      JSON.stringify(r3.futureEvents));
  }
}

// ============================================================
section('[R12-d] 三臂上下文构造');
// ============================================================
{
  const cut = { taskKey: 'pilot1', startTs: CUT, endTs: null };
  const probes = buildProbes(db, cut);

  const a = buildArmA();
  check('A 臂不含任何历史', a.historyBlock === '' && a.estTokens === 0);
  check('A 臂没有 tasklog 工具', !a.tools.some((t) => t.startsWith('search_history')));

  // 窗口足够大 -> 完整装入
  const bBig = buildArmB(db, cut, { modelContextWindow: 1_000_000 });
  check('B 臂窗口够时完整装入，不做裁剪', bBig.degraded === undefined, JSON.stringify(bBig.degraded));
  check('B 臂拿到切点前的全部事件', bBig.referencedEventIds.length === 30,
    `${bBig.referencedEventIds.length}`);
  check('B 臂不含未来内容', !/FUTURE_SOLUTION_MARKER/.test(bBig.historyBlock));

  // 窗口不够 -> 必须降级而不是退赛
  const bSmall = buildArmB(db, cut, { modelContextWindow: 700, reserveTokens: 400 });
  check('B 臂超窗时降级而不是空手', bSmall.historyBlock.length > 0 && !!bSmall.degraded,
    JSON.stringify(bSmall.degraded));
  check('降级方式与丢弃量被记录', (bSmall.degraded?.droppedEvents ?? 0) > 0,
    JSON.stringify(bSmall.degraded));
  check('降级后仍在预算内', bSmall.estTokens <= 300, `${bSmall.estTokens}`);

  const c = buildArmC(db, cut, '继续处理 src/payment/charge.ts 的重试逻辑');
  check('C 臂拿到了 tasklog 工具', c.tools.includes('search_history') && c.tools.includes('resume_task'));
  check('C 臂发出了查询', c.warmup.length > 0, `${c.warmup.length} 次`);
  check('C 臂上下文不含未来内容', !/FUTURE_SOLUTION_MARKER/.test(c.historyBlock),
    c.historyBlock.slice(0, 200));
  const cLeak = checkLeak(db, c.historyBlock, cut, probes, c.referencedEventIds);
  check('C 臂上下文通过泄漏检查', cLeak.ok,
    JSON.stringify({ hits: cLeak.hits.slice(0, 2), future: cLeak.futureEvents.slice(0, 2) }));
  // 这里刻意不断言 "C 比 B 省上下文"。
  // 谁省谁费、省了之后效果如何，正是第 11 节要用实验回答的问题，
  // 写成单元测试等于把待验证的结论提前钉成事实。只记录数字。
  console.log(`  note  上下文规模 A=${a.estTokens} B=${bBig.estTokens} C=${c.estTokens} tokens（仅记录，不作断言）`);
  check('C 臂明确标注自己是 C-fixed 不是 C-model',
    c.notes.some((n) => /C-fixed/.test(n)));
}

// ============================================================
section('[R12-e] 查询遥测与主历史隔离');
// ============================================================
{
  const before = (db.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number }).n;
  const qlBefore = (db.prepare(`SELECT COUNT(*) n FROM query_log`).get() as { n: number }).n;
  buildArmC(db, { taskKey: 'p2', startTs: CUT, endTs: null }, '再查一次 charge.ts', undefined, 'run_test');
  const after = (db.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number }).n;
  const qlAfter = (db.prepare(`SELECT COUNT(*) n FROM query_log`).get() as { n: number }).n;

  check('预热查询不写进 events（否则下次检索会命中上次检索）', before === after,
    `${before} -> ${after}`);
  check('预热查询写进 query_log', qlAfter > qlBefore, `${qlBefore} -> ${qlAfter}`);

  const row = db
    .prepare(`SELECT * FROM query_log WHERE run_id='run_test' LIMIT 1`)
    .get() as Record<string, unknown>;
  check('遥测记录了阶段/工具/命中/字节/耗时',
    row.phase === 'warmup' &&
      typeof row.tool === 'string' &&
      typeof row.bytes_out === 'number' &&
      typeof row.latency_ms === 'number',
    JSON.stringify(row));

  const leaked = db
    .prepare(`SELECT COUNT(*) n FROM events WHERE text LIKE '%search_history%' OR text LIKE '%list_tasks%'`)
    .get() as { n: number };
  check('主历史里没有混入工具名痕迹', leaked.n === 0, `${leaked.n}`);
}

// ============================================================
section('[R12-f] token 估算');
// ============================================================
{
  check('中文按更高密度估算', estimateTokens('这是一段中文文本内容') > estimateTokens('abcdefghij'));
  check('空串为 0', estimateTokens('') === 0);
  console.log('  note 估算只用于构造阶段的预算控制；报告必须用 API 返回的真实 usage');
}

section('[R12-g] 完整原文与隔离快照');
{
  const body = '原始工具输出\n'.repeat(900) + 'BLOB_EVIDENCE_TAIL';
  ing.add({ sessionId: 'ses_blob', seq: 0, ts: T0 + 40 * MIN, role: 'tool', kind: 'tool_result', text: body, outcome: 'ok' });
  const cut = { taskKey: 'isolation', startTs: CUT, endTs: null };
  const b = buildArmB(db, cut, { modelContextWindow: 1_000_000 });
  check('B 臂内联 blob 尾部原文', b.historyBlock.includes('BLOB_EVIDENCE_TAIL'));
  const deepHits = searchHistory(db, { query: 'BLOB_EVIDENCE_TAIL', untilTs: CUT });
  check('无向量服务也能全文命中 blob 深处', deepHits.length === 1 && deepHits[0]!.matchedBy.includes('fts'));
  check('深处全文命中带精确原文区间', !!deepHits[0]?.lexicalSpan && deepHits[0]!.lexicalSpan!.byteFrom > 0);
  check('B 臂保留原文时间与会话出处', b.historyBlock.includes('ses_blob') && b.historyBlock.includes(String(T0 + 40 * MIN)));
  const past = (db.prepare(`SELECT task_id FROM events WHERE session_id='ses_past' LIMIT 1`).get() as { task_id: number }).task_id;
  db.prepare(`UPDATE tasks SET title='FUTURE_METADATA_SECRET', status='done', status_source='user' WHERE id=?`).run(past);
  db.prepare(`UPDATE events SET task_id=? WHERE session_id='ses_future'`).run(past);
  const snapshot = createHistorySnapshot(db, cut);
  try {
    check('快照物理排除未来事件', (snapshot.db.prepare(`SELECT COUNT(*) n FROM events WHERE ts >= ?`).get(CUT) as { n: number }).n === 0);
    check('快照重新派生任务而不复制未来标题', !JSON.stringify(listTasks(snapshot.db)).includes('FUTURE_METADATA_SECRET'));
    check('快照状态不继承未来人工确认', listTasks(snapshot.db).every((t) => t.status === 'unknown'));
    const c = buildArmC(db, cut, '继续处理 src/payment/charge.ts');
    check('C-fixed 不泄漏未来任务元数据', !c.historyBlock.includes('FUTURE_METADATA_SECRET'));
    check('C-fixed 所有引用都早于切点', checkLeak(db, c.historyBlock, cut, [], c.referencedEventIds).ok);
    const futureBody = '未来原文\n'.repeat(900) + 'FUTURE_BLOB_SECRET';
    const inserted = ing.add({ sessionId: 'ses_future_blob', seq: 0, ts: CUT + MIN, role: 'tool', kind: 'tool_result', text: futureBody });
    const futureRef = (db.prepare(`SELECT blob_ref FROM events WHERE id=?`).get(inserted.eventId) as { blob_ref: string }).blob_ref;
    check('即使知道未来 blob 句柄也无法读取', snapshot.readBlob(futureRef) === null);
  } finally { snapshot.close(); }
}

{
  const body = '完整原文\n'.repeat(1200) + '提问';
  const added = ing.add({ sessionId: 'short-query', seq: 0, ts: T0 + 50 * MIN, role: 'user', kind: 'text', text: body });
  ing.add({ sessionId: 'short-query', seq: 1, ts: CUT + MIN, role: 'user', kind: 'text', text: '提问：未来解法' });
  ing.add({ sessionId: 'short-query', seq: 2, ts: T0 + 51 * MIN, role: 'user', kind: 'text', text: 'literal %_ chars' });
  const hits = searchHistory(db, { query: '提问', untilTs: CUT, k: 3 });
  check('双字中文查询不被 trigram 静默丢弃', hits.some(h => h.locator.eventId === added.eventId));
  check('短查询发现 blob 深处原文并带区间', hits.some(h => h.locator.eventId === added.eventId && (h.lexicalSpan?.byteFrom ?? 0) > 0));
  check('短查询时间过滤下压，不泄漏未来', hits.length > 0 && hits.every(h => h.ts < CUT));
  const literal = searchHistory(db, { query: '%_', untilTs: CUT });
  check('短查询按字面匹配 SQL 通配符', literal.length === 1 && literal[0]!.brief.line.includes('%_'));
  check('空白查询不扫描全部历史', searchHistory(db, { query: '  ' }).length === 0);
}
{
  const large = openDb({ path: join(TMP, 'oversized.db') });
  const writer = new Ingestor(large, large.name);
  writer.addMany([
    { sessionId: 'large', seq: 0, ts: T0, role: 'user', kind: 'text', text: 'OLDER_USEFUL_EVIDENCE' },
    { sessionId: 'large', seq: 1, ts: T0 + MIN, role: 'tool', kind: 'tool_result', text: 'huge output '.repeat(6000) },
    { sessionId: 'large', seq: 2, ts: T0 + 2 * MIN, role: 'assistant', kind: 'text', text: 'LATEST_SMALL_EVIDENCE' },
  ]);
  const b = buildArmB(large, { taskKey: 'oversize', startTs: CUT, endTs: null }, { modelContextWindow: 20_000, overflowStrategy: 'compact' });
  check('B compact 遇到超大单条不停止打包其余证据', b.historyBlock.includes('OLDER_USEFUL_EVIDENCE') && b.historyBlock.includes('LATEST_SMALL_EVIDENCE'));
  check('B 超大原文省略明确记录且不伪称完整', b.degraded?.droppedEvents === 1 && b.estTokens <= 4000);
  large.close();
}

db.close();
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (failures.length) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
