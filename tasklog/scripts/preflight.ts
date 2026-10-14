#!/usr/bin/env -S npx tsx
/**
 * 真实日志体检。
 *
 * 用法：
 *   npx tsx scripts/preflight.ts --host-db /path/to/opencode.db [--repo /path/to/project]
 *
 * 它回答一个问题：**这份日志够不够支撑第 11 节的三臂评估？**
 *
 * 回答只有三种，不打分、不含糊：
 *   够        —— 列出可用的 pilot 候选
 *   勉强      —— 指出哪几类任务样本不足，说明结论会弱在哪
 *   不够      —— 说明缺什么，不要硬跑
 *
 * 它不修改任何已有数据：导入是幂等的，重复跑安全。
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/db/open.ts';
import { importOpenCode, locateOpenCodeDb } from '../src/adapters/opencode.ts';
import { importDevin, locateDevinDb } from '../src/adapters/devin.ts';
import { syncCommits } from '../src/tasks/git.ts';
import { rebuildTasks } from '../src/tasks/segment.ts';
import { health } from '../src/query/index.ts';
import { listPilotCandidates } from '../src/eval/split.ts';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string): boolean => argv.includes(`--${n}`);

const source = flag('source') ?? 'opencode';
if (!['opencode', 'devin'].includes(source)) throw new Error('Supported sources: opencode, devin');
const hostDb = flag('source-snapshot') ?? flag('host-db') ?? (source === 'devin' ? locateDevinDb() : locateOpenCodeDb()) ?? undefined;
const hostStorage = flag('host-storage');
const repo = flag('repo') ? resolve(flag('repo')!) : null;
const dbPath = resolve(flag('db') ?? join(process.cwd(), '.tasklog', 'eval.db'));

const line = (s = ''): void => console.log(s);
const h1 = (s: string): void => {
  line();
  line(`${'='.repeat(64)}`);
  line(s);
  line(`${'='.repeat(64)}`);
};

h1('1. 输入');
line(`  宿主 DB      ${hostDb ?? '(未找到)'}`);
line(`  宿主 storage ${hostStorage ?? '(未指定)'}`);
line(`  目标仓库     ${repo ?? '(未指定，将跳过 git 同步)'}`);
line(`  tasklog DB   ${dbPath}`);

if (!hostDb && !hostStorage) {
  line();
  if (source === 'devin') { line('没有可读的 Devin sessions.db，请给 --host-db。'); process.exit(2); }
  line('没有可读的 OpenCode 数据。请给 --host-db 或 --host-storage。');
  line();
  line('找库的办法：');
  line('  opencode db path                               # 1.17+ 直接打印');
  line('  ls ~/.local/share/opencode/opencode.db         # Unix 默认位置');
  line('  ls ~/.local/share/opencode/storage/session     # 1.17 之前的 JSON 布局');
  line();
  line('导出前建议先 checkpoint，否则最近的会话可能读不到：');
  line('  sqlite3 ~/.local/share/opencode/opencode.db "PRAGMA wal_checkpoint(TRUNCATE);"');
  process.exit(2);
}
if (repo && !existsSync(join(repo, '.git'))) {
  line();
  line(`  注意：${repo} 下没有 .git —— 任务边界将只能靠时间 gap，质量会明显下降。`);
}

const db = openDb({ path: dbPath });

h1('2. 导入');
const rep = source === 'devin'
  ? importDevin(db, dbPath, { dbPath: hostDb, snapshot: !flag('source-snapshot'), directoryPrefix: flag('project') ?? repo ?? undefined, sessions: flag('sessions')?.split(','), untilTs: flag('until') ? Number(flag('until')) : undefined })
  : importOpenCode(db, dbPath, { dbPath: hostDb, storageDir: hostStorage, directoryPrefix: repo ?? undefined, readGit: !has('no-git') });
line(`  宿主        ${rep.source}`);
line(`  布局        ${rep.layout}`);
line(`  会话        ${rep.sessions}`);
line(`  消息 / part ${rep.messages} / ${rep.parts}`);
line(`  事件        写入 ${rep.inserted}，跳过 ${rep.skipped}（跳过 = 之前导过，幂等）`);
if (rep.source === 'opencode') {
  line(`  宿主版本    ${rep.hostVersions.join(', ') || '(未知)'}`);
  line(`  part 类型   ${JSON.stringify(rep.partTypes)}`);
  if (rep.unmappedTypes.length) line(`  未映射类型  ${rep.unmappedTypes.join(', ')}`);
} else {
  line(`  源快照      ${rep.hostPath}`);
  line(`  压缩副本    ${rep.duplicates} 个组件；摘要节点 ${rep.summaries}；系统前缀 ${rep.systemPrefixes}；无原始时间 ${rep.untimed}`);
  if (rep.unmappedRoles.length) line(`  未映射角色  ${rep.unmappedRoles.join(', ')}`);
}
if (rep.repos.length) {
  line(`  关联仓库`);
  for (const r of rep.repos) line(`    ${r.directory}  branch=${r.branch ?? '?'} head=${(r.head ?? '').slice(0, 10)}`);
}
if (rep.warnings.length) {
  line();
  line('  警告:');
  for (const w of rep.warnings) line(`    - ${w}`);
}
if (rep.layout === 'none') {
  line();
  line('  读不到任何宿主数据，后面的体检没有意义，到此为止。');
  line(`  检查路径是否存在：${hostDb ?? hostStorage}`);
  db.close();
  process.exit(2);
}
if (rep.sessions === 0 || rep.events === 0) {
  line();
  line('  库能打开，但筛选后没有会话。');
  if (repo) line(`  很可能是 --repo ${repo} 与会话的 directory 对不上。先去掉 --repo 再跑一次看看。`);
  db.close();
  process.exit(2);
}

if (repo && existsSync(join(repo, '.git'))) {
  h1('3. 同步 git 与任务划分');
  const n = syncCommits(db, repo);
  const seg = rebuildTasks(db);
  line(`  commits 同步 ${n}`);
  line(`  任务 ${seg.tasks}（新建 ${seg.created} / 复用 ${seg.reused} / 退役 ${seg.retired} / 锁定 ${seg.locked}）`);
  line(`  边界来源 git=${seg.fromGit} heuristic=${seg.fromHeuristic}`);
  line(`  关系边 supersedes=${seg.edges.supersedes} continues=${seg.edges.continues}`);
} else {
  h1('3. 任务划分（无 git，只能靠时间 gap）');
  const seg = rebuildTasks(db);
  line(`  任务 ${seg.tasks}，全部 boundary_src=heuristic`);
}

h1('4. 索引健康度');
const hh = health(db);
for (const [k, v] of Object.entries(hh)) line(`  ${k.padEnd(20)} ${JSON.stringify(v)}`);

h1('5. 数据能支撑哪几类 pilot');

const span = db.prepare(`SELECT MIN(ts) lo, MAX(ts) hi FROM events`).get() as {
  lo: number | null;
  hi: number | null;
};
const days = span.lo && span.hi ? (span.hi - span.lo) / 86_400_000 : 0;
const nSessions = (
  db.prepare(`SELECT COUNT(DISTINCT session_id) n FROM events`).get() as { n: number }
).n;
const nErr = (
  db.prepare(`SELECT COUNT(*) n FROM events WHERE outcome='error'`).get() as { n: number }
).n;
const nSup = (
  db.prepare(`SELECT COUNT(*) n FROM task_edges WHERE rel='supersedes'`).get() as { n: number }
).n;
const nTasks = (
  db.prepare(`SELECT COUNT(*) n FROM tasks WHERE retired_at IS NULL`).get() as { n: number }
).n;

line(`  时间跨度   ${days.toFixed(1)} 天`);
line(`  会话数     ${nSessions}`);
line(`  任务数     ${nTasks}`);
line(`  失败事件   ${nErr}`);
line(`  supersedes ${nSup}`);
line();

type Verdict = '够' | '勉强' | '不够';
const rows: Array<{ type: string; verdict: Verdict; why: string }> = [
  {
    type: '1 继续被中断的任务',
    verdict: nErr >= 5 && nTasks >= 4 ? '够' : nErr >= 1 ? '勉强' : '不够',
    why: `需要有未闭合项的任务；当前失败事件 ${nErr}，任务 ${nTasks}`,
  },
  {
    type: '2 避免重复失败方案',
    verdict: nErr >= 8 ? '够' : nErr >= 3 ? '勉强' : '不够',
    why: `需要同一件事失败过并留下记录；当前失败事件 ${nErr}`,
  },
  {
    type: '3 遵守历史决策及其修订',
    verdict: nSup >= 2 ? '够' : nSup >= 1 ? '勉强' : '不够',
    why: `需要 revert / 决策推翻；当前 supersedes 边 ${nSup}`,
  },
  {
    type: '4 跨任务复用项目约定',
    verdict: nSessions >= 3 && nTasks >= 6 ? '够' : nSessions >= 2 ? '勉强' : '不够',
    why: `需要多会话多任务共享约定；当前会话 ${nSessions}，任务 ${nTasks}`,
  },
  {
    type: '5 历史无关任务（污染检测）',
    verdict: nTasks >= 3 ? '够' : '不够',
    why: '只要有足够历史可供"误用"即可；这一类是唯一可能让 C 输的设计，必须保留',
  },
];
for (const r of rows) line(`  [${r.verdict}] ${r.type.padEnd(22)} ${r.why}`);

h1('6. pilot 候选（机械筛选，分类必须人工确认）');
const cands = listPilotCandidates(db, { minPriorEvents: 20, minEvents: 3 });
if (cands.length === 0) {
  line('  没有满足条件的候选（要求：之前至少 20 条历史、任务本身至少 3 条事件）。');
} else {
  line(`  共 ${cands.length} 个。按"之前历史量"排序，取前 15：`);
  line();
  for (const c of [...cands].sort((a, b) => b.priorEvents - a.priorEvents).slice(0, 15)) {
    const sig = [
      c.signals.hasUnresolvedError ? '有未解错误' : '',
      c.signals.hasTodo ? '有TODO' : '',
      c.signals.isSuperseded ? '被取代' : '',
      c.signals.supersedesOther ? '取代了别的' : '',
      c.signals.touchesFilesSeenBefore > 0 ? `复用${c.signals.touchesFilesSeenBefore}个旧文件` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    line(
      `  task#${String(c.taskId).padEnd(5)} 事件${String(c.events).padStart(4)} ` +
        `先验${String(c.priorEvents).padStart(5)}条/${String(c.priorSpanDays).padStart(5)}天  ` +
        `${(c.title ?? '(无标题)').slice(0, 40)}`,
    );
    if (sig) line(`              ${sig}`);
  }
}

h1('7. 结论');
const bad = rows.filter((r) => r.verdict === '不够');
const weak = rows.filter((r) => r.verdict === '勉强');
if (bad.length === 0 && weak.length === 0) {
  line('  五类任务都有数据支撑。可以进入 pilot 设计。');
} else if (bad.length >= 3) {
  line('  数据不足以支撑这组评估。强行跑出来的差异说明不了问题。');
  line('  缺的是：');
  for (const r of bad) line(`    - ${r.type}：${r.why}`);
} else {
  line('  可以跑，但结论会弱在这几类上，报告里必须写明：');
  for (const r of [...bad, ...weak]) line(`    - [${r.verdict}] ${r.type}：${r.why}`);
}
line();
line('  下一步需要人工做的（不能自动化，自动化就等于被测系统自己出题）：');
line('    1. 从第 6 节的候选里为五类各挑 2-3 个任务');
line('    2. 为每个任务写题面与验收标准（隐藏测试或可审计条目）');
line('    3. 确认每个任务的 ground truth，并跑 checkLeak 验证切分干净');
line();
line(`  数据库：${dbPath}`);

db.close();
