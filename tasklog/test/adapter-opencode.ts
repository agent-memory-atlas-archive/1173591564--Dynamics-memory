/**
 * R11：OpenCode 适配器。
 *
 * ============================================================
 * 这个文件里的 opencode.db 是合成 fixture，不是真实 agent 轨迹。
 * ============================================================
 * 它存在的目的只有一个：验证适配器的解析逻辑对不对 ——
 * 字段读没读对、tool part 拆没拆开、失败有没有被当成成功、
 * 重复导入会不会产生副本。
 *
 * 它不能用来说明"tasklog 在真实项目里有用"，也不能当成实验数据。
 * 真实结论必须来自用户提供的真实 opencode.db。
 * 同理，fixture 里的字段形状是按 OpenCode 1.18 的公开描述写的，
 * 如果宿主实际 schema 与此不同，这些测试全绿也不代表能读真库。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/open.ts';
import { importOpenCode, lastImportedTs } from '../src/adapters/opencode.ts';

const TMP = mkdtempSync(join(process.cwd(), '.tmp-adapter-'));

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
// 合成 fixture：OpenCode 1.18 形态的 SQLite
// ============================================================
const HOST_DB = join(TMP, 'opencode.db');
const T0 = Date.UTC(2026, 8, 3, 10, 0, 0);

function buildHostDb(): void {
  const h = new Database(HOST_DB);
  // 刻意开 WAL：真实的 live 库就是 WAL，适配器必须能对付旁车文件
  h.pragma('journal_mode = WAL');
  h.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
      title TEXT, version TEXT, slug TEXT, path TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER, revert TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
    );
  `);

  const insS = h.prepare(
    `INSERT INTO session (id, directory, title, version, parent_id, time_created, model)
     VALUES (?,?,?,?,?,?,?)`,
  );
  // model 是 JSON 对象，不是字符串 —— 这是容易读错的地方
  insS.run(
    'ses_alpha',
    '/work/proj-a',
    '修登录超时',
    '1.18.3',
    null,
    T0,
    JSON.stringify({ id: 'claude-sonnet-4-6', providerID: 'anthropic', variant: null }),
  );
  insS.run('ses_beta', '/work/proj-b', '别的项目', '1.18.3', null, T0 + 60_000, 'legacy-model-string');
  // 子会话（subagent）用 parent_id 标识
  insS.run('ses_child', '/work/proj-a', 'subagent', '1.18.3', 'ses_alpha', T0 + 120_000, null);

  const insM = h.prepare(
    `INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`,
  );
  const insP = h.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`,
  );

  // --- ses_alpha ---
  insM.run('m1', 'ses_alpha', T0 + 1000, JSON.stringify({ role: 'user' }));
  insP.run('p1', 'm1', 'ses_alpha', T0 + 1000, JSON.stringify({
    type: 'text',
    text: '登录偶尔超时，排查一下 src/auth/session.ts',
  }));

  insM.run('m2', 'ses_alpha', T0 + 2000, JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4-6' }));
  insP.run('p2', 'm2', 'ses_alpha', T0 + 2000, JSON.stringify({
    type: 'reasoning',
    text: '先看看 refreshToken 的超时设置 ADAPTER_REASONING_MARKER',
  }));
  insP.run('p3', 'm2', 'ses_alpha', T0 + 2100, JSON.stringify({
    type: 'tool',
    tool: 'bash',
    callID: 'call_001',
    state: { status: 'error', input: { command: 'npm test -- auth' }, error: 'FAIL src/auth/session.test.ts\nTimeout of 5000ms exceeded' },
  }));
  insP.run('p4', 'm2', 'ses_alpha', T0 + 2200, JSON.stringify({
    type: 'text',
    text: '测试超时了，看来 ADAPTER_FINDING 连接池没释放',
  }));

  insM.run('m3', 'ses_alpha', T0 + 3000, JSON.stringify({ role: 'assistant' }));
  insP.run('p5', 'm3', 'ses_alpha', T0 + 3000, JSON.stringify({
    type: 'tool',
    tool: 'edit',
    callID: 'call_002',
    state: { status: 'completed', input: { filePath: 'src/auth/session.ts' }, output: '1 replacement' },
  }));
  // 状态字符串宿主没给 —— 不许默认当成功
  insP.run('p6', 'm3', 'ses_alpha', T0 + 3100, JSON.stringify({
    type: 'tool',
    tool: 'bash',
    callID: 'call_003',
    state: { input: { command: 'npm run build' }, output: 'built' },
  }));
  insP.run('p7', 'm3', 'ses_alpha', T0 + 3200, JSON.stringify({ type: 'step-finish', tokens: 1234 }));
  // 未来版本可能出现的新类型
  insP.run('p8', 'm3', 'ses_alpha', T0 + 3300, JSON.stringify({ type: 'brand-new-type', foo: 'bar' }));

  // --- ses_beta（另一个项目，用于目录过滤）---
  insM.run('m4', 'ses_beta', T0 + 61_000, JSON.stringify({ role: 'user' }));
  insP.run('p9', 'm4', 'ses_beta', T0 + 61_000, JSON.stringify({
    type: 'text',
    text: '这是 proj-b 的事，OTHER_PROJECT_MARKER',
  }));

  // --- ses_child（晚于 alpha，用于增量导入）---
  insM.run('m5', 'ses_child', T0 + 500_000, JSON.stringify({ role: 'assistant' }));
  insP.run('p10', 'm5', 'ses_child', T0 + 500_000, JSON.stringify({
    type: 'text',
    text: 'subagent 的结论 LATER_MARKER',
  }));

  h.close();
}

buildHostDb();

// ============================================================
section('[R11-a] 读取 1.17+ 的 SQLite 布局');
// ============================================================
const TL_DB = join(TMP, 'tasklog', 'log.db');
const db = openDb({ path: TL_DB });

const rep = importOpenCode(db, TL_DB, { dbPath: HOST_DB, readGit: false });

check('识别为 sqlite 布局', rep.layout === 'sqlite', rep.layout);
check('读到三个 session', rep.sessions === 3, `${rep.sessions}`);
check('记录宿主版本（schema 不稳定，必须钉版本）', rep.hostVersions.includes('1.18.3'), JSON.stringify(rep.hostVersions));
check('带 wal 旁车的库能打开', rep.warnings.every((w) => !/unable to open/i.test(w)), JSON.stringify(rep.warnings));
check('写入了事件', rep.inserted > 0, `inserted=${rep.inserted}`);
check(
  '未映射的新类型被报告而不是静默丢弃',
  rep.unmappedTypes.includes('brand-new-type'),
  JSON.stringify(rep.unmappedTypes),
);

// ============================================================
section('[R11-b] 原文、工具事件、失败判定');
// ============================================================
{
  const rows = db
    .prepare(`SELECT * FROM events WHERE session_id = 'ses_alpha' ORDER BY ts, id`)
    .all() as Array<Record<string, unknown>>;

  check('用户原文逐字保留', rows.some((r) => String(r.text ?? '').includes('登录偶尔超时，排查一下 src/auth/session.ts')));
  check('reasoning 默认保留（里面常有"为什么不这么做"）',
    rows.some((r) => String(r.text ?? '').includes('ADAPTER_REASONING_MARKER')));

  const calls = rows.filter((r) => r.kind === 'tool_call');
  const results = rows.filter((r) => r.kind === 'tool_result' || r.kind === 'error');
  check('tool part 拆成调用与结果两条', calls.length === 3 && results.length === 3,
    `calls=${calls.length} results=${results.length}`);

  const c1 = calls.find((r) => r.call_id === 'call_001');
  check('工具调用参数完整保留', String(c1?.args_json ?? '').includes('npm test -- auth'), String(c1?.args_json));

  const r1 = results.find((r) => r.call_id === 'call_001');
  check('失败被判为 error', r1?.outcome === 'error', String(r1?.outcome));
  check('错误原文保留', String(r1?.text ?? '').includes('Timeout of 5000ms exceeded'));

  const r2 = results.find((r) => r.call_id === 'call_002');
  check('completed 判为 ok', r2?.outcome === 'ok', String(r2?.outcome));

  const r3 = results.find((r) => r.call_id === 'call_003');
  check(
    '宿主没给状态时留空，不默认当成功',
    r3?.outcome === null || r3?.outcome === undefined,
    `outcome=${String(r3?.outcome)}`,
  );
}

// ============================================================
section('[R11-c] 原始记录与推断元数据必须可分辨');
// ============================================================
{
  const r = db
    .prepare(`SELECT source, source_id, source_ref FROM events WHERE session_id='ses_alpha' LIMIT 1`)
    .get() as { source: string; source_id: string; source_ref: string };
  check('标了来源系统', r.source === 'opencode', r.source);
  check('保留宿主的稳定 id', typeof r.source_id === 'string' && r.source_id.length > 0, r.source_id);

  const ref = JSON.parse(r.source_ref) as Record<string, unknown>;
  check('保留宿主 session/message/part 三级标识',
    !!ref.sessionId && !!ref.messageId && !!ref.partId,
    JSON.stringify({ s: ref.sessionId, m: ref.messageId, p: ref.partId }));
  check('保留宿主自己的时间戳', typeof ref.messageTimeCreated === 'number');
  check('model 是 JSON 对象也能读成标签', ref.model === 'anthropic/claude-sonnet-4-6', String(ref.model));
  check('子会话关系保留（subagent 靠 parent_id）',
    (db.prepare(`SELECT source_ref FROM events WHERE session_id='ses_child' LIMIT 1`).get() as any)
      ? JSON.parse((db.prepare(`SELECT source_ref sr FROM events WHERE session_id='ses_child' LIMIT 1`).get() as any).sr).parentSessionId === 'ses_alpha'
      : false);
  check('推断出来的东西单独放在 inferred 里', !!ref.inferred && typeof ref.inferred === 'object',
    JSON.stringify(ref.inferred));

  const toolRef = JSON.parse(
    (db.prepare(`SELECT source_ref sr FROM events WHERE call_id='call_003' AND kind='tool_result'`).get() as any).sr,
  ) as Record<string, unknown>;
  const inferred = toolRef.inferred as Record<string, unknown>;
  check('outcome 的判定依据被写明', typeof inferred.outcomeInferredFrom === 'string',
    JSON.stringify(inferred));
}

// ============================================================
section('[R11-d] 可重复导入、可增量追加');
// ============================================================
{
  const before = (db.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number }).n;
  const rep2 = importOpenCode(db, TL_DB, { dbPath: HOST_DB, readGit: false });
  const after = (db.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number }).n;
  check('重复导入不产生副本', before === after, `${before} -> ${after}`);
  check('重复导入全部计为 skipped', rep2.inserted === 0 && rep2.skipped > 0,
    `inserted=${rep2.inserted} skipped=${rep2.skipped}`);

  const ts = lastImportedTs(db);
  check('记录了导入水位线', typeof ts === 'number' && ts > 0, String(ts));

  // 宿主新增一条（模拟继续用 OpenCode 干活）
  const h = new Database(HOST_DB);
  h.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`).run(
    'm6', 'ses_alpha', T0 + 900_000, JSON.stringify({ role: 'user' }),
  );
  h.prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`).run(
    'p11', 'm6', 'ses_alpha', T0 + 900_000,
    JSON.stringify({ type: 'text', text: '后来又补了一句 INCREMENTAL_MARKER' }),
  );
  h.close();

  const rep3 = importOpenCode(db, TL_DB, { dbPath: HOST_DB, sinceTs: ts! + 1, readGit: false });
  check('增量追加只写新内容', rep3.inserted === 1, `inserted=${rep3.inserted}`);
  const got = db
    .prepare(`SELECT COUNT(*) n FROM events WHERE text LIKE '%INCREMENTAL_MARKER%'`)
    .get() as { n: number };
  check('新内容确实入库', got.n === 1, `${got.n}`);

  const dupSeq = db
    .prepare(
      `SELECT session_id, seq, COUNT(*) c FROM events GROUP BY session_id, seq HAVING c > 1`,
    )
    .all() as unknown[];
  check('没有 (session, seq) 冲突', dupSeq.length === 0, JSON.stringify(dupSeq.slice(0, 3)));
}

// ============================================================
section('[R11-e] 按项目过滤 / 按时间过滤');
// ============================================================
{
  const db2Path = join(TMP, 'tasklog2', 'log.db');
  const db2 = openDb({ path: db2Path });
  const r = importOpenCode(db2, db2Path, {
    dbPath: HOST_DB,
    directoryPrefix: '/work/proj-a',
    readGit: false,
  });
  check('目录过滤生效', r.sessions === 2, `${r.sessions}`);
  const other = db2
    .prepare(`SELECT COUNT(*) n FROM events WHERE text LIKE '%OTHER_PROJECT_MARKER%'`)
    .get() as { n: number };
  check('别的项目的内容没有被带进来', other.n === 0, `${other.n}`);
  db2.close();

  const db3Path = join(TMP, 'tasklog3', 'log.db');
  const db3 = openDb({ path: db3Path });
  importOpenCode(db3, db3Path, { dbPath: HOST_DB, sinceTs: T0 + 400_000, readGit: false });
  const late = db3.prepare(`SELECT COUNT(*) n FROM events`).get() as { n: number };
  const hasLater = db3
    .prepare(`SELECT COUNT(*) n FROM events WHERE text LIKE '%LATER_MARKER%'`)
    .get() as { n: number };
  check('时间过滤生效', late.n > 0 && hasLater.n === 1, `n=${late.n} later=${hasLater.n}`);
  const early = db3
    .prepare(`SELECT COUNT(*) n FROM events WHERE text LIKE '%ADAPTER_FINDING%'`)
    .get() as { n: number };
  check('早于水位线的内容未被重复导入', early.n === 0, `${early.n}`);
  db3.close();
}

// ============================================================
section('[R11-f] 旧版 JSON 布局');
// ============================================================
{
  const root = join(TMP, 'storage');
  const w = (p: string, obj: unknown): void => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(obj), 'utf8');
  };
  w(join(root, 'session', 'projhash', 'ses_old.json'), {
    id: 'ses_old',
    directory: '/work/legacy',
    title: '旧格式会话',
    version: '1.16.0',
    time: { created: T0 },
    model: { id: 'gpt-5', providerID: 'openai' },
  });
  w(join(root, 'message', 'ses_old', 'msg_mm1.json'), {
    id: 'mm1',
    sessionID: 'ses_old',
    role: 'user',
    time: { created: T0 + 10 },
  });
  w(join(root, 'part', 'ses_old', 'mm1', 'pp1.json'), {
    id: 'pp1',
    messageID: 'mm1',
    sessionID: 'ses_old',
    type: 'text',
    text: '旧版 JSON 布局 JSON_LAYOUT_MARKER',
    time: { created: T0 + 10 },
  });

  const db4Path = join(TMP, 'tasklog4', 'log.db');
  const db4 = openDb({ path: db4Path });
  const r = importOpenCode(db4, db4Path, { storageDir: root, readGit: false });
  check('识别为 json 布局', r.layout === 'json', r.layout);
  check('旧格式也能读出内容',
    (db4.prepare(`SELECT COUNT(*) n FROM events WHERE text LIKE '%JSON_LAYOUT_MARKER%'`).get() as { n: number }).n === 1);
  check('旧格式也记录宿主版本', r.hostVersions.includes('1.16.0'), JSON.stringify(r.hostVersions));
  db4.close();
}

// ============================================================
section('[R11-g] 找不到数据时明说，不假装成功');
// ============================================================
{
  const db5Path = join(TMP, 'tasklog5', 'log.db');
  const db5 = openDb({ path: db5Path });
  const r = importOpenCode(db5, db5Path, { dbPath: join(TMP, 'nope.db'), readGit: false });
  check('缺数据时 layout=none', r.layout === 'none', r.layout);
  check('缺数据时给出可操作的提示', r.warnings.some((w) => /dbPath|storageDir/.test(w)),
    JSON.stringify(r.warnings));
  check('缺数据时不写入任何东西', r.inserted === 0);
  db5.close();
}

db.close();
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (failures.length) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
