import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DevinModel, parseDevinTurn, checkDevinProvider } from '../src/eval/devin-model.ts';
import { openDb } from '../src/db/open.ts';
import { Ingestor } from '../src/ingest/events.ts';
import { runPilot, runArm } from '../src/eval/runner.ts';
import { createEvaluationView, redactCredentialPatterns } from '../src/eval/privacy.ts';
import { readBlob } from '../src/ingest/events.ts';

let passed = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); passed++; console.log(`ok ${name}`); };
const message = { message_id: 'reply', role: 'assistant', content: JSON.stringify({ content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'src/auth/middleware.ts' } }] }), metadata: { generation_model: 'fixture-frontier', metrics: { input_tokens: 80, output_tokens: 20, cache_read_tokens: 100 } } };
const turn = parseDevinTurn([message, message], 'requested-alias');
check('Devin 文本协议转换为执行器工具决策', turn.message.tool_calls?.[0]?.function.name === 'read_file');
check('响应身份来自原始 generation_model', turn.model === 'fixture-frontier' && turn.identityVerified === true);
check('压缩副本不重复计算回执', Array.isArray(turn.reportedUsage) && turn.reportedUsage.length === 1);
check('input/cache 重叠未知时不编造归一 token 合计', turn.usage === null && (turn.reportedUsage as any)[0].metrics.cache_read_tokens === 100);
const unknown = parseDevinTurn([{ ...message, metadata: {} }], 'requested-model');
check('宿主未给身份和 usage 就保留未知', unknown.identityVerified === false && unknown.usage === null && unknown.model === 'requested:requested-model');
assert.throws(() => parseDevinTurn([{ ...message, tool_calls: [{ name: 'exec' }] }], 'x'), /native tools/); passed++;
assert.throws(() => parseDevinTurn([message, { ...message, message_id: 'another', metadata: { generation_model: 'unexpected-small-model' } }], 'x'), /changed models/); passed++;
assert.throws(() => parseDevinTurn([{ ...message, content: 'not-json' }], 'x'), /protocol/); passed++;
assert.throws(() => parseDevinTurn([{ ...message, content: '{"tool_calls":[{"name":"exec","arguments":[]}]}' }], 'x'), /Invalid/); passed++;
const tmp = mkdtempSync(join(process.cwd(), '.tmp-devin-model-'));
const binary = join(tmp, 'fixture-provider.mjs');
writeFileSync(binary, `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
import { createInterface } from 'node:readline';
const argv=process.argv.slice(2);
const flag=n=>argv[argv.indexOf(n)+1];
if(argv.includes('--agent-type'))process.exit(3);
const model=argv.includes('--model')?flag('--model'):'fixture-model';
const dbPath=process.env.CHISEL_SESSION_DB;
if(!dbPath||process.env.ACP_BACKEND!=='windsurf')process.exit(4);
const sessionId='fixture-session';
let db=null;
function ensureDb(){if(!db){db=new Database(dbPath);db.exec('CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,working_directory TEXT,model TEXT,created_at INTEGER);CREATE TABLE IF NOT EXISTS message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT)');db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(sessionId,process.cwd(),model,Date.now()/1000);}}
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  let f;try{f=JSON.parse(line)}catch{return}
  const id=f.id;
  if(f.method==='initialize')return send({jsonrpc:'2.0',id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'windsurf-api-key'}]}});
  if(f.method==='authenticate'){if(f.params?.methodId!=='windsurf-api-key'||!f.params?._meta?.api_key)process.exit(5);return send({jsonrpc:'2.0',id,result:{}});}
  if(f.method==='session/new'){ensureDb();return send({jsonrpc:'2.0',id,result:{sessionId,modes:{currentModeId:'ask',availableModes:[]}}});}
  if(f.method==='session/set_mode')return send({jsonrpc:'2.0',id,result:{}});
  if(f.method==='session/prompt'){
    const text=f.params?.prompt?.[0]?.text??'';
    const {messages,tools}=JSON.parse(text.slice(text.indexOf('\\n')+1));
    if(messages.some(m=>m.content==='startup-error-fixture')){process.stderr.write('Error: Not logged in. PRIVATE_STDERR_MARKER\\n');process.exit(2);}
    const prior=messages.flatMap(m=>m.tool_calls??[]).map(c=>c.function.name);
    let call;
    if(tools.some(t=>t.function.name==='finish_warmup')){
      if(!prior.includes('search_history'))call={name:'search_history',arguments:{query:'src/auth/middleware.ts'}};
      else call={name:'finish_warmup',arguments:{reason:'fixture evidence read'}};
    }else if(!prior.includes('write_file'))call={name:'write_file',arguments:{path:'proof.txt',content:'fixture-ok'}};
    const smoke=messages.some(m=>m.content?.includes('provider-smoke-ok'));
    if(smoke)call=undefined;
    const reply=JSON.stringify({content:smoke?'provider-smoke-ok':call?null:'fixture ended',tool_calls:call?[call]:[]});
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:reply}}}});
    if(messages.some(m=>m.content==='compaction-fixture'))db.prepare('INSERT INTO message_nodes VALUES (?,?,?,?)').run(sessionId,1,JSON.stringify({role:'user',content:'internal-summary'}),JSON.stringify({summarized_from:0}));
    return send({jsonrpc:'2.0',id,result:{stopReason:'end_turn',usage:null}});
  }
});
`, 'utf8');
const model = new DevinModel({ model: 'fixture-frontier', binary: process.execPath, prefixArgs: [binary], providerParent: tmp });
const actual = await model.complete([{ role: 'user', content: 'fixture' }], []);
check('Devin 后端实际启动隔离子进程并读回真实格式节点', actual.message.tool_calls?.[0]?.function.name === 'write_file');
await assert.rejects(() => model.complete([{ role: 'user', content: 'compaction-fixture' }], []), /compacted/); passed++;
const ready = await checkDevinProvider(model);
check('无历史烟测核对协议及明确响应模型', ready.ready && ready.servedModel === model.id && ready.contentMatches && ready.historyTransmitted === false);
check('烟测保留原始回执但不编造标准 usage', ready.receipt !== null && ready.usage === null);
const mismatch = await checkDevinProvider({ id: 'requested-frontier', complete: async () => ({ ...turn, model: 'other-model' }) });
check('烟测模型不符时阻止三臂启动', !mismatch.ready && mismatch.servedModel === 'other-model' && !!mismatch.error);
const failed = await checkDevinProvider({ id: 'requested-frontier', complete: async () => { throw new Error('fixture authentication unavailable'); } });
check('烟测失败也返回可持久化记录，不冒充任务失败', !failed.ready && failed.error?.includes('unavailable') === true && failed.servedModel === null);
await assert.rejects(() => model.complete([{ role: 'user', content: 'startup-error-fixture' }], []), error => error instanceof Error && error.message.includes('authentication_required') && !error.message.includes('PRIVATE_STDERR_MARKER')); passed++;
const db = openDb({ path: join(tmp, 'history.db') });
const cut = Date.UTC(2030, 0, 1);
new Ingestor(db, db.name).add({ sessionId: 'fixture', seq: 0, ts: cut - 1000, role: 'user', kind: 'text', text: 'src/auth/middleware.ts 历史证据' });
try {
  const repo = resolve('demo-repo');
  const task = { id: 'devin-backend-fixture', repo, startCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), cut: { taskKey: 'fixture', startTs: cut, endTs: null }, prompt: 'fixture: write proof.txt', checks: [{ name: 'independent', argv: [process.execPath, '-e', 'process.exit(require("fs").readFileSync("proof.txt","utf8")==="fixture-ok"?0:1)'] }] };
  const options = { db, model, outputDir: join(tmp, 'run'), modelContextWindow: 100_000, budget: { maxContextTokens: null, warmupRounds: 3, queriesPerRound: 2, bytesPerQuery: 20_000 }, maxSteps: 5, maxTotalTokens: 100_000, synthetic: true };
  const progress: Array<Record<string, unknown>> = [];
  const report = await runPilot([task], { ...options, onProgress: event => progress.push(event) });
  check('进度覆盖每条臂开始与完成', progress.filter(e => e.stage === 'arm_started').length === 3 && progress.filter(e => e.stage === 'arm_finished').length === 3);
  check('请求与工具进度不暴露消息原文或参数', progress.some(e => e.stage === 'request_started') && progress.some(e => e.stage === 'tool_finished') && !JSON.stringify(progress).includes('历史证据'));
  check('Devin 协议→MCP→代码修改→独立验收三臂链路通过', report.results.every(r => r.status === 'checks_passed'));
  check('三臂相同响应模型身份被保存', report.comparable && report.results.every(r => r.servedModels[0] === 'fixture-frontier'));
  check('原始 token 回执逐请求保存，缺标准口径不填零冒充', report.results.every(r => r.usageReceipts.length === r.requests && r.usage.missing === r.requests));
  check('未知 token 口径时预算采用独立估算字段', report.results.every(r => r.estimatedUnmeteredTokens > 0));
  check('C-model 经实际 MCP 主动读取', report.results[2]?.queries.some(q => q.tool === 'search_history') === true);
  check('fixture 始终标记为合成机制验证', report.synthetic && report.results.every(r => r.synthetic));
  const catalogPath = join(tmp, 'catalog.json'), manifestPath = join(tmp, 'pilot.json');
  const catalog = { families: [{ variants: [{ model_uid: model.id, max_context_tokens: options.modelContextWindow, max_output_tokens: 8000 }] }] };
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(manifestPath, JSON.stringify({ synthetic: true, backend: 'devin', model: model.id, modelCatalog: catalogPath, db: db.name, outputDir: join(tmp, 'cli-output'), modelContextWindow: options.modelContextWindow, maxTotalTokens: options.maxTotalTokens, budget: options.budget, tasks: [task] }));
  const cliArgs = ['--import', import.meta.resolve('tsx'), resolve('scripts/pilot.ts'), '--manifest', manifestPath, '--dry-run'];
  const cliEnv = { ...process.env, TASKLOG_MODEL: model.id };
  const dry = JSON.parse(execFileSync(process.execPath, cliArgs, { encoding: 'utf8', env: cliEnv }).trim());
  check('CLI 干跑按真实形状模型目录核对 UID 和窗口，不调模型', dry.synthetic === true && dry.historicalEvents === 1);
  catalog.families[0]!.variants[0]!.max_context_tokens++;
  writeFileSync(catalogPath, JSON.stringify(catalog));
  assert.throws(() => execFileSync(process.execPath, cliArgs, { encoding: 'utf8', env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] }), /Requested model\/window does not match/); passed++;
  const bounded = await runArm('A', task, { ...options, maxTotalTokens: 1 });
  check('没有标准 usage 也不能绕过总预算', bounded.status === 'budget_exhausted' && bounded.requests === 0);
  const privateDb = openDb({ path: join(tmp, 'private.db') });
  try {
    const dummy = 'sk-' + 'x'.repeat(40);
    const original = '原文\n'.repeat(1500) + dummy;
    const ingestor = new Ingestor(privateDb, privateDb.name);
    ingestor.add({ sessionId: 'privacy-fixture', seq: 0, ts: cut - 2000, role: 'tool', kind: 'tool_result', text: original });
    ingestor.add({ sessionId: 'privacy-fixture', seq: 1, ts: cut - 1000, role: 'assistant', kind: 'tool_call', args: { command: `api_key=${dummy}`, nested: ['authorization=' + 'a'.repeat(30)] } });
    ingestor.add({ sessionId: 'privacy-fixture', seq: 2, ts: cut + 1000, role: 'user', kind: 'text', text: 'future-privacy-fixture' });
    const raw = privateDb.prepare('SELECT blob_ref FROM events WHERE seq=0').get() as any;
    const viewPath = join(tmp, 'safe-view', 'history.db');
    const prepared = createEvaluationView(privateDb, viewPath, cut);
    check('评测脱敏视图不是手写历史，保留独立来源', prepared.events === 2 && prepared.redactedEvents === 2);
    check('原始日志与 blob 不被改写', readBlob(privateDb.name, raw.blob_ref) === original && (privateDb.prepare('SELECT COUNT(*) n FROM events').get() as any).n === 3);
    const view = openDb({ path: viewPath, readonly: true });
    try {
      const rows = view.prepare('SELECT * FROM events').all() as any[];
      check('副本严格排除未来事件', rows.every(r => r.ts < cut));
      const sanitized = readBlob(view.name, rows[0].blob_ref)!;
      check('blob 原文主体保留，凭据片段单独替换', sanitized.startsWith('原文\n') && !sanitized.includes(dummy) && sanitized.includes('[redacted credential pattern]'));
      check('工具参数递归脱敏，JSON 结构不破坏', JSON.parse(rows[1].args_json).nested.length === 1 && !rows[1].args_json.includes(dummy));
      check('脱敏出处注明原事件、hash 与替换数', JSON.parse(rows[0].source_ref).evaluation_view.original_event_id === 1 && JSON.parse(rows[0].source_ref).evaluation_view.redactions === 1);
      check('标准库视图元数据公开检测局限，不宣称完全排除秘密', JSON.parse((view.prepare('SELECT value FROM meta WHERE key=?').get('evaluation_view') as any).value).detection.includes('heuristic'));
    } finally { view.close(); }
    const blocked = await runArm('B', task, { ...options, db: privateDb, outputDir: join(tmp, 'blocked') });
    check('未脱敏历史不发模型请求', blocked.status === 'error' && blocked.requests === 0);
    check('被拦截的凭据不写进执行器报告', !JSON.stringify(blocked).includes(dummy));
    check('代码中的占位值不当真实凭据脱敏', redactCredentialPatterns('api_key=process.env.TEST; sk-...').replacements === 0);
    assert.throws(() => createEvaluationView(privateDb, viewPath, cut), /already exists/); passed++;
  } finally { privateDb.close(); }
} finally { db.close(); }
console.log(`\n${passed} passed, 0 failed (synthetic Devin backend mechanism tests only)`);
