# tasklog

按任务分段的事件日志，作为 coding agent 的记忆层。**写入侧零 LLM 调用。**

不存摘要、不存提炼出来的"记忆条目"。存的是 agent 实际做过的事：
每一次工具调用、每一个返回、每一条报错，按任务切分，用符号倒排建索引，
通过五个 MCP 工具开放给 agent 按需查询。

设计文档：`../design/agent-memory-design.md`

---

## 为什么不压缩

**显著性是查询条件化的。** 写入时的模型无法预知未来会被问什么，只能按通用显著性压缩；
而实际查询往往要的正是当时看起来不重要的细节。这是结构性的，换更强的模型解决不了。

**压缩的罪不在压缩，在压缩后删原件。** 判据只有一条：这个加工件错了，原始信息还找得回来吗。
所以摘要只允许做导航（决定读不读），不允许做替代。本项目里超过 4KB 的工具输出会落盘，
事件里只留机械截断的摘要行加一个 blob 句柄 —— 原件一个字节都没少。

**"现在是什么"问世界，"为什么是这样"问日志。** 代码和 git 才是现势的权威来源。
用日志推演当前状态，是用不权威的副本对抗权威的原件，而时间戳会让这种错误显得更自信。
日志不可替代的是另一半：失败的尝试、被否决的方案、某个坑的成因 —— 这些世界上不留痕迹。

---

## 快速开始

```bash
npm install          # node_modules 不入工作区快照，换机器要重装
npm run demo         # 造一个真实 git 仓库（含一次 revert）+ 对应事件日志
npm test             # 50 项：符号抽取 + 查询层 + 真实 MCP client 端到端

npx tsx test/reliability.ts       # 36 项：跨会话 / 长任务 / 重分段 / 幂等
npx tsx test/migration.ts         # 12 项：v1 迁移不丢数据
npx tsx test/adapter-opencode.ts  # 38 项：OpenCode 适配器解析
npx tsx test/eval-split.ts        # 54 项：时间切分 / 防泄漏 / 短查询 / 超大事件打包
npm run test:devin               # 34 项日志格式 + 38 项宿主后端、启动烟测、进度与脱敏机制
```

> **demo 数据是手写剧本，不是真实 agent 轨迹。** git 仓库是真的，34 条事件是编的。
> 它能说明接口怎么用，不能说明这套东西有用。

然后查：

```bash
export TASKLOG_DB=$PWD/demo-repo/.tasklog/log.db

npx tsx src/cli.ts tasks                              # 目录
npx tsx src/cli.ts search "config/server.yaml"        # 点查
npx tsx src/cli.ts sym src/auth/middleware.ts         # 符号历史
npx tsx src/cli.ts resume 5                           # 状态重建
npx tsx src/cli.ts read --task 5 --from 25 --to 30    # 分页读原文
npx tsx src/cli.ts health                             # 遥测
```

### demo 里那个关键场景

端口 `8080 → 9090 → revert 回 8080`。revert commit 被解析成一条 `supersedes` 边，
零 LLM。检索**默认两段都给**，但已作废的那段强制带标注：

```
$ npx tsx src/cli.ts search "server.yaml 端口"
[3.0] task#3 [SUPERSEDED by #4]  assistant: 已改 config/server.yaml，端口现在是 9090。
[3.0] task#4 [current]           assistant: 已回滚，config/server.yaml 的 port 恢复为 8080。
```

早先的版本是"默认隐藏已作废的那段"。那是错的：被 revert 的那段恰恰存着
"当初为什么改成 9090、后来为什么退回"。要防的不是看见旧结论，
是把旧结论当成现状 —— 那该用标注解决，不该用隐藏解决。
只想要仍然成立的内容时加 `--only-current`。

---

## 导入真实日志（OpenCode / Devin）

```bash
npx tsx scripts/preflight.ts --host-db ~/.local/share/opencode/opencode.db --repo /path/to/proj
# 一键体检：导入 + 同步 git + 判断这份日志够不够支撑三臂评估 + 列出 pilot 候选

npx tsx src/cli.ts where                    # 能不能自动找到宿主的库
npx tsx src/cli.ts import opencode --this-repo
npx tsx src/cli.ts sync                     # 同步 git + 重建任务划分
npx tsx src/cli.ts import opencode --incremental   # 之后反复跑这条
npx tsx src/cli.ts import devin --project /path/to/workspace --until EPOCH_MS
npx tsx scripts/preflight.ts --source devin --project /path/to/workspace --repo /path/to/workspace/repo --until EPOCH_MS
```

