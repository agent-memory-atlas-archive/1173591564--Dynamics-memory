# agent-memory 设计文档（coding 场景）

状态：原文存储、分片全文/向量、切点快照、C-model 工具循环、三臂执行器和具体断言验证门已实现；Windows 下 322 项机制/集成检查通过。
HTTP、OpenCode 与 Devin 宿主模型后端均已有入口，不读取或复制宿主密钥；Devin 实际模型调用仍受独立 CLI 登录阻断。
**真实前沿模型 + 真实历史的效果对跑尚未进行**；fixture 端到端只证明执行链路，不证明记忆收益。
标注约定沿用 `research/dm-code-read.md`：`[代码]` 实际源码事实（附文件名）、`[文档]` 项目文档声称、`[目标]` 尚未实现的目标态、`[自报]` 论文自己报告的数字。

**阅读本文档前必须知道的三件事：**
1. 到目前为止的所有验证都只证明**实现行为符合预期**，没有任何一条证明**记忆对 coding 任务有用**。
2. 已接入 Devin 的 **12 个真实会话、23,424 条去重事件**，并逐条核对原件；首个真实三臂（swe-2-max、单任务 n=1）已跑完，**该任务上记忆未展示收益**——结果与污染核查见第 11 节表。
3. 下面凡标 `[假设]` 的，是**尚未验证、不得作为实现依据硬编码**的命题。

---

## 0. 一句话

不在写入侧做任何 LLM 加工：把 agent 的完整事件日志按任务分段存下来，用符号倒排和 git 结构建索引，通过工具接口让 agent 在任务起点自己把心智模型读出来；压缩只允许发生在会话内，且不落盘。

---

## 1. 范围

**做：** coding agent 的跨会话记忆。单项目、单仓库、本地优先。

**不做：**
- 通用对话场景的记忆（单任务短、边界少、没有权威真值源，收益不足以覆盖复杂度）
- 跨项目的知识迁移
- 任何形式的持久化摘要

**场景限定带来的三项红利**，整个设计建立在这三条之上：
1. 世界是可寻址且权威的（文件系统、git、测试结果）
2. 任务边界大半是免费的（commit、分支切换、测试由红转绿）
3. 查询词**常常**是精确符号（函数名、路径、错误码），倒排在这类查询上是确定性的

   原先这条写的是"适合倒排远胜向量"。那是 `[假设]`，不是结论：它只在"用户说得出符号"
   时成立，而真实场景里大量查询是"不记得函数名，只记得当时讨论过什么意思"。
   因此倒排与向量是**互补的发现通道**，不是替代关系。见 3.6。

---

## 2. 核心主张

**2.1 显著性是查询条件化的，所以写入时的取舍必错。**
写入时的 LLM 无法预知未来会被问什么，只能按通用显著性压缩；而实际查询常常要的正是当时看起来不重要的细节。这是结构性的，换更强的模型解决不了。

**2.2 压缩的罪不在压缩，在压缩后删原件。**
判据：这个加工件错了，原始信息还找得回来吗。找得回来就安全。因此摘要只允许做导航（决定读不读），不允许做替代（替代原文被消费）。

**2.3 "现在是什么"问世界，"为什么是这样 / 试过什么没成"问日志。**
代码和 git 是现势的权威来源。用日志去推演当前状态，是用不权威的副本对抗权威的原件，且时间戳会让错误变得更自信。

**2.4 全量暴露不是上界。**
日志里平铺着大量失败尝试和被推翻的结论，没有作废标记。必须裁剪，但裁剪依据不能是"重要性"（那等于又做了一次合成），只能是机械规则（见第 8 节）。

---

## 3. 数据模型

设计原则：**没有 memory 表，没有 summary 表。** 全部是事实表加索引。

### 3.1 events — 最细粒度单元是事件，不是对话

```sql
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,          -- 产品侧会话（一次打开）
  seq        INTEGER NOT NULL,          -- 会话内单调序号
  ts         INTEGER NOT NULL,          -- epoch ms，最细粒度时间戳
  task_id    INTEGER,                   -- 后验归属，可为 NULL，可修订
  role       TEXT    NOT NULL,          -- user | assistant | tool | system
  kind       TEXT    NOT NULL,          -- text | tool_call | tool_result | error
  tool_name  TEXT,
  call_id    TEXT,                      -- tool_result 借此指回 tool_call
  args_json  TEXT,                      -- tool_call 的参数（完整）
  text       TEXT,                      -- 文本内容；大结果只存摘要行
  blob_ref   TEXT,                      -- 大结果的落盘路径
  nbytes     INTEGER,                   -- 原始结果字节数
  outcome    TEXT,                      -- ok | error | NULL
  UNIQUE(session_id, seq)
);
```

要点：

- **tool_call 与 tool_result 分两行**（时间不同，各自可检索），用 `call_id` 配对。
- **大结果不进 `text`**。读了一个 5000 行文件，`text` 只存摘要行（路径、行数、前若干行），原文落 `blob_ref`。否则 FTS 索引会被单次文件读淹没。
- `role='tool'` 的行是现在 Dynamics-memory 完全没有的东西，见第 10 节。

### 3.2 tasks — 存储与检索的一等单元

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT,                      -- 优先取 commit message
  started_ts INTEGER NOT NULL,
  ended_ts   INTEGER,
  status     TEXT NOT NULL,             -- open | done | abandoned
  branch     TEXT,
  commit_sha TEXT,                      -- git join 的锚点
  boundary_src TEXT NOT NULL            -- git | heuristic | user
);

