/**
 * 三臂上下文构造。
 *
 * ============================================================
 * 这个模块做什么、不做什么
 * ============================================================
 * 做：为 A / B / C 三条臂各自构造出**要喂给模型的上下文包**，
 *     附带 token 估算、泄漏检查结果、以及 C 臂的完整查询遥测。
 * 不做：实际调用模型。沙箱里没有 API 凭据，网络也不通。
 *
 * 所以这里的产物是**可审计的输入包 + 可复算的评分脚本**，
 * 实际的三臂对跑要在能访问模型的地方执行。
 * 这一点不能含糊：没跑就是没跑。
 *
 * ============================================================
 * 三条臂
 * ============================================================
 *  A 冷启动   只给任务描述 + 仓库状态。这是地板，不是基线。
 *  B 长上下文 历史装得下就完整给；装不下按 B′ 规则降级（见 buildArmB）。
 *  C tasklog  不预先塞历史，给工具 + 预热预算，让模型自己查。
 *
 * 公平性要求（三条都必须成立，否则结论无效）：
 *  - 同一模型、同一版本、同一推理设置
 *  - 同一仓库起始快照
 *  - 同一组 coding 工具
 *  - 同一道题面、同一套验收标准
 *  - 同一个时间切点（见 split.ts）
 */

import type { DB } from '../db/open.ts';
import { listTasks, searchHistory, resumeTask, readEvents, symbolHistory } from '../query/index.ts';
import type { CutPoint } from './split.ts';
import { readBlob } from '../ingest/events.ts';
import { createHistorySnapshot } from './history.ts';

export type ArmId = 'A' | 'B' | 'C';

export interface ArmBudget {
  /** 上下文 token 预算。null = 不限（性能优先口径） */
  maxContextTokens: number | null;
  /** C 臂的预热轮数上限 */
  warmupRounds: number;
  /** C 臂每轮最多发几个查询 */
  queriesPerRound: number;
  /** C 臂单次查询返回的最大字节 */
  bytesPerQuery: number;
}

export const DEFAULT_BUDGET: ArmBudget = {
  maxContextTokens: null,
  warmupRounds: 3,
  queriesPerRound: 4,
  bytesPerQuery: 24_000,
};

export interface ArmContext {
  arm: ArmId;
  /** 要放进 system / 首条 user 消息的历史部分 */
  historyBlock: string;
  /** 这条臂能用的工具名 */
  tools: string[];
  /** 粗略 token 估算（见 estimateTokens 的说明） */
  estTokens: number;
  bytes: number;
  /** 构造这份上下文引用到的事件 id，用于泄漏检查 */
  referencedEventIds: number[];
  /** 人类可读的构造说明，进实验记录 */
  notes: string[];
  /** B 臂专用：是否因超窗降级，以及怎么降的 */
  degraded?: { reason: string; strategy: string; droppedEvents: number };
}

/**
 * token 估算。
 *
 * 这是**估算**，不是真实 tokenizer 的结果。混合中英文时按
 * 中文 ~1.5 字符/token、英文 ~4 字符/token 加权。
 * 报告里必须用真实 API 返回的 usage 数字，这个只用于构造阶段的预算控制。
 */
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  const other = s.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

const CODING_TOOLS = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'list_dir'];
const TASKLOG_TOOLS = [
  'list_tasks',
  'search_history',
  'symbol_history',
  'resume_task',
  'read_events',
  'read_blob',
];

// ============================================================
// A 臂：冷启动
// ============================================================

export function buildArmA(): ArmContext {
  return {
    arm: 'A',
    historyBlock: '',
    tools: [...CODING_TOOLS],
    estTokens: 0,
    bytes: 0,
    referencedEventIds: [],
    notes: [
      'A 臂不提供任何历史。它是地板参照，不是"基线"——',
      '用它当唯一对照会让任何记忆方案都显得有效。',
    ],
  };
}

// ============================================================
// B 臂：长上下文
// ============================================================

