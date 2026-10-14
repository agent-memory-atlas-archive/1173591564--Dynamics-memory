# Dynamics-memory 源码通读 — 进度与事实记录

规则：只记代码事实，每条带文件名。严格区分三档：
`[代码]` = 读到的实现 / `[文档]` = README 或 docs 的声称 / `[目标]` = target-architecture 标注的待实现。
不在本文件里下设计判断。

---

## 〇、对我此前说法的自我更正（第二轮，基于 bootstrap.py）

**此前我说「`defer_credit` 默认关、`cap_m` 代码 40 与 README 的 8 不一致」——这两条是错的。**
我只看了 `config.py` 的 `Cfg` dataclass 默认值，没看装配点。

`transport/bootstrap.py::build_default_service` 实际构造：

```python
cfg = Cfg(theta=0.35, cap_m=8, k=5, tau_dup=0.85, tau_sim=0.78,
          useful_hit=True, defer_credit=True)
```

- `cap_m=8` —— 与 README 一致，不矛盾。
- `defer_credit=True` —— 生产态**不是**检索内就地结算，走 `/feedback` + `relevant_set` 答案级归因。
- `tau_dup=0.85 / tau_sim=0.78` —— 也不是 dataclass 的 0.90 / 0.80。
- **没有被覆盖**的仍是 dataclass 默认：`confidence_on=False`、`salience_on=False`、
  `novelty_on=False`、`consolidation_on=False`、`lex_weight=0.0`、
  `miss_on_recognizer_none=False`、`capacity_on=True`。

由此推出的三条代码事实：
1. `core/retrieval.py` 的 `provisional`（注入里的 `[未确认]` 前缀）只在 `cfg.confidence_on`
   为真时才可能非空 → **生产态该前缀不会出现**。
2. `core/consolidation.py::maybe_consolidate` 首行 `if not cfg.consolidation_on: return`
   → **生产态不产 reflection，`maintenance_due` 不会由巩固回路发出**，
   注入里的 `[项目状态汇总]` 前缀也不会出现。
3. `defer_credit=True` 时 `run_retrieve` 末尾的就地结算整块被跳过 →
   检索不更新 `last_hit`、不复活 ARCHIVE、不加 `d_hit`；这些只在
   `/feedback` → `submit_relevance` / `credit_shown` 路径发生。

---

## 一、进度

**`hybrid_memory/` 全部 67 个 py 已读完**（含 4 个 shim 包、全部 `__init__`）。
**`.opencode/plugin/memory-bridge.ts` 4/4 chunk 已读完。**
**`.opencode/agent/{hauler,selector,reviewer}.md` 3/3 已读完。**

未读：`analysis/target-architecture.md` chunk 2–8、`analysis/*.py`、`docs/*`、
`tests/`、`eval/`、仓库根杂项。（`agent/codemode/` 是 vendored opencode，不读。）

---

## 二、代码事实

### 装配与启动（transport/bootstrap.py · config.py · server.py）
- 入口 `python -m hybrid_memory.server`；`server.py` 只是垫片，实现在
  `transport.bootstrap.main`。
- `MEMORY_PIPELINE` 默认 `opencode`（= trio），`legacy` 走旧管线，其余值 `Fatal` 拒启动。
- trio 模式下启动前跑 `OpenCodeRunner.verify_channel()`：`opencode run --help`
  必须含 `--file`，否则 `Fatal`。
- 两条后台循环：`start_unit_recovery()`（单元恢复 + 语义任务）恒开；
  `DispatchWorker`（trio 工作流）在 `trio_mode and not --no-agent` 时开。
- 状态目录 `<project>/.opencode/memory/`，启动时自写 `.gitignore`（内容 `*`）。
- 双 token：`.memory-token`（读写）与 `.human-review-token`（人审），均 0600。

### L0 证据层（store/evidence.py + store/schema.py）
- `units` 表列：`id, t, ts, scene, user_text, assistant_text, assistant_turns`。
  **只有两列文本**，没有工具调用/观测的任何字段。
- `units_fts` 是 fts5 trigram，content='units'，索引列只有 user_text / assistant_text。
- `mentions(entity, kind, unit_id)`：`entities_in()` 零 LLM 抽 url / path / pr / hash /
  version / envvar / ident。