CREATE TABLE task_edges (
  src INTEGER NOT NULL,
  dst INTEGER NOT NULL,
  rel TEXT NOT NULL,                    -- parent | continues | supersedes
  PRIMARY KEY (src, dst, rel)
);
```

`boundary_src` 必须保留，因为边界是推断出来的、允许事后修订。原文是事实，边界只是索引 —— 索引错了可以重建，这是本方案相对压缩方案的核心退路。

`supersedes` 边是 N53 那个病的解法（见第 10 节）：检索时自动排除被取代的任务。

### 3.3 symbols — coding 场景的主索引

```sql
CREATE TABLE symbols (
  sym      TEXT    NOT NULL,
  kind     TEXT    NOT NULL,            -- path | ident | errcode | sha | testname
  event_id INTEGER NOT NULL,
  PRIMARY KEY (sym, kind, event_id)
);
CREATE INDEX idx_symbols_event ON symbols(event_id);
```

抽取零 LLM：正则为主（路径、错误码、commit sha、测试名），标识符可选接 tree-sitter。
**这是日志与代码之间的确定性 join key。** 一个事件的可检索内容不是它那句自然语言，而是它碰过哪些东西。

### 3.4 FTS 与向量

```sql
CREATE VIRTUAL TABLE events_fts USING fts5(text, content='events', content_rowid='id');
```

---

### 3.5 三条发现通道是互补的，不是主备关系

初版把向量写成"降为兜底"。修订：**符号精确 / 全文 / 向量是三条并列的发现通道**，
各自覆盖对方覆盖不到的查询形态。

| 通道 | 覆盖的查询形态 | 覆盖不到的 |
|---|---|---|
| 符号倒排 | 说得出函数名、路径、错误码、测试名、sha | 说不出任何符号时完全失效 |
| FTS（trigram） | 记得原话里的片段、罕见词串 | 换了说法就命中不了 |
| 向量 | **只记得当时讨论的意思**，说不出任何字面 | 近义但不同一的符号会混（`get_user_id` / `get_user_ids`） |

把向量当兜底的隐含前提是"用户总说得出符号"。这个前提在 coding 场景经常不成立：
"上次我们讨论过为什么不用那个缓存方案" —— 这句话里没有一个可倒排的 key。
失去这类查询，等于把"为什么没这么做"整类历史变成不可达。

**但向量在本设计里的地位是受限的：** `[目标]`

> 向量索引是**可重建的寻址层，不是事实权威**。

具体约束，三条都要在实现里成立：
1. 向量只用来**产生候选事件 id**，不参与任何真值判断。返回的永远是事件原文与定位符。
2. 向量表可随时整表删除重建（换 embedding provider、换维度），重建不丢任何事实 ——
   `embeddings` 表只有 `event_id / provider / dim / vec / built_at`，没有文本副本。`[代码]` `src/db/schema.ts`
3. 向量命中必须和另两条通道的命中**合并后再排序**，不允许单通道独占返回位。
   单通道独占会让"向量召回的近义误配"直接冒充精确答案。

现状 `[代码]`：`embeddings` 表已建、`searchHistory` 已有符号 + FTS 双通道融合打分；
**向量通道本身尚未接入**（无 embedding provider）。这是本设计当前最大的未实现项。

---

## 4. 写入路径（零 LLM）

```
agent 运行时 → 事件落 events（同步，仅 insert）
            → 抽符号落 symbols（同步，正则）
            → FTS 自动更新
            → 大结果落 blob
（异步/批）  → git 扫描 → 划 tasks、回填 task_id、建 task_edges
```

全程不调用任何模型。没有抽取、没有去重、没有冲突消解、没有衰减。
这是"更方便"的实际含义：少掉的是写入管道、一致性维护、池容量管理，以及它们各自的 bug。

### 任务边界的来源，按可信度排序

1. git commit / 分支切换（`boundary_src='git'`，最可信）
2. 测试由红转绿、文件集合突变、长时间间隔（`heuristic`）
3. 用户显式说"好了 / 下一个"，或低置信时主动问一次（`user`）

不采用"每轮询问任务是否结束"：任务是嵌套的、会回溯的，且打断有成本。

---

## 5. 查询接口（MCP 工具面）

五个工具，语义边界互不重叠。**每个返回都必须带定位符**（`task_id` + `seq` 区间），否则 agent 只能整段灌。

| 工具 | 用途 | 关键返回 |
|---|---|---|
| `list_tasks(filter, limit)` | 目录。第一次查询的落脚点 | task 列表 + 标题 + 状态 + 时间 + 关联 commit |
| `search_history(query, symbols?, task_id?, k)` | 点查历史："为什么这样决策" | 命中事件 + **所属任务** + 定位符 |
| `symbol_history(sym, kind?, limit)` | 某符号的全部历史。纯倒排 | 按时间排序的事件行 |
| `resume_task(task_id)` | 状态重建："继续完成 XX" | 骨架 + 尾部原文 + 未闭合项 |
| `read_events(task_id, cursor, limit)` | 分页读原文 | 原始事件 + `next_cursor` |

另有两个辅助：`read_blob(blob, offset, max_bytes)` 取回落盘原文（带 `next_offset`）、
`index_health()` 看索引健康度。七个工具全部 `readOnlyHint`。`[代码]` `src/mcp/server.ts`

**跨会话约定（`[代码]`，与初版不同）：**
- 翻页用 `next_cursor` 原样回传，**不要用 `seq` 自己算**。`seq` 只在单个会话内唯一，
  任务横跨多会话时按 `seq` 翻页既会漏也会重。见 12.1。
- 被取代的内容默认返回并带 `currentValidity`；只想要仍然成立的内容才加 `only_current=true`。见第 8 节。
- 任务 `status` 多数是 `unknown`，除非 `status_source='user'`，否则不要当完成度读。见 12.4。

### 两个要点

**`search_history` 的返回形态就是两段式检索本身**：事件级精确命中（高精度小粒度），同时带出它所属的任务（粗粒度容器），任务内其他内容由 agent 自己用 `read_events` 按需补全。扩展依据是**任务归属**而非时间邻接 —— 任务是意图边界，邻接只是巧合。

**`resume_task` 不能退化成 `search` 的一种用法。** 状态重建要的是完整性和未闭合项，不是相关性；用 top-k 去恢复状态，会恢复出一个有洞的心智模型，而 agent 不会知道有洞。它返回三样：
- 时间线骨架（每个事件压成一行：做了什么、结果是什么）
- 尾部 N 步的原文
- 显式未闭合项（计划了没执行的、报错了没解决的、开了没关的 TODO）

---

## 6. 任务起点建模

```
任务开始
  → 第 1 轮：并行广撒 3–5 个查询（list_tasks + symbol_history + search_history）
  → 第 2 轮：按结果收窄，read_events 补全
  → 批量证伪（第 9 节）
  → 进入执行循环
