/**
 * R10：v1 -> v2 迁移不得丢数据。
 *
 * 单独一个文件，因为它必须从一个真正的 v1 库开始 —— 用当前 DDL 造库
 * 再测迁移等于什么都没测。下面的 DDL_V1 是 git 历史里的原版，逐字抄来，
 * 不要为了让测试好写而改动它。
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/open.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

const TMP = mkdtempSync(join(process.cwd(), '.tmp-migration-'));
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

// ---------- 造一个 v1 库 ----------
const DDL_V1 = /* sql */ `
CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY,
  title         TEXT,
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,
  status        TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','done','abandoned')),
  branch        TEXT,
  commit_sha    TEXT,
  boundary_src  TEXT    NOT NULL DEFAULT 'heuristic'
                        CHECK (boundary_src IN ('git','heuristic','user')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_tasks_time   ON tasks(started_ts, ended_ts);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_commit ON tasks(commit_sha);
CREATE TABLE task_edges (
  src  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dst  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rel  TEXT    NOT NULL CHECK (rel IN ('parent','continues','supersedes','derived_from')),
  note TEXT,
  PRIMARY KEY (src, dst, rel)
);
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  role       TEXT    NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  kind       TEXT    NOT NULL CHECK (kind IN ('text','tool_call','tool_result','error')),
  tool_name  TEXT,
  call_id    TEXT,
  args_json  TEXT,
  text       TEXT,
  blob_ref   TEXT,
  nbytes     INTEGER,
  outcome    TEXT CHECK (outcome IS NULL OR outcome IN ('ok','error')),
  UNIQUE (session_id, seq)
);
CREATE TABLE symbols (
  sym      TEXT    NOT NULL,
  kind     TEXT    NOT NULL CHECK (kind IN ('path','ident','errcode','sha','test')),
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (sym, kind, event_id)
) WITHOUT ROWID;
CREATE TABLE commits (
  sha         TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  author      TEXT,
  subject     TEXT,
  body        TEXT,
  branch      TEXT,
  files_json  TEXT NOT NULL DEFAULT '[]',
  reverts_sha TEXT
);
CREATE VIRTUAL TABLE events_fts USING fts5(
  text, content='events', content_rowid='id', tokenize='trigram'
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

console.log('\n[R10] v1 -> 最新 schema 的迁移');
{
  const raw = new Database(DB_PATH);
  raw.pragma('journal_mode = WAL');
  raw.exec(DDL_V1);
  raw.prepare(`INSERT INTO meta(key,value) VALUES ('schema_version','1')`).run();

  const t0 = Date.UTC(2026, 0, 5, 9, 0, 0);
  const insT = raw.prepare(
    `INSERT INTO tasks (id,title,started_ts,ended_ts,status,branch,commit_sha,boundary_src)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  insT.run(1, '旧任务一', t0, t0 + 1000, 'done', 'main', 'aaaa111', 'git');
  insT.run(2, '旧任务二', t0 + 2000, null, 'open', 'main', null, 'heuristic');
  insT.run(3, '旧任务三', t0 + 4000, t0 + 5000, 'abandoned', 'main', null, 'user');

  const insE = raw.prepare(
    `INSERT INTO events (session_id,seq,ts,task_id,role,kind,text,outcome)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 9; i++) {
    insE.run('ses_old', i, t0 + i * 500, (i % 3) + 1, 'user', 'text', `旧事件 ${i}`, null);
  }
  raw
    .prepare(`INSERT INTO task_edges (src,dst,rel,note) VALUES (3,1,'supersedes','v1 edge')`)
    .run();
  raw.prepare(`INSERT INTO symbols (sym,kind,event_id) VALUES ('src/old.ts','path',1)`).run();
  raw.close();
}

// ---------- 迁移 ----------
const db = openDb({ path: DB_PATH });

const n = (t: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

const ver = (db.prepare(`SELECT value v FROM meta WHERE key='schema_version'`).get() as { v: string }).v;
check(`版本升到最新（${SCHEMA_VERSION}）`, Number(ver) === SCHEMA_VERSION, ver);
const evCols = new Set((db.pragma('table_info(events)') as Array<{ name: string }>).map((c) => c.name));
check('v3 的导入幂等键列存在', evCols.has('source_id') && evCols.has('source'),
  [...evCols].join(','));
check('tasks 行数不变', n('tasks') === 3, `${n('tasks')}`);
check('events 行数不变', n('events') === 9, `${n('events')}`);
check('task_edges 不变', n('task_edges') === 1, `${n('task_edges')}`);
check('symbols 不变', n('symbols') === 1, `${n('symbols')}`);

const orphan = (
  db.prepare(`SELECT COUNT(*) n FROM events WHERE task_id IS NULL`).get() as { n: number }
).n;
check('events.task_id 没有被外键级联清空', orphan === 0, `${orphan} 条被置空`);

const titles = (db.prepare(`SELECT title FROM tasks ORDER BY id`).all() as Array<{ title: string }>)
  .map((r) => r.title)
  .join(',');
check('标题保留', titles === '旧任务一,旧任务二,旧任务三', titles);

const statuses = (db.prepare(`SELECT DISTINCT status FROM tasks`).all() as Array<{ status: string }>)
  .map((r) => r.status);
check(
  'v1 推断出的 done/abandoned 被降级为 unknown',
  statuses.length === 1 && statuses[0] === 'unknown',
  JSON.stringify(statuses),
);

const keys = (
  db.prepare(`SELECT stable_key FROM tasks ORDER BY id`).all() as Array<{ stable_key: string }>
).map((r) => r.stable_key);
check('每个任务都拿到 stable_key', keys.every((k) => typeof k === 'string' && k.length > 0), JSON.stringify(keys));

const fk = db.pragma('foreign_key_check') as unknown[];
check('外键完整性检查通过', fk.length === 0, JSON.stringify(fk.slice(0, 2)));

// ---------- 再次打开必须是空操作 ----------
db.close();
const db2 = openDb({ path: DB_PATH });
const n2 = (
  db2.prepare(`SELECT COUNT(*) n FROM events WHERE task_id IS NOT NULL`).get() as { n: number }
).n;
check('重复打开不重跑迁移', n2 === 9, `${n2}`);
db2.close();

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (failures.length) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
