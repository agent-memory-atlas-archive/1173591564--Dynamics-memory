import Database from 'better-sqlite3';
import type { DB } from '../db/open.ts';
import { DDL, SCHEMA_VERSION } from '../db/schema.ts';
import { readBlob, indexContentChunks, type BlobSlice } from '../ingest/events.ts';
import { rebuildTasks } from '../tasks/segment.ts';
import type { CutPoint } from './split.ts';

export interface HistorySnapshot {
  db: DB;
  sourcePath: string;
  untilTs: number;
  readBlob(ref: string, range?: { offset?: number; length?: number }): BlobSlice | null;
  close(): void;
}

export function createHistorySnapshot(source: DB, cut: CutPoint): HistorySnapshot {
  if (!Number.isSafeInteger(cut.startTs)) throw new Error('Invalid history cutoff');
  const db = new Database(':memory:');
  const sourcePath = source.name;
  try {
    db.pragma('foreign_keys = ON');
    db.exec(DDL);
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
    const events = source.prepare(`SELECT * FROM events WHERE ts < ? ORDER BY ts, id`)
      .all(cut.startTs) as Array<Record<string, unknown>>;
    const columns = (db.pragma('table_info(events)') as Array<{ name: string }>).map((r) => r.name);
    const insert = db.prepare(`INSERT INTO events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    const symbols = source.prepare(`SELECT sym, kind FROM symbols WHERE event_id = ?`);
    const putSymbol = db.prepare(`INSERT INTO symbols(sym, kind, event_id) VALUES (?, ?, ?)`);
    const putEmbedding = db.prepare(`INSERT INTO embeddings(event_id, provider, dim, vec, built_at) VALUES (?, ?, ?, ?, ?)`);
    const getEmbedding = source.prepare(`SELECT * FROM embeddings WHERE event_id = ?`);
    db.transaction(() => {
      for (const event of events) {
        insert.run(...columns.map((c) => c === 'task_id' ? null : event[c] ?? null));
        for (const symbol of symbols.all(event.id) as Array<{ sym: string; kind: string }>) {
          putSymbol.run(symbol.sym, symbol.kind, event.id);
        }
        const embedding = getEmbedding.get(event.id) as Record<string, unknown> | undefined;
        if (embedding) putEmbedding.run(event.id, embedding.provider, embedding.dim, embedding.vec, embedding.built_at);
      }
      const commits = source.prepare(`SELECT * FROM commits WHERE ts < ? ORDER BY ts, sha`).all(cut.startTs) as Array<Record<string, unknown>>;
      const cc = (db.pragma('table_info(commits)') as Array<{ name: string }>).map((r) => r.name);
      const putCommit = db.prepare(`INSERT INTO commits (${cc.join(',')}) VALUES (${cc.map(() => '?').join(',')})`);
      for (const commit of commits) putCommit.run(...cc.map((c) => commit[c] ?? null));
    })();
    if (source.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vector_chunks'`).get()) {
      const vectorRows = source.prepare(`SELECT v.* FROM vector_chunks v JOIN events e ON e.id=v.event_id WHERE e.ts < ?`).all(cut.startTs) as Array<Record<string, unknown>>;
      const columns = (db.pragma('table_info(vector_chunks)') as Array<{ name: string }>).map((r) => r.name);
      const insert = db.prepare(`INSERT INTO vector_chunks (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      db.transaction(() => { for (const row of vectorRows) insert.run(...columns.map((c) => row[c] ?? null)); })();
    }
    indexContentChunks(db, sourcePath);
    rebuildTasks(db);
    const refs = new Set(events.map((e) => e.blob_ref).filter((r): r is string => typeof r === 'string')
      .map((r) => (r.split(/[/\\]/).pop() ?? '').replace(/\.txt$/, '')));
    return {
      db, sourcePath, untilTs: cut.startTs,
      readBlob(ref, range = {}) {
        const hash = (ref.split(/[/\\]/).pop() ?? '').replace(/\.txt$/, '');
        if (!/^[0-9a-f]{8,64}$/.test(hash)) return null;
        const matches = [...refs].filter((r) => r.startsWith(hash));
        if (matches.length !== 1) return null;
        return readBlob(sourcePath, matches[0]!, range);
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
