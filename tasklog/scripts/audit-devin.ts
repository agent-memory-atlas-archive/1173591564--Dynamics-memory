import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/open.ts';
import { readBlob } from '../src/ingest/events.ts';
import { createHistorySnapshot } from '../src/eval/history.ts';
import { redactCredentialPatterns } from '../src/eval/privacy.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const path = resolve(flag('db') ?? '.tasklog/devin-history.db');
const cut = Number(flag('until'));
if (!Number.isSafeInteger(cut)) throw new Error('Specify --until EPOCH_MS');
const db = openDb({ path, readonly: true });
const sources = new Map<string, Database.Database>();
const view = flag('view') ? openDb({ path: resolve(flag('view')!), readonly: true }) : null;
const queryDb = view ?? db;
let client: Client | undefined;
const output = resolve(flag('output') ?? `.tasklog/devin-audit-${Date.now()}.json`);
const report = { status: 'running', error: null as string | null, synthetic: false, modelCalled: false, cutoff: cut, eventsChecked: 0, fullBlobsChecked: 0, originalTextMatches: 0, originalArgumentsMatches: 0, originalTimestamps: 0, missingCalls: 0, viewEventsChecked: 0, viewRedactedEvents: 0, suspiciousCredentialEventIds: [] as number[], mcp: [] as Array<Record<string, unknown>> };
try {
  const rows = db.prepare("SELECT * FROM events WHERE source='devin' AND ts < ? ORDER BY id").all(cut) as any[];
  const calls = new Set(rows.filter(r => r.kind === 'tool_call').map(r => r.call_id));
  for (const row of rows) {
    const ref = JSON.parse(row.source_ref);
    let source = sources.get(ref.host_path);
    if (!source) { source = new Database(ref.host_path, { readonly: true, fileMustExist: true }); sources.set(ref.host_path, source); }
    const raw = source.prepare('SELECT chat_message FROM message_nodes WHERE session_id=? AND node_id=?').get(ref.session_id, ref.node_id) as { chat_message: string } | undefined;
    assert.ok(raw, `Missing raw node for event ${row.id}`);
    const message = JSON.parse(raw.chat_message);
    const originalTs = Date.parse(message.metadata?.created_at ?? '');
    if (ref.inferred.timestamp_source === 'message.metadata.created_at') { assert.equal(row.ts, originalTs); report.originalTimestamps++; }
    const text = row.blob_ref ? readBlob(path, row.blob_ref) : row.text;
    if (row.blob_ref) { assert.notEqual(text, null); report.fullBlobsChecked++; }
    if (ref.component === 'text') { assert.ok(text === message.content, `Original text mismatch at event ${row.id}`); report.originalTextMatches++; }
    if (ref.component === 'thinking') { assert.ok(text === message.thinking.thinking, `Original reasoning mismatch at event ${row.id}`); report.originalTextMatches++; }
    if (ref.component === 'result') { assert.ok(text === (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null)), `Original result mismatch at event ${row.id}`); report.originalTextMatches++; if (row.call_id && !calls.has(row.call_id)) report.missingCalls++; }
    if (ref.component.startsWith('call:')) {
      const call = message.tool_calls.find((c: any) => ref.component === `call:${c.id}`);
      assert.ok(call, `Missing raw tool call for event ${row.id}`);
      assert.ok(row.args_json === (call.arguments === undefined ? null : JSON.stringify(call.arguments)), `Original arguments mismatch at event ${row.id}`);
      report.originalArgumentsMatches++;
    }
    if (redactCredentialPatterns(`${text ?? ''}\n${row.args_json ?? ''}`).replacements) report.suspiciousCredentialEventIds.push(row.id);
    report.eventsChecked++;
  }
  if (view) {
    const originals = new Map(rows.map(row => [row.id, row]));
    const sanitize = (value: any): any => typeof value === 'string' ? redactCredentialPatterns(value).text : Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) : value;
    for (const row of view.prepare('SELECT * FROM events WHERE ts < ? ORDER BY id').iterate(cut) as Iterable<any>) {
      const ref = JSON.parse(row.source_ref).evaluation_view;
      const original = originals.get(ref.original_event_id);
      assert.ok(original, 'Evaluation view must locate an original event');
      const before: string | null = original.blob_ref ? readBlob(path, original.blob_ref) : original.text;
      const after: string | null = row.blob_ref ? readBlob(view.name, row.blob_ref) : row.text;
      assert.ok(after === (before === null ? null : redactCredentialPatterns(before).text), `Unexpected view body change at event ${row.id}`);
      assert.ok(row.args_json === (original.args_json === null ? null : JSON.stringify(sanitize(JSON.parse(original.args_json)))), `Unexpected view arguments change at event ${row.id}`);
      assert.ok(redactCredentialPatterns(`${after ?? ''}\n${row.args_json ?? ''}`).replacements === 0, `Unredacted credential pattern at event ${row.id}`);
      assert.ok(row.ts === original.ts && row.session_id === original.session_id && row.seq === original.seq && row.kind === original.kind && row.outcome === original.outcome);
      report.viewEventsChecked++; if (ref.redactions > 0) report.viewRedactedEvents++;
    }
    assert.equal(report.viewEventsChecked, rows.length, 'Evaluation view dropped original events');
  }
  const earliest = rows[0]?.ts;
  const auditCut = Math.min(cut, Number(flag('probe-cut') ?? cut));
  assert.ok(earliest < auditCut, 'Audit cutoff must have prior history');
  const snapshot = createHistorySnapshot(queryDb, { taskKey: 'real-devin-cut-audit', startTs: auditCut, endTs: null });
  try { assert.equal((snapshot.db.prepare('SELECT COUNT(*) n FROM events WHERE ts>=?').get(auditCut) as any).n, 0); }
  finally { snapshot.close(); }
  const server = fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('TASKLOG_'))) as Record<string, string>;
  client = new Client({ name: 'real-devin-local-audit', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), server], env: { ...env, TASKLOG_DB: queryDb.name, TASKLOG_UNTIL_TS: String(auditCut) }, stderr: 'pipe' }));
  const invoke = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = await client!.callTool({ name, arguments: args });
    assert.ok(!result.isError, `MCP tool failed: ${name}`);
    const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    const data = JSON.parse(text);
    report.mcp.push({ tool: name, bytes: Buffer.byteLength(text), succeeded: true });
    return data;
  };
  const hits = await invoke('search_history', { query: flag('query') ?? '提问', k: 3 });
  assert.ok(Array.isArray(hits) && hits.length > 0, 'Real query must have evidence');
  assert.ok(hits.every(h => h.ts < auditCut));
  const taskId = hits.find(h => h.task?.taskId)?.task.taskId;
  assert.ok(taskId, 'Real event hit must locate a task');
  const resumed = await invoke('resume_task', { task_id: taskId, tail: 3 });
  assert.ok(resumed.task, 'Real task must be expandable');
  const read = await invoke('read_events', { task_id: taskId, limit: 5 });
  assert.ok(read.events.length > 0 && read.events.every((e: any) => e.ts < auditCut));
  const blob = queryDb.prepare('SELECT blob_ref FROM events WHERE blob_ref IS NOT NULL AND ts < ? ORDER BY id LIMIT 1').get(auditCut) as { blob_ref: string } | undefined;
  assert.ok(blob);
  const slice = await invoke('read_blob', { blob: blob.blob_ref, max_bytes: 512 });
  assert.ok(typeof slice.content === 'string' && !slice.content.includes('\uFFFD'));
  report.status = 'passed';
  console.log(JSON.stringify({ ...report, suspiciousCredentialEventIds: report.suspiciousCredentialEventIds.length }, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : 'Audit failed';
  throw error;
} finally {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  try { await client?.close(); } finally { for (const source of sources.values()) source.close(); view?.close(); db.close(); }
}
