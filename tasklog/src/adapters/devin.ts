import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/open.ts';
import { Ingestor } from '../ingest/events.ts';
import type { EventInput, Role } from '../types.ts';

export interface DevinOptions {
  dbPath?: string;
  directoryPrefix?: string;
  sessions?: string[];
  untilTs?: number;
  skipReasoning?: boolean;
  snapshot?: boolean;
}
export interface DevinReport {
  source: 'devin';
  layout: 'sqlite';
  hostPath: string;
  originalPath: string;
  sessions: number;
  messages: number;
  parts: number;
  events: number;
  inserted: number;
  skipped: number;
  duplicates: number;
  summaries: number;
  systemPrefixes: number;
  untimed: number;
  revisions: number;
  unmappedRoles: string[];
  warnings: string[];
  repos: Array<{ directory: string; branch: null; head: null }>;
}
interface Session { id: string; working_directory: string; model: string; created_at: number; main_chain_id: number | null }
interface NodeRow { node_id: number; parent_node_id: number | null; chat_message: string; created_at: number; metadata: string | null }
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const normalized = (path: string): string => {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(p) ? p.toLowerCase() : p;
};
export function locateDevinDb(): string | null {
  const paths = [process.env.APPDATA ? join(process.env.APPDATA, 'devin', 'cli', 'sessions.db') : null, join(homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db')];
  return paths.find((p): p is string => !!p && existsSync(p)) ?? null;
}
function selectedSessions(host: DB, options: DevinOptions): Session[] {
  const prefix = options.directoryPrefix ? normalized(options.directoryPrefix) : null;
  return (host.prepare('SELECT id,working_directory,model,created_at,main_chain_id FROM sessions ORDER BY created_at,id').all() as Session[])
    .filter(s => (!options.sessions || options.sessions.includes(s.id)) && (!prefix || normalized(s.working_directory) === prefix || normalized(s.working_directory).startsWith(`${prefix}/`)));
}
function parse(raw: string | null, label: string): Record<string, any> {
  if (!raw) return {};
  try { const value = JSON.parse(raw); if (value === null) return {}; if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  throw new Error(`Invalid Devin JSON at ${label}`);
}
function originalTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
export function snapshotDevinDb(hostPath: string, destination: string, options: DevinOptions = {}): string {
  if (existsSync(destination)) throw new Error('Devin source snapshot already exists');
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  const host = new Database(resolve(hostPath), { readonly: true, fileMustExist: true });
  let snapshot: DB | undefined;
  try {
    host.pragma('query_only = ON');
    host.exec('BEGIN');
    const sessions = selectedSessions(host, options);
    snapshot = new Database(resolve(destination));
    const available = new Set((host.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name));
    snapshot.transaction(() => {
      for (const table of ['sessions', 'message_nodes', 'tool_call_state', 'subagent_heads']) {
        if (!available.has(table)) { if (['sessions', 'message_nodes'].includes(table)) throw new Error(`Missing Devin table ${table}`); continue; }
        const schema = host.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
        snapshot!.exec(schema.sql);
        const columns = (host.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
        if (columns.some(c => !/^[a-z_]+$/i.test(c))) throw new Error('Unexpected Devin column name');
        const insert = snapshot!.prepare(`INSERT INTO ${table} (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        const rows = host.prepare(`SELECT * FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'}=?`);
        for (const session of sessions) for (const row of rows.iterate(session.id) as Iterable<Record<string, any>>) insert.run(...columns.map(c => row[c]));
      }
      snapshot!.exec('CREATE INDEX IF NOT EXISTS idx_devin_snapshot_nodes ON message_nodes(session_id,node_id)');
    })();
    host.exec('COMMIT');
    return resolve(destination);
  } finally { snapshot?.close(); host.close(); }
}
export function importDevin(db: DB, dbPath: string, options: DevinOptions = {}): DevinReport {
  const input = options.dbPath ?? locateDevinDb();
  if (!input || !existsSync(input)) throw new Error('Devin sessions.db not found');
  if (options.untilTs !== undefined && (!Number.isSafeInteger(options.untilTs) || options.untilTs < 0)) throw new Error('Invalid Devin cutoff');
  const originalPath = resolve(input);
  const hostPath = options.snapshot === false ? originalPath : snapshotDevinDb(originalPath, join(dirname(resolve(dbPath)), 'sources', `devin-${randomUUID()}.db`), options);
  const report: DevinReport = { source: 'devin', layout: 'sqlite', originalPath, hostPath, sessions: 0, messages: 0, parts: 0, events: 0, inserted: 0, skipped: 0, duplicates: 0, summaries: 0, systemPrefixes: 0, untimed: 0, revisions: 0, unmappedRoles: [], warnings: [], repos: [] };
  const host = new Database(hostPath, { readonly: true, fileMustExist: true });
  const ingestor = new Ingestor(db, dbPath);
  try {
    host.pragma('query_only = ON'); host.exec('BEGIN');
    const sessions = selectedSessions(host, options);
    report.sessions = sessions.length;
    for (const session of sessions) {
      report.repos.push({ directory: session.working_directory, branch: null, head: null });
      const parents = new Map((host.prepare('SELECT node_id,parent_node_id FROM message_nodes WHERE session_id=?').all(session.id) as Array<{ node_id: number; parent_node_id: number | null }>).map(n => [n.node_id, n.parent_node_id]));
      const chains = new Map<number, string[]>();
      const hasHeads = host.prepare("SELECT name FROM sqlite_master WHERE name='subagent_heads'").get();
      if (hasHeads) for (const head of host.prepare('SELECT agent_id,chain_node_id FROM subagent_heads WHERE session_id=? AND (? IS NULL OR updated_at * 1000 < ?)').all(session.id, options.untilTs ?? null, options.untilTs ?? null) as Array<{ agent_id: string; chain_node_id: number }>) {
        const seen = new Set<number>();
        let id: number | null | undefined = head.chain_node_id;
        while (id != null && !seen.has(id)) { seen.add(id); chains.set(id, [...chains.get(id) ?? [], head.agent_id]); id = parents.get(id); }
      }
      const sessionId = `devin:${session.id}`;
      let seq = ((db.prepare('SELECT MAX(seq) seq FROM events WHERE session_id=?').get(sessionId) as { seq: number | null }).seq ?? -1) + 1;
      const seen = new Set<string>();
      const versions = new Map<string, string>();
      const messages = new Set<string>();
      const calls = new Map<string, string>();
      const events: EventInput[] = [];
      for (const row of host.prepare('SELECT node_id,parent_node_id,chat_message,created_at,metadata FROM message_nodes WHERE session_id=? ORDER BY node_id').iterate(session.id) as Iterable<NodeRow>) {
        report.parts++;
        const message = parse(row.chat_message, `${session.id}:${row.node_id}`);
        const nodeMeta = parse(row.metadata, `${session.id}:${row.node_id}:metadata`);
        if (nodeMeta.summarized_from != null) { report.summaries++; continue; }
        if (nodeMeta.is_system_prefix === true || message.metadata?.telemetry?.source === 'sysprompt') { report.systemPrefixes++; continue; }
        const role = message.role as Role;
        if (!['user', 'assistant', 'tool', 'system'].includes(role)) { if (!report.unmappedRoles.includes(String(role))) report.unmappedRoles.push(String(role)); continue; }
        const metadata = message.metadata ?? {};
        const rawTs = originalTime(metadata.created_at);
        if (rawTs === null) { report.untimed++; if (options.untilTs !== undefined) continue; }
        const messageId = typeof message.message_id === 'string' ? message.message_id : `node:${row.node_id}`;
        messages.add(messageId);
        const sourceRef = { host_path: hostPath, session_id: session.id, message_id: messageId, node_id: row.node_id, parent_node_id: row.parent_node_id, agent_ids: chains.get(row.node_id) ?? [], node_saved_at: row.created_at, message_created_at: metadata.created_at ?? null, working_directory: session.working_directory, generation_model: metadata.generation_model ?? null, model_identity_source: metadata.generation_model ? 'message.metadata.generation_model' : 'unknown', inferred: { seq: true, mapping: 'devin-message-components', timestamp_source: rawTs === null ? 'node_saved_at_seconds_fallback' : 'message.metadata.created_at' } };
        const add = (component: string, event: Omit<EventInput, 'sessionId' | 'seq' | 'ts'>): void => {
          const digest = hash(JSON.stringify({ text: event.text ?? null, args: event.args ?? null, outcome: event.outcome ?? null }));
          const key = `${session.id}:${messageId}:${component}`;
          const sourceId = `${key}:${digest}`;
          if (seen.has(sourceId)) { report.duplicates++; return; }
          seen.add(sourceId);
          const changed = versions.has(key) && versions.get(key) !== digest;
          if (changed) report.revisions++;
          versions.set(key, digest);
          const ts = changed ? Math.max(rawTs ?? 0, row.created_at * 1000) : rawTs ?? row.created_at * 1000;
          if (!Number.isSafeInteger(ts) || options.untilTs !== undefined && ts >= options.untilTs) return;
          events.push({ ...event, sessionId, seq: 0, ts, source: 'devin', sourceId, sourceRef: { ...sourceRef, component, inferred: { ...sourceRef.inferred, timestamp_source: changed ? 'revision_node_saved_at_conservative' : sourceRef.inferred.timestamp_source } } });
        };
        if (role === 'tool') {
          const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : null;
          const extensions = metadata.extensions ?? {};
          const success = extensions['chisel/tool_result_meta']?.success;
          const exitCode = extensions['chisel/terminal_output']?.exit?.exit_code;
          const outcome = success === false || typeof exitCode === 'number' && exitCode !== 0 ? 'error' : success === true || exitCode === 0 ? 'ok' : null;
          add('result', { role, kind: 'tool_result', callId: callId ? `${session.id}:${callId}` : null, toolName: calls.get(callId ?? '') ?? metadata.telemetry?.operation ?? null, text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null), outcome });
        } else {
          if (typeof message.content === 'string' && message.content.length) add('text', { role, kind: 'text', text: message.content });
          else if (message.content != null && typeof message.content !== 'string') add('content', { role, kind: 'text', text: JSON.stringify(message.content) });
          if (!options.skipReasoning && typeof message.thinking?.thinking === 'string' && message.thinking.thinking.length) add('thinking', { role, kind: 'text', text: message.thinking.thinking });
          for (const [index, call] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
            const id = typeof call.id === 'string' ? call.id : `${messageId}:${index}`;
            const name = typeof call.name === 'string' ? call.name : 'unknown';
            calls.set(id, name);
            add(`call:${id}`, { role: 'assistant', kind: 'tool_call', toolName: name, callId: `${session.id}:${id}`, args: call.arguments, text: null });
          }
        }
      }
      events.sort((a, b) => a.ts - b.ts);
      for (const event of events) event.seq = seq++;
      const stats = ingestor.addMany(events);
      report.messages += messages.size; report.events += events.length;
      report.inserted += stats.inserted; report.skipped += stats.skipped;
    }
    host.exec('COMMIT');
    if (report.untimed) report.warnings.push(`${report.untimed} nodes lack original message timestamps; strict-cut imports exclude them, otherwise save time is explicitly marked as a fallback.`);
    if (report.unmappedRoles.length) report.warnings.push('Unknown roles are preserved in the source snapshot, not promoted into searchable evidence.');
    report.warnings.push('Session model/title, subagent heads and tool_call_state are current host metadata; they are not proof of historical state. Raw nodes, summaries and tool sidecars remain in the private source snapshot.');
    return report;
  } finally { host.close(); }
}
