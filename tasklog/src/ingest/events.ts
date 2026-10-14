/**
 * 事件写入。全程零 LLM —— 只有 insert、正则抽取、落盘。
 *
 * 少掉的东西（相对蒸馏式记忆）：抽取管道、一致性维护、冲突消解、
 * 衰减策略、池容量管理，以及它们各自的 bug。
 */

import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { DB } from '../db/open.ts';
import { blobDir } from '../db/open.ts';
import { extractSymbols } from './symbols.ts';
import type { EventInput, EventRow } from '../types.ts';

/** 超过这个字节数的内容不进 events.text，落盘并在 text 留机械摘要行。 */
export const INLINE_LIMIT = 4096;
/** 机械摘要保留的前若干字符 */
const DIGEST_HEAD = 1200;

export interface IngestStats {
  inserted: number;
  skipped: number;
  symbols: number;
  blobs: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 机械摘要：绝不调用模型。只做截断 + 结构提示。
 * 这是"摘要只做导航、不做替代"的实现 —— 原文在 blob 里，随时可取。
 */
function digestLarge(text: string, dbPath: string): { text: string; blobRef: string } {
  const hash = sha256(text);
  const rel = posix.join('blobs', hash.slice(0, 2), `${hash}.txt`);
  const abs = join(blobDir(dbPath), hash.slice(0, 2), `${hash}.txt`);
  if (!existsSync(abs)) {
    mkdirSync(join(blobDir(dbPath), hash.slice(0, 2)), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  const lines = text.split('\n');
  const head = text.slice(0, DIGEST_HEAD);
  const digest =
    `${head}\n` +
    `[tasklog] 内容已截断：共 ${lines.length} 行 / ${Buffer.byteLength(text, 'utf8')} 字节。` +
    `完整原文 blob=${hash.slice(0, 16)}，用 read_blob 取回。`;
  return { text: digest, blobRef: rel };
}

/** 解析 blob 句柄（完整 hash、前缀或 blobs/xx/hash.txt 形式）到绝对路径 */
function resolveBlobPath(dbPath: string, blobRefOrHash: string): string | null {
  const hash = (blobRefOrHash.split(/[/\\]/).pop() ?? '').replace(/\.txt$/, '');
  if (!/^[0-9a-f]{8,64}$/.test(hash)) return null;
  const dir = join(blobDir(dbPath), hash.slice(0, 2));
  const full = join(dir, `${hash}.txt`);
  if (existsSync(full)) return full;
  try {
    const hit = readdirSync(dir).find((f) => f.startsWith(hash));
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

export interface BlobSlice {
  content: string;
  /** blob 的总字节数 */
  totalBytes: number;
  offset: number;
  /** 本次返回的字节数 */
  bytes: number;
  /** 还有后续时给出下一个 offset；读完为 null */
  nextOffset: number | null;
}

/** 读 blob 全文（不带范围参数时） */
export function readBlob(dbPath: string, blobRefOrHash: string): string | null;
/** 按字节范围读 blob —— 必须支持，否则超过返回上限的内容永远只能读开头 */
export function readBlob(
  dbPath: string,
  blobRefOrHash: string,
  range: { offset?: number; length?: number },
): BlobSlice | null;
export function readBlob(
  dbPath: string,
  blobRefOrHash: string,
  range?: { offset?: number; length?: number },
): string | BlobSlice | null {
  const p = resolveBlobPath(dbPath, blobRefOrHash);
  if (!p) return null;
  const buf = readFileSync(p);
  if (!range) return buf.toString('utf8');

  const totalBytes = buf.byteLength;
  if (!Number.isSafeInteger(range.offset ?? 0) || (range.offset ?? 0) < 0 || (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length <= 0))) throw new Error('Invalid blob byte range');
  let offset = Math.min(range.offset ?? 0, totalBytes);
  while (offset > 0 && offset < totalBytes && (buf[offset]! & 0xc0) === 0x80) offset--;
  const length = Math.min(range.length ?? totalBytes - offset, totalBytes - offset);
  let end = offset + length;
  while (end > offset && end < totalBytes && (buf[end]! & 0xc0) === 0x80) end--;
  if (end === offset && offset < totalBytes) throw new Error('Blob range is too small for a UTF-8 character');
  // 按 UTF-8 边界收缩切片，避免分页把多字节字符拆坏。
  const content = buf.subarray(offset, end).toString('utf8');
  return {
    content,
    totalBytes,
    offset,
    bytes: end - offset,
    nextOffset: end < totalBytes ? end : null,
  };
}

function indexEventContent(db: DB, eventId: number, text: string): number {
  const insert = db.prepare(`INSERT INTO event_chunks(event_id,char_from,char_to,byte_from,byte_to,text) VALUES (?,?,?,?,?,?) ON CONFLICT(event_id,char_from) DO UPDATE SET char_to=excluded.char_to,byte_from=excluded.byte_from,byte_to=excluded.byte_to,text=excluded.text`);
  let count = 0;
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + 3000);
    if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1]!)) to--;
    insert.run(eventId, from, to, Buffer.byteLength(text.slice(0, from)), Buffer.byteLength(text.slice(0, to)), text.slice(from, to));
    count++;
    if (to === text.length) break;
    from = Math.max(from + 1, to - 100);
    if (/[\uDC00-\uDFFF]/.test(text[from] ?? '')) from--;
  }
  return count;
}