Devin 的 `sessions.working_directory` 可以是仓库的父工作区，故 `--project`（会话过滤）与 `--repo`（git 来源）分开。适配器在只读事务中复制选定会话的原始节点、工具旁表与子分支 heads 到 `.tasklog/sources/`，不 checkpoint、不更改宿主库；`--source-snapshot PATH` 可让 preflight 复用已冻结的源。节点原件包括压缩摘要、重复副本和未知角色；检索事件按消息组件来源键与内容 hash 去重，不将系统前缀或宿主摘要提升为原始交互证据。时间取 `message.metadata.created_at`，改文版本用保存时间作保守上界；严格截止排除无原始时间节点。增量重扫稳定来源键，覆盖旧时间回补与同毫秒新增记录，不依赖时间水位。

- **支持两种布局**：1.17+ 的 `opencode.db`（SQLite），以及更早的 `storage/` JSON 树。
- **导入前最好退出 OpenCode。** live 库的 `-wal` 里未 checkpoint 的部分，
  在普通只读打不开、退回 `immutable=1` 时会读不到。适配器检测到这种情况会警告，
  不会假装读全了。要彻底干净：`sqlite3 opencode.db "PRAGMA wal_checkpoint(TRUNCATE);"`
- **幂等靠宿主的 part id**，不靠我们算出来的 `seq`。反复导入不会产生副本。
- **原始记录与推断元数据分开**：`source_ref` 里存宿主的 session / message / part id、
  宿主自己的时间戳、模型标识；我们猜的东西（seq、kind 映射、outcome 判定依据、git 信息）
  全部放在 `source_ref.inferred` 下面。
- **宿主没给工具状态时 `outcome` 留 null**，不默认当成功。

> OpenCode 的 schema 是内部的、不保证稳定。适配器对所有 JSON 字段做防御式解析，
> 遇到不认识的 part 类型会原样存下来并在导入报告里列出 —— 这只能做到"不丢"，
> 做不到"读懂"。用它的时候请钉死 OpenCode 版本。

---

## 五个工具

| 工具 | 回答什么 | 关键性质 |
|---|---|---|
| `list_tasks` | 不知道从哪下手 | 目录。没有它 agent 第一次查询只能瞎猜关键词 |
| `search_history` | 「为什么当初这样决策」 | 事件级精确命中 + **带出所属任务**，其余由 agent 按需补全 |
| `symbol_history` | 「这个文件/函数以前出过什么事」 | 纯倒排。`get_user_id` 与 `get_user_ids` 是两个 key，不会混 |
| `resume_task` | 「继续做上次那个任务」 | 给完整性而非相关性：骨架 + 尾部原文 + **未闭合项** |
| `read_events` | 展开某一段 | 分页。一次只取一段，不把整个任务灌进上下文 |

辅助：`read_blob`（取回被截断的原文）、`index_health`（遥测）。

`resume_task` 刻意不做成 `search` 的一种用法：状态重建要的是完整性，
用 top-k 去恢复状态会恢复出一个有洞的心智模型，而 agent 不会察觉有洞。
它检出三类未闭合项：报错后没有"同一件事"成功重做的、悬挂的工具调用、TODO。

"同一件事"用调用签名判定而不是只看工具名 ——
`npm test` 失败之后 `npm run build` 成功，不代表测试的问题解决了。

---

## 接入 MCP 客户端

```json
{
  "mcpServers": {
    "tasklog": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/tasklog/src/mcp/server.ts"],
      "env": {
        "TASKLOG_REPO": "/absolute/path/to/your/project",
        "TASKLOG_DB": "/absolute/path/to/your/project/.tasklog/log.db"
      }
    }
  }
}
```

server 的 `instructions` 里写明了什么时候该查日志、什么时候该直接读代码 ——
工具描述是 agent 决策时唯一能看到的东西，所以它承担了路由职责。

