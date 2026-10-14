import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { codingCall, repositorySnapshot, type PilotTask } from '../src/eval/runner.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const file = flag('manifest');
if (!file) throw new Error('Specify --manifest PATH');
const manifestPath = resolve(file);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { tasks: PilotTask[]; synthetic: boolean };
const output = resolve(flag('output') ?? '.tasklog/oracle-validation');
const resultPath = join(output, 'checks.json');
if (existsSync(resultPath)) throw new Error('Validation output already exists; use a new output directory');
mkdirSync(output, { recursive: true });
const results: unknown[] = [];
for (const raw of manifest.tasks) {
  if (!raw.cut.commitSha || !raw.checks.length) throw new Error('Acceptance validation requires an oracle commit and checks');
  const task = { ...raw, repo: resolve(dirname(manifestPath), raw.repo) };
  const before = repositorySnapshot(task, output);
  const oracleTs = Number(execFileSync('git', ['show', '-s', '--format=%ct', raw.cut.commitSha], { cwd: task.repo, encoding: 'utf8' }).trim()) * 1000;
  const after = repositorySnapshot({ ...task, startCommit: raw.cut.commitSha, cut: { ...task.cut, startTs: oracleTs + 1 } }, output);
  const run = (root: string) => task.checks.map(check => ({ name: check.name, ...codingCall(root, 'bash', { name: check.name }, task.checks) as { passed: boolean; exitCode: number | null; stdout: string; stderr: string } }));
  const baseline = run(before.root), oracle = run(after.root);
  results.push({ task: task.id, beforeCommit: before.commit, oracleCommit: after.commit, baselineWorkspace: before.root, oracleWorkspace: after.root, baseline, oracle, discriminatesKnownFix: baseline.some(check => !check.passed) && oracle.every(check => check.passed) });
}
writeFileSync(resultPath, JSON.stringify({ synthetic: manifest.synthetic, modelCalled: false, purpose: 'acceptance-oracle validation, not memory effectiveness', results }, null, 2), 'utf8');
console.log(JSON.stringify(results.map((r: any) => ({ task: r.task, baseline: r.baseline.map((c: any) => ({ name: c.name, passed: c.passed, exitCode: c.exitCode })), oracle: r.oracle.map((c: any) => ({ name: c.name, passed: c.passed, exitCode: c.exitCode })), discriminatesKnownFix: r.discriminatesKnownFix })), null, 2));
if (results.some((r: any) => !r.discriminatesKnownFix)) process.exitCode = 1;