export function indexContentChunks(db: DB, dbPath = db.name): { events: number; chunks: number } {
  const rows = db.prepare(`SELECT id,text,blob_ref,args_json FROM events ORDER BY id`).all() as Array<Pick<EventRow, 'id' | 'text' | 'blob_ref' | 'args_json'>>;
  const bodies = rows.map((row) => {
    const body = row.blob_ref ? readBlob(dbPath, row.blob_ref) : row.text ?? row.args_json ?? '';
    if (body === null) throw new Error(`Missing content source blob for event ${row.id}`);
    return { id: row.id, body };
  });
  let chunks = 0;
  db.transaction(() => { for (const row of bodies) chunks += indexEventContent(db, row.id, row.body); })();
  return { events: rows.length, chunks };
}

export class Ingestor {
  private insEvent;
  private insSymbol;
  private getEvent;
  private getBySource;

  constructor(
    private db: DB,
    private dbPath: string,
  ) {
    this.insEvent = db.prepare(/* sql */ `
      INSERT INTO events (session_id, seq, ts, role, kind, tool_name, call_id,
                          args_json, text, blob_ref, nbytes, outcome,
                          source, source_id, source_ref)
      VALUES (@session_id, @seq, @ts, @role, @kind, @tool_name, @call_id,
              @args_json, @text, @blob_ref, @nbytes, @outcome,
              @source, @source_id, @source_ref)
      ON CONFLICT(session_id, seq) DO NOTHING
    `);
    // 带宿主稳定 id 时，幂等键是 (source, source_id) 而不是推断出来的 seq
    this.getBySource = db.prepare(
      `SELECT id FROM events WHERE source = ? AND source_id = ?`,
    );
    this.insSymbol = db.prepare(
      `INSERT OR IGNORE INTO symbols (sym, kind, event_id) VALUES (?, ?, ?)`,
    );
    this.getEvent = db.prepare(`SELECT id FROM events WHERE session_id = ? AND seq = ?`);
  }