export interface ArmBOptions {
  /** 模型的真实上下文窗口。不得虚称：支持多少就填多少。 */
  modelContextWindow: number;
  /** 留给题面、工具定义、模型输出的余量 */
  reserveTokens?: number;
  /** 超窗时的降级策略 */
  overflowStrategy?: 'rolling' | 'compact';
  /**
   * estimateTokens 的低估安全系数：打包预算 = (窗口 - 余量) / factor。
   * 实测 Devin swe-2-max 真实 input ≈ est × 1.34；provider 在接近
   * 窗口时 auto-compact（使"上下文未变"前提失效）。factor 2.8（est ~88K，
   * real ~120K）实测在第 11 轮触发 compaction —— 对话增长 ~130K 把余量
   * 吃光了。默认 5.0 把 B′ 基座压到 real ~66K，给 ~15 轮对话留 ~180K。
   */
  estSafetyFactor?: number;
}

/**
 * B 臂：把切点之前的历史**完整**铺平喂进去。
 *
 * 历史装不下时不能直接判 B 出局 —— 那是拿一个人为残废的对手去赢。
 * 必须降级成 B′：
 *   rolling  保留最近的 N 条完整事件（滚动窗口）
 *   compact  按任务分组，每个任务保留首尾与全部错误事件（历史整理）
 * 降级方式与丢弃量必须记录在 degraded 字段里，报告中单独列出。
 */
export function buildArmB(db: DB, cut: CutPoint, opts: ArmBOptions): ArmContext {
  const snapshot = createHistorySnapshot(db, cut);
  try { return buildArmBVisible(snapshot.db, cut, opts, snapshot.sourcePath); }
  finally { snapshot.close(); }
}

function buildArmBVisible(db: DB, cut: CutPoint, opts: ArmBOptions, blobPath: string): ArmContext {
  const reserve = opts.reserveTokens ?? 16_000;
  const factor = opts.estSafetyFactor ?? 5.0;
  const budget = Math.floor((opts.modelContextWindow - reserve) / factor);
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('History context budget must be positive');
  const notes: string[] = [];

  const all = db
    .prepare(
      `SELECT id, ts, session_id, seq, task_id, role, kind, tool_name, args_json, text, outcome, blob_ref
         FROM events WHERE ts < ? ORDER BY ts ASC, id ASC`,
    )
    .all(cut.startTs) as Array<Record<string, unknown>>;

  const render = (e: Record<string, unknown>): string => {
    const who = String(e.role);
    const kind = String(e.kind);
    const tool = e.tool_name ? ` ${String(e.tool_name)}` : '';
    const oc = e.outcome ? ` [${String(e.outcome)}]` : '';
    const args = e.args_json ? ` args=${String(e.args_json)}` : '';
    const body = e.blob_ref ? readBlob(blobPath, String(e.blob_ref)) : String(e.text ?? '');
    if (body === null) throw new Error(`Missing historical blob for event ${e.id}`);
    return `<${who}:${kind}${tool}${oc} ts=${e.ts} session=${e.session_id} seq=${e.seq} event=${e.id}>${args}\n${body}`;
  };

  const full = all.map(render);
  const fullText = full.join('\n\n');
  const fullTokens = estimateTokens(fullText);

  if (fullTokens <= budget) {
    notes.push(
      `历史完整装入：${all.length} 条事件，约 ${fullTokens} tokens，` +
        `窗口 ${opts.modelContextWindow}（留余量 ${reserve}，估算安全系数 ${factor}）。未做任何裁剪。`,
    );
    return {
      arm: 'B',
      historyBlock: fullText,
      tools: [...CODING_TOOLS],
      estTokens: fullTokens,
      bytes: Buffer.byteLength(fullText, 'utf8'),
      referencedEventIds: all.map((e) => Number(e.id)),
      notes,
    };
  }

  // ---- 超窗，必须降级而不是退赛 ----
  const strategy = opts.overflowStrategy ?? 'compact';
  notes.push(
    `历史约 ${fullTokens} tokens，超过可用预算 ${budget}（窗口 ${opts.modelContextWindow} 余量 ${reserve} 后除以估算安全系数 ${factor}）。` +
      `按要求升级为 B′（${strategy}），不以"基线不存在"为由退回只和 A 比。`,
  );

  let kept: Array<Record<string, unknown>>;
  if (strategy === 'rolling') {
    kept = [];
    let acc = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const t = estimateTokens(render(all[i]!)) + (kept.length ? estimateTokens('\n\n') : 0);
      if (acc + t > budget) break;
      acc += t;
      kept.unshift(all[i]!);
    }
  } else {
    // compact：按任务分组，每组保留首尾各 3 条 + 全部错误事件。
    // 这是"历史整理"基线的机械实现，不调用 LLM —— 用 LLM 整理
    // 会把 B′ 变成另一个记忆系统，就不是长上下文对照了。
    const byTask = new Map<number | null, Array<Record<string, unknown>>>();
    for (const e of all) {
      const k = (e.task_id as number | null) ?? null;
      if (!byTask.has(k)) byTask.set(k, []);
      byTask.get(k)!.push(e);
    }
    const picked: Array<Record<string, unknown>> = [];
    for (const group of byTask.values()) {
      const errs = group.filter((e) => e.outcome === 'error');
      const head = group.slice(0, 3);
      const tail = group.slice(-3);
      const set = new Map<number, Record<string, unknown>>();
      for (const e of [...head, ...errs, ...tail]) set.set(Number(e.id), e);
      picked.push(...set.values());
    }
    picked.sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id));
    kept = [];
    let acc = 0;
    for (let i = picked.length - 1; i >= 0; i--) {
      const t = estimateTokens(render(picked[i]!)) + (kept.length ? estimateTokens('\n\n') : 0);
      if (acc + t > budget) continue;
      acc += t;
      kept.unshift(picked[i]!);
    }
  }

  const text = kept.map(render).join('\n\n');
  return {
    arm: 'B',
    historyBlock: text,
    tools: [...CODING_TOOLS],
    estTokens: estimateTokens(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    referencedEventIds: kept.map((e) => Number(e.id)),
    notes,
    degraded: {
      reason: `历史 ${fullTokens} tokens > 可用 ${budget}`,
      strategy,
      droppedEvents: all.length - kept.length,
    },
  };
}

