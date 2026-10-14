/**
 * 测试：符号抽取单测 + 经真实 MCP client 的端到端验证。
 * 运行前需要 demo 数据：npm run demo
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { extractSymbols } from '../src/ingest/symbols.ts';
import { openDb } from '../src/db/open.ts';
import { searchHistory, resumeTask, listTasks, health } from '../src/query/index.ts';

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

const REPO = resolve(process.argv[2] ?? join(process.cwd(), 'demo-repo'));
const DB = join(REPO, '.tasklog', 'log.db');

if (!existsSync(DB)) {
  console.error(`缺少 demo 数据：先跑 npm run demo`);
  process.exit(2);
}

// ============================================================
console.log('\n[1] 符号抽取');
// ============================================================
{
  const s = extractSymbols({
    text: 'jwt.verify 在 src/auth/middleware.ts:8 抛 TypeError，跑 npm test -- auth 复现，commit 32e32b7644',
    argsJson: JSON.stringify({ path: 'config/server.yaml' }),
    toolName: 'read_file',
  });
  const has = (sym: string, kind?: string) =>
    s.some((x) => x.sym.toLowerCase() === sym.toLowerCase() && (!kind || x.kind === kind));

  check('抽出带目录的路径', has('src/auth/middleware.ts', 'path'));
  check('从 args 抽出路径', has('config/server.yaml', 'path'));
  check('抽出异常类名', has('TypeError', 'errcode'));
  check('抽出 commit sha', has('32e32b7644', 'sha'));
  check('抽出工具名', has('read_file', 'ident'));
  check('抽出点号表达式', s.some((x) => x.sym.includes('jwt.verify')));

  const noise = extractSymbols({ text: '这是一段普通的中文说明，没有任何代码符号在里面。' });
  check('纯自然语言不产生噪音符号', noise.length === 0, `得到 ${noise.length} 个`);

  const stop = extractSymbols({ text: 'if the value is true then return null for this object' });
  check('关键字与常见词被过滤', stop.length === 0, JSON.stringify(stop.map((x) => x.sym)));

  const casing = extractSymbols({ text: 'getUserId 与 get_user_ids 是两个不同的函数' });
  check(
    '形近标识符不合并',
    casing.some((x) => x.sym === 'getUserId') && casing.some((x) => x.sym === 'get_user_ids'),
  );
}

// ============================================================
console.log('\n[2] 查询层（直连 DB）');
// ============================================================
{
  const db = openDb({ path: DB, readonly: true });
  const h = health(db);
  check('事件已入库', h.events > 30, `events=${h.events}`);
  check('无孤儿事件（全部归属到任务）', h.orphanEvents === 0, `orphan=${h.orphanEvents}`);
  check('非文本事件全部有符号索引', h.unindexedRate === 0, `rate=${h.unindexedRate}`);
  check('检出被取代的任务', h.supersededTasks === 1, `n=${h.supersededTasks}`);

  // --- 核心场景：端口被 revert 之后，9090 仍要能查到，但必须标明已失效 ---
  // 这里原本断言"默认不返回被取代的事件"。那条断言是错的：
  // 被 revert 的那段恰恰存着"为什么改成 9090、后来为什么退回"，
  // 默认藏掉等于把最该读的一段删了。改为"默认可见 + 强制标注"。
  const hits = searchHistory(db, { query: 'config/server.yaml', k: 10 });
  const texts = hits.map((x) => x.brief.line).join(' | ');
  check('默认检索能看到被取代任务的事件', hits.some((x) => x.task.superseded), texts.slice(0, 120));
  check(
    '被取代的命中一律带 superseded 标注',
    hits.filter((x) => x.task.superseded).every((x) => x.currentValidity === 'superseded'),
    JSON.stringify(hits.map((x) => x.currentValidity)),
  );
  check(
    '被取代的命中给出取代者',
    hits.filter((x) => x.task.superseded).every((x) => (x.supersededBy?.length ?? 0) > 0),
  );

  const cur = searchHistory(db, { query: 'config/server.yaml', k: 10, onlyCurrent: true });
  check('only_current 才排除已失效内容', cur.every((x) => x.currentValidity === 'current'));
  check('only_current 下不出现已作废的 9090',
    !/9090/.test(cur.map((x) => x.brief.line).join(' | ')),
    cur.map((x) => x.brief.line).join(' | ').slice(0, 160));

  // --- 任务划分 ---
  const tasks = listTasks(db, { status: 'any', limit: 50 });
  check('任务数正确', tasks.length === 5, `n=${tasks.length}`);
  check('revert 的任务来自 git 边界', tasks.some((t) => t.boundarySrc === 'git' && t.commit));
  // 原断言是"有 commit 的段=done、无 commit 的中间段=abandoned、最后一段=open"。
  // 那是把分段证据当成了完成事实：commit 只能证明这里提交过一次，
  // 既不证明任务做完，也不证明没提交的段被放弃。现在一律 unknown。
  check('分段不臆断完成状态，一律 unknown', tasks.every((t) => t.status === 'unknown'),
    JSON.stringify(tasks.map((t) => t.status)));
  check('状态来源标为 none（没人确认过）', tasks.every((t) => t.statusSource === 'none'));
  check('分段证据单独可查', tasks.every((t) => {
    const ev = t.boundaryEvidence as { closedBy?: string } | null;
    return !!ev && typeof ev.closedBy === 'string';
  }), JSON.stringify((tasks[0]?.boundaryEvidence as Record<string, unknown>) ?? null));

  // --- 状态重建：按事件最多的任务挑，不再靠 status ---
  const open = [...tasks].sort((a, b) => b.events - a.events)[0]!;
  const r = resumeTask(db, open.taskId, { tail: 4 });
  const kinds = r.openItems.map((o) => o.kind);
  check('resume 检出未解决的错误', kinds.includes('unresolved_error'), JSON.stringify(kinds));
  check('resume 检出悬挂的工具调用', kinds.includes('dangling_call'), JSON.stringify(kinds));
  check('resume 给出完整骨架', r.skeleton.length === open.events, `${r.skeleton.length}/${open.events}`);
  check('resume 尾部不超过请求数', r.tail.length <= 4);

  const withTodo = tasks
    .map((t) => ({ t, r: resumeTask(db, t.taskId) }))
    .find((x) => x.r.openItems.some((o) => o.kind === 'todo'));
  check('留有 TODO 的任务被检出', !!withTodo,
    JSON.stringify(tasks.map((t) => resumeTask(db, t.taskId).openItems.length)));

  const sup = tasks.find((t) => t.superseded)!;
  const r3 = resumeTask(db, sup.taskId);
  check('被取代的任务会告知取代者', r3.related.supersededBy.length === 1);

  // --- 签名严格性：npm test 失败后 npm build 成功不算解决 ---
  const errItem = r.openItems.find((o) => o.kind === 'unresolved_error');
  check(
    '未闭合判定用调用签名而非只看工具名',
    !!errItem && /npm test/.test(errItem.detail),
    errItem?.detail.slice(0, 80) ?? '(无)',
  );

  db.close();
}

// ============================================================
console.log('\n[3] MCP 端到端');
// ============================================================
{
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', resolve('src/mcp/server.ts')],
    env: { ...process.env, TASKLOG_DB: DB, TASKLOG_REPO: REPO } as Record<string, string>,
  });
  const client = new Client({ name: 'tasklog-test', version: '0.1.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    '五个查询接口 + 两个辅助全部注册',
    ['index_health', 'list_tasks', 'read_blob', 'read_events', 'resume_task', 'search_history', 'symbol_history']
      .every((n) => names.includes(n)),
    names.join(','),
  );
  check(
    '每个工具都有非空描述',
    tools.tools.every((t) => (t.description ?? '').length > 40),
  );
  check(
    '全部标记为只读',
    tools.tools.every((t) => t.annotations?.readOnlyHint === true),
  );

  const callJson = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const t = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    return JSON.parse(t);
  };

  const lt = await callJson('list_tasks', {});
  // 原断言"默认隐藏被取代任务"同样编码了错误前提，改为"默认可见且带标注"
  check('list_tasks 默认也列出被取代任务', Array.isArray(lt) && lt.some((t: any) => t.superseded),
    JSON.stringify(lt.map((t: any) => t.superseded)));
  check('被取代的任务带取代者', lt.filter((t: any) => t.superseded)
    .every((t: any) => Array.isArray(t.supersededBy) && t.supersededBy.length > 0));
  const ltCur = await callJson('list_tasks', { only_current: true });
  check('only_current 才排除被取代任务', ltCur.every((t: any) => !t.superseded));
  check('list_tasks 带 topPaths 供下一步定位', lt.some((t: any) => t.topPaths?.length > 0));

  const sh = await callJson('search_history', { query: 'verifyToken', k: 5 });
  check('search_history 有命中', sh.length > 0, `n=${sh.length}`);
  check(
    'search_history 每条都带定位符',
    sh.every((h: any) => h.locator?.eventId && typeof h.locator.seq === 'number'),
  );
  check(
    'search_history 每条都带所属任务与可展开范围',
    sh.every((h: any) => h.task && (h.task.seqRange === null || h.task.seqRange.length === 2)),
  );

  const symh = await callJson('symbol_history', { symbol: 'src/auth/middleware.ts' });
  check('symbol_history 跨任务串起时间线', symh.timeline.length >= 4, `n=${symh.timeline.length}`);
  check(
    'symbol_history 时间有序',
    symh.timeline.every((e: any, i: number) => i === 0 || e.ts >= symh.timeline[i - 1].ts),
  );

  const openTask = [...lt].sort((a: any, b: any) => b.events - a.events)[0];
  const rt = await callJson('resume_task', { task_id: openTask.taskId, tail: 3 });
  check('resume_task 返回骨架/尾部/未闭合三段', !!rt.skeleton && !!rt.tail && !!rt.openItems);
  check('resume_task 给出行动提示', typeof rt.hint === 'string' && rt.hint.length > 0);

  const re = await callJson('read_events', { task_id: openTask.taskId, limit: 3 });
  check(
    'read_events 分页并给出跨会话游标',
    re.events.length === 3 && typeof re.next_cursor === 'string' && /^\d+\.\d+$/.test(re.next_cursor),
    JSON.stringify({ n: re.events.length, cursor: re.next_cursor }),
  );
  const re2 = await callJson('read_events', {
    task_id: openTask.taskId,
    limit: 3,
    cursor: re.next_cursor,
  });
  check(
    '游标续读不重复已读事件',
    re2.events.every((e: any) => !re.events.some((p: any) => p.eventId === e.eventId)),
  );

  // blob 回取：原件从未被删除
  const big = re.events.find((e: any) => e.blob) ??
    (await callJson('read_events', { task_id: openTask.taskId, limit: 50 })).events.find((e: any) => e.blob);
  check('大结果落盘并留下 blob 句柄', !!big, '未找到 blob 事件');
  if (big) {
    const blob = await callJson('read_blob', { blob: big.blob });
    check('read_blob 能取回完整原文', blob.bytes > 4096, `bytes=${blob.bytes}`);
    check('取回的原文含被截断的尾部内容', /module_399/.test(blob.content));
  }

  const hh = await callJson('index_health', {});
  check('index_health 暴露 unindexed_rate', typeof hh.unindexedRate === 'number');

  await client.close();
}

// ============================================================
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