```

**并行大概率省往返，但"K=2 并行等价于 K=5 串行"是 `[假设]`，没测过**，不得写进实现当硬编码的轮次上限。
串行只在"必须根据上一次结果决定下一次查什么"时才需要。

**K 与读取预算都要可配置**，并且允许两件事：提前停止（够了就不再读），
以及执行中继续查（预热不是唯一的查询时机）。
**不要求用户每轮确认任务是否结束，也不自动宣布任务完成。**

成本参考 `[自报]`：MemAgent（`2609.32521`）的 Begin 阶段开销约 370 tokens（中位 268，最大 2.2K），整任务注入约 1.2K tokens，占任务 token 的 <0.5%。

**必须有预算上限和停止条件。** agent 很容易过度阅读。
停止条件要显式告知 agent："你要建立的心智模型是为了回答什么。"

注意 `[自报]` 的 "32K 后显著衰减" 来自 `2602.22769` 的**合成子集**，
是单一实验里的观察，**不是所有前沿模型的统一失效阈值**，
不能拿它当预算上限的硬编码依据。预算该设多少，要在第 11 节里测。

---

## 7. 路由与交叉校验

不追求"查询分类分对"，追求"分错了能被廉价兜住"。

**廉价先验（零 LLM，看问句形态）：**
- 含"为什么 / 之前 / 怎么决定的" → 日志
- 含"现在 / 当前 / 有没有"且能定位到符号 → 读世界
- 含"继续 / 接着 / 上次" → `resume_task`

**查询改写与是否继续读，由同一个前沿模型负责，不换小模型做路由。** `[目标]`
理由：判断"刚读到的这段够不够回答我的问题"需要的正是任务本身的理解力，
换个小模型路由会在最需要判断力的地方降配。代价是每轮预热都花主模型的 token，
这笔开销必须进评估账（第 11 节），不能藏。

**符号级回查（这才是关键）：** 走读世界得到答案后，拿那个文件路径或符号去 `symbol_history` 反查一次 —— 几毫秒的倒排查询。一致则收工；不一致则两边都端出、明确标注冲突。

**校验的 key 是符号不是语义**，所以是确定性的。冲突本身是高价值信号：它意味着心智模型有洞，静默选一边是最糟的处理。

---

## 8. 裁剪规则（机械，零 LLM）

**成功路径只给结果，失败路径给全过程。**
理由：成功路径的过程在代码里（代码就是它的产物），要细节直接读代码；失败路径在世界上不留痕迹，只有日志有 —— 那才是日志不可替代的部分。

**被 revert / 被 supersede 的内容默认照样返回，但强制带 `currentValidity` 标注。** `[代码]`
`src/query/index.ts` 的 `searchHistory` / `listTasks` / `symbolHistory` 默认 `onlyCurrent=false`。

这条推翻了本文档的初版主张（原文是"默认不出现在首次返回"）。推翻的理由：
被取代的那一段恰恰存着"当初为什么这么做、后来为什么推翻"，默认藏掉等于把最该读的一段删了。
真正要防的不是"看见旧结论"，是"把旧结论当成现状"——那应该用标注解决，不是用隐藏解决。
只有显式 `onlyCurrent=true` 时才排除，且 `symbolHistory` 会返回 `filteredOut` 条数，
让调用方知道自己看的不是全部。

依据 `[自报]`：`2607.08716` 报告 full-bank 全量暴露比其完整系统差 2.8 macro 点 ——
这支持"要裁剪"，不支持"按有效性隐藏"。裁剪的是**量**（第 8 节的成功/失败不对称），
不是**真值状态**。

---

## 9. 验证门

建模完成时，把心智模型里**所有可被世界证伪的断言**批量证伪一次。

例：模型认为"认证走 JWT，在 `auth/middleware.py`" → grep 验证。失败说明日志相对代码已过期，报给 agent，而不是让它带着错误前提开工。

零 LLM、一次性、可并行。
依据 `[自报]`：`2604.20874` Root Theorem 推论 —— 验证必须在被验证的信道之外进行。coding 场景白送一个外部验证器（代码库本身）。

---

## 10. 与 Dynamics-memory 的对照

以下均为 `[代码]`，来自 `research/dm-code-read.md` 的通读记录。

| 现状 | 本设计 |
|---|---|
| `store/schema.py::_DDL_LOG` 的 units 只有 `user_text`/`assistant_text` 两列文本，FTS 也只建这两列 | events 表含工具事件行；**没有任何能表示"agent 做了 X"的结构是当前最大的结构性障碍** |
| `transport/dto.py::observe_payload` 只有两个字符串；`memory-bridge.ts` 两处只收 `part.type==="text"` | 工具世界被过滤两次，必须打开 |
| `transport/bootstrap.py::build_default_service` 设 `lex_weight=0.0` | FTS 已建好却关着，coding 场景它该是主路。接近零成本 |
| `core/types.Memory` 的 `kind` 只有 `fact`/`reflection`，无 locator、无 TTL | 不需要 Memory 类型；事实表 + 定位符 |
| `service/recall.py` 每轮注入一次、在工具循环之前 | 改为任务起点一次 prefetch + 循环内按需查 |
| `core/dynamics.py` 衰减、`core/consolidation.py`、去重与张力 | 不存压缩件就不需要维护压缩件，整体不需要 |

**保留的部分**（与"存什么"无关，是真资产）：
- `agents/selector.py::authorized_change` 的授权链（只认用户原话）
- 人审水位、因果界
- `store/tasks.py` 的事务与回执

**项目自身的佐证：** `eval/BASELINE.md`（2026-09-27，mock LLM）记录三个消融 `decay_only`/`abl_no_dedup`/`abl_no_tension` 在 recall 与 ctx_eff 上同时高于完整版（完整版 0.792/0.691）；同文件记「助手答错的内容也会被蒸馏成记忆」。`eval/l2l3/REPORT.md` 的 N53 三链一致复现「旧值与新候选并排端出、已作废值继续服务」，原话「当前检索质量的主要敌人是内核不是模型」。

---

## 11. 评估计划（三臂对照）

**首个真实三臂已跑完**（`swe-2-max`，任务 `real-history-causal-probe-slice`，产物 `.tasklog/devin-pilot-01-{AB,B,C}`，n=1 单任务，非预注册基准）：

| 臂 | 结局 | 请求 | input tok | 时序检查 | 超时边界检查 |
|---|---|---|---|---|---|
| A 冷启 | checks_failed | 12 | 1.13M | ✅ | ❌ |
| B′ 长上下文（est 9.5M→49K，丢 18,620 事件） | checks_failed | 13 | 2.14M | ❌ | ❌ |
| C 记忆（20 次记忆查询，5 种工具） | checks_failed | 18 | 2.69M | ✅ | ❌ |

三臂 `servedModels` 全部核验为 `swe-2-max`；原生工具全部经 deny 拒绝（A 8 / B 20 / C 31 次尝试，零执行），wire 与会话库中 tool 角色内容零真实仓库路径，无 provider 压缩。**初步信号：此任务上记忆未展示收益**——C 与 A 同检查结局但多花 ~1.4× input 和 50% 请求；B′ 连时序检查都没过（历史基座被压缩到 49K 后信息太稀疏）。此前一次 deny 生效前的 B 跑过检查时曾读真实仓库（HEAD 含未来解），其 ✅ 不可信——印证遏制配置是有效性边界的一部分。单任务单样本，不能外推。

### 11.1 主问题

初版写的是"在 AMA-Bench 上逼近 AMA-Agent 的 57.22%"。**这个目标已被替换。**
替换理由：逼近某个基准分数不回答我们真正关心的问题，而 AMA-Bench 是别人的轨迹、别人的任务分布。

修订后的主问题：

> 同一个前沿模型、同一套推理设置、同一个仓库起始快照、同一组 coding 工具，
> 在**真实项目的跨任务跨会话使用**中，tasklog 主动查询相比长上下文直接投喂，
> 是否提高后续 coding 任务的成功率，并减少历史信息缺失与污染？

### 11.2 三条臂

| 臂 | 上下文来源 | 说明 |
|---|---|---|
| **A 冷启动** | 只有当前任务描述 + 仓库 | 下界参照。它不是"基线"，只是地板 |
| **B 长上下文** | 历史装得下就**完整**给 | 装不下时必须用滚动上下文或历史整理，**不允许以"基线不存在"为由退回只和 A 比** |
| **C tasklog** | 五个工具主动展开 | 有预算的 K 轮预热 + 执行中继续查 |

**关于 B 的两条硬规矩：**
1. **只有支持 1M 的模型才测真实 1M。** 模型实际窗口是多少就报多少，不得虚称。
2. 历史超窗口时，B 必须升级成"B′ 滚动上下文 / 历史整理"，而不是直接判 B 出局。
   拿一个被人为残废的 B 去赢，赢了也不说明问题。

`[假设]`（不得作为实现依据）：
- "长上下文必输"或"原文检索必胜" —— 两条都没验证过。
  `2602.22769` `[自报]` 的结论恰恰是长上下文基线**持续强势、经常最好**。
- "32K 之后衰减" —— 那是 `2602.22769` 合成子集上的单一观察，不是所有前沿模型的统一阈值。
- "两轮并行查询等价于五轮串行" —— 没测过。

### 11.3 五类 pilot 任务

| 类型 | 考什么 | 失败长什么样 |
|---|---|---|
| 1 继续被中断的任务 | 状态重建的完整性 | 漏掉未闭合项且不自知 |
| 2 避免重复失败方案 | 失败路径的可达性 | 又把上次踩过的坑踩一遍 |
| 3 遵守历史决策**及其后续修订** | supersedes 的正确使用 | 执行了已被推翻的旧决策 |
| 4 跨任务复用项目约定 | 隐式约定的发现 | 风格/接口与既有约定冲突 |
| 5 **历史无关的任务** | **污染检测** | 被无关历史带偏，比 A 还差 |

第 5 类是这组实验里唯一可能让 C **输**的设计，必须保留。
只测 1–4 等于只找自己赢的局。

### 11.4 判胜标准（**扩大评估前固定，事后不得改**）

**主结果**（按重要性排序，不是选一个报）：
1. **任务实际完成**：隐藏测试通过 / 可审计验收条目逐条核对。不是历史问答得分。
2. **返工次数**：同一处代码被反复改的次数。
3. **重复失败**：命中历史上已记录过的失败方案的次数。
4. **过期假设**：基于已被 supersede 的结论行动的次数。

**成本结果**（必须和主结果**分开报**，不许合并成一个"综合得分"）：
5. tokens（输入/输出分列）、费用、墙钟耗时。
   **主动检索的额外开销要单列**，不得摊进总数糊过去。

**两种口径分开报：**
- **预算匹配**：给三臂相同 token 预算，看谁在同等开销下做得好。
- **性能优先**：各臂放开预算，看天花板在哪。

### 11.5 防泄漏（这条做不到，整组实验作废）

**严格按时间切分。** 对第 N 个任务，可见历史只到该任务开始之前，且必须排除：
- 该任务最终的解法与 diff
- 该任务的测试结果
- 该任务的 commit 与 commit message

实现上靠 `untilTs` 全链路下压，而不是靠"提示模型不要看"。模型会看的。`[代码]`

- 四个查询接口（`listTasks` / `searchHistory` / `symbolHistory` / `readEvents`）全部支持 `untilTs`，
  语义统一为**严格小于**。统一这件事本身是修了一个 bug：原先 `readEvents` 用 `<=`、
  `searchHistory` 根本没有，同名参数在不同接口含义不同，在防泄漏场景就是漏判。
- **时间窗下压到候选生成阶段，不是打完分再过滤。** 先取 top-k 再滤时间的话，
  未来的事件会先占掉名额，返回条数静默变少而调用方看不出来 —— 这比直接泄漏更难发现。
  `test/eval-split.ts` 专门有一条断言盯着"下压后仍能取满 k 条"。
- `buildProbes()` 自动生成泄漏探针：该任务的 commit sha / subject、
  以及它首次引入、此前历史里不存在的标识符。`checkLeak()` 同时查时间越界与探针命中。

### 11.7 执行模块与输入输出 `[代码]`

- `src/eval/split.ts`：任务切点与人工探针 → 候选任务、越界与内容泄漏报告。
- `src/eval/history.ts::createHistorySnapshot(DB, CutPoint)`：源库与切点 → 独立内存库、受限原文读取与关闭句柄。只复制切点前事件/commit/向量，任务元数据重新派生，未来 blob 即使知道 hash 也不可读。
- `src/eval/arms.ts::{buildArmA,buildArmB,buildArmC}`：历史与预算 → A/B/B′/C-fixed 输入包。B 内联完整 blob；缺原件报错，不伪装完整。C-fixed 在同一切点快照中执行，不是 C-model，也不是数学上的性能下界。
- `src/eval/model.ts::{ApiModel,apiEndpoint}`：显式模型、端点与环境凭据 → Chat Completions 工具回合、响应模型、实际 token 回执。端点限制 HTTPS/本地测试，错误不转储凭据。
- `src/eval/opencode-model.ts::{OpenCodeModel,parseOpenCodeTurn}`：宿主模型名与 JSON 事件 → 同一工具回合接口。独立 `.devin` 配置禁用原生工具与自动分享，辅助模型固定为主模型。CLI 未暴露响应身份时明确记未核验。
- `src/eval/devin-model.ts::{DevinModel.complete,parseDevinTurn}`：显式宿主模型、消息与工具定义/原始响应节点 → 同一工具回合、原始 `generation_model` 与 `usageReceipts`。每请求新会话，原生工具拒绝并审计；宿主内部压缩或模型切换报错。缓存口径不明确时不造合计，预算估算另记。`checkDevinProvider(ChatModel)`：无历史的协议探针 → readiness、响应模型、原始回执与失败记录；真实 CLI 在它通过之前不发历史或执行三臂。原始 CLI 输出只扫描为诊断类别，不保存其内容。
- `src/eval/privacy.ts::redactCredentialPatterns(string)`：文本 → 脱敏文本与替换数；`assertNoCredentialPatterns(string)`：模型输入/工具输出 → 通过或拦截；`createEvaluationView(DB,newPath,untilTs)`：原库与严格截止 → 独立评测库及替换报告。保留原件，副本附原事件定位/hash，索引重新派生；检测启发式，不保证发现所有秘密。
- `src/adapters/devin.ts::locateDevinDb()`：宿主默认目录 → DB 路径或 null；`snapshotDevinDb(hostPath,newPath,options)`：只读事务与会话过滤 → 保留全部原始节点/旁表/分支的私有快照；`importDevin(DB,dbPath,options)`：源库、项目/会话/严格截止 → 事件及导入报告。优先原始消息时间，组件来源键+内容 hash 去重；旧时间回补可重复导入，改文按保存时间保守隔离，摘要/系统前缀不提升成原始交互事实。
- `src/eval/runner.ts::{runPilot,runArm}`：任务清单、预算、模型后端 → 独立仓库目录、逐回合轨迹、usage、原始回执、查询遥测与独立验收结果。所有臂使用同一模型实例及起始 commit；C-model 的查询/展开/停止由模型决定。无标准 usage 时估算单列且仍受总预算约束；输入与工具输出拒绝凭据疑似模式。
- `runner.ts::repositorySnapshot`：源仓库与切点前 commit → 不带 `.git` 的 `git archive` 副本。`workspacePath/codingCall` 将文件工具限定到该副本，命令仅允许预声明 argv；`clipUtf8` 保证输出截断不切坏字符。
- `runner.ts::verifyRepositoryClaims`：路径/字面文本/hash 与出处 → 当前文件观察、反证与出处可见性。没有内容 hash 时，新鲜度保持未知，不能验证整个心智模型。
- `scripts/{preflight,pilot}.ts`：真实宿主日志或 `.devin/pilot.json` → 数据体检、干跑输入或实际 A/B/C-model 执行。manifest 不含密钥；检查定义不提供给模型，已有结果不覆盖。可用 `modelCatalog` 按导出目录核对模型 UID 和窗口；`--provider-smoke-only` 只做无历史烟测，实际运行自动先烟测并保存独立证据。`RunnerOptions.onProgress` 输出臂/请求/工具阶段元数据，不含消息或参数。
- `scripts/audit-devin.ts`：原库、可选脱敏视图、严格截止 → 逐条原文/参数/时间/配对校验及实际 MCP 查询/展开/分页/blob 核查报告，失败也留报告，不记录凭据值；`prepare-history.ts`：原库/新路径/截止 → 独立脱敏视图；`validate-pilot.ts`：manifest/新输出目录 → 起始 commit 与已知修复 commit 的独立验收对照，不调用模型、不是效果评测。
- `.devin/pilot-devin.json` 与 `.devin/checks/causal-probe.py`：真实历史中探针时序子任务、切点与离线行为验收 → 同一三臂的任务配置及因果顺序/末尾探针/超时停喂判定。这是 agent 选取的诊断切片，不是整轮任务成功或预注册基准。

`query_log` 只存查询遥测，不写进 `events`。报告保留中途新读的事件 id，但不自动将它们判为检索失败。配置、输出位置与调用命令见 `tasklog/README.md`。


### 11.6 必须预先声明的限制

- pilot 是**用来发现问题的**。几个样本上的差异不构成"显著优越"，不得据此宣布路线成立。
- 失败案例**全部保留**并逐条列出，不得只报聚合数字。
- 验证只能针对**具体、可检验的主张**（"第 3 类任务里 C 避免了 2/3 次过期决策执行"），
  不得宣称"整个心智模型已被验证"。

---

## 12. 跨会话可靠性（本轮新增，已实现并回归）

第 3–10 节描述的是"单次用起来是对的"。这一节处理"**用了很多次、跨很多会话之后还是对的**"。
下面每一条都先有失败测试再有修复，测试在 `tasklog/test/reliability.ts`（36 项）
与 `tasklog/test/migration.ts`（12 项）。

### 12.1 跨会话顺序：`seq` 不是全局序 `[代码]`

`seq` 只在单个 session 内唯一。三个会话时间交错时，按 `seq` 排序会把它们切成块，
分页还会**同时漏和重**。改为 `(ts, id)` 行值游标（SQLite 3.15+ 支持元组比较），
游标编码 `"{ts}.{id}"`，走 `idx_events_global`。
`readEvents` 返回 `nextCursor`；`next_seq` 仅作兼容保留并标了 deprecated。

### 12.2 长任务的"尾部"必须是真尾部 `[代码]`

修复前：骨架取前 400 条，尾部取**这 400 条的后 12 条** —— 对 601 事件的任务，
拿到的"最后状态"其实是任务中段。这比没有尾部更危险，因为它看起来是对的。
改为两次独立查询，尾部用 `ORDER BY ts DESC LIMIT n` 再反转。
骨架被截断时返回 `skeletonTruncated: true` + `skeletonNextCursor` + 明确的续读提示。

### 12.3 任务身份必须稳定 `[代码]`

修复前 `rebuildTasks` 第一句是 `DELETE FROM task_edges; DELETE FROM tasks;`。
后果有两个：用户的人工修订被静默抹掉；所有旧 `task_id` 的含义发生漂移
（同一个 id 指向了不同的事件集合）——后者更隐蔽，因为旧 id 仍然能查到东西。

现在：
- `tasks.stable_key = 'ev:' + 段内首事件 id`，重分段按键 **upsert**，不删行。
- 不再出现的段标 `retired_at` 并写 `successor_id`，旧 id 永远能解析。
- `boundary_src='user'` 或 `locked=1` 的任务**整段跳过重分段**，其事件不进入重算输入。
- 只清推断出来的边；`note` 以 `user:` 开头的边保留。

### 12.4 分段证据 ≠ 完成状态 `[代码]`

修复前：`status = seg.commit ? 'done' : isLast ? 'open' : 'abandoned'`。
这行代码把三件事混为一谈：有提交、任务做完了、没提交就是放弃了。
**"commit 意味着任务完成"是未经验证的假设**，当场就能举出反例（拆成多个 commit、
提交了但没做完、做完了但没提交）。

现在：
- `status` 默认 `unknown`，且 `unknown` 是绝大多数任务的真实状态。
- 新增 `status_source ∈ {none, inferred, user}`，只有 `setTaskStatus` 能改 status。
- 分段依据另存 `boundary_evidence` JSON：`closedBy`（commit / time_gap / end_of_log / user）、
  `commitSha`、`gapMs`、事件区间、分段时间。证据和结论从此分开，可审计。
- v1→v2 迁移把历史上推断出来的 `done/abandoned` **一律降级为 unknown**：
  宁可说不知道，不要留假事实。

### 12.5 索引重建必须读原件，以及一个没解决的缺口 `[代码]`

`reindexSymbols` 原先只读 `events.text`，而那是**截断后的摘要**。
一次 reindex 就会让落盘内容深处的符号永久失去索引 —— 原文还在磁盘上，索引却再也指不到它。
这是"压缩后删原件"的变体，只不过删的是指针。现在 reindex 读 blob 原文。

**顺带发现的更深问题：** 一次 build 输出里 300 个 `module_N.ts` 会把符号配额吃干净，
把真正稀有的标识符挤出索引。改成两层：先按 kind 分配额（path 120 / ident 160 / …），
再对"模板族"折叠（数字归一成 `#`，同族只留首尾各 3 个）。