---

## 数据模型

```
events   ── 最细粒度是事件，不是对话
             (session_id, seq) 唯一；tool_call 与 tool_result 分两行用 call_id 配对
             >4KB 的内容落 blob，text 只留机械摘要行
   │
   ├─ task_id ──► tasks        标题优先取 commit message
   │               task_edges  parent / continues / supersedes
   │
   ├─────────► symbols         path | ident | errcode | sha | test
   │                           零 LLM 正则抽取，日志与代码的 join key
   └─────────► events_fts      trigram，中英文子串兜底
```

**写入路径全程无模型调用：** insert → 正则抽符号 → FTS 触发器 → 大结果落盘。
任务划分是异步批处理：扫 git log，按 commit 时间切段，revert 建 supersedes 边。

边界来源记在 `tasks.boundary_src`（`git` / `heuristic` / `user`）。
保留它是因为**边界允许事后修订** —— 原文是事实，边界只是索引，索引错了可以重建。
这是本方案相对压缩方案的核心退路：压缩件错了没有退路。

---

## 现状

**322 项机制与集成检查通过（Windows）**，`tsc --noEmit` 零错误。模型和 embedding 集成测试使用本地 fixture 服务，不是真实前沿模型效果评测。

- `test/run.ts`：50；符号、查询与真实 MCP client。
- `test/reliability.ts`：36；跨会话、稳定身份、长尾、blob 与 UTF-8。
- `test/migration.ts`：12；旧 schema 数据保全。
- `test/adapter-opencode.ts`：38；两种布局、幂等与增量。
- `test/adapter-devin.ts`：34；实际节点形状、WAL 快照、压缩副本、改文、分支与严格截止。
- `test/model-devin.ts`：38；宿主进程→MCP→代码→独立验收、原始回执、预算与脱敏副本、启动烟测、安全诊断、进度与模型目录校验。
- `test/eval-split.ts`：54；时间隔离、完整原文、短查询、超大事件打包。
- `test/pilot-runner.ts`：43；API/OpenCode 后端、三臂、验收与遥测。
- `test/vector.ts`：17；分片向量、时间过滤与 MCP 回读。

> **测试全绿只证明实现行为符合预期，不证明这套记忆对 coding 任务有用。**
> 有效性要靠设计文档第 11 节的三臂对照。首个真实三臂（swe-2-max）已跑完：A/B′/C 全部 `checks_failed`，记忆臂未展示收益——结果表与污染核查见设计文档第 11 节。

### 本轮修掉的几个真 bug

1. `seq` 当全局序用 —— 跨会话分页同时漏和重。改 `(ts, id)` 游标。
2. 长任务的"尾部"其实是前 400 条的尾部，也就是任务中段。两次查询分开取。
3. `rebuildTasks` 开头 `DELETE FROM tasks` —— 抹掉人工修订，且让旧 `task_id` 含义漂移。
   改成按 `stable_key` upsert，退役的任务保留行并指向继任者。
4. `status = commit ? 'done' : ...` —— 把分段证据当完成事实。改为默认 `unknown` +
   `status_source` + 独立的 `boundary_evidence`。
5. `reindexSymbols` 只读截断后的 `text` —— 一次重建就让 blob 深处的符号永久失去索引。
6. 300 个 `module_N.ts` 占满符号配额，把稀有标识符挤出索引。改分类配额 + 模板族折叠。
7. 迁移脚本里 `ALTER TABLE tasks RENAME` 会重写外键指向，随后 `DROP` 触发
   `ON DELETE SET NULL`，**静默清空所有任务归属**。改用 SQLite 官方的表重建顺序。
8. 路径正则的前缀是 ASCII 白名单，`讨论：src/a/b.ts` 这种中文写法只抽到 `b.ts`,
   完整路径进不了索引。改成"任何不能构成路径的字符"。
9. `untilTs` 在不同接口一个是 `<` 一个是 `<=`。在防泄漏场景这直接变成漏判，全库统一为 `<`。
10. `searchHistory` 的 top-k 在时间过滤**之前**算 —— 未来事件先占名额，
    返回条数静默变少。改为把时间窗下压到候选生成阶段。
