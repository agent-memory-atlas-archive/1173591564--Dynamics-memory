import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { DDL, SCHEMA_VERSION, MIGRATE_V1_V2, MIGRATE_V2_V3 } from './schema.ts';

export type DB = Database.Database;

export interface OpenOptions {
  /** 数据库文件路径。默认 .tasklog/log.db */
  path?: string;
  readonly?: boolean;
}

export function defaultDbPath(root = process.cwd()): string {
  return join(root, '.tasklog', 'log.db');
}

export function blobDir(dbPath: string): string {
  return join(dirname(resolve(dbPath)), 'blobs');
}

export function openDb(opts: OpenOptions = {}): DB {
  const path = resolve(opts.path ?? process.env.TASKLOG_DB ?? defaultDbPath());
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(blobDir(path), { recursive: true });

  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  if (!opts.readonly) migrate(db);
  return db;
}

function migrate(db: DB): void {
  const hasTasks = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`)
    .get() as { name: string } | undefined;

  if (hasTasks) {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    const current = row ? Number(row.value) : 1;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}，请升级 tasklog。`,
      );
    }
    if (current < 2) {
      // 表重建期间必须关外键，否则 DROP TABLE tasks 会让 events.task_id 被置空
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(MIGRATE_V1_V2);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        db.pragma('foreign_keys = ON');
      }
      const bad = db.pragma('foreign_key_check') as unknown[];
      if (bad.length > 0) {
        throw new Error(`v1->v2 迁移后外键校验失败：${JSON.stringify(bad.slice(0, 3))}`);
      }
    }
    if (current < 3) {
      const cols = (db.pragma('table_info(events)') as Array<{ name: string }>).map((c) => c.name);
      if (!cols.includes('source_id')) db.exec(MIGRATE_V2_V3);
    }
  }

  db.exec(DDL);
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
}

export function dbExists(path?: string): boolean {
  return existsSync(resolve(path ?? process.env.TASKLOG_DB ?? defaultDbPath()));
}