- `unit_emb`：单元向量 = `(user_text[:600] + "\n" + assistant_text)[:1800]`；
  embed 失败只计 `n_embed_fail`，不阻塞写入。
- `unit_work(unit_id, state, result, context, attempts, last_error, next_run_at)`：
  每单元一行 JSON `context`。只有在线 append 建行，历史单元不回填。
- `search()`：FTS5 trigram bm25 + 向量余弦，**RRF 融合**（`1/(60+rank)`），
  无 ≥3 字符 token 时 LIKE 兜底。**永不返回全文**，只返回 snippet。
- `window(unit_ids, max_chars, before)` 是唯一回展原文的通道，按字符预算逐单元截断。
- `before=t` 在 search / timeline / stats / window / exists 全链硬过滤。
- 幂等：同 id 同内容 no-op；同 id 异内容 `ValueError`；`capture_id` 绑定异正文
  `CaptureConflict`。
- `retention_report()`：只统计 units / bytes / 最旧单元 / `dangling_src`，**只告警不删**。

### 记忆数据模型（core/types.py）
- `Memory` 无观测模态字段。`src: frozenset` 只存 L0 unit id。
- `origin ∈ {passive, repair, extract, mining, agent}`（+ 人审写入用 `user_confirmed`），
  注释：「只做审计与消融分组，不参与 V」。
- `claim_key: tuple[str,str]`（实体, 属性）+ `claim_value` + `claim_unit` + `withdrawn_at`
  + `reviewed_after` —— 单值槽位版本链。
- `MemorySemantics` 协议含 `valid(belief_id, value, t) -> bool`。

### 语义通路（semantics/real.py · llm.py · provider.py）
- 生产装配：`SemanticsProvider(LLMSemantics(None, chat_fn=..., model="glm-5.3-flash"),
  provider="zhipu")`。
- `RealChatSemantics`：`relevant()` 恒 True，`valid()` 恒 True，`scope()` 恒 ""。
- `LLMSemantics(RealChatSemantics)` **只覆盖 judge / relevant_set / consolidate**，
  **未覆盖 `valid()` 与 `scope()`** → 生产态 **`valid()` 仍恒 True、`scope()` 仍恒 ""**。
- 后果一：`valid()` 协议槽位两条通路都是空桩，无任何失效检测实现。
- 后果二：`maintenance.apply_resolution` 的 contradiction 分支里 `scope(a) != scope(b)`
  恒假 → **永远走「同 scope」路径**：双方 `v *= 0.5` + 聚合 `pending=True` 等人审。
- `judge` 四级：verbatim 相等 → 人工标注 JSONL → LLM 判 → 失败 `"pending"`。
- `relevant_set` 是答案级归因器（prompt 要求「最小充分集合」），返回 None = 识别失败。
- `SemanticsProvider` 对 judge/relevant_set/consolidate 计 `calls`/`failures`/`last_error`，
  进 `/health` 的 `semantic_provider` 段。

### 检索（core/retrieval.py）
- `score = cos + lex_weight·lex + π_pool + fresh_alpha·e^(−λ(t−birth))`；
  `lex_weight=0` 时词法通道整条关闭（且有「query 无低 df token 则整条关闭」的稀有词门）。
- 槽位作用域：查询点名了某个已登记 `(实体,属性)` 时，排除「明确属于其他槽位」的记忆；
  无 claim_key 的记忆不受此过滤。
- 退役版本（superseded / aggregated / withdrawn）**一律不参与检索**。
- 带内压制：与已选记忆 cos > `tau_sim` → 进 `suppressed` + `add_tension`，不入选；
  派生血缘（`derived_from`）对不裁判、不进 backlog。
- 入选记忆若有未决 tension，对手版本一并端出为 `contested`。
- `len(selected) < k` → 发 `thin_recall` 信号（仅遥测）。

### 注入与预算（service/recall.py）
- 渲染前缀：`[未确认]`（仅 confidence_on）/ `[待人审冲突，不可断言为当前事实]` /
  `[有未决冲突，不可断言为当前事实]` / `[项目状态汇总]`（仅 reflection）+ `[t=birth] 正文`。
  对手行用 `- ⚠️未决冲突：…`，人审提案行用 `- [待人审提案，非当前事实] …`。