折叠掉的中间成员不保证有符号倒排键，但原文已补两条发现路径：
`ingest/events.ts::indexContentChunks(DB, dbPath)` 将完整原文切为重叠分片，写入 `event_chunks/chunks_fts`；首次写入自动建片，旧库 `reindex` 补建。
`query/vector.ts::indexVectors(DB, dbPath, provider, options)` 从同一完整原文建 `vector_chunks`，hash 相同则跳过；`ApiEmbeddingProvider` 按输入 index 对齐回执并校验维度。
`searchVectors` 在排名前按时间/任务过滤；`hybridSearch` 用倒排/全文与向量的秩融合返回原始事件及分片字节区间。`embeddingProviderFromEnv` 只接显式配置，不用伪向量兜底。

### 12.6 blob 必须能按范围读 `[代码]`

`read_blob` 加 `offset` / `max_bytes`，返回 `total_bytes` 与 `next_offset`。
修复前超过返回上限的 blob 只能读到开头，而"读到的就是全部"这个误会不会有任何提示。

### 12.7 导入幂等键不能是推断量 `[代码]`

`(session_id, seq)` 不足以做幂等：宿主在旧会话里补写一条，后面所有 `seq` 整体位移，
同一条内容会以新 `seq` 再插一遍。改用宿主自己的稳定 id：
`events.source + source_id` 唯一索引（partial index，仅对有来源的行生效）。

