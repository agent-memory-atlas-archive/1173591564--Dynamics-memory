#!/usr/bin/env -S npx tsx
/**
 * tasklog CLI —— 用于本地验证与运维。
 * agent 走 MCP（src/mcp/server.ts），人走这里。
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDb, defaultDbPath } from './db/open.ts';
import { Ingestor, reindexSymbols, readBlob } from './ingest/events.ts';
import { syncCommits, currentBranch } from './tasks/git.ts';
import { importOpenCode, locateOpenCodeDb, locateOpenCodeStorage, lastImportedTs } from './adapters/opencode.ts';
import { importDevin, locateDevinDb } from './adapters/devin.ts';
import { rebuildTasks } from './tasks/segment.ts';
import { embeddingProviderFromEnv, indexVectors, hybridSearch } from './query/vector.ts';
import {
  listTasks,
  searchHistory,
  symbolHistory,
  resumeTask,
  readEvents,
  health,
} from './query/index.ts';
import type { EventInput, TaskStatus } from './types.ts';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}
function positional(n: number): string | undefined {
  const rest = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !arr[i - 1]?.startsWith('--'));
  return rest[n];
}

const repoRoot = resolve(flag('repo') ?? process.cwd());
const dbPath = resolve(
  flag('db') ?? process.env.TASKLOG_DB ?? join(repoRoot, '.tasklog', 'log.db'),
);
const asJson = has('json');

function out(v: unknown): void {
  if (asJson) {
    console.log(JSON.stringify(v, null, 2));
  } else {
    console.dir(v, { depth: 6, maxArrayLength: 200, colors: process.stdout.isTTY });
  }
}

function ts(n: number): string {
  return new Date(n).toISOString().replace('T', ' ').slice(0, 16);
}

const db = openDb({ path: dbPath });

switch (cmd) {
  case 'health': {
    out({ db: dbPath, branch: currentBranch(repoRoot), ...health(db) });
    break;
  }

  case 'sync': {
    const n = syncCommits(db, repoRoot);
    const seg = rebuildTasks(db, {
      gapMs: flag('gap') ? Number(flag('gap')) * 60_000 : undefined,
    });
    out({ commits: n, ...seg });
    break;
  }

  case 'reindex': {
    out(reindexSymbols(db));
    break;
  }

  case 'ingest': {
    const file = positional(0);
    if (!file) {
      console.error('用法: tasklog ingest <events.json>');
      process.exit(2);
    }
    const data = JSON.parse(readFileSync(resolve(file), 'utf8')) as EventInput[];
    const ing = new Ingestor(db, dbPath);
    out(ing.addMany(data));
    break;
  }

  case 'import': {
    const host = positional(0) ?? 'opencode';
    if (host === 'devin') {
      const rep = importDevin(db, dbPath, {
        dbPath: flag('host-db'),
        directoryPrefix: flag('project') ?? (has('this-repo') ? repoRoot : undefined),
        sessions: flag('sessions')?.split(','),
        untilTs: flag('until') ? Number(flag('until')) : undefined,
        skipReasoning: has('skip-reasoning'),
      });
      out(rep);
      for (const warning of rep.warnings) console.error(`  - ${warning}`);
      break;
    }
    if (host !== 'opencode') {
      console.error('支持的宿主：opencode、devin。');
      process.exit(2);
    }
    const incremental = has('incremental');
    const since = incremental ? (lastImportedTs(db) ?? undefined) : undefined;
    if (incremental) {
      console.error(`增量导入：只取 ts > ${since ?? '(无水位线，全量)'} 的内容`);
    }
    const rep = importOpenCode(db, dbPath, {
      dbPath: flag('host-db'),
      storageDir: flag('host-storage'),
      directoryPrefix: flag('project') ?? (has('this-repo') ? repoRoot : undefined),
      sinceTs: since ? since + 1 : undefined,
      readGit: !has('no-git'),
      skipReasoning: has('skip-reasoning'),
    });
    out(rep);
    if (rep.warnings.length) {
      console.error('\n注意:');
      for (const w of rep.warnings) console.error(`  - ${w}`);
    }
    if (rep.inserted > 0) {
      console.error('\n下一步: tasklog sync   （同步 git 并重建任务划分）');
    }
    break;
  }

  case 'where': {
    out({
      devinDb: locateDevinDb(),
      opencodeDb: locateOpenCodeDb(),
      opencodeStorage: locateOpenCodeStorage(),
      tasklogDb: dbPath,
      lastImported: lastImportedTs(db),
    });
    break;
  }

  case 'tasks': {
    const rows = listTasks(db, {
      status: (flag('status') as TaskStatus | undefined) ?? 'any',
      q: flag('q'),
      touching: flag('touching'),
      includeSuperseded: has('all'),
      limit: Number(flag('limit') ?? 30),
    });
    if (asJson) {
      out(rows);
      break;
    }
    for (const t of rows) {
      const mark = t.superseded ? ' [SUPERSEDED]' : '';
      const err = t.errors > 0 ? `  err=${t.errors}` : '';
      console.log(
        `#${String(t.taskId).padStart(3)}  ${t.status.padEnd(9)} ${ts(t.startedTs)}  ` +
          `${(t.commit ?? '-').padEnd(10)} ${t.boundarySrc.padEnd(9)} ev=${String(t.events).padStart(3)}${err}${mark}`,
      );
      console.log(`      ${t.title ?? '(无标题)'}`);
      if (t.topPaths.length) console.log(`      paths: ${t.topPaths.join(', ')}`);
    }
    break;
  }

  case 'vectors': {
    const provider = embeddingProviderFromEnv();
    if (!provider) throw new Error('Set TASKLOG_EMBEDDING_MODEL and embedding API base/key');
    out(await indexVectors(db, dbPath, provider, { limit: Number(flag('limit') ?? 1000) }));
    break;
  }

  case 'search': {
    const q = positional(0);
    const hits = await hybridSearch(db, {
      query: q,
      symbols: flag('sym') ? [flag('sym')!] : undefined,
      taskId: flag('task') ? Number(flag('task')) : undefined,
      k: Number(flag('k') ?? 8),
      onlyCurrent: has('only-current'),
    }, embeddingProviderFromEnv());
    if (asJson) {
      out(hits);
      break;
    }
    if (hits.length === 0) console.log('(无命中)');
    for (const h of hits) {
      const sup = h.task.superseded ? ' [SUPERSEDED]' : '';
      console.log(
        `[${h.score.toFixed(1)}] ${h.matchedBy.join('+').padEnd(11)} ` +
          `task#${h.task.taskId ?? '-'} seq=${h.locator.seq} ${ts(h.ts)}${sup}`,
      );
      console.log(`      ${h.brief.line}`);
      console.log(
        `      ↳ 任务: ${h.task.title ?? '-'} (${h.task.status ?? '-'}, ${h.task.events} 事件` +
          `${h.task.seqRange ? `, seq ${h.task.seqRange[0]}..${h.task.seqRange[1]}` : ''})`,
      );
    }
    break;
  }

  case 'sym': {
    const s = positional(0);
    if (!s) {
      console.error('用法: tasklog sym <symbol>');
      process.exit(2);
    }
    const r = symbolHistory(db, s, {
      kind: flag('kind') as never,
      limit: Number(flag('limit') ?? 40),
      includeSuperseded: has('all'),
    });
    if (asJson) {
      out(r);
      break;
    }
    console.log(`符号 ${r.symbol}  kinds=[${r.kinds.join(',')}]  命中 ${r.total} 次\n`);
    for (const e of r.timeline) {
      console.log(
        `${ts(e.ts)}  task#${e.taskId ?? '-'} seq=${String(e.seq).padStart(3)}` +
          `${e.superseded ? ' [SUPERSEDED]' : ''}  ${e.line}`,
      );
    }
    break;
  }

  case 'resume': {
    const id = Number(positional(0));
    if (!id) {
      console.error('用法: tasklog resume <taskId>');
      process.exit(2);
    }
    const r = resumeTask(db, id, { tail: Number(flag('tail') ?? 8) });
    if (asJson) {
      out(r);
      break;
    }
    console.log(`任务 #${id}: ${r.task?.title ?? '(无)'}  [${r.task?.status}]`);
    console.log(`commit=${r.task?.commit ?? '-'}  事件=${r.task?.events}  错误=${r.task?.errors}`);
    if (r.related.supersededBy.length)
      console.log(`!! 已被任务 ${r.related.supersededBy.join(',')} 取代`);
    if (r.related.supersedes.length) console.log(`   取代了任务 ${r.related.supersedes.join(',')}`);
    if (r.related.continues.length) console.log(`   续自任务 ${r.related.continues.join(',')}`);

    console.log(`\n--- 骨架 (${r.skeleton.length}) ---`);
    for (const e of r.skeleton) console.log(`  seq=${String(e.seq).padStart(3)}  ${e.line}`);

    console.log(`\n--- 未闭合项 (${r.openItems.length}) ---`);
    for (const o of r.openItems)
      console.log(`  [${o.kind}] seq=${o.locator.seq}  ${o.detail}`);

    console.log(`\n--- 尾部原文 (${r.tail.length}) ---`);
    for (const e of r.tail) console.log(`  seq=${String(e.seq).padStart(3)}  ${e.line}`);
    console.log(`\n${r.hint}`);
    break;
  }

  case 'read': {
    const r = readEvents(db, {
      taskId: flag('task') ? Number(flag('task')) : undefined,
      sessionId: flag('session'),
      seqFrom: flag('from') ? Number(flag('from')) : undefined,
      seqTo: flag('to') ? Number(flag('to')) : undefined,
      limit: Number(flag('limit') ?? 40),
    });
    if (asJson) {
      out(r);
      break;
    }
    for (const e of r.events) {
      console.log(`seq=${String(e.seq).padStart(3)} ${ts(e.ts)} ${e.role}/${e.kind}`);
      if (e.text) console.log(`    ${e.text.replace(/\n/g, '\n    ').slice(0, 1200)}`);
      if (e.blob) console.log(`    [blob ${e.blob}]  用 tasklog blob ${e.blob} 取回原文`);
    }
    console.log(`\n共 ${r.total} 条，nextSeq=${r.nextSeq ?? '(末尾)'}`);
    break;
  }

  case 'blob': {
    const h = positional(0);
    if (!h) {
      console.error('用法: tasklog blob <hash>');
      process.exit(2);
    }
    const c = readBlob(dbPath, h);
    console.log(c ?? '(未找到)');
    break;
  }

  default:
    console.log(`tasklog —— 按任务分段的事件日志，coding agent 的记忆层

用法:
  tasklog health                     索引健康度与遥测
  tasklog sync [--repo DIR] [--gap M] 同步 git 并重建任务划分
  tasklog reindex                    重抽符号（改了正则后用）
  tasklog ingest <events.json>       批量写入事件（手写/自造数据）

导入真实宿主日志:
  tasklog where                      自动定位 OpenCode / Devin 会话库
  tasklog import devin [--host-db PATH] [--this-repo | --project DIR]
                       [--sessions ID,ID] [--until EPOCH_MS] [--incremental]
    Devin 每次保存只读事务快照并按消息组件来源键去重；增量重扫，不因旧时间回补漏记录。
    --until 严格排除未来和无原始时间的节点；原始节点与旁表只存本地 sources 快照。
  tasklog import opencode [--host-db PATH] [--host-storage DIR]
                         [--this-repo | --project DIR] [--incremental]
                         [--skip-reasoning] [--no-git]
    --host-db      1.17+ 的 opencode.db；不给就按官方路径自动找
    --host-storage 1.17 之前的 storage 目录
    --this-repo    只导入工作目录在当前仓库下的会话
    --incremental  从上次水位线之后继续导（可反复跑）
    导入前最好退出 OpenCode：live 库的 -wal 里未 checkpoint 的部分可能读不到，
    适配器检测到这种情况会警告，不会假装读全了。

查询（五个接口）:
  tasklog tasks [--status S] [--q T] [--touching SYM] [--all]
  tasklog search <query> [-k N] [--sym S] [--task N] [--all]
  tasklog sym <symbol> [--kind K] [--all]
  tasklog resume <taskId> [--tail N]
  tasklog read --task N [--from S] [--to E]

辅助:
  tasklog blob <hash>                取回落盘原文

全局: --db PATH  --repo DIR  --json
`);
}

db.close();
