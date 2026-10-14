#!/usr/bin/env -S npx tsx
/**
 * tasklog MCP server —— 把按任务分段的事件日志开放为查询入口。
 *
 * 设计要点（design/agent-memory-design.md 第 5 节）：
 *  - 五个工具语义边界互不重叠，不给一个万能 search。
 *  - 每个返回都带定位符，agent 可二次深入读，不必整段灌。
 *  - resume_task 不是 search 的一种用法：状态重建要完整性，不是相关性。
 *  - 被 supersedes 取代的任务默认照样返回，但强制带 currentValidity 标注。
 *    藏起来等于把"当初为什么这么做、后来为什么推翻"一起删了。
 *    只有显式 only_current 才排除。
 *
 * 注意：stdio 传输下 stdout 属于协议，日志一律走 stderr。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, join } from 'node:path';
import { openDb } from '../db/open.ts';
import { readBlob } from '../ingest/events.ts';
import { createHistorySnapshot } from '../eval/history.ts';
import { embeddingProviderFromEnv, hybridSearch } from '../query/vector.ts';
import {
  listTasks,
  searchHistory,
  symbolHistory,
  resumeTask,
  readEvents,
  health,
} from '../query/index.ts';
import type { SymbolKind, TaskStatus } from '../types.ts';

const repoRoot = resolve(process.env.TASKLOG_REPO ?? process.cwd());
const dbPath = resolve(process.env.TASKLOG_DB ?? join(repoRoot, '.tasklog', 'log.db'));
const cutoff = process.env.TASKLOG_UNTIL_TS === undefined ? null : Number(process.env.TASKLOG_UNTIL_TS);
if (cutoff !== null && (!Number.isSafeInteger(cutoff) || cutoff < 0)) throw new Error('Invalid TASKLOG_UNTIL_TS');
const source = openDb({ path: dbPath, readonly: cutoff !== null });
const snapshot = cutoff === null ? null : createHistorySnapshot(source, { taskKey: 'mcp', startTs: cutoff, endTs: null });
const db = snapshot?.db ?? source;
const embeddingProvider = embeddingProviderFromEnv();

const server = new McpServer(
  { name: 'tasklog', version: '0.1.0' },
  {
    instructions: `tasklog 是本项目的历史日志，按任务分段存放原始事件（含工具调用与结果），不做摘要。

什么时候查它：
  - 「为什么当初这样决策」「上次为什么没选那个方案」 -> search_history
  - 「继续做上次那个任务」「上次做到哪了」          -> resume_task
  - 「这个文件/函数以前出过什么事」                  -> symbol_history
  - 不知道从哪下手                                    -> list_tasks 先看目录

什么时候不要查它：
  - 「现在用的是什么」这类当前状态问题，直接读代码和 git —— 它们才是权威。
    日志回答的是「为什么是现在这样」和「试过什么没成功」。
  - 失败的尝试、被否决的方案、某个坑的成因，世界上不留痕迹，只有这里有。

用法约定：
  - 每个返回都带 locator（task_id / session_id / seq / event_id）。
    想看更多就用 read_events 按 seq 区间翻页，不要指望一次拿全。
  - 已被 revert / 取代的内容默认照样返回，但会标 currentValidity="superseded"。
    那是历史，不是现状：读它是为了知道以前试过什么、为什么改掉，不要据它判断当前状态。
    只想要仍然成立的内容时，加 only_current=true。
  - 任务的 status 多数是 unknown。分段只能证明边界，证明不了任务做完或被放弃，
    所以除非有人确认过（status_source="user"），不要把 status 当成完成度读。`,
  },
);

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }],
});

// ============================================================
// 1. list_tasks
// ============================================================
server.registerTool(
  'list_tasks',
  {
    title: '列出任务',
    description:
      '按任务列出项目历史的目录。不知道该查什么时先用它。' +
      '每条给出标题（优先取 commit message）、状态、时间、关联 commit、事件数、错误数、' +
      '最常触碰的文件、分段证据。默认包含已被取代的任务并加标注。',
    inputSchema: {
      status: z
        .enum(['unknown', 'open', 'done', 'abandoned', 'any'])
        .optional()
        .describe('多数任务是 unknown：没人确认过就不臆断完成或放弃'),
      q: z.string().optional().describe('标题/commit 的模糊匹配'),
      touching: z
        .string()
        .optional()
        .describe('只要触碰过该文件路径或符号的任务，例如 src/auth/middleware.ts'),
      only_current: z
        .boolean()
        .optional()
        .describe('只要仍然有效的任务，排除被 revert / 取代的。默认 false（全给并标注）'),
      include_retired: z.boolean().optional().describe('含重分段后已退役的任务行'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(
      listTasks(db, {
        status: (a.status as TaskStatus | 'any') ?? 'any',
        q: a.q,
        touching: a.touching,
        onlyCurrent: a.only_current ?? false,
        includeRetired: a.include_retired ?? false,
        limit: a.limit ?? 30,
      }),
    ),
);

// ============================================================
// 2. search_history
// ============================================================
server.registerTool(
  'search_history',
  {
    title: '点查历史',
    description:
      '在历史事件里点查，回答「为什么当初这样做」这类问题。' +
      '命中是事件级的（精确、小粒度），但每条都会带出它所属的任务 —— ' +
      '想看该任务的其余部分，用返回里的 task_id 和 seq 区间调 read_events 补全。' +
      '符号倒排、全文与已配置的向量通道联合发现。向量命中带 vectorSpan，' +
      'blob 内容可按 byteFrom 和 byteTo 读取对应原文，再按任务补全。',
    inputSchema: {
      query: z.string().optional().describe('自然语言或关键词；其中像符号的 token 会自动走倒排'),
      symbols: z
        .array(z.string())
        .optional()
        .describe('精确符号，如 ["src/auth/middleware.ts","verifyToken"]'),
      task_id: z.number().int().optional().describe('限定在某个任务内查'),
      kinds: z
        .array(z.enum(['path', 'ident', 'errcode', 'sha', 'test']))
        .optional()
        .describe('限定符号类型'),
      k: z.number().int().min(1).max(50).optional(),
      only_current: z.boolean().optional().describe('排除已被取代的内容。默认 false'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(
      await hybridSearch(db, {
        query: a.query,
        symbols: a.symbols,
        taskId: a.task_id,
        kinds: a.kinds as SymbolKind[] | undefined,
        k: a.k ?? 8,
        onlyCurrent: a.only_current ?? false,
      }, embeddingProvider),
    ),
);

// ============================================================
// 3. symbol_history
// ============================================================
server.registerTool(
  'symbol_history',
  {
    title: '符号的全部历史',
    description:
      '某个文件、函数、错误码、测试名在历史上的全部出现，按时间排序。' +
      '改动某处代码之前用它看看这里以前出过什么事。' +
      '这是精确匹配：get_user_id 和 get_user_ids 是两个不同的 key，不会混。',
    inputSchema: {
      symbol: z.string().describe('文件路径、标识符、错误码、commit sha 或测试名'),
      kind: z.enum(['path', 'ident', 'errcode', 'sha', 'test']).optional(),
      limit: z.number().int().min(1).max(300).optional(),
      only_current: z.boolean().optional().describe('排除已被取代的内容。默认 false'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(
      symbolHistory(db, a.symbol, {
        kind: a.kind as SymbolKind | undefined,
        limit: a.limit ?? 40,
        onlyCurrent: a.only_current ?? false,
      }),
    ),
);

// ============================================================
// 4. resume_task
// ============================================================
server.registerTool(
  'resume_task',
  {
    title: '恢复任务状态',
    description:
      '接着做某个任务之前用它。它不是检索 —— 它给的是完整性而不是相关性：' +
      '整条时间线的骨架（每个事件一行）、尾部若干步的原文、以及显式的未闭合项' +
      '（报错后没重做成功的、悬挂的工具调用、TODO）。' +
      '不要用 search_history 代替它来恢复状态，那样会漏掉未闭合项，而你不会察觉。' +
      '如果该任务已被取代，返回里会标出取代它的任务。',
    inputSchema: {
      task_id: z.number().int(),
      tail: z.number().int().min(1).max(60).optional().describe('尾部给多少条原文，默认 12'),
      skeleton_limit: z
        .number()
        .int()
        .min(20)
        .max(2000)
        .optional()
        .describe('骨架最多给多少条，默认 400。超出会标 skeletonTruncated 并给续读游标'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(resumeTask(db, a.task_id, { tail: a.tail ?? 12, skeletonLimit: a.skeleton_limit ?? 400 })),
);

// ============================================================
// 5. read_events
// ============================================================
server.registerTool(
  'read_events',
  {
    title: '分页读原文',
    description:
      '读某个任务或会话的原始事件，按时间顺序分页。配合 search_history / resume_task 的定位符使用。' +
      '一次只取一段 —— 把整个任务灌进上下文会让长上下文衰减开始吃你。' +
      '翻页请原样回传 next_cursor，不要用 seq 自己算：seq 只在单个会话内唯一，' +
      '一个任务横跨多个会话时按 seq 翻页既会漏也会重。',
    inputSchema: {
      task_id: z.number().int().optional(),
      session_id: z.string().optional(),
      cursor: z.string().optional().describe('上一页返回的 next_cursor，原样回传'),
      seq_from: z.number().int().optional().describe('仅在限定了 session_id 时有意义'),
      seq_to: z.number().int().optional().describe('仅在限定了 session_id 时有意义'),
      since_ts: z.number().int().optional(),
      until_ts: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => {
    const r = readEvents(db, {
      taskId: a.task_id,
      sessionId: a.session_id,
      seqFrom: a.seq_from,
      seqTo: a.seq_to,
      cursor: a.cursor,
      sinceTs: a.since_ts,
      untilTs: a.until_ts,
      limit: a.limit ?? 40,
    });
    return ok({ events: r.events, next_cursor: r.nextCursor, total: r.total });
  },
);

// ============================================================
// 辅助：取回落盘原文 / 健康度
// ============================================================
server.registerTool(
  'read_blob',
  {
    title: '取回被截断的原文',
    description:
      '事件里标了 [blob xxxx] 的，说明原始输出过大、只在日志里留了摘要行。' +
      '用这个句柄把完整原文取回来。原件从未被删除，这是本系统与摘要式记忆的根本差别。' +
      '超过 max_bytes 时返回 next_offset，带着它再调一次就能继续往后读 —— ' +
      '不要以为读到的就是全部。',
    inputSchema: {
      blob: z.string().describe('事件返回里的 blob 句柄'),
      offset: z.number().int().min(0).optional().describe('从第几字节开始读，默认 0'),
      max_bytes: z.number().int().min(256).max(200_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => {
    const cap = a.max_bytes ?? 40_000;
    const range = { offset: a.offset ?? 0, length: cap };
    const r = snapshot ? snapshot.readBlob(a.blob, range) : readBlob(dbPath, a.blob, range);
    if (r === null) return ok({ error: 'blob 未找到', blob: a.blob });
    return ok({
      blob: a.blob,
      total_bytes: r.totalBytes,
      offset: r.offset,
      bytes: r.bytes,
      next_offset: r.nextOffset,
      truncated: r.nextOffset !== null,
      content: r.content,
    });
  },
);

server.registerTool(
  'index_health',
  {
    title: '索引健康度',
    description:
      '事件/任务/符号规模与遥测。unindexed_rate 是抽不出任何符号的非文本事件占比 —— ' +
      '它偏高说明正则漏抽，那些事件在主索引里等于不存在。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => ok({ db: dbPath, repo: repoRoot, vectorProvider: embeddingProvider?.id ?? null, cutoff, ...health(db) }),
);

// ============================================================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[tasklog] MCP server ready  db=${dbPath}`);