// ============================================================
// C 臂：tasklog 主动查询
// ============================================================

export interface WarmupStep {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  nHits: number;
  bytes: number;
  latencyMs: number;
  /** 这一步返回里出现的事件 id */
  eventIds: number[];
}

export interface ArmCResult extends ArmContext {
  warmup: WarmupStep[];
  /** 全部遥测，单独保存，不混进 events */
  telemetry: {
    runId: string;
    rounds: number;
    totalQueries: number;
    totalBytes: number;
    totalLatencyMs: number;
    stoppedEarly: boolean;
    stopReason: string;
  };
}

/**
 * C 臂的预热。
 *
 * ============================================================
 * 一个必须讲清楚的局限
 * ============================================================
 * 真正的 C 臂里，**查询改写、读到哪里停、要不要继续读，都由前沿模型自己决定**
 * （设计文档第 7 节：不换小模型做路由）。
 * 这个函数做不到那一步 —— 它跑在沙箱里，没有模型可调。
 *
 * 所以它实现的是一个**确定性的参照预热**：按固定顺序发几个结构性查询。
 * 它的用途有两个：
 *   1. 验证工具链在真实数据上跑得通、返回量在预算内
 *   2. 给模型驱动的 C 臂提供一个"最笨的 C"下界 ——
 *      如果模型驱动的 C 还不如固定脚本的 C，说明问题出在模型的查询策略
 *
 * 它**不是** C 臂本身。报告里必须把两者分开写成 C-fixed 与 C-model。
 */
export function buildArmC(
  db: DB,
  cut: CutPoint,
  taskPrompt: string,
  budget: ArmBudget = DEFAULT_BUDGET,
  runId = `run_${Date.now()}`,
): ArmCResult {
  const snapshot = createHistorySnapshot(db, cut);
  try { return buildArmCVisible(snapshot.db, cut, taskPrompt, budget, runId, db); }
  finally { snapshot.close(); }
}