- `CONTESTED_K = 3` 同时约束 contested 行与 dispute 行；超限 `truncated=True`。
- `_safe_mem_text` 中和 `<relevant-memories>` 同名标签，防存储型注入逃逸。
- `approx_tokens`：CJK 单字 1 / ASCII 词 1 / 其余非空白符号 1；`budget_tokens` 按**整行**截断。
- `passive=True` 或带 signal_id 时走 `copy.deepcopy` 的引擎副本，
  强制 `defer_credit=True, shadow_credit=False`，不登记 rid、不改状态、不发信号。
- `causal_memory_ids(before)`：`birth < before and last_seen < before` 且 `src ⊆` before 内
  已知单元，再迭代剔除 supersede/aggregate 指向界外的条目。
- `_RETRIEVAL_KEEP = 512`；淘汰时优先保留 `feedback_sent and not credited` 的对象。

### 信用结算（core/engine.py · dispatch/worker.py · dispatch/effects.py）
- 生产态 `defer_credit=True`：`engine.feedback()` 只发 `feedback_pending` 信号，返回 0。
- `worker.semantic_model` 锁外调 `relevant_set(texts, question, answer)`；
  返回 None 或长度不符 → `used=[True]*n` + `recog_fail` 计数（退化全记）。
- `apply_feedback`：展示一致 → `submit_relevance`；注册表已退役/变更 → `credit_shown`
  按载荷 id 记账并标 `retired_source`。
- `_credit_hit` 沿 supersede/aggregate 链找当前代表，链断则不记（不复活尸体）；
  命中则 `last_hit=t`、`hits+=1`、`d_hit+=1.0`，ARCHIVE → CANDIDATE 复活。
- shadow 信用恒延迟：`_record_shadow_pending` 存 `(pair, mid, t_ret, rel)`，
  verdict 到达时 `_settle_shadow`，**verdict != "synonym" 且 rel 为真**才发
  `d_shadow += 1.0`（含 verdict == "pending"）。队列上限 `shadow_pending_cap=256`。
- `/feedback` 的 payload 只有 `{retrieval_id, question, answer, request_id}`，
  **没有任何行动结果字段**。
- `miss_on_recognizer_none=False` → recognizer 判「一条都没用上」不会触发 `recall_miss`。

### 写路径授权（agents/selector.py · dispatch/effects.py · core/triggers.py）
- `triggers.claims_in(text, authoritative=True)`：正则抽单值槽位声明。
  `CLAIM_RE`「由 X 改为 Y / 定为 / 设为 / 改成 / is set to / 现在是 / 应该是 / 是 / =」；
  `RETRACT_RE`「作废 / 撤回 / 废弃 / 弃用 / 停用 / 取消 / withdrawn / retracted」；
  `UNSAFE_CLAIM_RE` 命中问号/引号/如果/假设/可能/建议/考虑/例如/据说/引用 → 整条不授权。
- `selector.authorized_change`：证据必须 ① 来自 `ev.src` 的 L0 单元且 `t <= anchor.t`；
  ② **只读 `source["user_text"]`**，assistant_text 完全不参与授权；
  ③ claim key 相同、值一致、mode ∈ {set, change, correction}（retract 对 retract）；
  ④ `(source.t, uid) > threshold`，threshold = max(旧声明锚, `reviewed_after` 人工水位)。
- `normalize_claim`：值相同 → EXIST；全部 proof 非空且无 pending_review → UPDATE；
  历史值想变当前 → REJECT；否则 → CONFLICT（"human freeze or insufficient user authorization"）。
- `apply_selector` 事务内二次确认 `verified_correction` + `proof_unit_id in ev.src`，
  不满足就降级 CONFLICT。`change_kind == "retract"` 时把 target 与 related 一起
  `withdrawn_at = archived_at = t` 并入 ARCHIVE。
- `apply_hauler`：对 `unit["user_text"]` 跑 `claims_in(authoritative=True)`，
  对**已登记槽位**的授权声明**直接补建候选**，并剔除与之重复的模型候选；
  模型候选先过 `_validate_proposal`（含 grounding），未接地按条拒绝并计 `n_ungrounded`。
  批量上限 50。
