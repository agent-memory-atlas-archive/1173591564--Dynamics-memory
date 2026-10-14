/**
 * 符号抽取。零 LLM，纯正则（标识符可选接 tree-sitter，暂未接）。
 *
 * 这是整个系统的主索引路径。设计依据（design/agent-memory-design.md 3.3）：
 * 一个事件的可检索内容不是它那句自然语言，而是它碰过哪些东西。
 *
 * 在 coding 场景，向量是兜底而非主路 —— `get_user_id` 与 `get_user_ids`
 * 的 embedding 几乎重合但指不同的东西，而倒排里它们是两个 key。
 */

import type { ExtractedSymbol, SymbolKind } from '../types.ts';

/**
 * 每类符号的配额，而不是一个全局上限。
 *
 * 为什么不用全局上限 + 按类型排序截断：一次 build 输出里有几百个
 * `module_N.ts`，会把配额全部占满，于是只出现在输出尾部的稀有标识符
 * 被整体挤掉 —— 那恰恰是检索时最有判别力的东西。
 * 分类配额让高频路径撑爆 path 桶时，ident 桶仍然留得住。
 */
const QUOTA: Record<SymbolKind, number> = {
  path: 120,
  ident: 160,
  errcode: 60,
  test: 60,
  sha: 40,
};
const MAX_SYMBOLS_PER_EVENT = 440;

const CODE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|kts|scala|sql|sh|bash|zsh|fish|ps1|yaml|yml|toml|ini|cfg|conf|env|json|jsonc|md|mdx|txt|lock|gradle|make|mk|proto|graphql|gql|vue|svelte|astro|css|scss|less|html|xml|csv|tsv';

/**
 * 路径：含目录分隔符，或带已知代码扩展名的裸文件名。
 *
 * 前缀用"任何不能构成路径的字符"而不是 ASCII 白名单。
 * 白名单版本漏掉了全角标点 —— 中文语境里 `讨论：src/a/b.ts` 这种写法极常见，
 * 结果只抽到 `b.ts`，完整路径进不了索引，跨任务的文件级串联就断了。
 */
const RE_PATH_WITH_DIR = new RegExp(
  String.raw`(?:^|[^\w./@-])((?:\.{0,2}/)?(?:[\w.@-]+/){1,}[\w.@-]+(?:\.(?:${CODE_EXT}))?)`,
  'gi',
);
const RE_PATH_BARE = new RegExp(String.raw`\b([\w.@-]+\.(?:${CODE_EXT}))\b`, 'gi');

/** commit sha：7-40 位十六进制，且必须含至少一个字母（排除纯数字串） */
const RE_SHA = /\b(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})\b/g;

/** 错误/异常 */
const RE_ERR_CLASS = /\b([A-Z][A-Za-z0-9]*(?:Error|Exception|Warning|Fault|Panic))\b/g;
const RE_ERR_ERRNO = /\b(E[A-Z]{3,12})\b/g;
const RE_ERR_HTTP = /\b(?:HTTP[\s/]?\d?\.?\d?\s*)?\b([45]\d{2})\b(?=\s|$|[,.;:)\]}"'：，。；])/g;
const RE_ERR_CODE = /\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+){1,})\b/g;

