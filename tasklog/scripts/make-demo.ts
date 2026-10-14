/**
 * 造一份端到端的 demo：真实 git 仓库（含一次 revert）+ 对应的 agent 事件日志。
 *
 * 场景刻意覆盖讨论里那个关键例子：
 *   端口 8080 -> 9090 -> revert 回 8080。
 *   只看日志会被 9090 骗（时间戳让错误更自信），有 supersedes 边才排得掉。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, defaultDbPath } from '../src/db/open.ts';
import { Ingestor } from '../src/ingest/events.ts';
import { syncCommits } from '../src/tasks/git.ts';
import { rebuildTasks } from '../src/tasks/segment.ts';
import type { EventInput } from '../src/types.ts';

const ROOT = resolve(process.argv[2] ?? join(process.cwd(), 'demo-repo'));
const DB_PATH = resolve(process.env.TASKLOG_DB ?? join(ROOT, '.tasklog', 'log.db'));

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 14, 9, 0, 0); // 2026-09-14 09:00 UTC

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitAt(msg: string, tsMs: number): string {
  const iso = new Date(tsMs).toISOString();
  git(['add', '-A']);
  git(['commit', '-m', msg, '--no-gpg-sign'], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  });
  return git(['rev-parse', 'HEAD']).trim();
}

function w(rel: string, content: string): void {
  const p = join(ROOT, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

// ============================================================
// 1) 建仓库
// ============================================================
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'demo']);
git(['config', 'user.email', 'demo@example.com']);
git(['config', 'commit.gpgsign', 'false']);

w('README.md', '# demo service\n');
w('config/server.yaml', 'server:\n  host: 0.0.0.0\n  port: 8080\n');
w('src/server.ts', 'export function start() { /* ... */ }\n');
commitAt('chore: scaffold', T0 - DAY);

// --- 任务 A: JWT 认证 ---
w(
  'src/auth/middleware.ts',
  `import jwt from 'jsonwebtoken';

export function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'missing token' });
  const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  req.user = { id: payload.sub, exp: payload.exp };
  next();
}
`,
);
const shaAuth = commitAt('feat(auth): add JWT middleware', T0 + 3 * 3600 * 1000);

// --- 任务 C: 改端口 ---
w('config/server.yaml', 'server:\n  host: 0.0.0.0\n  port: 9090\n');
const shaPort = commitAt('chore(config): switch port 8080 -> 9090', T0 + 3 * DAY);

// --- 任务 D: revert 端口 ---
git(['revert', '--no-edit', '--no-commit', shaPort]);
const shaRevert = commitAt(
  `Revert "chore(config): switch port 8080 -> 9090"\n\nThis reverts commit ${shaPort}.\n\n9090 与网关冲突。`,
  T0 + 4 * DAY,
);

console.log('git repo:', ROOT);
console.log('  auth   ', shaAuth.slice(0, 10));
console.log('  port   ', shaPort.slice(0, 10));
console.log('  revert ', shaRevert.slice(0, 10), '-> reverts', shaPort.slice(0, 10));

// ============================================================
// 2) 造事件日志
// ============================================================
let seq = 0;
const ev: EventInput[] = [];
const S = 'sess-demo';

function text(role: 'user' | 'assistant', ts: number, t: string): void {
  ev.push({ sessionId: S, seq: seq++, ts, role, kind: 'text', text: t });
}
function call(ts: number, tool: string, args: unknown, id: string): void {
  ev.push({
    sessionId: S,
    seq: seq++,
    ts,
    role: 'assistant',
    kind: 'tool_call',
    toolName: tool,
    callId: id,
    args,
  });
}
function result(ts: number, tool: string, id: string, out: string, ok = true): void {
  ev.push({
    sessionId: S,
    seq: seq++,
    ts,
    role: 'tool',
    kind: 'tool_result',
    toolName: tool,
    callId: id,
    text: out,
    outcome: ok ? 'ok' : 'error',
    nbytes: Buffer.byteLength(out, 'utf8'),
  });
}

// ---- 任务 A：实现 JWT 认证（成功，落 commit） ----
let t = T0;
text('user', t, '给这个服务加上 JWT 认证，接口要能校验 Authorization 头。');
t += 40_000;
text('assistant', t, '先看一下现有的 src/server.ts 和路由结构。');
t += 20_000;
call(t, 'read_file', { path: 'src/server.ts' }, 'c1');
t += 5_000;
result(t, 'read_file', 'c1', 'export function start() { /* ... */ }\n');
t += 60_000;
call(t, 'write_file', { path: 'src/auth/middleware.ts' }, 'c2');
t += 8_000;
result(t, 'write_file', 'c2', 'wrote src/auth/middleware.ts (9 lines)');
t += 30_000;
text(
  'assistant',
  t,
  '用 jsonwebtoken 的 verifyToken 做中间件，密钥从 JWT_SECRET 读。注意 payload.exp 要带出去给上层判过期。',
);
t += 20_000;
call(t, 'bash', { command: 'npm test -- auth' }, 'c3');
t += 25_000;
result(t, 'bash', 'c3', 'PASS test/auth.test.ts\n  verifyToken\n    ✓ rejects missing token\n\n1 passed');