- `enqueue_review`：review_key = sha256(target id + stamp + peers + claim 三元组)。
  同 key 已 `keep_old` 且新来源 ⊆ 旧来源 → 直接返回旧 id。
  pending 上限 `MAX_PENDING_REVIEWS = 512`，满则 `Degraded("capacity_backpressure")`。
- `close_retired_relations`：任一版本退役 → 其 pending 人审标 stale，相关 tension 删除
  并以 "pending" 结算 shadow。
- 人审 `decide_human_review`（service/review.py）：需 `X-Human-Review-Token`；
  `accept_new` 走 `_validate_proposal` + `origin="user_confirmed"`，
  给选中版本盖 `reviewed_after = (t, unit_id-1)` 水位；同 target 的其他 pending 全标 stale。

### 三 Agent 的能力面（.opencode/agent/*.md）
- hauler / selector / reviewer 三份 agent 定义的 frontmatter **全部是**
  `permission: {"*": deny, bash: deny, read: deny, edit: deny, glob: deny,
  grep: deny, webfetch: deny, task: deny, websearch: deny}`
  → **三个记忆 agent 一个工具都没有**，只能读 prompt 里给的 JSON payload 并回 JSON。
- Hauler 提示明确：「窗口内重复出现不构成独立确认」「不要对照当前记忆库分类，那是 Selector 的活」。
- Selector 提示明确：「不得仅凭 recency 选 UPDATE」「快照不足以安全判断时宁可失败，不要编 CREATE」。
- Reviewer 提示明确：「没有上一轮检索记录时视为未知，不得当作检索成功/失败的证据」
  「只有 completed 的交接才算决策，pending 的不能为遗漏背锅」「规则是指导，不是分类本身」。
- `agents/opencode.py`：payload 走 `--file` 0600 临时文件，短指令是位置参数；
  win32 用 `serve --pure` 常驻 + `run --attach`，其余平台 `run --pure` 自举；
  子进程注入 `DYNAMICS_MEMORY_INTERNAL_AGENT=1`（插件据此整个 return 空对象，不挂钩子）。
- 输出解析：只取 stdout 中 `type=="text"` 的 part 拼接，再 `json.loads`，必须是 dict。

### 任务机（store/tasks.py · dispatch/policy.py · dispatch/worker.py）
- 状态：pending → running → ready → applying → done，另有 dead / skipped。
- `tasks_mergeable` 唯一索引：`(kind, task_key) WHERE state='pending' AND attempts=0
  AND task_key<>''` —— 合并只发生在未领取且零尝试的任务上。
- 策略表：INV(recall_miss, extract_due) 2/3；SEM(conflict_pending, feedback_pending,
  maintenance_due) 5/5，lease 360s，backoff 2.0；WF(hauler/selector/reviewer_due)
  5/5，lease 120s，backoff 2.0。全部 `on_exhausted="dead"`。
  `DispatchWorker` 构造默认 `lease_s=600` 覆盖策略的 120。
- `assert_consumers`：POLICIES 的每个 kind 必须有 applier，反向无野项，否则 `Fatal`。
- `retry(..., retry_model=isinstance(exc, ValueError))` —— **校验类异常清空产物重跑模型**。
- `complete()`：效果 + checkpoint + `operations` 回执 + state='done' 同一笔 SQLite 事务。
- `apply_unit()`：单元效果 + 下游任务入队 + checkpoint + `unit_receipts` 同事务。
- checkpoint 是**全量 pickle** 写进 `checkpoint(id=1, revision, state BLOB)`，revision CAS。
- `task_call_contexts(task_id, token, context)`：N10 封存，`store_call_context` 在
  state='running' 时写，同 token 重复写入内容不一致抛 `CaptureConflict`。
- `workflow_trace`：Reviewer 可见的历史交接，>18 条或 >24000 字符直接 `ValueError`。

### 容量与保护（core/dynamics.py · dispatch/effects.py · service/observability.py）
- `pinned_ids`：未决 tension 两端 ∪ pending_review 聚合体及成员 ∪ `_external_pins`
  ∪ `_shadow_pending`，再沿 superseded_by / aggregated_into / agg_members 求引用闭包。