### 12.8 迁移本身不能丢数据 `[代码]`

v1→v2 要改 `tasks` 的 CHECK 约束，SQLite 只能重建表。
**写错了顺序会静默清空数据**：先 `ALTER TABLE tasks RENAME TO tasks_v1`，
SQLite 会把 `events` 指向 `tasks` 的外键一并改写成指向 `tasks_v1`，
接着 `DROP TABLE tasks_v1` 就触发 `ON DELETE SET NULL`，所有 `events.task_id` 归零 ——
全表行数不变，只是任务归属全没了，不跑检查根本发现不了。

正确顺序：关外键 → 建 `tasks_new` → 复制 → `DROP TABLE tasks` → 改名 → 开外键 →
`PRAGMA foreign_key_check` 校验。`test/migration.ts` 从一份逐字抄来的 v1 DDL 起步验证这条路径。

---

## 13. 查询遥测（与主历史严格隔离）

`query_log` 表记录：时间、`run_id`、阶段（warmup / midtask / adhoc）、工具名、参数、
命中数、展开数、输出字节、耗时。`[代码]` `src/db/schema.ts`

**它绝不写进 `events`。** 系统自己的检索记录进入主历史索引，
会让下一次检索命中上一次检索的记录，形成递归污染 —— 这是记忆系统特有的失败模式，
一旦发生很难察觉，因为命中率看起来还在上升。

