import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openDb } from '../src/db/open.ts';
import { Ingestor, readBlob } from '../src/ingest/events.ts';
import { ApiEmbeddingProvider, hybridSearch, indexVectors, searchVectors, type EmbeddingProvider } from '../src/query/vector.ts';
import { createHistorySnapshot } from '../src/eval/history.ts';

let passed = 0;
const check = (name: string, value: boolean) => { assert.ok(value, name); passed++; console.log(`ok ${name}`); };
const tmp = mkdtempSync(join(process.cwd(), '.tmp-vector-'));
const db = openDb({ path: join(tmp, 'log.db') });
const ing = new Ingestor(db, db.name);
const cut = 1000;
const body = '中性工具输出\n'.repeat(1000) + '尾部讨论 semantic_retry_tail';
const old = ing.add({ sessionId: 'past', seq: 0, ts: 100, role: 'tool', kind: 'tool_result', text: body });
ing.add({ sessionId: 'future', seq: 0, ts: 2000, role: 'assistant', kind: 'text', text: 'FUTURE_VECTOR_EVIDENCE semantic_retry_tail' });
const makeVector = (text: string): number[] => /FUTURE_VECTOR_EVIDENCE|如何限制重复网络请求/.test(text) ? [0, 1] : text.includes('semantic_retry_tail') ? [0.1, 0.9] : [1, 0];
const provider: EmbeddingProvider = { id: 'fixture-vector-not-semantic-evidence', async embed(input) { return input.map(makeVector); } };
try {
  const n = (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
  const built = await indexVectors(db, db.name, provider, { chunkChars: 500 });
  check('长原文分片覆盖 blob 尾部', built.chunks > 3);
  check('向量构建不改原始日志', (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n === n);
  const again = await indexVectors(db, db.name, provider, { chunkChars: 500 });
  check('重复建索引跳过未变的分片', again.chunks === 0 && again.skipped === built.chunks);
  const full = await searchVectors(db, '如何限制重复网络请求', provider, { k: 1 });
  check('全量向量检索确实能发现未来事件', full[0]?.eventId !== old.eventId);
  const bounded = await searchVectors(db, '如何限制重复网络请求', provider, { untilTs: cut, k: 1 });
  check('向量时间过滤发生在 top-k 之前', bounded.length === 1 && bounded[0]?.eventId === old.eventId);
  const hybrid = await hybridSearch(db, { query: '如何限制重复网络请求', untilTs: cut }, provider);
  check('没有关键词重合仍可经独立向量通道发现', hybrid.length === 1 && !!hybrid[0]?.matchedBy.includes('vector'));
  check('向量命中仍带任务/事件出处', hybrid[0]?.locator.eventId === old.eventId);
  const ref = (db.prepare('SELECT blob_ref FROM events WHERE id=?').get(old.eventId) as { blob_ref: string }).blob_ref;
  const span = hybrid[0]!.vectorSpan!;
  const slice = readBlob(db.name, ref, { offset: span.byteFrom, length: span.byteTo - span.byteFrom });
  check('向量命中的字节区间能回读原文尾部', !!slice?.content.includes('semantic_retry_tail'));
  const snapshot = createHistorySnapshot(db, { taskKey: 'vector', startTs: cut, endTs: null });
  try {
    check('快照只保留切点前的向量', (snapshot.db.prepare('SELECT COUNT(DISTINCT event_id) n FROM vector_chunks').get() as { n: number }).n === 1);
  } finally { snapshot.close(); }
  await assert.rejects(() => indexVectors(db, db.name, { id: 'invalid-fixture', async embed(input) { return input.map(() => [NaN, 1]); } })); passed++;
  await assert.rejects(() => searchVectors(db, 'query', { id: provider.id, async embed() { return [[1, 2, 3]]; } })); passed++;
  let embeddingRequests = 0;
  const server = createServer((req, res) => {
    let text = ''; req.on('data', (c) => text += c); req.on('end', () => {
      embeddingRequests++;
      const { input } = JSON.parse(text) as { input: string[] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: input.map((s, index) => ({ index, embedding: makeVector(s) })).reverse() }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const api = new ApiEmbeddingProvider({ baseUrl, apiKey: 'fixture-key', model: 'fixture-embedding' });
    const output = await api.embed(['中性', 'semantic_retry_tail']);
    check('HTTP embedding 响应按输入 index 对齐', output[0]?.[0] === 1 && output[1]?.[1] === 0.9);
    await indexVectors(db, db.name, api, { chunkChars: 500 });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))], env: { ...process.env, TASKLOG_DB: db.name, TASKLOG_UNTIL_TS: String(cut), TASKLOG_EMBEDDING_API_BASE: baseUrl, TASKLOG_EMBEDDING_API_KEY: 'fixture-key', TASKLOG_EMBEDDING_MODEL: 'fixture-embedding' } as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'vector-integration', version: '0.1.0' });
    try {
      await client.connect(transport);
      const reply = await client.callTool({ name: 'search_history', arguments: { query: '如何限制重复网络请求' } });
      const content = reply.content as Array<{ type: string; text?: string }>;
      const hits = JSON.parse(content.find((c) => c.type === 'text')!.text!);
      check('真实 MCP 工具调用接入向量发现', hits.length === 1 && hits[0].matchedBy.includes('vector'));
      check('MCP 向量调用受到服务端物理时间边界约束', hits[0].ts < cut && !JSON.stringify(hits).includes('FUTURE_VECTOR_EVIDENCE'));
      check('MCP 返回可展开的向量原文范围', hits[0].vectorSpan.byteTo > hits[0].vectorSpan.byteFrom);
      const replyBlob = await client.callTool({ name: 'read_blob', arguments: { blob: hits[0].brief.blob, offset: hits[0].vectorSpan.byteFrom, max_bytes: Math.max(256, hits[0].vectorSpan.byteTo - hits[0].vectorSpan.byteFrom) } });
      check('向量发现→MCP blob 回读链路实际通', JSON.stringify(replyBlob).includes('semantic_retry_tail'));
    } finally { await client.close(); }
    check('实际 HTTP embedding 请求已发生', embeddingRequests > 2);
  } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  console.log(`\n==== ${passed} passed, 0 failed (fixture embeddings only) ====`);
} finally { db.close(); }
