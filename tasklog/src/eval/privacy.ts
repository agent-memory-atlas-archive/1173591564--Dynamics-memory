import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DB } from '../db/open.ts';
import { openDb } from '../db/open.ts';
import { Ingestor, readBlob } from '../ingest/events.ts';
import { rebuildTasks } from '../tasks/segment.ts';
import type { EventRow } from '../types.ts';

export function redactCredentialPatterns(input: string): { text: string; replacements: number } {
  let replacements = 0;
  const text = input.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|authorization|access[_-]?token|password)\s*["']?\s*[:=]\s*["']?(?!process\.|os\.|getenv|Bearer\s*\{|YOUR_|your_|example|placeholder|\.{3}|<)[A-Za-z0-9_+\/-]{24,})/gi, () => { replacements++; return '[redacted credential pattern]'; });
  return { text, replacements };
}
export function assertNoCredentialPatterns(input: string): void {
  if (redactCredentialPatterns(input).replacements) throw new Error('Credential-like history must be redacted in a separate evaluation view before model execution');
}
export function createEvaluationView(source: DB, outputPath: string, untilTs: number): { sourcePath: string; outputPath: string; untilTs: number; events: number; redactedEvents: number; replacements: number; redactedEventIds: number[] } {
  if (existsSync(outputPath)) throw new Error('Evaluation view already exists; choose a new path');
  if (!Number.isSafeInteger(untilTs)) throw new Error('Invalid evaluation view cutoff');
  const view = openDb({ path: outputPath });
  const report = { sourcePath: source.name, outputPath: view.name, untilTs, events: 0, redactedEvents: 0, replacements: 0, redactedEventIds: [] as number[] };
  const ingestor = new Ingestor(view, view.name);
  source.exec('BEGIN');
  try {
    const rows = source.prepare('SELECT * FROM events WHERE ts < ? ORDER BY id').all(untilTs) as EventRow[];
    view.transaction(() => {
      for (const row of rows) {
        const original = row.blob_ref ? readBlob(source.name, row.blob_ref) : row.text;
        if (row.blob_ref && original === null) throw new Error(`Missing original blob for event ${row.id}`);
        const text = original === null ? { text: null, replacements: 0 } : redactCredentialPatterns(original);
        const sanitize = (value: any): any => typeof value === 'string' ? (() => { const r = redactCredentialPatterns(value); report.replacements += r.replacements; return r.text; })() : Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) : value;
        const before = report.replacements;
        const args = row.args_json === null ? undefined : sanitize(JSON.parse(row.args_json));
        report.replacements += text.replacements;
        const count = report.replacements - before;
        if (count) { report.redactedEvents++; report.redactedEventIds.push(row.id); }
        const ref = row.source_ref ? JSON.parse(row.source_ref) : {};
        const inserted = ingestor.add({ sessionId: row.session_id, seq: row.seq, ts: row.ts, role: row.role, kind: row.kind, toolName: row.tool_name, callId: row.call_id, args, text: text.text, outcome: row.outcome, source: row.source, sourceId: row.source_id, sourceRef: { ...ref, evaluation_view: { original_event_id: row.id, redactions: count, original_text_sha256: original === null ? null : createHash('sha256').update(original).digest('hex'), derived: 'credential-pattern-redaction' } } });
        if (!inserted.inserted) throw new Error('Evaluation view unexpectedly duplicated source events');
        report.events++;
      }
      const columns = ['sha', 'ts', 'author', 'subject', 'body', 'branch', 'files_json', 'reverts_sha'];
      const insert = view.prepare(`INSERT INTO commits(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const commit of source.prepare('SELECT * FROM commits WHERE ts < ? ORDER BY ts,sha').all(untilTs) as Array<Record<string, unknown>>) insert.run(...columns.map(c => commit[c]));
      rebuildTasks(view);
      view.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('evaluation_view', JSON.stringify({ ...report, detection: 'heuristic credential patterns, not a guarantee that every secret is detected', originalDataMutated: false }));
    })();
    source.exec('COMMIT');
    return report;
  } finally { if (source.inTransaction) source.exec('ROLLBACK'); view.close(); }
}