11. Windows 的 blob 引用使用反斜杠，读取与查询句柄只按 `/` 拆分，导致原文不可达与重建丢索引。新引用统一用 `/`，读取兼容两种分隔符。
12. 带时间水位的增量导入从 `seq=0` 重排，与已有事件冲突后静默跳过。改为从各会话已有的最大序号继续分配；适配器回归现在实际使用 `sinceTs`。
13. 双字中文查询没有 trigram，直接返回空。补完整分片的字面子串兜底，时间与任务过滤在候选上限之前。
14. B compact 遇到单条超窗原文就停止，真实历史仅装入 1 条。改为跳过放不下的事件并继续打包完整证据，丢弃量仍明确报告。
15. CLI 缺标准 usage 时总预算失效。补独立的未计量请求估算字段；原始回执单独保存，不把估算当实际用量。

### 还没做

1. **真实日志已接入**：Devin 的 12 个会话、32.1 天、23,424 条事件；原文/参数/时间与 2,191 个 blob 已逐条核对，实际 MCP 查询/展开/分页/范围读取通过。原始库保存在本地，评测另用脱敏副本。
2. **真实前沿模型效果对跑仍未执行**：用户指定 `swe-2-max`；用户 CMD 已返回 `Logged in (via Devin)`，但工具进程的模型列表仍返回 `Not logged in`，实际协议烟测超时，未取得可核验响应；认证/代理环境与 IDE 标记对照未解决，原因仍未确认。记录见 `.tasklog/devin-provider-check.json`；不能把超时直接归因为登录。已备一个真实历史任务的测量子任务 manifest 与独立验收：旧 commit 两项失败，已知修复 commit 两项通过；这仅验证验收区分力，不是记忆收益。
3. **部署时的 embedding 接入** —— HTTP provider、分片存储、混合检索与 MCP 已实现，实际使用需显式配置 embedding 服务并建索引。
4. **更强的新鲜度证据** —— 验证门支持路径、文本与内容 hash；没有历史内容 hash 时只报告未知，不能靠解压后的 mtime 推断陈旧。

### 已知限制

- 符号模板族折叠仍不保证每个中间成员都有倒排键。完整原文现已进入 `event_chunks/chunks_fts`；向量进入 `vector_chunks`。两种命中都给字节区间，可直接回读深处原文。旧库运行 `reindex` 补建全文分片；向量索引需单独构建。
- 任务边界在没有 git 的项目里只能靠时间 gap，质量会明显下降。
- 符号抽取是正则，漏抽等于那条事件在主索引里不存在 —— 用 `index_health` 的
  `unindexed_rate` 盯着，改了正则跑 `cli.ts reindex` 重建。
- `supersedes` 目前只从 revert 推断。"后续 commit 改了同一处"是更弱的信号，暂未启用。
- 落盘原文取回仍需一次工具调用，不是零成本 —— 原件不删解决的是不可恢复损失，
  不是取回成本。
- OpenCode CLI JSON 不暴露供应商响应模型身份，记录请求模型但不虚称响应已核验；此后端报告 `comparable=false`。正式同版本结论优先使用能回报响应模型的 API 后端。

## 三臂执行入口

在 tasklog 目录运行 `npm run test:all`。实际任务运行：

```bash
npm run pilot -- --manifest .devin/pilot.json --dry-run
npm run pilot -- --manifest .devin/pilot.json
npx tsx src/cli.ts vectors --db /absolute/path/to/history.db --limit 1000
```

manifest 是任务数据与运行配置，不含密钥：`synthetic`、`db`、新的 `outputDir`、`modelContextWindow`、`maxSteps`、`maxTotalTokens`、`budget`、`tasks`。预算含 `maxContextTokens`、`warmupRounds`、`queriesPerRound`、`bytesPerQuery`。每个任务含 `id/repo/startCommit/prompt/cut`，以及独立 `checks`；`cut` 是 `taskKey/startTs/endTs`，命令是 `{name, argv, timeoutMs?}`。可声明相同的 `prepare` 和 `commands`，验收命令不发送给模型。可选 `modelCatalog` 指向宿主导出的 JSON，按 `families[].variants[].model_uid/max_context_tokens` 核对所选模型与窗口。路径相对 manifest，输出目录已有结果时拒绝覆盖。

