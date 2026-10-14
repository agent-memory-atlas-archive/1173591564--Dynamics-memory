import { createHash } from 'node:crypto';
import type { DB } from '../db/open.ts';
import { readBlob } from '../ingest/events.ts';
import { apiEndpoint } from '../eval/model.ts';
import { searchHistory, type SearchArgs, type SearchHit } from './index.ts';

export interface EmbeddingProvider { id: string; embed(text: string[]): Promise<number[][]> }
export interface VectorHit { eventId: number; score: number; charFrom: number; charTo: number; byteFrom: number; byteTo: number }

function vector(values: number[]): Float32Array {
  if (!Array.isArray(values) || !values.length || values.length > 8192 || values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Invalid embedding vector');
  const v = new Float32Array(values);
  if (v.some((n) => !Number.isFinite(n)) || !v.some((n) => n !== 0)) throw new Error('Embedding must have a finite nonzero norm');
  return v;
}

export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  constructor(private options: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }) {
    if (!options.apiKey || !options.model) throw new Error('Embedding model and API key are required');
    this.id = `${options.model}@${apiEndpoint(options.baseUrl, 'embeddings')}`;
  }
  async embed(input: string[]): Promise<number[][]> {
    const response = await fetch(apiEndpoint(this.options.baseUrl, 'embeddings'), {
      method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.options.model, input, encoding_format: 'float' }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Embedding API returned HTTP ${response.status}`);
    const result = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const rows = result.data?.sort((a, b) => a.index - b.index);
    if (!rows || rows.length !== input.length || rows.some((r, i) => r.index !== i)) throw new Error('Embedding response does not align with inputs');
    for (const row of rows) vector(row.embedding);
    return rows.map((r) => r.embedding);
  }
}

export function embeddingProviderFromEnv(): EmbeddingProvider | null {
  const model = process.env.TASKLOG_EMBEDDING_MODEL;
  if (!model) return null;
  const baseUrl = process.env.TASKLOG_EMBEDDING_API_BASE ?? process.env.TASKLOG_API_BASE;
  const apiKey = process.env.TASKLOG_EMBEDDING_API_KEY ?? process.env.TASKLOG_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('Embedding model is configured but its API base/key is missing');
  return new ApiEmbeddingProvider({ baseUrl, apiKey, model });
}

function chunks(text: string, width: number): Array<{ text: string; from: number; to: number }> {
  const result: Array<{ text: string; from: number; to: number }> = [];
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + width);
    if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1]!)) to--;
    result.push({ text: text.slice(from, to), from, to });
    if (to === text.length) break;
    from = Math.max(from + 1, to - 100);
    if (/[\uDC00-\uDFFF]/.test(text[from] ?? '')) from--;
  }
  return result;
}

export async function indexVectors(db: DB, dbPath: string, provider: EmbeddingProvider, opts: { untilTs?: number; limit?: number; chunkChars?: number } = {}): Promise<{ events: number; chunks: number; skipped: number }> {
  const width = opts.chunkChars ?? 3000;
  if (!Number.isSafeInteger(width) || width < 200 || width > 20_000) throw new Error('Invalid embedding chunk size');
  const limit = opts.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Invalid embedding event limit');
  const rows = db.prepare(`SELECT id,text,blob_ref,args_json FROM events ${opts.untilTs === undefined ? '' : 'WHERE ts < ?'} ORDER BY ts,id LIMIT ?`)
    .all(...(opts.untilTs === undefined ? [] : [opts.untilTs]), limit) as Array<{ id: number; text: string | null; blob_ref: string | null; args_json: string | null }>;
  const existing = db.prepare(`SELECT text_hash,dim FROM vector_chunks WHERE event_id=? AND provider=? AND ordinal=?`);
  const write = db.prepare(`INSERT INTO vector_chunks(event_id,provider,ordinal,char_from,char_to,byte_from,byte_to,text_hash,dim,vec,built_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,provider,ordinal) DO UPDATE SET char_from=excluded.char_from,char_to=excluded.char_to,byte_from=excluded.byte_from,byte_to=excluded.byte_to,text_hash=excluded.text_hash,dim=excluded.dim,vec=excluded.vec,built_at=excluded.built_at`);
  let dim = (db.prepare(`SELECT dim FROM vector_chunks WHERE provider=? LIMIT 1`).get(provider.id) as { dim: number } | undefined)?.dim;
  const result = { events: 0, chunks: 0, skipped: 0 };
  for (const row of rows) {
    const text = row.blob_ref ? readBlob(dbPath, row.blob_ref) : row.text;
    if (row.blob_ref && text === null) throw new Error(`Missing embedding source blob for event ${row.id}`);
    const body = text ?? row.args_json ?? '';
    const parts = chunks(body, width);
    const pending = parts.map((part, ordinal) => ({ ...part, ordinal, hash: createHash('sha256').update(part.text).digest('hex') }))
      .filter((part) => {
        const old = existing.get(row.id, provider.id, part.ordinal) as { text_hash: string } | undefined;
        if (old?.text_hash === part.hash) { result.skipped++; return false; }
        return true;
      });
    if (!pending.length) continue;
    result.events++;
    for (let i = 0; i < pending.length; i += 16) {
      const batch = pending.slice(i, i + 16);
      const values = await provider.embed(batch.map((p) => p.text));
      if (values.length !== batch.length) throw new Error('Embedding batch length mismatch');
      const vectors = values.map(vector);
      for (const v of vectors) {
        if (dim !== undefined && v.length !== dim) throw new Error('Embedding dimension changed; use a new provider identity');
        dim = v.length;
      }
      db.transaction(() => {
        for (const [j, part] of batch.entries()) {
          const v = vectors[j]!;
          write.run(row.id, provider.id, part.ordinal, part.from, part.to, Buffer.byteLength(body.slice(0, part.from)), Buffer.byteLength(body.slice(0, part.to)), part.hash, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength), Date.now());
          result.chunks++;
        }
      })();
    }
  }
  return result;
}

export async function searchVectors(db: DB, query: string, provider: EmbeddingProvider, opts: { untilTs?: number; sinceTs?: number; taskId?: number; k?: number } = {}): Promise<VectorHit[]> {
  const filters = ['v.provider=?'], args: unknown[] = [provider.id];
  if (opts.untilTs !== undefined) { filters.push('e.ts < ?'); args.push(opts.untilTs); }
  if (opts.sinceTs !== undefined) { filters.push('e.ts >= ?'); args.push(opts.sinceTs); }
  if (opts.taskId !== undefined) { filters.push('e.task_id=?'); args.push(opts.taskId); }
  const rows = db.prepare(`SELECT v.*,e.ts FROM vector_chunks v JOIN events e ON e.id=v.event_id WHERE ${filters.join(' AND ')}`).all(...args) as Array<{ event_id: number; dim: number; vec: Buffer; char_from: number; char_to: number; byte_from: number; byte_to: number }>;
  if (!rows.length || !query.trim()) return [];
  const embeddings = await provider.embed([query]);
  if (embeddings.length !== 1) throw new Error('Embedding query batch mismatch');
  const q = vector(embeddings[0]!);
  const qNorm = Math.sqrt(q.reduce((sum, n) => sum + n * n, 0));
  const scores = new Map<number, VectorHit>();
  for (const row of rows) {
    if (row.dim !== q.length || row.vec.byteLength !== row.dim * 4) throw new Error('Stored embedding dimension mismatch');
    let dot = 0, norm = 0;
    for (let i = 0; i < q.length; i++) { const v = row.vec.readFloatLE(i * 4); if (!Number.isFinite(v)) throw new Error('Invalid stored embedding'); dot += q[i]! * v; norm += v * v; }
    const score = norm > 0 ? dot / (qNorm * Math.sqrt(norm)) : 0;
    if (score <= 0) continue;
    if (score > (scores.get(row.event_id)?.score ?? -Infinity)) scores.set(row.event_id, { eventId: row.event_id, score, charFrom: row.char_from, charTo: row.char_to, byteFrom: row.byte_from, byteTo: row.byte_to });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.eventId - b.eventId).slice(0, Math.min(opts.k ?? 50, 200));
}

export async function hybridSearch(db: DB, args: SearchArgs, provider: EmbeddingProvider | null): Promise<SearchHit[]> {
  const hits = provider && args.query ? await searchVectors(db, args.query, provider, { untilTs: args.untilTs, sinceTs: args.sinceTs, taskId: args.taskId, k: 100 }) : undefined;
  return searchHistory(db, { ...args, vectorHits: hits });
}