**中途补读不自动等于检索失败。** 它是候选缺口信号：
可能是预热不够，也可能是任务本身在执行中才暴露出新的未知。两者要靠人看具体案例区分，
不要直接把"补读次数"当成负向指标去优化。

---

## 14. 已知风险

0. **（本轮最大的）没有任何有效性证据。** 322 项机制/集成检查只证明执行链路。
   "跑通"与"有用"之间隔着整个第 11 节，而第 11 节一条都还没跑。
1. **"原文留着"不等于"取得回来"。** ACM（`2607.23809`）的公开 referee report 指出：lossless 是架构属性，取回由 querier LLM 中介且输出有预算截断，操作上仍有损。把压缩挪到读侧没有消灭压缩，只是让它每次可重做 —— 好处是不累积，代价是每次都付。
2. **"原文 + agent 自检索"已被测过且不够。** AMA-Bench 的 baseline 描述里，MemGPT 正是"存 raw trajectory，靠 agent 检索能力取回"，而它不在最强之列。结论不是方案错，是**索引质量决定一切**，原文和工具只是必要条件。
3. **过度阅读。** 见第 6 节的预算上限。
4. **符号抽取的召回。** 正则漏抽等于那条事件在主索引里不存在。需要 `unindexed_event` 遥测。
5. **task 边界错划。** 可修订。修订已实现为幂等的 upsert + 退役标记，见 12.3。
6. **索引有构建与检索成本。** blob 已有全文/向量分片，但语义发现不保证召回；向量当前为 SQLite 中的精确余弦扫描，长期规模与收益仍需测量。
7. **OpenCode 的 schema 是内部的、会变。** `[代码]` 适配器全程防御式解析，
   未知 part 类型原样存为 system 文本并报告，不静默丢弃；但这只能做到"不丢"，
   做不到"读懂"。构建工具必须钉死宿主版本。