/** 测试 */
const RE_TEST_PY = /\b(test_[a-z0-9_]{2,})\b/gi;
const RE_TEST_FILE = new RegExp(String.raw`\b([\w.-]+\.(?:test|spec)\.(?:${CODE_EXT}))\b`, 'gi');
const RE_TEST_BLOCK = /\b(?:it|test|describe)\(\s*['"`]([^'"`\n]{3,80})['"`]/g;

/** 标识符：只抽有代码特征的形态 */
const RE_BACKTICK = /`([^`\n]{2,80})`/g;
const RE_CAMEL = /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g;
const RE_SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const RE_PASCAL = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g;
const RE_CALL = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g;
const RE_DOTTED = /\b([a-z][A-Za-z0-9_]*(?:\.[a-z_][A-Za-z0-9_]*){1,3})\b/g;

/** 语言关键字与高频噪音词，不作为 ident 索引 */
const STOP = new Set([
  'if','for','while','return','function','const','let','var','class','import','export','from',
  'async','await','try','catch','finally','throw','new','this','null','true','false','void',
  'type','interface','extends','implements','public','private','protected','static','super',
  'string','number','boolean','object','array','undefined','symbol','bigint','never','unknown',
  'and','not','def','elif','else','pass','raise','with','yield','lambda','print','self','none',
  'func','struct','impl','trait','pub','mut','use','mod','match','where','defer','range','map',
  'int','float','bool','char','byte','long','short','double','list','dict','set','tuple',
  'then','when','end','begin','do','done','echo','exit','case','esac','fi','in','is','as','of',
  'console','log','warn','info','debug','trace','assert','expect','should','test','it','describe',
  'the','and','but','that','this','with','have','has','was','were','are','you','your','can',
  'get','set','add','put','run','call','main','init','data','value','name','key','item','args',
  'http','https','www','com','org','net','json','html','text','file','path','dir','src','lib',
]);

/**
 * 模板族折叠。
 *
 * 一次 build 输出里的 module_0 … module_299 是机器生成的序列，判别力极低，
 * 却能把整个配额吃干净，把真正稀有的符号挤出索引。
 * 把数字串归一成 # 得到族签名，同族只留首尾若干个代表。
 *
 * 代价是明确的：被折叠掉的中间成员（如 module_150）失去符号索引。
 * 原文仍在 blob 里、可用 read_blob 取回，但符号通道指不到它。
 * 这是用"少数模板化符号不可直接命中"换"稀有符号不被淹没"，
 * 不是无损操作 —— 见 design 第 12.5 节的已知缺口。
 */
const FAMILY_TRIGGER = 8;
const FAMILY_KEEP = 3;

function familyKey(sym: string, kind: SymbolKind): string {
  return `${kind}\u0000${sym.replace(/\d+/g, '#')}`;
}

export function foldFamilies(items: ExtractedSymbol[]): ExtractedSymbol[] {
  const fams = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = familyKey(it.sym, it.kind);
    if (!fams.has(k)) fams.set(k, []);
    fams.get(k)!.push(i);
  });
  const drop = new Set<number>();
  for (const idxs of fams.values()) {
    if (idxs.length < FAMILY_TRIGGER) continue;
    const keep = new Set([...idxs.slice(0, FAMILY_KEEP), ...idxs.slice(-FAMILY_KEEP)]);
    for (const i of idxs) if (!keep.has(i)) drop.add(i);
  }
  return items.filter((_, i) => !drop.has(i));
}

/** 分类配额截断：每个桶独立计数，高频路径不会挤掉稀有标识符。 */
function applyQuota(items: ExtractedSymbol[]): ExtractedSymbol[] {
  const used: Record<SymbolKind, number> = { path: 0, ident: 0, errcode: 0, test: 0, sha: 0 };
  const out: ExtractedSymbol[] = [];
  for (const it of items) {
    if (used[it.kind] >= QUOTA[it.kind]) continue;
    if (out.length >= MAX_SYMBOLS_PER_EVENT) break;
    used[it.kind]++;
    out.push(it);
  }
  return out;
}

function normalizeIdent(raw: string): string | null {
  const s = raw.trim().replace(/^[.,;:'"`([{<]+|[.,;:'"`)\]}>]+$/g, '');
  if (s.length < 3 || s.length > 80) return null;
  if (!/[A-Za-z_]/.test(s)) return null;
  if (/^\d+$/.test(s)) return null;
  if (STOP.has(s.toLowerCase())) return null;
  // 单个全小写词且无下划线/驼峰 —— 判为自然语言，不索引
  if (/^[a-z]+$/.test(s)) return null;
  return s;
}

function normalizePath(raw: string): string | null {
  let s = raw.trim().replace(/^[("'`<\[]+|[)"'`>\],.;:]+$/g, '');
  s = s.replace(/^\.\//, '');
  if (s.length < 3 || s.length > 200) return null;
  if (/^https?:\/\//i.test(raw)) return null; // URL 不当路径
  if (!/[A-Za-z]/.test(s)) return null;
  return s;
}

function collect(
  out: Map<string, SymbolKind>,
  re: RegExp,
  kind: SymbolKind,
  text: string,
  normalize: (s: string) => string | null,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 4000) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const captured = m[1];
    if (!captured) continue;
    const v = normalize(captured);
    if (!v) continue;
    const key = `${kind}\u0000${v}`;
    if (!out.has(key)) out.set(key, kind);
  }
}

export interface ExtractInput {
  text?: string | null;
  argsJson?: string | null;
  toolName?: string | null;
}

/**
 * 从一个事件抽取符号集合。
 * 顺序有意义：先抽 path（路径里含标识符片段），其结果用于后续去重。
 */
export function extractSymbols(input: ExtractInput): ExtractedSymbol[] {
  const parts: string[] = [];
  if (input.text) parts.push(input.text);
  if (input.argsJson) parts.push(input.argsJson);
  const body = parts.join('\n');
  if (!body.trim()) return [];

  const found = new Map<string, SymbolKind>();

  // 1) 路径
  collect(found, RE_PATH_WITH_DIR, 'path', body, normalizePath);
  collect(found, RE_PATH_BARE, 'path', body, normalizePath);
  const paths = new Set(
    [...found.keys()].filter((k) => k.startsWith('path\u0000')).map((k) => k.split('\u0000')[1]!),
  );
  const pathSegments = new Set<string>();
  for (const p of paths) for (const seg of p.split(/[/\\]/)) if (seg) pathSegments.add(seg);

  // 2) 测试
  collect(found, RE_TEST_FILE, 'test', body, (s) => normalizePath(s));
  collect(found, RE_TEST_PY, 'test', body, (s) => (s.length >= 6 ? s : null));
  collect(found, RE_TEST_BLOCK, 'test', body, (s) => (s.trim().length >= 3 ? s.trim() : null));

  // 3) 错误码
  collect(found, RE_ERR_CLASS, 'errcode', body, (s) => s);
  collect(found, RE_ERR_ERRNO, 'errcode', body, (s) => s);
  collect(found, RE_ERR_HTTP, 'errcode', body, (s) => s);
  collect(found, RE_ERR_CODE, 'errcode', body, (s) => (s.length >= 5 ? s : null));

  // 4) commit sha
  collect(found, RE_SHA, 'sha', body, (s) => {
    // 避免把十六进制颜色、长数字、路径片段当 sha
    if (pathSegments.has(s)) return null;
    return s.toLowerCase();
  });

  // 5) 标识符
  const identNorm = (s: string): string | null => {
    const v = normalizeIdent(s);
    if (!v) return null;
    if (pathSegments.has(v)) return null; // 已由 path 覆盖
    return v;
  };
  collect(found, RE_BACKTICK, 'ident', body, identNorm);
  collect(found, RE_CAMEL, 'ident', body, identNorm);
  collect(found, RE_SNAKE, 'ident', body, identNorm);
  collect(found, RE_PASCAL, 'ident', body, identNorm);
  collect(found, RE_CALL, 'ident', body, identNorm);
  collect(found, RE_DOTTED, 'ident', body, identNorm);

  // 工具名本身是一个可检索符号
  if (input.toolName) found.set(`ident\u0000${input.toolName}`, 'ident');

  const items = [...found.entries()].map(([key, kind]) => ({
    sym: key.split('\u0000')[1]!,
    kind,
  }));
  return applyQuota(foldFamilies(items));
}