// ---- 任务 B：refresh token（放弃，无 commit） ----
t = T0 + DAY;
text('user', t, '再加上 refresh token 吧。');
t += 30_000;
call(t, 'read_file', { path: 'src/auth/middleware.ts' }, 'c4');
t += 6_000;
result(t, 'read_file', 'c4', 'export function verifyToken(req, res, next) { ... }');
t += 90_000;
call(t, 'write_file', { path: 'src/auth/refresh.ts' }, 'c5');
t += 7_000;
result(t, 'write_file', 'c5', 'wrote src/auth/refresh.ts (34 lines)');
t += 40_000;
call(t, 'bash', { command: 'npm test -- auth' }, 'c6');
t += 30_000;
result(
  t,
  'bash',
  'c6',
  "FAIL test/auth.test.ts\n  ● refreshToken › rotates\n\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at refreshToken (src/auth/refresh.ts:21:18)\n\n1 failed, 1 passed",
  false,
);
t += 60_000;
text(
  'assistant',
  t,
  'refresh.ts 里取 payload.exp 时 payload 可能是 undefined。TODO: refresh token 的过期处理还没做完，先搁置。',
);

// ---- 任务 C：改端口（成功，落 commit） ----
t = T0 + 3 * DAY - 20 * 60_000;
text('user', t, '把服务端口从 8080 改成 9090。');
t += 25_000;
call(t, 'edit_file', { path: 'config/server.yaml', old: 'port: 8080', new: 'port: 9090' }, 'c7');
t += 5_000;
result(t, 'edit_file', 'c7', 'config/server.yaml: 1 replacement');
t += 15_000;
text('assistant', t, '已改 config/server.yaml，端口现在是 9090。');

// ---- 任务 D：revert 端口（落 revert commit → supersedes） ----
t = T0 + 4 * DAY - 15 * 60_000;
text('user', t, '端口改回去，9090 跟网关冲突了。');
t += 20_000;
call(t, 'bash', { command: `git revert --no-edit ${shaPort.slice(0, 10)}` }, 'c8');
t += 12_000;
result(t, 'bash', 'c8', `[main ${shaRevert.slice(0, 7)}] Revert "chore(config): switch port 8080 -> 9090"`);
t += 10_000;
text('assistant', t, '已回滚，config/server.yaml 的 port 恢复为 8080。');

// ---- 任务 E：查 500（open，含未闭合项与悬挂调用） ----
t = T0 + 6 * DAY;
text('user', t, '登录接口偶尔返回 500，帮我查一下。');
t += 30_000;
call(t, 'grep', { pattern: 'status(500', path: 'src' }, 'c9');
t += 8_000;
result(t, 'grep', 'c9', 'src/routes/login.ts:44:    res.status(500).json({ error: e.message });');
t += 45_000;
call(t, 'bash', { command: 'npm test -- login' }, 'c10');
t += 35_000;
result(
  t,
  'bash',
  'c10',
  "FAIL test/login.test.ts\n  ● login › handles expired token\n\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at verifyToken (src/auth/middleware.ts:8:38)\n\n1 failed",
  false,
);
t += 50_000;
text(
  'assistant',
  t,
  'middleware.ts 第 8 行 jwt.verify 失败时 payload 是 undefined，和上次 refresh.ts 是同一类问题。先读一下 middleware。',
);
t += 15_000;
call(t, 'read_file', { path: 'src/auth/middleware.ts' }, 'c11'); // 故意不给 result → dangling_call

// 一条超过 INLINE_LIMIT 的大结果，验证 blob 落盘
t += 20_000;
call(t, 'bash', { command: 'npm run build --verbose' }, 'c12');
t += 40_000;
result(
  t,
  'bash',
  'c12',
  Array.from({ length: 400 }, (_, i) => `[build] step ${i} compiling module_${i}.ts ... ok`).join('\n'),
);

// ============================================================
// 3) 入库
// ============================================================
mkdirSync(join(ROOT, '.tasklog'), { recursive: true });
const db = openDb({ path: DB_PATH });
const ing = new Ingestor(db, DB_PATH);
const stats = ing.addMany(ev);
const nCommits = syncCommits(db, ROOT);
const seg = rebuildTasks(db);

console.log('\ningest:', stats);
console.log('commits synced:', nCommits);
console.log('segment:', JSON.stringify(seg));
console.log('\ndb:', DB_PATH);
db.close();