8. **live 库的 WAL。** 普通只读打不开时退回 `immutable=1` 会**看不到未 checkpoint 的最新会话**。
   适配器检测到 `-wal` 非空时会警告并给出 checkpoint 命令，不假装读全了。`[代码]`
9. **模型身份与 token 口径。** API 记录供应商自报响应模型，不能当权重证明；OpenCode CLI 缺响应身份时标未核验。token 来自接口回执，构造预算仍是估算；不能虚称费用已核算。
10. **切点快照的边界。** 只根据截止前原始事件与 commit 重派生任务，不继承事后人工修订。原始宿主时间若不可靠，过滤也不能恢复真实发生时间，真实 pilot 仍需审计切点。

---

## 15. 决策记录（已定）

1. **新建，不改造 Dynamics-memory。** 第 10 节的对照显示要动的是地基（schema）。已落地为 `tasklog/`。
2. **TypeScript + better-sqlite3 + FTS5。** `better-sqlite3` 钉 `^11.10`
   （13.x 在 Node 20 上 ABI 不匹配，`require` 即 segfault）。
3. **宿主先接 OpenCode，现按用户提供的可用历史补 Devin。** `[代码]` `src/adapters/{opencode,devin}.ts`。不泛化所有客户端；每个宿主的时间、失败状态、压缩副本与身份语义都要独立核查。
4. **原始记录与推断元数据分离。** `[代码]` `events.source` / `source_id` / `source_ref`，
   其中 `source_ref.inferred` 专门装导入器猜的东西（seq、kind 映射、outcome 判定依据、git 信息）。
   宿主没给工具状态时 `outcome` 留 `null`，**不默认当成功** —— 把失败记成成功是这套日志最不能出的错。