- `protected_ids(svc)` 额外并入：未结清 feedback 的 selected、活跃任务 payload 里的
  selected、selector ready 产物里的 target_id、各任务封存 `window_ids`；
  以及「存在 withdrawn 记忆时」把最近 6 个 L0 单元的 window 并进来。
- M 满 → 拒绝晋升（`n_promote_rejected++`），不挤出已有 M。
- C 溢出 → 按 (v, last_hit|birth, id) 迁 A；A 溢出 → 按 (archived_at, id) FIFO 删除。
- `cap_context`（非退役总数，含 A）超限 → 补删最旧无保护非退役 A。
- 全 pin 收不了口 → `Degraded("capacity_backpressure")`，整批效果拒收回滚。
- `_rollback_effect` 另有 checkpoint 预算闸：`_state_bytes >
  CHECKPOINT_BUDGET_BYTES (2 MiB)` → `Degraded("checkpoint_over_budget")`（503）。
- `PIN_OCCUPANCY_ALERT = 0.7`：pin 占 `cap_context` 比例超限在 /health 外显告警。

### 插件桥（.opencode/plugin/memory-bridge.ts，4/4 chunk）
- 钩子：`chat.message` / `experimental.chat.system.transform` / `event` / `tool` / `dispose`。
- `DYNAMICS_MEMORY_INTERNAL_AGENT=1` 时整个插件 `return {}`（worker 会话不被捕获）。
- `chat.message`：`parts.filter(p => p.type === "text")`。
- `event` → `message.part.updated`：**`if (part.type === "text" && ...)`**，
  其余 part 类型（含工具调用/结果）直接丢弃；`message.updated` 只用来记 role。
- `session.idle`：reply = 该 session 里 role=="assistant" 的 text part 拼接
  → `POST /observe` → 若有 retrievalId 再 `POST /feedback`。
- 注入在 `experimental.chat.system.transform`，**每轮一次、在工具循环开始前**，
  query = 用户原话 `p.user`，走 `POST /search`。注入块：
  `<relevant-memories>\n以下是召回的相关记忆，不代表当前任务进程，仅作为参考：\n…\n</relevant-memories>`
  + 「若上述记忆不足以回答且问题涉及项目历史（之前的决定、改过什么、某个值是多少），
  先用 log_search / log_timeline 查证再作答；**不要直接写入长期记忆，后台 Hauler 和
  Selector 会处理已保存的交互**。」（trio 分支）
- `tool` 面 trio 模式只暴露 6 个：`memory_search, memory_conflicts, log_search,
  log_timeline, log_stats, log_window`；legacy 模式才另加 `memory_resolve,
  memory_propose, memory_diagnose`。
- `reportMiss`（主 agent 用了日志工具 = 记忆没接住）**在 trio 模式下第一行就 return**，
  即 trio 态 `/miss` 根本不上报（服务端也把 `/miss` 列入 `TRIO_DISABLED`）。
- outbox：`bridge-outbox.json`（0600 + 自建 .gitignore），每回合先落盘再入发送链；
  observe/feedback 各带稳定 request-id，acked / retry / stop 三态判定；
  401 → `authDead` 永久停发。

### HTTP 面（transport/http.py · dto.py · auth.py）
- 路由 18 条；`TRIO_DISABLED = {/resolve, /propose, /diagnose, /miss}` → trio 下 403。
- `SIGNAL_PATHS`（可带 `X-Signal-Id` 的）共 10 条；带 sid 访问其他路径 → `SignalClosed` 403。
- GET 只有 `/recall /conflicts /signals`，`/health` 免鉴权；其余 POST，体上限 4 MiB。
- 错误码表在 `errors.py::_STATUS`：queue_full / checkpoint_conflict /
  capacity_backpressure / checkpoint_over_budget 全是 503。
- `telemetry.health_view` 里 **`"validation": "unverified"` 是硬编码字面量**。

### legacy 管线（legacy/，`MEMORY_PIPELINE=legacy` 才启用）
- `InlineInvestigator`：进程内 function-calling 循环（glm-5.3-flash），
  6 个只读工具（log_search / log_timeline / log_stats / log_window /
  memory_search / memory_conflicts），写入只经最终 JSON。
  **「火墙」注释：这个循环从不调 observe，调查过程不可能被捕获成记忆。**
