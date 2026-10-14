/**
 * DDL。对应 design/agent-memory-design.md 第 3 节。
 *
 * 刻意不存在的表：memory、summary、reflection。
 * 写入侧不做任何 LLM 加工，所以没有加工件需要维护。
 *
 * v2 变更（可靠性回归，design 第 12 节）：
 *   - tasks.stable_key      任务身份稳定，重分段不改变旧定位符含义
 *   - tasks.status 默认 unknown + status_source 区分 inferred / user
 *   - tasks.boundary_evidence  分段证据单独记录，与"完成状态"分离
 *   - tasks.retired_at / successor_id  退役任务保留行，可追继任者
 *   - tasks.locked          用户修订过的任务不参与重分段
 */

export const SCHEMA_VERSION = 3;

export const DDL = /* sql */ `
-- ============================================================
-- tasks: 存储与检索的一等单元
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  -- 稳定身份：由段内首个事件 id 派生。重分段按它 upsert，不重建行。
  stable_key    TEXT UNIQUE,
  title         TEXT,
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,
  -- 状态默认 unknown：commit 与时间间隔是分段证据，不是完成/放弃的事实。
  status        TEXT    NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('unknown','open','done','abandoned')),
  status_source TEXT    NOT NULL DEFAULT 'none'
                        CHECK (status_source IN ('none','inferred','user')),
  branch        TEXT,
  commit_sha    TEXT,
  boundary_src  TEXT    NOT NULL DEFAULT 'heuristic'
                        CHECK (boundary_src IN ('git','heuristic','user')),
  -- 分段依据的可审计记录（JSON）：commit / gap / 用户指定
  boundary_evidence TEXT,
  -- 用户修订过的任务被锁定，重分段不得改写其事件归属
  locked        INTEGER NOT NULL DEFAULT 0,
  -- 退役的任务保留行，旧 locator 仍可解析
  retired_at    INTEGER,
  successor_id  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_tasks_time    ON tasks(started_ts, ended_ts);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_commit  ON tasks(commit_sha);
CREATE INDEX IF NOT EXISTS idx_tasks_retired ON tasks(retired_at);

CREATE TABLE IF NOT EXISTS task_edges (
  src  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dst  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rel  TEXT    NOT NULL CHECK (rel IN ('parent','continues','supersedes','derived_from')),
  note TEXT,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON task_edges(dst, rel);

-- ============================================================
-- events: 最细粒度单元是事件，不是对话
-- 跨会话全局顺序由 (ts, id) 决定；seq 只在 session 内有意义。
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
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
  -- 来源可追溯：原始系统名、原始系统里的稳定 id、以及完整原始标识 JSON
  source     TEXT,
  source_id  TEXT,
  source_ref TEXT,
  UNIQUE (session_id, seq)
);
-- 真正的导入幂等键。
-- 不能靠 (session_id, seq) 做幂等：seq 是导入时算出来的推断量，
-- 宿主在旧会话里补了一条 part，后面所有 seq 就全体位移，
-- 于是同一条内容会以新 seq 再插一遍。宿主自己的 part id 才是稳定的。
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source
  ON events(source, source_id) WHERE source IS NOT NULL AND source_id IS NOT NULL;
-- 跨会话游标的主索引
CREATE INDEX IF NOT EXISTS idx_events_global  ON events(ts, id);
CREATE INDEX IF NOT EXISTS idx_events_task    ON events(task_id, ts, id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_call    ON events(call_id);
CREATE INDEX IF NOT EXISTS idx_events_outcome ON events(outcome) WHERE outcome = 'error';

-- ============================================================
-- symbols: coding 场景的主索引
-- ============================================================
CREATE TABLE IF NOT EXISTS symbols (
  sym      TEXT    NOT NULL,
  kind     TEXT    NOT NULL CHECK (kind IN ('path','ident','errcode','sha','test')),
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (sym, kind, event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_symbols_event ON symbols(event_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind  ON symbols(kind, sym);
CREATE INDEX IF NOT EXISTS idx_symbols_lower ON symbols(LOWER(sym));

-- ============================================================
-- 向量通道：可重建的寻址层，不是事实权威。
-- 向量本体存 BLOB（Float32Array），provider/dim 变更即整体重建。
-- ============================================================
CREATE TABLE IF NOT EXISTS embeddings (
  event_id  INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  provider  TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vec       BLOB NOT NULL,
  built_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_provider ON embeddings(provider, dim);
CREATE TABLE IF NOT EXISTS vector_chunks (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  char_from INTEGER NOT NULL,
  char_to INTEGER NOT NULL,
  byte_from INTEGER NOT NULL,
  byte_to INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  built_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, provider, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_vector_provider ON vector_chunks(provider, dim);
CREATE TABLE IF NOT EXISTS event_chunks (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  char_from INTEGER NOT NULL,
  char_to INTEGER NOT NULL,
  byte_from INTEGER NOT NULL,
  byte_to INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(event_id, char_from)
);
CREATE INDEX IF NOT EXISTS idx_chunks_event ON event_chunks(event_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text,content='event_chunks',content_rowid='id',tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON event_chunks BEGIN
  INSERT INTO chunks_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON event_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',old.id,old.text);
  INSERT INTO chunks_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON event_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',old.id,old.text);
END;

-- ============================================================
-- commits: git 快照
-- ============================================================
CREATE TABLE IF NOT EXISTS commits (
  sha         TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  author      TEXT,
  subject     TEXT,
  body        TEXT,
  branch      TEXT,
  files_json  TEXT NOT NULL DEFAULT '[]',
  reverts_sha TEXT
);
CREATE INDEX IF NOT EXISTS idx_commits_ts      ON commits(ts);
CREATE INDEX IF NOT EXISTS idx_commits_reverts ON commits(reverts_sha) WHERE reverts_sha IS NOT NULL;

-- ============================================================
-- FTS5
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, content='events', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.id, COALESCE(new.text,''));
END;
CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, COALESCE(old.text,''));
END;
CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE OF text ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, COALESCE(old.text,''));
  INSERT INTO events_fts(rowid, text) VALUES (new.id, COALESCE(new.text,''));
END;

-- ============================================================
-- 查询遥测：单独存放。
-- 绝不混入 events —— 系统自己的查询记录进主历史索引会造成递归污染。
-- ============================================================
CREATE TABLE IF NOT EXISTS query_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  run_id      TEXT,
  phase       TEXT,              -- warmup | midtask | adhoc
  tool        TEXT NOT NULL,
  args_json   TEXT,
  n_hits      INTEGER,
  n_expanded  INTEGER,
  bytes_out   INTEGER,
  latency_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qlog_run ON query_log(run_id, ts);

-- 导入状态：支持增量追加，并记录每次导入的可追溯信息
CREATE TABLE IF NOT EXISTS import_state (
  source        TEXT NOT NULL,
  scope         TEXT NOT NULL,     -- 通常是宿主的 session id
  last_source_id TEXT,
  last_ts       INTEGER,
  n_events      INTEGER NOT NULL DEFAULT 0,
  host_version  TEXT,
  imported_at   INTEGER NOT NULL,
  PRIMARY KEY (source, scope)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * v1 -> v2：tasks 的 CHECK 约束变了，SQLite 改不了 CHECK，只能重建表。
 *
 * 必须按"建新表 → 复制 → DROP 旧表 → RENAME"的顺序，且全程关外键。
 * 反过来先 `ALTER TABLE tasks RENAME TO tasks_v1` 是错的：SQLite 会把
 * events 指向 tasks 的外键一并改写成指向 tasks_v1，接着 DROP tasks_v1
 * 就触发 ON DELETE SET NULL，把所有 events.task_id 静默清空。
 * 迁移把数据搞丢，正是这套方案最不能犯的错。
 */
export const MIGRATE_V1_V2 = /* sql */ `
DROP INDEX IF EXISTS idx_tasks_time;
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_commit;
CREATE TABLE tasks_new (
  id            INTEGER PRIMARY KEY,
  stable_key    TEXT UNIQUE,
  title         TEXT,
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,
  status        TEXT    NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('unknown','open','done','abandoned')),
  status_source TEXT    NOT NULL DEFAULT 'none'
                        CHECK (status_source IN ('none','inferred','user')),
  branch        TEXT,
  commit_sha    TEXT,
  boundary_src  TEXT    NOT NULL DEFAULT 'heuristic'
                        CHECK (boundary_src IN ('git','heuristic','user')),
  boundary_evidence TEXT,
  locked        INTEGER NOT NULL DEFAULT 0,
  retired_at    INTEGER,
  successor_id  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT INTO tasks_new (id, stable_key, title, started_ts, ended_ts, status, status_source,
                       branch, commit_sha, boundary_src, created_at)
  SELECT id,
         'ev:' || COALESCE((SELECT MIN(e.id) FROM events e WHERE e.task_id = t.id), 'legacy' || t.id),
         title, started_ts, ended_ts,
         -- v1 的 done/abandoned 是从 commit 推出来的，不是确认过的事实，
         -- 一律降级为 unknown；open 同理。宁可说不知道，不要留假事实。
         'unknown', 'none',
         branch, commit_sha, boundary_src, created_at
    FROM tasks t;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE events ADD COLUMN source TEXT;
ALTER TABLE events ADD COLUMN source_ref TEXT;
`;

/** v2 -> v3：导入幂等键与增量状态 */
export const MIGRATE_V2_V3 = /* sql */ `
ALTER TABLE events ADD COLUMN source_id TEXT;
`;