function buildArmCVisible(db: DB, cut: CutPoint, taskPrompt: string, budget: ArmBudget, runId: string, logDb: DB): ArmCResult {
  const steps: WarmupStep[] = [];
  const seenEvents = new Set<number>();
  const blocks: string[] = [];
  let totalBytes = 0;
  let stoppedEarly = false;
  let stopReason = '用满预热轮数';

  const logQuery = logDb.prepare(/* sql */ `
    INSERT INTO query_log (ts, run_id, phase, tool, args_json, n_hits, n_expanded, bytes_out, latency_ms)
    VALUES (?, ?, 'warmup', ?, ?, ?, ?, ?, ?)
  `);

  const exec = (
    round: number,
    tool: string,
    args: Record<string, unknown>,
    fn: () => { text: string; hits: number; eventIds: number[] },
  ): void => {
    const t0 = Date.now();
    const r = fn();
    const dt = Date.now() - t0;
    const clipped =
      r.text.length > budget.bytesPerQuery
        ? `${r.text.slice(0, budget.bytesPerQuery)}\n[...返回被预算截断，可用 read_events 继续读]`
        : r.text;
    const bytes = Buffer.byteLength(clipped, 'utf8');
    totalBytes += bytes;
    for (const id of r.eventIds) seenEvents.add(id);
    steps.push({ round, tool, args, nHits: r.hits, bytes, latencyMs: dt, eventIds: r.eventIds });
    // 遥测单独落 query_log，绝不写进 events —— 否则下一次检索会命中上一次检索
    logQuery.run(Date.now(), runId, tool, JSON.stringify(args), r.hits, r.eventIds.length, bytes, dt);
    if (clipped.trim()) blocks.push(`### ${tool}(${JSON.stringify(args)})\n${clipped}`);
  };

  // ---- 第 1 轮：目录。没有它，第一次查询只能瞎猜关键词 ----
  const a1 = { only_current: false, limit: 25, until_ts: cut.startTs };
  exec(1, 'list_tasks', a1, () => {
    const rows = listTasks(db, { limit: 25, untilTs: cut.startTs }).filter(
      (t) => t.startedTs < cut.startTs,
    );
    const text = rows
      .map(
        (t) =>
          `task#${t.taskId} [${t.status}/${t.statusSource}] ${t.title ?? '(无标题)'} ` +
          `events=${t.events} errors=${t.errors} ` +
          `${t.superseded ? `[SUPERSEDED by ${t.supersededBy?.join(',')}] ` : ''}` +
          `paths=${t.topPaths.slice(0, 3).join(',')}`,
      )
      .join('\n');
    return { text, hits: rows.length, eventIds: [] };
  });

  // ---- 第 2 轮：用题面里的符号点查 ----
  if (budget.warmupRounds >= 2) {
    const syms = extractQuerySymbols(taskPrompt).slice(0, budget.queriesPerRound);
    if (syms.length === 0) {
      stoppedEarly = true;
      stopReason = '题面里没有可倒排的符号，固定脚本无法继续（模型驱动的 C 臂在这里会改写查询）';
    }
    for (const sym of syms) {
      exec(2, 'symbol_history', { symbol: sym, until_ts: cut.startTs }, () => {
        const r = symbolHistory(db, sym, { limit: 25 });
        const tl = r.timeline.filter((e) => e.ts < cut.startTs);
        const text =
          tl.length === 0
            ? ''
            : `符号 ${sym}（共 ${r.total} 次出现，切点前 ${tl.length} 次）\n` +
              tl
                .map(
                  (e) =>
                    `  ev#${e.eventId} task#${e.taskId} [${e.currentValidity}] ${e.line.slice(0, 180)}`,
                )
                .join('\n');
        return { text, hits: tl.length, eventIds: tl.map((e) => e.eventId) };
      });
    }
    exec(2, 'search_history', { query: taskPrompt.slice(0, 120), until_ts: cut.startTs }, () => {
      const hits = searchHistory(db, { query: taskPrompt.slice(0, 120), k: 8 }).filter(
        (h) => h.ts < cut.startTs,
      );
      const text = hits
        .map(
          (h) =>
            `ev#${h.locator.eventId} task#${h.task.taskId} [${h.currentValidity}] ` +
            `score=${h.score} by=${h.matchedBy.join('+')}\n  ${h.brief.line.slice(0, 220)}`,
        )
        .join('\n');
      return { text, hits: hits.length, eventIds: hits.map((h) => h.locator.eventId) };
    });
  }

  // ---- 第 3 轮：对命中最多的任务做状态重建 ----
  if (budget.warmupRounds >= 3 && seenEvents.size > 0) {
    const counts = new Map<number, number>();
    const taskOf = db.prepare(`SELECT task_id FROM events WHERE id = ?`);
    for (const id of seenEvents) {
      const r = taskOf.get(id) as { task_id: number | null } | undefined;
      if (r?.task_id != null) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    for (const [tid] of top) {
      exec(3, 'resume_task', { task_id: tid, tail: 8 }, () => {
        const r = resumeTask(db, tid, { tail: 8, skeletonLimit: 120 });
        const lines = [
          `task#${tid} ${r.task?.title ?? ''} status=${r.task?.status}/${r.task?.statusSource}`,
          r.hint,
          r.openItems.length ? `未闭合项：` : '未检出未闭合项',
          ...r.openItems.slice(0, 10).map((o) => `  [${o.kind}] ${o.detail.slice(0, 200)}`),
          `尾部：`,
          ...r.tail.filter((e) => e.ts < cut.startTs).map((e) => `  ${e.line.slice(0, 200)}`),
        ];
        return {
          text: lines.join('\n'),
          hits: r.openItems.length,
          eventIds: r.tail.map((e) => e.eventId),
        };
      });
    }
  }

  if (budget.maxContextTokens !== null) {
    const est = estimateTokens(blocks.join('\n\n'));
    if (est > budget.maxContextTokens) {
      stoppedEarly = true;
      stopReason = `达到上下文预算 ${budget.maxContextTokens} tokens`;
    }
  }

  const historyBlock = blocks.length
    ? [
        '以下是你从项目历史里查到的内容。几条注意事项：',
        '- 标 [superseded] 的是已被推翻的旧结论。它说明"当初怎么想、后来为什么改"，不要当现状用。',
        '- 任务 status 多为 unknown：没人确认过就不代表做完或放弃。',
        '- 这些只是预热查到的部分。执行过程中可以继续用工具查。',
        '',
        ...blocks,
      ].join('\n')
    : '';

  return {
    arm: 'C',
    historyBlock,
    tools: [...CODING_TOOLS, ...TASKLOG_TOOLS],
    estTokens: estimateTokens(historyBlock),
    bytes: Buffer.byteLength(historyBlock, 'utf8'),
    referencedEventIds: [...seenEvents],
    notes: [
      '这是 C-fixed（固定脚本预热），不是 C-model。',
      'C-model 的查询改写与停止判断由前沿模型自己做，需要在能调模型的环境里跑。',
      '两者必须在报告里分开写。',
    ],
    warmup: steps,
    telemetry: {
      runId,
      rounds: Math.min(budget.warmupRounds, 3),
      totalQueries: steps.length,
      totalBytes,
      totalLatencyMs: steps.reduce((a, s) => a + s.latencyMs, 0),
      stoppedEarly,
      stopReason,
    },
  };
}

/** 从题面里挑出像符号的 token。零 LLM。 */
function extractQuerySymbols(q: string): string[] {
  const out = new Set<string>();
  const re = /[A-Za-z_][\w./-]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const t = m[0].replace(/[.,;:]+$/, '');
    if (t.length >= 4 && !/^(the|and|that|this|with|from|into|about)$/i.test(t)) out.add(t);
  }
  return [...out];
}