- `AgentWorker`：SQLite 领任务，每日 `daily_cap=200`，`dedupe_ttl=24h`，
  预算 `tool_calls=8 / window_chars=4000 / timeout=300s` 按次开关。
- `ChatGenerator`（candgen）：单轮窗口抽取 prompt，产出 `{scene_name, memories[]}`。
  注意：**trio 模式下它仍被装进 MemoryService**（bootstrap 无条件传入）。
- `legacy/worker.SignalWorker`：裸引擎/实验用的内存信号消费者。
- `hybrid_memory/agent/` 与 `hybrid_memory/candgen/` 两个包是纯 re-export shim（给冻结测试用）。

### 其他
- `agents/payload.py`：Hauler/Reviewer 窗口 `recent_ids(limit=6)` + `window(max_chars=12000)`，
  `truncated` → **`raise ValueError`（硬失败，整轮重试）**；`memory_snapshot` > 500 →
  `RuntimeError("needs indexed paging")`。
- `guards/grounding.content_grounded`：候选正文至少一个可核对片段（连续两汉字或 ≥4 的
  ASCII 串）出现在所引原文；≥8 的长标识必须全部出现。
- `guards/redact`：sk- / Bearer / api_key / gh[pousr]_ / github_pat_ / xox[baprs]- /
  AKIA / JWT / password|secret|token / PEM 私钥块 → `[REDACTED]`。
- `service/budgets.py`：`MAIN_WINDOW_CAP = 1500`（主 agent 无 signal 时单次回展上限）。
- `core/triggers.is_dissatisfaction` 触发 `reviewer_due`；`is_correction` 是其子集。
- `core/signals.SignalQueue`：cap 256，同 (kind,key) 合并，满了丢最旧计 `n_dropped`；
  `on_emit` 返回非 None 即被持久任务表接管（只接管
  `recall_miss / extract_due / 三个语义 kind / 三个工作流 kind`，`thin_recall` 仍易失）。
- `store/state.py`：pickle 受限反序列化白名单（防 RCE）；加载时对旧档
  `claim_key` 为空的 fact 用 `triggers.claims_in` 回填。
- `lifecycle.recover_or_init`：durable checkpoint 优先 → state.pkl → 坏档隔离为
  `.corrupt` 后空启动（`snapshot=quarantined`）。
- `embed/zhipu.py`：embedding-3，2048 维，>2000 字符分块后按长度加权求和再归一化；
  SQLite 缓存键 = sha256(model + dim + chunk)。

---

## 三、评测侧事实（eval/，仓库自报）

### eval/BASELINE.md（2026-09-27，mock LLM + 本地 bge 向量，自述「只验管道不评质量」）
- pytest 211 项全过；sidecar 全部 HTTP 接口通；持久化恢复通但**信号队列丢失**。
- 自报仿真结果（10 种子 × 10 预设）：
  `ours recall=0.792 eff=0.691 pollM=0.102 maxM=8`；
  `decay_only 0.837 / 0.746`、`abl_no_dedup 0.849 / 0.752`、`abl_no_tension 0.833 / 0.725`
  —— **三个消融在 recall 与 ctx_eff 上同时高于完整版**；`flat 0.917 / 0.227 maxM=706`。
- 当时记录的问题（部分已在后续 N 轮修掉，部分仍在）：插件健康检查 bug 导致永不自动拉起；
  **L0 未脱敏，密钥经 log_* 流向 LLM**；contested 无上限（top-k=5 注入 16 行，11 行是冲突）；
  端口写死 17872 导致多项目串台 401；**助手答错的内容也会被蒸馏成记忆**；
  36 轮后 M 池仍为 0。

### eval/l2l3/REPORT.md（N51 抽检 → N53 探针 → N54 内核闭环）
- N51 抽检：873 任务 811 done / 62 dead（7.1%，其中 53 个是 `ungrounded_content` 接地拒收）；
  产出 292 条记忆；Agent 单评 499/500 合格（报告自己声明「单评分者、未人工验收」）。
