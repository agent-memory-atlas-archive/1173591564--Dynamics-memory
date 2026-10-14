import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openDb } from '../src/db/open.ts';
import { ApiModel } from '../src/eval/model.ts';
import { OpenCodeModel } from '../src/eval/opencode-model.ts';
import { DevinModel, checkDevinProvider } from '../src/eval/devin-model.ts';
import { runPilot } from '../src/eval/runner.ts';

const command = z.object({ name: z.string().min(1), argv: z.array(z.string()).min(1), timeoutMs: z.number().int().positive().max(600_000).optional() });
const manifestSchema = z.object({
  synthetic: z.boolean(),
  backend: z.enum(['api', 'opencode', 'devin']).default('api'),
  model: z.string().optional(),
  modelCatalog: z.string().optional(),
  db: z.string().min(1), outputDir: z.string().min(1),
  modelContextWindow: z.number().int().min(20_000),
  maxSteps: z.number().int().positive().max(200).default(20),
  maxTotalTokens: z.number().int().positive(),
  arms: z.array(z.enum(['A', 'B', 'C'])).optional(),
  budget: z.object({ maxContextTokens: z.number().int().positive().nullable(), warmupRounds: z.number().int().min(0).max(20), queriesPerRound: z.number().int().positive().max(20), bytesPerQuery: z.number().int().min(512).max(200_000) }),
  tasks: z.array(z.object({
    id: z.string().min(1), repo: z.string().min(1), startCommit: z.string().min(1), prompt: z.string().min(1),
    cut: z.object({ taskKey: z.string(), startTs: z.number().int().nonnegative(), endTs: z.number().int().nonnegative().nullable(), commitSha: z.string().nullable().optional() }),
    checks: z.array(command).min(1), commands: z.array(command).optional(), prepare: z.array(command).optional(),
    probes: z.array(z.object({ what: z.string(), needles: z.array(z.string()) })).optional(),
  })).min(1),
});

const argv = process.argv.slice(2);
const index = argv.indexOf('--manifest');
const file = index < 0 ? undefined : argv[index + 1];
if (!file) {
  console.error('Usage: npm run pilot -- --manifest PATH [--dry-run]. Use backend=devin/opencode with an authenticated host, or set TASKLOG_API_BASE, TASKLOG_API_KEY, TASKLOG_MODEL.');
  process.exit(2);
}
const manifestPath = resolve(file);
const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
const root = dirname(manifestPath);
const db = openDb({ path: resolve(root, manifest.db) });
try {
  if (!manifest.synthetic && (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n === 0) throw new Error('Real pilot requires nonempty real history; do not replace it with fixtures');
  const tasks = manifest.tasks.map((t) => ({ ...t, repo: resolve(root, t.repo) }));
  const model = process.env.TASKLOG_MODEL ?? manifest.model;
  let catalogEvidence: Record<string, unknown> | null = null;
  if (manifest.modelCatalog) {
    const file = resolve(root, manifest.modelCatalog), text = readFileSync(file, 'utf8');
    const catalog = JSON.parse(text) as { families: Array<{ variants: Array<{ model_uid: string; max_context_tokens?: number; max_output_tokens?: number }> }> };
    const variant = catalog.families.flatMap(f => f.variants).find(v => v.model_uid === model);
    if (!variant || variant.max_context_tokens !== manifest.modelContextWindow) throw new Error('Requested model/window does not match the supplied host catalog');
    catalogEvidence = { path: file, sha256: createHash('sha256').update(text).digest('hex'), model: variant.model_uid, maxContextTokens: variant.max_context_tokens, maxOutputTokens: variant.max_output_tokens ?? null, authority: 'host declaration, not an independently measured capacity' };
  }
  if (argv.includes('--dry-run')) {
    const { buildArmB } = await import('../src/eval/arms.ts');
    for (const task of tasks) {
      const b = buildArmB(db, task.cut, { modelContextWindow: manifest.modelContextWindow });
      console.log(JSON.stringify({ task: task.id, synthetic: manifest.synthetic, historicalEvents: b.referencedEventIds.length, estimatedHistoryTokens: b.estTokens, degraded: b.degraded ?? null }));
    }
  } else {
    if (!model) throw new Error('Specify TASKLOG_MODEL or model in the manifest; the harness never chooses a smaller model');
    const outputDir = resolve(root, manifest.outputDir);
    const baseUrl = process.env.TASKLOG_API_BASE, apiKey = process.env.TASKLOG_API_KEY;
    if (manifest.backend === 'api' && (!baseUrl || !apiKey)) throw new Error('Set TASKLOG_API_BASE/TASKLOG_API_KEY, or use backend=devin/opencode with an authenticated host');
    const client = manifest.backend === 'devin'
      ? new DevinModel({ model, binary: process.env.TASKLOG_DEVIN_BINARY })
      : manifest.backend === 'opencode'
        ? new OpenCodeModel({ model, workDir: resolve(outputDir, '.provider'), variant: process.env.TASKLOG_REASONING_EFFORT, binary: process.env.TASKLOG_OPENCODE_BINARY })
        : new ApiModel({ baseUrl: baseUrl!, apiKey: apiKey!, model, reasoningEffort: process.env.TASKLOG_REASONING_EFFORT });
    let ready = true;
    if (manifest.backend === 'devin' && (!manifest.synthetic || argv.includes('--provider-smoke-only'))) {
      if (existsSync(join(outputDir, 'pilot-results.json'))) throw new Error('Pilot output already exists; choose a new run directory');
      mkdirSync(outputDir, { recursive: true });
      console.log(JSON.stringify({ stage: 'provider_smoke_started', model, historyTransmitted: false }));
      const check = await checkDevinProvider(client);
      const path = join(outputDir, `provider-check-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify({ ...check, synthetic: manifest.synthetic, catalogEvidence, purpose: 'provider readiness, not task acceptance or memory effectiveness' }, null, 2), 'utf8');
      console.log(JSON.stringify({ stage: 'provider_smoke_finished', ready: check.ready, model: check.servedModel, error: check.error, evidence: path }));
      ready = check.ready;
      if (!ready) process.exitCode = 1;
    } else if (argv.includes('--provider-smoke-only')) throw new Error('--provider-smoke-only requires backend=devin');
    if (ready && !argv.includes('--provider-smoke-only')) {
      const report = await runPilot(tasks, { ...manifest, db, model: client, outputDir, onProgress: event => console.log(JSON.stringify(event)) });
      console.log(JSON.stringify({ synthetic: report.synthetic, comparable: report.comparable, arms: report.results.map((r) => ({ task: r.task, arm: r.arm, mode: r.mode, status: r.status, requests: r.requests, usage: r.usage, nativeToolAttempts: r.nativeToolAttempts, error: r.error ?? null })) }, null, 2));
      if (report.results.some((r) => r.status === 'error' || r.status === 'budget_exhausted')) process.exitCode = 1;
    }
  }
} finally { db.close(); }
