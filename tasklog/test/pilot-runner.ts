import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db/open.ts';
import { Ingestor } from '../src/ingest/events.ts';
import { OpenCodeModel, parseOpenCodeTurn } from '../src/eval/opencode-model.ts';
import { ApiModel, apiEndpoint, type ChatModel, type ChatMessage, type ToolDefinition, type ToolCall } from '../src/eval/model.ts';
import { runPilot, runArm, codingCall, clipUtf8, verifyRepositoryClaims, type RunnerOptions, type PilotTask } from '../src/eval/runner.ts';

let passed = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); passed++; console.log(`ok ${name}`); };
const tmp = mkdtempSync(join(process.cwd(), '.tmp-runner-'));
const db = openDb({ path: join(tmp, 'log.db') });
const cutTs = Date.UTC(2030, 0, 1);
const ing = new Ingestor(db, db.name);
const full = '历史原文\n'.repeat(900) + 'ORIGINAL_HISTORY_TAIL';
ing.addMany([
  { sessionId: 'real-format-fixture', seq: 0, ts: cutTs - 10_000, role: 'user', kind: 'text', text: '上次讨论了 src/auth/middleware.ts，为什么没有继续旧方案。' },
  { sessionId: 'real-format-fixture', seq: 1, ts: cutTs - 9000, role: 'tool', kind: 'tool_result', text: full, toolName: 'read_file', outcome: 'ok' },
  { sessionId: 'future-fixture', seq: 0, ts: cutTs + 1000, role: 'assistant', kind: 'text', text: 'FUTURE_EVIDENCE_SECRET src/auth/middleware.ts' },
]);
const repo = resolve('demo-repo');
const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const task: PilotTask = {
  id: 'mechanism-fixture', repo, startCommit,
  cut: { taskKey: 'mechanism-fixture', startTs: cutTs, endTs: null },
  prompt: '查看相关历史，然后在 proof.txt 写入 fixture-ok。',
  probes: [{ what: 'future fixture evidence', needles: ['FUTURE_EVIDENCE_SECRET'] }],
  checks: [{ name: 'independent-output-check', argv: [process.execPath, '-e', 'const f=require("fs");process.exit(f.readFileSync("proof.txt","utf8")==="fixture-ok"?0:1)'] }],
};
let calls = 0;
const scripted: ChatModel = {
  id: 'fixture-not-frontier',
  async complete(messages: ChatMessage[], tools: ToolDefinition[]) {
    calls++;
    let call: ToolCall | undefined;
    if (tools.some((t) => t.function.name === 'finish_warmup')) {
      const historicalCalls = messages.flatMap((m) => m.tool_calls ?? []);
      if (!historicalCalls.some((c) => c.function.name === 'search_history')) {
        call = { id: `call-${calls}`, type: 'function', function: { name: 'search_history', arguments: JSON.stringify({ query: 'src/auth/middleware.ts' }) } };
      } else if (!historicalCalls.some((c) => c.function.name === 'read_events')) {
        const reply = messages.findLast((m) => m.role === 'tool');
        const hits = JSON.parse(reply?.content ?? '[]');
        call = { id: `call-${calls}`, type: 'function', function: { name: 'read_events', arguments: JSON.stringify({ task_id: hits[0].task.taskId }) } };
      } else call = { id: `call-${calls}`, type: 'function', function: { name: 'finish_warmup', arguments: JSON.stringify({ reason: '已读取相关任务，开始执行' }) } };
    } else if (!messages.some((m) => m.tool_calls?.some((c) => c.function.name === 'write_file'))) {
      call = { id: `call-${calls}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'proof.txt', content: 'fixture-ok' }) } };
    }
    return { message: { role: 'assistant', content: call ? null : 'Fixture execution ended.', ...(call ? { tool_calls: [call] } : {}) }, model: 'fixture-not-frontier', identityVerified: true, usage: { input: 12, output: 6, cached: 0, reasoning: 0 } };
  },
};
const options: RunnerOptions = { db, model: scripted, outputDir: join(tmp, 'output'), modelContextWindow: 100_000, budget: { maxContextTokens: null, warmupRounds: 3, queriesPerRound: 3, bytesPerQuery: 24_000 }, synthetic: true, maxSteps: 5 };
try {
  const before = (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
  const report = await runPilot([task], options);
  check('三臂实际执行并运行独立验收', report.results.length === 3 && report.results.every((r) => r.status === 'checks_passed'));
  check('合成端到端不冒充真实有效性', report.synthetic && report.results.every((r) => r.synthetic));
  check('三臂使用同一模型和同一 commit', report.comparable && new Set(report.results.map((r) => r.repositoryCommit)).size === 1);
  check('每条臂使用独立目录', new Set(report.results.map((r) => r.workspace)).size === 3);
  const [a, b, c] = report.results;
  check('A 臂没有历史', !JSON.stringify(a!.messages).includes('ORIGINAL_HISTORY_TAIL') && a!.queries.length === 0);
  check('B 臂收到 blob 完整尾部', JSON.stringify(b!.messages).includes('ORIGINAL_HISTORY_TAIL'));
  check('C-model 的查询由模型返回而非固定脚本', c!.mode === 'C-model' && c!.queries.some((q) => q.tool === 'search_history') && c!.queries.some((q) => q.tool === 'read_events'));
  check('C-model 能自行停止预热', c!.stopReason === '已读取相关任务，开始执行');
  check('所有臂均不读取未来原文', report.results.every((r) => !JSON.stringify(r.messages).includes('FUTURE_EVIDENCE_SECRET')));
  check('查询不污染原始 events', (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n === before);
  check('遥测保存在独立 query_log', (db.prepare('SELECT COUNT(*) n FROM query_log').get() as { n: number }).n >= 2);
  check('真实 usage 字段被累计', c!.usage.input === c!.requests * 12 && c!.usage.missing === 0);
  check('输出文件和逐臂轨迹确实落盘', JSON.parse(readFileSync(join(options.outputDir, 'pilot-results.json'), 'utf8')).results.length === 3);
  const root = a!.workspace;
  const observations = verifyRepositoryClaims(root, [
    { path: 'proof.txt', contains: 'fixture-ok', evidence_event_id: 1 },
    { path: 'proof.txt', contains: 'not-present', evidence_event_id: 3 },
    { path: 'missing-file.txt' },
  ], db, cutTs) as Array<Record<string, unknown>>;
  check('批量验证门读取真实仓库内容', observations[0]?.exists === true && observations[0]?.contains === true);
  check('历史断言与代码不符时明确返回反证', observations[1]?.contains === false && observations[2]?.exists === false);
  check('验证门不接受未来出处', observations[0]?.evidenceVisible === true && observations[1]?.evidenceVisible === false);
  check('没有内容 hash 不虚称新鲜度已验证', observations[0]?.freshness === 'unverified_without_content_hash');
  if (process.platform === 'win32') {
    const npm = codingCall(root, 'bash', { name: 'npm-version' }, [{ name: 'npm-version', argv: ['npm', '--version'] }]) as { passed: boolean };
    check('Windows 预声明 npm 命令可执行', npm.passed);
  }
  assert.throws(() => codingCall(root, 'write_file', { path: '../escape.txt', content: 'x' }, [])); passed++;
  assert.throws(() => codingCall(root, 'bash', { name: 'undeclared' }, [])); passed++;
  assert.throws(() => codingCall(root, 'read_file', { path: '.env' }, [])); passed++;
  await assert.rejects(() => runPilot([task], options), /already exists/); passed++;
  const outside = join(tmp, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'fixture-private');
  symlinkSync(outside, join(root, 'outward-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => codingCall(root, 'read_file', { path: 'outward-link/secret.txt' }, [])); passed++;
  check('UTF-8 截断不破坏中文字符', clipUtf8('中文原文', 5) === '中');
  const exhausted = await runArm('A', task, { ...options, budget: { ...options.budget, maxContextTokens: 1 } });
  check('预算不足不会发模型请求或假报成功', exhausted.status === 'budget_exhausted' && exhausted.requests === 0);
  const future = await runArm('C', { ...task, cut: { ...task.cut, startTs: 0 } }, options).catch((e) => e);
  check('不允许未来 commit 作为起始快照', future instanceof Error);
  let requestBody: any;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => body += c); req.on('end', async () => {
      requestBody = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (requestBody.model === 'fixture-runner-api') {
        const turn = await scripted.complete(requestBody.messages, requestBody.tools ?? []);
        res.end(JSON.stringify({ model: 'fixture-http-served', choices: [{ message: turn.message }], usage: { prompt_tokens: 12, completion_tokens: 6 } }));
      } else res.end(JSON.stringify({ model: 'fixture-served', choices: [{ message: { role: 'assistant', content: 'fixture-api-response' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const model = new ApiModel({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-key', model: 'fixture-requested', reasoningEffort: 'high' });
    const turn = await model.complete([{ role: 'user', content: 'fixture' }], []);
    check('HTTP 模型适配器实际发出请求', requestBody.model === 'fixture-requested' && requestBody.reasoning_effort === 'high');
    check('记录响应模型而非仅请求别名', turn.model === 'fixture-served' && turn.usage?.input === 5);
    assert.throws(() => apiEndpoint('http://remote.invalid/v1', 'chat/completions')); passed++;
    assert.throws(() => apiEndpoint('https://u:password@example.invalid/v1', 'chat/completions')); passed++;
    const httpModel = new ApiModel({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-key', model: 'fixture-runner-api', reasoningEffort: 'high' });
    const httpReport = await runPilot([task], { ...options, model: httpModel, outputDir: join(tmp, 'http-output') });
    check('HTTP 模型→MCP→代码修改→独立验收端到端执行', httpReport.results.every((r) => r.status === 'checks_passed'));
    check('HTTP 三臂请求配置相同且记录响应身份', httpReport.comparable && httpReport.results.every((r) => r.modelSettings.reasoningEffort === 'high' && r.servedModels[0] === 'fixture-http-served'));
    check('HTTP C-model 保留真实 MCP 查询遥测', httpReport.results[2]!.queries.some((q) => q.hits !== null && q.hits > 0 && q.eventIds.length > 0));
    check('模型凭据不进入运行报告', !JSON.stringify(httpReport).includes('fixture-key'));
  } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  const stream = [
    { type: 'text', part: { id: 'text-1', text: JSON.stringify({ content: null, tool_calls: [{ id: 'oc-1', name: 'search_history', arguments: { query: '历史原因' } }] }) } },
    { type: 'step_finish', part: { id: 'step-1', tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } } } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const ocTurn = parseOpenCodeTurn(stream, 'fixture/frontier');
  check('OpenCode JSON 事件可转为模型工具决策', ocTurn.message.tool_calls?.[0]?.function.name === 'search_history');
  check('OpenCode token 回执被读取而非估算', ocTurn.usage?.input === 13 && ocTurn.usage.output === 7);
  check('CLI 没提供响应身份时不虚称已核验模型', ocTurn.identityVerified === false);
  assert.throws(() => parseOpenCodeTurn(JSON.stringify({ type: 'tool_use' }), 'fixture/frontier')); passed++;
  assert.throws(() => parseOpenCodeTurn(JSON.stringify({ type: 'error', error: { name: 'AuthFailure' } }), 'fixture/frontier')); passed++;
  const fake = join(tmp, 'fake-opencode.cjs');
  writeFileSync(fake, `const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'));if(!process.env.OPENCODE_CONFIG.includes('.devin')||c.agent['tasklog-provider'].permission['*']!=='deny'||c.small_model!=='fixture/frontier'||c.share!=='disabled')process.exit(2);console.log(JSON.stringify({type:'text',part:{id:'t',text:JSON.stringify({content:'宿主配置接入成功',tool_calls:[]})}}));`);
  const hostModel = new OpenCodeModel({ model: 'fixture/frontier', workDir: join(tmp, 'host-model'), binary: process.execPath, prefixArgs: [fake] });
  const hostTurn = await hostModel.complete([{ role: 'user', content: 'fixture' }], []);
  check('OpenCode 宿主后端实际启动子进程并解析返回', hostTurn.message.content === '宿主配置接入成功');
  check('CLI 缺失 usage 时保持未知而非填零', hostTurn.usage === null);
  const configDir = join(tmp, '.devin'); mkdirSync(configDir);
  const manifest = join(configDir, 'pilot.json');
  writeFileSync(manifest, JSON.stringify({ synthetic: true, db: db.name, outputDir: join(tmp, 'cli-output'), modelContextWindow: options.modelContextWindow, maxSteps: 5, maxTotalTokens: 50_000, budget: options.budget, tasks: [task] }));
  const dry = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('scripts/pilot.ts'), '--manifest', manifest, '--dry-run'], { encoding: 'utf8' });
  check('pilot CLI 干跑实际构造切点前输入', JSON.parse(dry).historicalEvents === 2);
  check('pilot CLI 明确保留合成数据标识', JSON.parse(dry).synthetic === true);
  console.log(`\n==== ${passed} passed, 0 failed (synthetic mechanism tests only) ====`);
} finally { db.close(); }