---

## 16. 当前阻断点

**真实日志阻断已解除，实际模型调用仍被执行上下文的认证问题阻断。** 用户已删除 OpenCode 日志，改用本机 Devin `sessions.db`。只读事务快照选中该工作区 12 个会话、60,171 个原始节点；导入 23,424 个去重事件，跨度 32.1 天、343 个失败事件、68 个推断任务。原文/参数与 2,191 个 blob 已逐条核对，实际 MCP 四条读取链路通过。没有识别到 revert 边；这不等于没有决策修订，相关样本需人工审计。

原始节点、压缩副本与旁表留在 `.tasklog/sources/`，不改宿主数据库；评测副本 `.tasklog/devin-eval/history.db` 对 12 条记录中的 15 处凭据疑似模式做明确脱敏，原文主体、参数结构和时间保留，逐条核查通过。两个目录均是本地私有数据，不上传。宿主摘要仍只作为原始宿主记录存档，不替代交互证据。

已准备真实历史任务的测量子任务及独立验收：起始 commit 两项失败，已知修复 commit 两项通过。它只验证验收可区分历史缺陷，不是任务成功率、不是记忆收益。切点前原文约 9.52M tokens（估算）；200K 干跑预算下 B′ compact 装入 532 条完整事件，约 183,523 tokens，并报告全部省略量。此前大事件会令打包提前停止仅剩 1 条的错误已修复。

Devin provider 已打通：IDE 同款 ACP 通道（`devin acp --model swe-2-max`、`ACP_BACKEND=windsurf`、authenticate 直传本地 api_key、`CHISEL_SESSION_DB` 隔离、stderr 持续排空——此前"随机挂死"的根因是 stderr 管道缓冲写满阻塞子进程）。模型身份以隔离库 `sessions.model` 逐请求核验；真实用量取 ACP `session/prompt` 回执；原生工具经 `--config` deny 全部拒绝并审计；provider 端压缩（`summarized_from` 非空）如实判该请求失效。首个真实三臂结果见第 11 节表——单任务 n=1，跨任务收益仍未验证。命令与本地证据路径见 `tasklog/README.md`。

**纯文本对话导出（如 `arena-conversation.md`）仍只能当文本导入样例。** 缺完整工具事件和结构化时间时不能冒充完整轨迹。

---

## 附：相关工作中最接近的实现（均 `[自报]`，主体档，未逐页深读）

- **MemMachine**（`2604.04853`）：存 raw episodes、句子级索引、含 MCP server。讨论节 9.1 原话："systems that invest heavily in LLM-based ingestion ... may be over-optimizing the wrong stage"。按时间邻接扩展，无 task 概念。
- **ACM**（`2607.23809`，CMU+Meta）：`manage_context` 压缩并落盘原文，`query_memory` 按 id 回查。只在单任务会话内。
- **MemAgent**（`2609.32521`）：Begin 阶段并行 probe 后路由。路由的是 provider 不是日志。
- **Maximem Synap**（`2607.21503`）：speculative prefetching，把检索移出关键路径。
- **MemoryArena**（`2602.16313`）：实验设定里"每个 subtask 开始时检索一次"，但这是评测设定，不是存储层组织原则。
- **LRE**（`2606.20954`）：千字节级 CPU 打分器、压缩时零 LLM 调用、逐字保留。
- 产业侧：`engram`（Go + SQLite + FTS5 + MCP）、`Data Olympus`（MCP 检索只返回经 validity 与 supersession 检查后仍生效的知识）、`AtMem`（provenance + execution evidence）。

**novelty 判断：** 部件全是现成的。没人占的空位是**把 task 当成存储与检索的一等单元** —— 现有粒度是 turn/episode/sentence、trajectory、provider 或 summary 段。值得占的理由是 AMA-Bench 自己的诊断：现有系统失败于 "fail to capture causal and objective information"，而它的解法 causality graph 要花 LLM 调用去抽；**任务边界 + supersedes 边是几乎免费的因果结构**。