- N51 登记的系统级发现：**值链旧值滞留**（同一端口槽位四代「当前值」并存于 C 池，
  旧值未迁 A）→ PENDING-11；**同一值变更两种判罚并存**（先 3 次 CONFLICT 进人审，
  随后又 CREATE 新记忆直入候选池）→ PENDING-12；`redact_secrets` 误伤
  （`--task-queue-cap` 被吞成 `--ta[REDACTED]`）。
- N53 因果探针（9 轮 9 探针，三链）：
  `run-glm2` eligible 6/9（hit 4 / harmful 2）；`run-deepseek` 5/9（hit 2 / harmful 3）。
  三链一致的内核行为：新值不落库（Selector 判 UPDATE 但服务端因用户文本无纠正标记
  降级 CONFLICT）、旧值与新候选并排端出、**已作废值继续服务**。
- N53 A/B（冻结载荷 7 case）：hauler GLM 14.76s vs DS 4.67s；selector 17.60 vs 4.89；
  **reviewer 159.79s vs 40.91s**。结论 `settle=ab_thresholds_not_met`，不换生产模型。
- N53 自述：「**当前检索质量的主要敌人是内核不是模型**」。
- N53 顺带核实并写明：生产 `defer_credit=True`；`confidence_on / salience_on /
  novelty_on / consolidation_on` **全 OFF**（PENDING-03）；M 池为 0 是因为该轮
  passive 探针不记 useful-hit。
- N54（本轮代码对应的版本）：实现了受控自动 UPDATE/撤回（有限中英文单值句法）、
  CONFLICT 按「目标版本戳 + 槽值」持久去重、`withdrawn_at` 撤回语义、
  维护先降级腾位再晋升、schema v2。
  确定性证据：**pytest 600 passed / 1 skipped**；架构登记 172 模块 / 1730 符号 / 0 failures；
  `acceptance_check.py --full` 25 PASS / 0 FAIL（**12 项 PENDING 在白名单里保留，未消项**）；
  Bun 桥接回归 26 pass。
- N54 真实 provider 链：DS / GLM 的 `run-*-live3d` 各 **25/25**、0 死信，
  各 23 ready / 2 needs_human、20 hit / 3 clean / 2 not_testable，
  终态 C=2 / M=0 / A=14，提交 CREATE 5 / EXIST 4 / UPDATE 14（含 3 次撤回）/ CONFLICT 6。
- 报告自己写明的未闭合：**PENDING-08（真实会话 + 人工抽检）与 PENDING-03（机制消融）不变**；
  25 轮链是 passive 测量，M=0 不否定晋升回路但也未验证；inline 通道不代替生产 OpenCode CLI；
  「授权句法只覆盖有限字面模式，不宣称通用自然语言理解」。
- `eval/checks/stale_in_context.py`：现成的「注入里含现值 / 含旧值 / 只有旧值 /
  现值且无旧值 / 平均注入条数」五列度量脚本（跑在合成仿真上）。

---

## 四、尚未读（精确清单）

- `analysis/target-architecture.md` chunk 2–8（共 9，113 KB）
- `analysis/acceptance-criteria.md` · `decision-register.md` · `design-debts.md` ·
  `engineering-charter.md` · `contract_snapshots/`
- `analysis/architecture_contract.py`(88 KB) · `check_architecture.py`(45 KB) ·
  `acceptance_check.py`(25 KB)
- `docs/` 13 个 md（其中 `architecture-inventory.md` 1.14 MB 是自动生成清单）；
  已读的只有 `opencode-trio.md`
- `tests/` 约 25 个文件、约 300 KB（含 `test_smoke.py` 55 KB、`test_server.py` 35 KB、
  `test_trio_protocol.py` 32 KB、`memory_bridge.test.ts` 17 KB、`unit/`、`integration/`、
  `characterization/` 三个子目录）
- `eval/README.md` · `eval/drive.py` · `eval/l2l3/*.py`（audit / export / gen_l2 /
  gen_l3 / model_ab / run_audit_chain / selftest / serve_inline / sidecar / inline_runner）·
  `eval/checks/{aggcheck_conflict,rescore_aggregate}.py` · `eval/checks/diagnosis-of-current-eval.md`
- 仓库根 `opencode.json` · `pytest.ini` · `.env.example`
- `agent/`（vendored opencode fork，`runtime.ts` 单文件 141 KB）—— 不属本项目代码，未读
