/**
 * git 扫描。coding 场景最大的一块免费午餐：
 * commit 是天然任务边界，commit message 就是任务描述，diff 就是结果，
 * revert 直接给出 supersedes 关系。
 *
 * 不需要 LLM 去推断任务边界。
 */

import { execFileSync } from 'node:child_process';
import type { DB } from '../db/open.ts';
import type { GitCommit } from '../types.ts';

const FS = '\u001f'; // 字段分隔
const RS = '\u001e'; // 记录分隔

export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

export function currentBranch(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function readCommits(cwd: string, limit = 2000): GitCommit[] {
  if (!isGitRepo(cwd)) return [];
  let raw: string;
  try {
    raw = execFileSync(
      'git',
      [
        'log',
        `--max-count=${limit}`,
        '--date-order',
        `--pretty=format:${FS}%H${FS}%ct${FS}%an${FS}%s${FS}%b${FS}%D${RS}`,
        '--name-only',
      ],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return [];
  }

  const out: GitCommit[] = [];
  for (const chunk of raw.split(RS)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(FS);
    // parts[0] 是上一条记录遗留的文件列表（或空）
    if (parts.length < 7) continue;
    const [, sha, ts, author, subject, body, tailAndRefs] = parts as [
      string, string, string, string, string, string, string,
    ];
    // tailAndRefs = "<refnames>\n<file>\n<file>..."
    const tl = tailAndRefs.split('\n');
    const refs = (tl.shift() ?? '').trim();
    const files = tl.map((s) => s.trim()).filter(Boolean);

    out.push({
      sha,
      ts: Number(ts) * 1000,
      author,
      subject,
      body,
      branch: parseBranch(refs),
      files,
      revertsSha: parseRevert(subject, body),
    });
  }
  return out;
}

function parseBranch(refs: string): string | null {
  if (!refs) return null;
  const m = refs.match(/HEAD -> ([^,]+)/) ?? refs.match(/^([^,(]+)/);
  return m?.[1]?.trim() ?? null;
}

/** Revert 检测：message 形态 + "This reverts commit <sha>" */
function parseRevert(subject: string, body: string): string | null {
  const m = body.match(/This reverts commit ([0-9a-f]{7,40})/i);
  if (m?.[1]) return m[1].toLowerCase();
  if (/^revert[\s:"']/i.test(subject)) return 'unknown';
  return null;
}

export function syncCommits(db: DB, cwd: string, limit = 2000): number {
  const commits = readCommits(cwd, limit);
  if (commits.length === 0) return 0;
  const ins = db.prepare(/* sql */ `
    INSERT INTO commits (sha, ts, author, subject, body, branch, files_json, reverts_sha)
    VALUES (@sha, @ts, @author, @subject, @body, @branch, @files_json, @reverts_sha)
    ON CONFLICT(sha) DO UPDATE SET
      ts=excluded.ts, author=excluded.author, subject=excluded.subject,
      body=excluded.body, branch=excluded.branch, files_json=excluded.files_json,
      reverts_sha=excluded.reverts_sha
  `);
  const tx = db.transaction((list: GitCommit[]) => {
    for (const c of list) {
      ins.run({
        sha: c.sha,
        ts: c.ts,
        author: c.author,
        subject: c.subject,
        body: c.body,
        branch: c.branch,
        files_json: JSON.stringify(c.files),
        reverts_sha: c.revertsSha,
      });
    }
  });
  tx(commits);
  return commits.length;
}