- `backend=api`：环境变量 `TASKLOG_API_BASE/TASKLOG_API_KEY/TASKLOG_MODEL`；兼容 Chat Completions 的服务，支持原生工具调用。推理档位用 `TASKLOG_REASONING_EFFORT`。
- `backend=opencode`：`model` 填明确的 `provider/model`，复用宿主配置，不读取或展示凭据。CLI 仅做文本模型后端，原生工具被禁用，实际工具由同一执行器执行；辅助模型也固定为所选模型。
- `backend=devin`：`model` 是明确的宿主模型 ID；每次请求在临时目录新建会话，禁用配置导入与子 agent、拒绝原生文件/命令/MCP 工具，并审计是否出现原生调用。决策由同一执行器执行。响应身份取原始 `generation_model`，原始 token/计费维度保存到 `usageReceipts`；input/cache 重叠未确认时 `usage=null`，预算估算记入 `estimatedUnmeteredTokens`，不得冒充实耗。使用前登录独立 CLI，不复制 IDE 凭据。
- 向量：`TASKLOG_EMBEDDING_MODEL/TASKLOG_EMBEDDING_API_BASE/TASKLOG_EMBEDDING_API_KEY`。后两项可回退到 API 后端变量，不配置就只走符号与全文，不伪装已有向量服务。

本机真实数据入口：`.devin/pilot-devin.json`，用户指定 `backend=devin`、`model=swe-2-max`，不自行换模型。它只重跑历史任务中的探针时序子任务，不涵盖整轮开发，也不是预注册的有效性基准。用户 CMD 导出的 `devin-model-catalog-01.json` 声明 SWE-2 Max 窗口为 262,000 tokens、输出上限为 128,000；配置已对齐 262K，并在 CLI 启动时与该目录核对。这是宿主能力声明，不是独立测得的容量，也不是 1M。切点前历史约 9.52M tokens（估算），当前干跑 B 明确为 B′ compact，不伪称全量长上下文。

```bash
npx tsx scripts/audit-devin.ts --db .tasklog/devin-history.db --view .tasklog/devin-eval/history.db --until 1791785560780 --probe-cut 1791129554973
npx tsx scripts/prepare-history.ts --db SOURCE_DB --output NEW_VIEW_DB --until EPOCH_MS
npx tsx scripts/validate-pilot.ts --manifest .devin/pilot-devin.json --output NEW_VALIDATION_DIR
npm run pilot -- --manifest .devin/pilot-devin.json --dry-run
npm run pilot -- --manifest .devin/pilot-devin.json --provider-smoke-only
npm run pilot -- --manifest .devin/pilot-devin.json
```

真实 Devin 运行自动先调用 `checkDevinProvider`：不发送历史，只检查文本协议及明确的响应模型；成功才开始三臂。烟测成功/失败均保存新的 `provider-check-*.json`，烟测不是任务成绩。`--provider-smoke-only` 不执行三臂。运行打印每臂开始/结束、请求开始/返回、工具结束的元数据进度，不输出消息或参数；CLI 错误只保留诊断类别，不转储原始 stdout/stderr。用户 CMD 已能导出模型目录，工具执行上下文认证仍失败时，从该 CMD 启动上述实际运行命令，不复制凭据。

`prepare-history` 不改原件，创建带原事件 locator/hash/替换数的评测副本，重建索引；本地副本替换了 12 条记录中的 15 处凭据疑似模式。检测是启发式，不保证识别所有秘密；执行器对输入及工具输出再次拦截命中模式，原库与 `sources/` 不应上传。

A/B/C 都从同一个切点前 commit 用 `git archive` 得到独立目录，不带 Git 历史。C-model 通过真实 MCP 工具读取切点前快照，可主动补读、提前结束预热和批量 `verify_claims`。命令仅运行 manifest 预声明的 argv，不接受模型生成的任意 shell。运行报告保存完整工具回合、实际 token 回执、耗时、独立验收结果和补读出处；不把 API 凭据或查询记录写入原始历史。