  /**
   * 单条写入。幂等。
   *
   * 幂等键优先用宿主的稳定 id (source, source_id)；没有时退回 (session_id, seq)。
   * 只靠 seq 是不够的：宿主在旧会话里补一条记录，后面所有 seq 整体位移，
   * 同一条内容就会以新 seq 再插一遍。
   */
  add(ev: EventInput): { eventId: number | null; inserted: boolean; symbols: number } {
    if (ev.source && ev.sourceId) {
      const dup = this.getBySource.get(ev.source, ev.sourceId) as { id: number } | undefined;
      if (dup) return { eventId: dup.id, inserted: false, symbols: 0 };
    }
    const argsJson = ev.args === undefined ? null : JSON.stringify(ev.args);
    let text = ev.text ?? null;
    let blobRef = ev.blobRef ?? null;
    let nbytes = ev.nbytes ?? (text ? Buffer.byteLength(text, 'utf8') : null);

    if (text && Buffer.byteLength(text, 'utf8') > INLINE_LIMIT && !blobRef) {
      const d = digestLarge(text, this.dbPath);
      text = d.text;
      blobRef = d.blobRef;
    }

    const info = this.insEvent.run({
      session_id: ev.sessionId,
      seq: ev.seq,
      ts: ev.ts,
      role: ev.role,
      kind: ev.kind,
      tool_name: ev.toolName ?? null,
      call_id: ev.callId ?? null,
      args_json: argsJson,
      text,
      blob_ref: blobRef,
      nbytes,
      outcome: ev.outcome ?? null,
      source: ev.source ?? null,
      source_id: ev.sourceId ?? null,
      source_ref: ev.sourceRef ? JSON.stringify(ev.sourceRef) : null,
    });

    const inserted = info.changes > 0;
    const row = this.getEvent.get(ev.sessionId, ev.seq) as { id: number } | undefined;
    if (!row) return { eventId: null, inserted: false, symbols: 0 };

    let symCount = 0;
    if (inserted) {
      const original = ev.text ?? (blobRef ? readBlob(this.dbPath, blobRef) : text) ?? argsJson ?? '';
      indexEventContent(this.db, row.id, original);
      const syms = extractSymbols({
        text: ev.text ?? text,
        argsJson,
        toolName: ev.toolName ?? null,
      });
      for (const s of syms) {
        this.insSymbol.run(s.sym, s.kind, row.id);
        symCount++;
      }
    }
    return { eventId: row.id, inserted, symbols: symCount };
  }

  /** 批量写入，单事务。 */
  addMany(events: EventInput[]): IngestStats {
    const stats: IngestStats = { inserted: 0, skipped: 0, symbols: 0, blobs: 0 };
    const tx = this.db.transaction((list: EventInput[]) => {
      for (const ev of list) {
        const r = this.add(ev);
        if (r.inserted) stats.inserted++;
        else stats.skipped++;
        stats.symbols += r.symbols;
      }
    });
    tx(events);
    stats.blobs = (
      this.db.prepare(`SELECT COUNT(*) n FROM events WHERE blob_ref IS NOT NULL`).get() as {
        n: number;
      }
    ).n;
    return stats;
  }
}

/**
 * 重建符号索引。
 *
 * 必须读 blob 原文：events.text 存的是截断后的摘要，只拿它重建会让
 * 落盘内容深处的符号在一次 reindex 之后永久消失 —— 原始信息还在磁盘上，
 * 索引却再也指不到它，这正是"压缩后删原件"的变体。
 */
export function reindexSymbols(
  db: DB,
  dbPath?: string,
): { events: number; symbols: number; blobsRead: number } {
  const path = dbPath ?? (db as unknown as { name: string }).name;
  const rows = db
    .prepare(`SELECT id, text, args_json, tool_name, blob_ref FROM events`)
    .all() as Array<Pick<EventRow, 'id' | 'text' | 'args_json' | 'tool_name' | 'blob_ref'>>;
  const del = db.prepare(`DELETE FROM symbols WHERE event_id = ?`);
  const ins = db.prepare(`INSERT OR IGNORE INTO symbols (sym, kind, event_id) VALUES (?, ?, ?)`);
  let n = 0;
  let blobsRead = 0;

  // 先把 blob 读出来（文件 IO 不进事务）
  const bodies = new Map<number, string>();
  for (const r of rows) {
    if (!r.blob_ref) continue;
    const full = readBlob(path, r.blob_ref);
    if (full != null) {
      bodies.set(r.id, full);
      blobsRead++;
    }
  }

  const tx = db.transaction(() => {
    for (const r of rows) {
      del.run(r.id);
      const body = bodies.get(r.id);
      const syms = extractSymbols({
        text: body ?? r.text,
        argsJson: r.args_json,
        toolName: r.tool_name,
      });
      for (const s of syms) {
        ins.run(s.sym, s.kind, r.id);
        n++;
      }
    }
  });
  tx();
  indexContentChunks(db, path);
  return { events: rows.length, symbols: n, blobsRead };
}
