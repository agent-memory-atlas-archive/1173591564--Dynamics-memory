# Agent-memory 效用文献笔记（2026-10 检索，五轮，81 PDF）

> 11 篇深读文献的逐篇卡片（方法/协议/结果/局限/可抄点）见
> `deep-read-cards.md`；本文件按主题组织，按 ID 互引。

核心问题：引入 agent-memory 后，LLM 在长任务上的回答/行动是变准了，还是被污染变差了？
结论：这正是 2025-2026 文献的主战场。实证答案冷峻但有结构——失败被定位到
五层独立机制，每层已有对应修法与证据强度。我们的设计在各层中的位置见各节对照。

## 阅读深度（诚实分级，2026-11-05 标）

"读"全部指读 arXiv HTML 正文分块。**三档含义**：
- **深读**（11 篇）：问题定义 + 方法/基准设计 + 实验设置 + 结果表 +
  failure/机制分析，逐段读过；跳过 related work、证明、大部分附录。
- **主体**（~27 篇）：abstract/intro + ≥2 个正文段（通常是设计与结果表）；
  数字取自论文自报，未核对 artifact。
- **摘要级**（13 篇）：abstract + intro；笔记中对应条目只复述其自报结论。

深读：TEPA、STALE、Stale Binding、EvolveScaler、2605.12978、
MemoryAgentBench、Supersede、MHM、Eywa、MemOps、Memory-R2。

摘要级：2410.00382、2608.22215、SSGM、MemoryBank、Mem0、Zep、A-MEM、
MemPO、AgeMem、Mem-α、Mem-T、AtomMem、DeltaMem。
其余 51 − 11 − 13 = 27 篇为主体档。**所有结论均未经独立复现**；
标"自报"的数字就是论文自己报的数字。

---

## 一、"记忆反而更差"的直接证据与修法

### TEPA（2608.07429）—— 记忆污染的形式化 + 已验证的修法
**问题形式化**：memory pollution = 被新证据取代的旧记忆仍可检索进 prompt。
单键取代模型下，append-only 相对无记忆的期望风险多出 ξ·η
（ξ=旧值暴露率，η=采纳率）；ξη > 当前证据收益 b 时记忆净为负。

**机制（精读）**：
- 每条 precedent = (key, value, 证据) + Beta 后验（s/f 计数）。
- 生命周期 Hypothesis → Active → **Revoked**（归档可审计、可再晋升）。
- 撤销条件：后验均值 < 0.3（满 5 次观测）或近 3 次同键成功率 < 0.34。
- **TEPA-Full 晋升前做 trial-by-execution**：3 次试验 = 1 支持 + 1 反事实 +
  **1 污染检查**（候选不得污染无关域），≥60% 通过才晋升。
  → 污染检查这个思路可直接借给我们的 C→M 晋升。

**结果**：受控反转相位（50 seed、配对置换检验、Holm 校正）：
append-only = last-write-wins = 0.210 < no-memory 0.309；TEPA 0.950。
结论句值得引用："A memory item can be relevant, recent, and still wrong
once its value has been superseded"——**有效性独立于相关性和新近度**。

**对我们的映射**：superseded/withdrawn 等价于 revoked，且我们走来源授权
（比 TEPA 的模型自判冲突更保守）。TEPA 的相位化协议（stable/light/
reversal/return 四相分别报告 vs no-memory）应直接抄进我们的 efficacy 评测。

### MemDelta（2606.29914）—— 评测混淆变量协议（精读）
**协议**：五阶段配对流程 reset→ingest→build-context→answer→judge；
每对比较只变一个组件；McNemar 配对检验 + bootstrap CI；配对设计下
judge 恒定偏差在差分中抵消。

**关键数字**：
- S0 无记忆 2.2%、随机检索 3.2%（证明任务确实需要记忆，随机基线必须有）。
- agent self-memory 42.0% < verbatim RAG 47.2%。
  "Compression is a wager: each write decides what future questions
  will not need."——压缩是赌注，这正是不做全文压缩的架构论据。
- 只换 embedding：47.2→53.4%（+6.2pp, p=0.004），翻转 Mem0-vs-RAG 结论。
- Mem0 vs cloud-RAG 打平（72.7 vs 73.9, p=1.0）但写路径 1000+ 调用 vs 0（50×）。
- **Sonnet 在 115K 全文下 63% 显式拒答**（截到 47K 降到 41%）；且失败模式
  按题型分裂：事实题拒答、偏好题不拒答但幻觉 83%——
  单一准确率数字掩盖了质的差别，我们的答案闭集分类（stale/conflated/
  fabricated）正是这个思想的实现。

---

## 二、"检索到 ≠ 用对"——读者层失效（最深的坑）

### Stale Binding（2609.38866）—— 新旧值都在 context 里仍答旧值
**现象**：2048 条操作日志上 GPT-5.6 Sol 9/40、Opus 4.8 18/40 答对当前态；
同一内容的静态快照问答 40/40。错误几乎全是 old-value reuse，非张冠李戴。

**机制（精读）**：
- **复述效应**：旧值若在查询附近被复述，旧值错误率 75.5-94.5%，且
  94.5-100% 的旧值答案就是被复述的那个值。
  → **serve 层并列呈现"旧值 X → 新值 Y"本身是污染源**。
  显式标记为 historical 只能把错误降到 25.5%（部分缓解，不能根治）。
- probe 能在错误回答时仍以 84.8% 概率恢复新值 → **选择失败不是知识缺失**。
- attention drift：失败时旧值注意力占比 +19.4pp，集中在晚层 + 旧值 key。
- **维持性要求（最重要）**：写入时修正注意力，若提问紧跟则修复率 92.8%，
  若中间再隔几轮只剩 8.7% → **有效性必须在每次查询时重新裁决，
  不能"写时修一次就完"**。这从模型机制上支持我们的 serve 时校验设计。
- 作者的 attention-routing 修法需要内部访问+校准，API 模型不可部署
  → 对生产系统，唯一现实解法是 L1/L2：**别喂旧值**。

### STALE（2605.06527）—— 隐式冲突与裁决鸿沟
**形式化（精读）**：Implicit Conflict = 两条公理——
①信念不相容（m_n ⊨_K ¬v_o(a)）；②非显式失效（全对话无任何显式否定）。
Type I 同属性隐式取代；Type II 跨属性级联（b→a 依赖链失效，
= 我们的 PENDING-02 依赖失效问题，文献确认是最难档）。
生成用 Logic Attacker 对抗式合成 m_n，judge 过滤句法捷径线索；
干扰会话经保守过滤保证冲突归因唯一（与我们的因果屏障同思想）。

**三维探测**：SR 显式探针 / **PR 预设抵抗**（提问预设旧态，最好模型仅 30%，
我们没有这类探针）/ IPA 无提示自然运用。
最好系统 55.2%；**外挂记忆框架多数不超裸模型**（LightMem 17.8% vs 8.7%）。

**裁决鸿沟（关键数字）**：新证据 top-20 可见率 77.5%，旧证据 top-1 占 88.2%；
写入时召回含旧证据的案例中仅 3.3% 被判需更新。
"可见性 ≠ 权威性"——必须让旧值进不了候选（我们的硬退役思路）。

**CUPMem 原型**：写侧裁决 KEEP/STALE/REPLACE/UNKNOWN + 拓扑触发的
级联失效搜索（沿属性依赖图扩候选）——与我们 Selector + 服务态 retired
同构；其 propagation-aware search 是 PENDING-02 的候选实现方向。

### Mem2ActBench（2601.19935）—— 记忆→行动，失败分类迁移
- 400 工具调用任务，91.3% 人工确认必须靠记忆；EM 仅 14-18%，
  即使工具选对率 93%+——**瓶颈是参数 grounding 不是检索**。
- **失败分类迁移律**：框架越强，失败从 retrieval-miss 转向
  retrieved-but-unused（后检索推理）——强系统死在"给了不用"。
- 最大 grounding 错误源 = **hallucinated default**：值根本没出现过，
  模型却生成貌似合理的默认值——我们的答案分类应加 fabricated-default 维度。
- 防泄漏：Blinded LLM Discriminator——不给记忆让模型猜参数，
  猜得出来就拒收该题。可直接借来验证我们的探针真·依赖记忆。

---

## 三、规模、成本、饱和

### Stored Evidence（2605.07313）—— 证据随无关历史堆积而不可用
**协议（精读）**：金证据固定、只加无关会话（evidence-preserving scaling）；
**预算事后判定**（rollout 不截断，成功要求 R(τ)≤B）——
我们的探针可同样不限调用、报告预算合规率。
四个指标：Pass@B 预算合规可靠性 / P90R 尾部长尾调用 /
p_exh 预算耗尽 vs p_wrong 预算内答错（失败分解，不是单分）/
s*_α=0.7 崩溃起始规模。
结果：HippoRAG 三个模型上都掉 16-20pp（证据不变！）；
LiCoMemory 在 8B 上 s0 就不及格、32B/235B 全程在线。
**可扩展性是 agent×接口×规模×预算的联合属性**，不是存储属性。

### Anatomy（2602.19320）—— 综述+实证的四个坑
1. **Context Saturation Risk**：LoCoMo ~20k、MemBench ~100k token 都在
   128k 窗口内→全上下文直接可解，记忆价值被高估。三个结构轴：
   体积/交互深度/实体多样性。→ 我们 none baseline + 更长轨迹是必须。
2. 指标有效性：F1 词面重叠漏语义；judge 对 prompt 敏感需校准。
3. backbone 敏感：弱模型上结构化记忆操作格式错误率 17.9→30.4%
   （静默腐化）→ 印证服务端严格校验的必要性。
4. **Agency tax**：MemoryOS 读延迟 32s、AMem 建索引 15h、Nemori 7.04M
   tokens 构建；"维护吞吐跟不上写入→记忆变陈旧"——
   我们 25/25 全是排空后分数，这个警告直接适用。

---

## 四、数据生成与评测框架

### EvolveScaler（2609.08435，已存）—— 状态演化语料的正确做法（精读）
- spec（人写操作规范：状态转移+记录有效性+难度控制+答案逻辑）→
  LLM 合成自含模拟器 → 执行渲染 NL 历史 → **确定性重放出答案+原子 checklist**。
  硬约束编译成 transition guard 而非散文要求（库存不能为负、退款不超额）。
- 117 任务原型、159 问题算子、5 难度档（~7 到 ~1200 事件）。
- **错误分解（对我们答案分类最有参考价值）**：
  Net-Change Aggregation ~46-56% 占绝对大头（选对记录但合成错）；
  Invalid-Record Handling ≤5.5%（挑有效记录本身不难）；
  Retrieval&Counting 17-21%；Ranking&Tie-Breaking 19-30%。
  → 读者层的瓶颈在**聚合**，不在有效性识别——和 stale binding
  （选择层失败）互补，说明答案层失败要再细分。
- pass@5 vs avg@5 分离"偶尔对"与"稳定对"——可靠性指标可借鉴。
- 训练：6k 例在 8 个独立 OOD 基准全涨（avg +5.25），混合档最佳。

### LongMemEval（2410.10813）—— 经典基准（精读）
- 五能力含 KU 知识更新 与 **ABS 弃答**（30 道 false-premise 题，
  正确答案是"我不知道"= 我们的 abstain-ok）。
- 证据**间接嵌入**任务对话（不说"我买了车"而在问保险时带出）——
  我们 gen_l2 可借鉴的增难手法。
- 商用记忆系统 0.33-0.58 vs 离线读 0.92（掉 37-64%）；长上下文模型
  掉 30-60%；judge 与人类一致率 97%。
- 三阶段框架 indexing/retrieval/reading：round 粒度优于 session；
  键扩展 +9.4% recall；CoN/结构化读取在完美召回下仍 +10pp——
  又一次证明读层独立于检索层。

### Memory Contagion（2606.23195）—— 偏差跨时间经记忆传播
- oracle 完美固化下长度偏差仍传播（Γ=13.18）；**有偏输入即充分条件**。
- 分解：内容 E1 ≈ 检索 E2（内容略大）；去偏效力长度 0.90 / 权威 0.51。
- 无安全阈值：p=0.2 已可检出；且模型代际敏感（V4-Chat 易感，
  V4-Pro/Sonnet 4.6 免疫）。
- 诚实点：权威偏差的 Γ=11.45 来自不可复现单跑，15 次受控重复全为 0，
  作者明确标注不当作结论——这种诚实分级值得我们报告效仿。
- 对我们的映射：defer_credit 若按有偏反馈归因会把偏差固化进 V/池位置；
  **反馈资格本身要被裁决**（使用≠正确）。

---

## 五A、第二波精读：写入侧与固化风险（前四层模型之外的新维度）

### Useful Memories Become Faulty（2605.12978）—— 最重要的单篇
**问题**：LLM 持续把轨迹固化为文本记忆库（CLIN/AWM/ACE/Dynamic Cheatsheet
式的 update-after-every-interaction），是否可靠？
**答案：不可靠。** 记忆效用先升后降，可跌破无记忆基线；**从 ground-truth
解答固化**的极端条件下，GPT-5.4 在 ARC-AGI 上从 100% 跌到只剩 46% 答对
（54% 答错）——输入无可挑剔，损坏发生在固化步骤本身。
**三个机制**：①误分组（把不同结构的 episode 池化）；②适用条件被抽象剥掉
（overgeneralized 条目干扰邻任务）；③窄输入流下过拟合已见实例。
**顺序敏感**：Static-All 与 Stream 产出质上不同的记忆；一个任务的更新
覆盖另一任务的记忆。
**对照**：episodic-only（原始轨迹直接当演示）已与固化方法打平；
给 retain/delete/consolidate 三动作的 agent 默认选保留原文，准确率
是强制固化组的 2 倍。
**对我们的直接印证**：L0 原文一等公民 + consolidation 默认关 +
固化须显式门控，全是文献验证过的正确默认；且"保留原文"
正是我们不做有损压缩的论据。

### MHM 递归记忆（2607.01523）—— capture/retention 分解
递归固化型记忆性能随长度系统性下降。分解后发现：**捕获率全程稳定，
保留率 896K token 时跌破 30%**——单调文本块每次更新都可能覆写旧内容，
第 t 步写入的信息要活过 T−t 次覆写。
修法：多头分区 + select-then-update（每步只写一个头，其余结构性屏蔽），
保留率→73.96%，免训练。
**对我们的印证**：版本化条目（只在原地 supersede/retire，从不整段重写）
正是"把保留负担从模型行为转移到结构设计"的同一思想；Reviewer 的
consolidation proposal 若将来开启，应遵守"不可整段覆写"约束。

### Supersede（2606.27472）—— 把我们的问题变成可训练信号
- 真实对话数据上：全上下文 92% → 有界自维护记忆 **77%**（gpt-5.4，
  McNemar p<0.005）——**记忆维护吃掉 15pp，前沿模型也不例外**。
- 会话增长 24×：68%→28%；**同比例放大记忆容量无恢复**（28→28, n=25）：
  失败追踪会话长度而非压缩比。
- 三个"简单出口"都被堵死（更大模型✗、更大记忆✗、更强嵌入✗），
  唯一出路是**训练记忆维护策略本身**（GRPO 9%→16.7%，单跑）。
- 产业佐证：OpenAI "Dreaming" 自报时效性更新成功率只有 75.1%
  （2024 年 9.4%）——**连头部厂商的自更新也没过 80%**。
- 附赠：Uddin et al. 的 FAMA（遗忘感知准确率，惩罚使用已失效记忆）
  就是 Supersede 的奖励来源 = 我们 answer 分类里 stale 类的判分器雏形。

### 时间冲突复现性（2603.15892）—— 评测方法学警告
DYNAMICQA 说"时间事实更抗拒外部 context"，MULAN 说"时间事实更容易
更新"——**两个已发表结论相反**。复现发现分歧来自：度量定义
（输出分布偏移 vs 答案翻转率）+ context 格式（自然 Wiki 段落 vs
程序化 "Imagine that..." 句式）+ 只用 7B 模型。
**对我们的直接警告**：注入上下文的**渲染格式**会改变"记忆是否被采信"
的测量结论——我们的 serve 渲染至少要在"自然陈述"和"结构化字段"
两种格式下各测一遍；判分指标不能只报一种。

### Track（2601.15495）—— 注入正确事实也可能变坏
向模型提供与参数知识冲突的**正确**事实做下游推理：收益有限，
**有时比不给还差**，且冲突事实越多越差；失败既有未忠实整合，
也有整合后推理本身出错。FKE（推理忠实于全部所需事实）+HP
（答案对且链忠实）两个指标可借。
→ 含义：即使我们的记忆全部正确，"注入"动作本身在与模型先验/近期
上下文冲突时就有净负风险——none 基线和"注入正确记忆的负收益"
必须同测。

### PI-LLM（2506.08184）+ 佯装遗忘（2410.00382）+ 实体追踪（2605.30233）
- PI-LLM：同键值被反复覆写后，答"最新值"的准确率对数线性跌到 0；
  错误系统性检索被覆写值；**显式指示"忽略旧值"几乎无效**；
  抗干扰能力与参数规模相关、与窗口长度无关。人类会平台化，LLM 不——
  缺 unbinding 机制。**读者不能被告知去遗忘，只能不喂旧值。**
- 佯装遗忘：即使微调过的 unlearning，中间层仍算出正确答案，
  最后一层才抑制——"遗忘"是浅层掩码。→ 我们的 retired 只是
  不进检索，不是让模型遗忘，语义一致。
- 实体追踪（ICML）：LM **不做增量式状态追踪**——只在查询出现时
  并行拉取相关 token；REMOVE 用脆弱的全局抑制 tag 实现，可预测一批
  失败模式。→ 机制级证据支持我们的存在前提：模型不维护持久世界态，
  需要外部载体；也警告"历史重放进 context"不等于"状态被追踪"。

## 五B、基准版图与系统对照（第二波）

| 论文 | 关键设计/数字 | 对我们的映射 |
|---|---|---|
| MemoryAgentBench 2507.05257 | 四能力 AR/TTL/LRU/**SF**；FactCon-MH 全员 ≤28%；BM25 在 SF 上打 Mem0(18%)/Zep(7%)/MIRIX(14%)；o4-mini 32K 上 80→14 | 选择性遗忘全业界未解；我们硬退役恰好绕开"同时看到新旧"的设定 |
| Memora/FAMA 2604.20006 | 既有基准平均固化深度 ~1 会话、mutation ≤3；FAMA 罚失效记忆复用；记忆 agent 仅边际改善 | 我们的探针要推高 mutation 深度才有区分度 |
| LongMemEval-V2 2605.12493 | "记忆=让 agent 成为有经验同事"；轨迹 haystack 至 115M token；AgentRunbook-R 三池（原始观测/状态转移事件/策略笔记）；premise awareness 题型；coding-agent 72.5% vs RAG 48.5% | 三池划分与我们 L0/事件/策略层同构；premise awareness=PR 探针又一例 |
| MemoryArena 2602.16313 | 记忆-行动-环境闭环、子任务相互依赖、潜在约束不重申；LoCoMo 饱和者在此崩 | T2/T3 终局的形状 |
| AgentMemBench 2608.00009 | 5 策略同 harness：EKV 全优、长距召回是分水岭（ICW/GEM ≤0.005）；CBS 靠 provenance 亚军；足迹成本 | provenance-aware 打分（对 gold session 而非索引）方法论可借 |
| StructMemEval 2602.11243 | 组织型任务（账本/todo/树/运行统计）检索法过不了规模阈值；LLM 不提示就认不出该组织 | C/M/A 结构价值只在组织需求任务上显现；失败模式含 record duplication |
| DyadMem 2610.03020 | Gold-Memory QA 78-96% vs 全管线 47.7%/57.4%；分阶段 Capture/Update/Recall 监督；**unsafe-deletion** 问题 | 阶段分解判分（我们 Gap_retrieve/Gap_read 前身）；unsafe-deletion=撤回误判的风险命名 |
| AMemGym 2603.01966 | on-policy 模拟用户+结构化状态演化轨迹；Write/Read/Utilization 诊断分解；off-policy 有 reuse bias | 我们的回放式评测是 off-policy，这是已知局限；长期要互动模式 |
| MPBench 2606.04329 | 4 写入通道（显式指令/系统提示/压缩固化/经验转程序）、9 漏洞、6 攻击类；prompt-injection 防线不覆盖记忆投毒；ASR~50% | 我们是"推断写入+服务端授权"，恰好堵 C1 直接写；experience-to-procedure=Reviewer 规则回喂的对应风险面 |
| SSGM 2603.11768 | 治理与演化解耦：固化前强制一致性验证+时间衰减+访问控制；三失效接口（摄入投毒/固化漂移/检索幻觉） | 概念框架=我们服务端裁决的文献化表达；无实验 |
| 反方 2604.27891 | 程序化任务上 LangGraph 编排**差于**同模型 in-context 自编排（多 1.2-1.7× 调用、引入新失败模式） | 警告：多 Agent 编排不是免费收益——需"无编排基线"对照 |
| SleepGate 2603.14517 | KV-cache 遗忘门 POC（793K 参数）；理论上干扰视界 O(n)→O(log n) | 概念有趣证据弱；引用 PI-LLM 现象即可 |
| Mem0 2504.19413 / Zep 2501.13956 / MemoryBank 2305.10250 | 生产基线：Mem0 判分 +26%、延迟 -91%；Zep 时态 KG 记 validity 区间、episode+semantic 双层（≈我们 L0+事实层）；MemoryBank=遗忘曲线起源 | Zep 的 non-lossy episode 层与 L0 同构，我们的差异在授权语义而非存储形态 |

## 五C、第三轮：最近邻系统、生命周期评测、RL 策略、投毒防御

### Eywa（2605.30771）—— 文献里离我们最近的系统
"evidence before belief"：Tier 0 不可变证据 + **零 LLM 的确定性信号检测器**
（日期/实体/金额/版本/ID/URL/引号串）；Tier 1 LLM 抽候选，再过验证
V = V_support（词面/模糊重叠）∧ V_hard（硬锚值须与源文完全一致）∧
V_subject（主语在支持窗口内）∧ V_act（保留否定与不确定性）。
143 样本审计：67.4% 候选无硬锚、仍走其余三条；132 条拒 11 条，
主因源重叠不足或**编造硬值**。对象模型：Evidence 不可变 / Signals
只追加 / Candidates 瞬态 / Beliefs 可修订带生命周期 / Links 只追加。
SQLite 权威，向量与图是**幂等投影**。读路径确定性多路由、零 LLM；
检索与回答分离以换读者模型。"Extraction is an index, not the memory."
结果：LoCoMo 90.19%、LongMemEval-S 检索充分性 88.2%、BEAM 81.45%。
**诚实标注**：单作者、公司白皮书性质、未同行评审、基准自跑。
**与我们的真实差异**：它的验证是词面/锚值级（"源文里有没有"），
我们是**授权级**（"谁、以何身份说可以改"）+ C/M/A 效用动力学 +
持久任务/因果屏障；它无三池、无 UPDATE 授权、无争议人审。
可互补：V_hard/V_act 可直接借作 Hauler 候选的服务端前置过滤。

### MemOps（2607.12893）—— 把"记忆操作"当评测单元
五类操作 Remember / Forget / Update / Reflect / **TrajectoryOps**（多操作
复合，要恢复中间态与顺序）；每个操作是结构化 trace（类型、目标、旧值、
新值、证据 span）。诊断指标：Operation F1 / Provenance / **Leakage Rate**
（被遗忘值复用）/ **Stale Value Rate**（回退旧值）/ Reflect Precision。
相邻证据与长上下文配对，2,006 QA → 4,012 实例。
- Sonnet-4.5 相邻 0.916 → 长上下文 0.790；**DeepSeek 长上下文反而略好**：
  新旧值紧邻时模型倾向复述整条证据链、被抑制值泄漏——
  **与 Stale Binding 复述效应独立互证。**
- **session 级检索 0.845 ≫ turn 级 0.618**；MemOS（长记忆单元）0.785 ≫
  Mem0（短抽取）0.543：Update/Reflect 需要跨轮上下文。
  → serve 命中事实时应附来源声明的局部上下文，不只给一句抽取结果。
- TrajectoryOps 长上下文下普遍最差；Temp-LoRA 参数化记忆 0.162。

### HaluMem（2511.03506）—— 幻觉按阶段定位
三任务抽取/更新/QA；~15k memory points、>1M token。结论：**幻觉在抽取
与更新阶段产生并累积，再传播到 QA**；boundary/conflict 题相对好，
多跳/动态更新/泛化差；**写阶段是计算瓶颈**（Mem0 ingest 2768 分钟 vs
检索 42 分钟）。→ Hauler→Selector 两步都是幻觉入口，服务端校验位置对；
写路径成本要进报告。

### Memory-R1（2508.19828）/ Memory-R2（2605.21768）—— RL 学记忆策略
R1：Manager 学 ADD/UPDATE/DELETE/NOOP + Answer Agent 学过滤 60→1；
152 条 QA 即超 Mem0。**奖励教训**：LLM-judge 作奖励学出冗长答案、
F1 反降；EM 奖励更均衡——奖励形态塑造输出形态。
R2 直击我们的理论难题：**记忆使环境非平稳**——本轮写入成为后续环境，
不同 rollout 中间记忆态不同，GRPO 组内比较失公平；轨迹级奖励分不清
"本轮操作错 / 继承坏记忆 / 后续覆写了好记忆"。解法 LoGo-GRPO：
全局分支保留轨迹奖励；**局部分支从同一缓存中间记忆态重 rollout
只重做第 t 轮**再比较；加 M-Fail（必需证据缺失率）；8→16→32 课程。
**这是我们"因果屏障 + 冻结回放"的 RL 表述**：同态出发比较不同操作，
功过才能算到操作头上；defer_credit 的理论依据——无同态对照，
使用统计就是噪声。另：固定强 answer agent 作奖励源，理由与 MemDelta
固定读者相同。

### 投毒防御（05 目录新增）
- **MemLineage（2605.14421）**：投毒当 chain-of-custody 而非过滤问题。
  逐条签名 + Merkle log + **加权派生 DAG**（哪些被检索条目影响了新写入）
  + max-of-strong-edges：外部祖先经强边链到达的条目继承 untrusted，
  敏感动作门拒绝。核心威胁 **memory laundering**：外部内容经 LLM 摘要
  重写成"本 agent 亲笔"条目，签名层无法分辨。K=5 跳派生时阈值要收到
  ≤0.10。→ **Reviewer 规则回喂与 consolidation 正是派生写入通道**，
  若开启需保留派生边。
- **Price of Safety（2609.22818）**：写时防御（清洗/provenance/异常检测）
  在良性流量上**无可分辨效用损失**；读时 reranker 掉 4.4 分且 **33.6%
  合法记忆被误隔离**。T=0 三次复跑结果仍不同，单跑结论曾是伪影。
  → 我们校验在写侧，位置对；**误拒率必须进指标**。
- **Misattribution Gap（2605.22842）**：记忆层攻击与模型失调行为**不可区分**
  （Two-Pipeline Indistinguishability）；64 次失败全被归咎模型；四个安全
  分类器 510 检查点零检出；59/65 案例把注入文档当规范权威引用。
  Counterfactual Composition Testing 定位致因条目 87.5%。
  → **答案错了先查记忆再怪模型**，L0 可追溯是前提。
- **Salami / MemCollusion（2608.01637）**：多条**单看无害**的记忆联合诱导
  不安全行为；MSR 81.3%、ASR 75.0%，稀释与逐条过滤下仍有效。
  → 逐条 Selector 校验防不了组合攻击；V 累积/晋升若被"切片"喂养同样
  放大；TEPA 式晋升污染检查是少数能看到组合效应的闸。
- **ConvoMem（2511.10523）**：前 30 次对话全上下文最优、150 次内可行；
  Mem0 等在 <150 次历史上 30-45% vs 全上下文 70-82%。记忆系统的独特性
  是"从零增长的小语料"。→ 短历史阶段我们必须赢过"全上下文"，
  不只是赢过 RAG。

### 07 目录其余（已下载、仅读摘要）
MemPO 2603.00680（自记忆策略优化）、AgeMem 2601.01885（LTM/STM 统一
管理）、Mem-α 2509.25911（RL 学记忆构建）、Mem-T 2601.23014（稠密奖励）、
AtomMem 2601.08323（原子操作可学习）、DeltaMem 2604.01560（RL 持久记忆
管理）。共同点：奖励都是任务结果或证据相关性，**无一以"当前值正确性"
为奖励**——Supersede 的差异点成立。A-MEM 2502.12110（Zettelkasten 式
互链笔记）进 06。

## 五D、第四轮：四个记忆主体 + 读者侧的机制底层

### 记忆的"主体"不是一个，是四个（新分解）
把文献按"记忆内容是谁"重排，四类主体的失效物理完全不同：

| 主体 | 内容 | 代表文献 | 特有失效 | 生命周期语义 |
|---|---|---|---|---|
| 世界事实 | 外部状态、声明值 | TEPA/STALE/Supersede | 过时、撤回 | supersede/withdraw（可作废） |
| 用户画像 | attributes/habits/preferences | DynamicMem/PersonaMem-v2 | 从不明说、不同时间尺度漂移 | 异构：离散跳变/中程惯例/长程渐变 |
| 关系状态 | 谁说、对谁说、共同约定 | GroupMemBench | 说话人归属被抽取抹掉 | 同一句话不同人说→不同更新 |
| 自我履历 | 经验→程序、教训 | MemoryGraft/Zombie/TAME | 假经验、安全漂移、投毒固化 | 不能"撤销"只能"学到教训" |

**我们当前架构主要覆盖第一个主体**（事实记忆 + 少量关系元数据）。
后三类各有文献证实是独立失效源，不能靠事实层顺带解决。

### DynamicMem（2606.22877）—— 画像类记忆的三个硬事实
15 个月 × 2.2M token × 16 应用 × 1,772 事件/用户；五个季度检查点。
- 画像重建随历史增长**持续下降**，而服务任务准确率持平——同一记忆，
  两种读法寿命不同。
- 没有系统能同时"留住不变事实 + 覆写变化事实"；错误集中在
  **偏好**（用户从不直说，必须推断）和**实体命名**（哪个健身房、哪个工具）。
- **>93% 的失败追到检索端**，不是回答模型——头房间在记忆本身。
→ 偏好类记忆天生没有"用户声明"可供授权校验——我们的来源授权
句法对偏好类失效源覆盖为零，这是比 PENDING-02 更底层的覆盖缺口。

### PersonaMem-v2（2512.06688）—— 隐式人格的读者上界
1000 画像、20k+ 偏好、128k context；前沿模型隐式人格识别仅 37-48%；
GRPO 训的 4B 到 53%；他们的 agentic 记忆（2k token 压缩档）55% 且省 16× 输入。
→ 隐式信号（没说出口的偏好）是画像类主战场；同时注意：**他们的"记忆"
就是一份单调增长的人类可读文档**——MHM 警告的形态，只因域窄（人格）才成立。

### GroupMemBench（2605.14498）—— 关系主体的存在证明
多人会话三轴：群体动力学 / **说话人信念追踪** / ToM 受众适配词汇
（"token"对 NLP 人和对安全人意思不同）。最强系统仅 46.0%，
知识更新 27.1%、术语歧义 37.7%；BM25 打平多数记忆系统。
根因一句：**现有摄入管线把说话人身份和词域结构抹掉了**——
"同一句话谁说的"决定该不该更新、答案给谁听。
→ Hauler 抽取若丢 speaker/audience 元数据，关系主体直接残废；
这给我们"候选必须带主语窗口校验"（Eywa V_subject）又一个理由。

### CL-Bench（2602.03587）—— 读者侧的天花板比想象低
500 专家构造上下文、1899 任务、31607 条 rubric；答案全在 context 里、
不需要检索，只考"从 context 学"。十前沿模型平均 **17.2%**，最好 23.7%；
主因是模型忽略 context 呈现的内容。
→ 对 L3 是冷水：**就算记忆注入完美，读者能不能"学到并用上"本身是
业界未解的大问题**。serve 层把"已算好的当前态"直接给出来，
比给证据让模型自己重建更重要——rebinding 证据同向。

### Rebinding circuit（2606.08644）—— 机制层最后一击
干预实验定位到 ~3-10% 组件的注意力头电路：LLM **不做全局状态更新**——
保留原绑定，只在回答检索时对 binding ID 做局部重映射
（retrieval-conditioned rebinding）。家族差异：Gemma 在 q/k 子空间，
Llama 主要在 key 向量。
→ 实体追踪（2605.30233）的电路级确认：模型不维护世界态，
"重放历史"≠"状态被追踪"；stale binding 的微观机制——
多个旧绑定的 ID 竞争时抢错。外部记忆必须替它完成状态计算。

### 履历主体的三重攻击面（05 新读）
- **MemoryGraft（2512.16962）**：毒的是"成功经验"——程序模板。
  利用语义模仿启发式，无触发器、语义相似即激活、跨会话行为漂移。
  只需往 README 一类"会被读的东西"里埋假经验。
- **Zombie Agents（2602.15654）**：载荷针对滑窗和 RAG 各自的
  淘汰/过滤逻辑**反向定制存续策略**；单会话 prompt 防线对
  跨会话持久化无效。写路径本身就是攻击面。
- **TAME（2602.03224）**：**无攻击者也漂**——纯任务分数驱动的记忆
  演化会系统性侵蚀安全对齐（misevolution，部署时 reward hacking）；
  Executor-Evaluator 信任感知反馈缓解。GPT-5.2 AIME +14.6pt。
→ 履历/程序性记忆（我们的 Reviewer 规则回喂、将来 consolidation 产物）
同时暴露在假经验、对抗性存续、良性漂移三条路上；MPBench 的 C4
通道 + TAME 的无攻击者漂移 = 这类记忆必须走最严准入 + 信任维度反馈。

## 五E、第五轮：context 工程 × memory 工程的协作界面（08-context-memory）

### 两篇把边界写死了的论文
**Root Theorem（2604.20874）**：两条公理（窗口有限 + 质量随注入量单调衰减）
推出"最大化信号/token 比"是唯一目标，五个推论里两条直接规范我们的接口：
- **append-only 必然在有限时间内越过有效窗口**——纯追加不是架构；
- **"homeostatic persistence"（accumulate→compress→rewrite→shed）是唯一可持续形态**——
  即我们的 C→M→A + 维护循环；
- 关键第五条：**压缩器在被压缩的信道内运行，所以验证门必须外部化**——
  "compression paradox"：压缩触发太晚，压缩本身已在衰减区运行，
  有损输出继续向前传播。→ 这是服务端校验的理论依据：
  agent 不能给自己做压缩的验收。

**Missing Memory Hierarchy / Pichay（2603.09023）**：857 生产会话、44.5 亿 token
实测：21.8% 是结构性浪费（未用工具 schema 11%、重复 2.2%、陈旧工具结果 8.7%，
中位 84.4× 重复处理）。核心论断：**context window 是 L1 cache 不是 memory**，
四层层级 L1 生成窗口 / L2 工作集（按需分页）/ L3 会话史（声明有损的压缩）/
L4 跨会话持久记忆——**L4 被明确点名为"剩余前沿"，就是我们的层**。
按需分页实现：evict 陈旧内容、模型再请求=page fault、fault 史驱动 pin；
离线 fault 率 0.0254%，生产 context 消耗 −93%，极端压力下出现 thrashing。

### 分工界面（文献收敛出的契约）
| 职责 | 归属 | 文献依据 |
|---|---|---|
| 什么存在、真值状态、谁能改 | memory 工程 | admissibility/生命周期（2610.07309） |
| 什么驻留、什么保真度、什么预算 | context 工程 | Pichay/ClawVM/ACM |
| 驱逐后还被需要 → fault，须可观测可回放 | 界面 | ClawVM fault model、Pichay fault-driven pin |
| context 侧状态写回记忆 → 须校验、非破坏性 | 界面 | ClawVM staged writeback；Root Theorem 外部门 |
| "对当前请求合用吗" ≠ "相关吗" | 界面 | 2610.07309 查询条件化 admissibility |

**ClawVM（2604.10352）**：把契约放在 harness（prompt assembler+tool mediator+
生命周期事件）——"harness 是天然执法点"。typed page + 最低保真不变量 +
多分辨率表示 + 每个生命周期边界的 validated writeback + 可观测 fault。
现场失败目录：post-compaction bootstrap loss / reset 时 flush miss /
destructive writeback。min-fidelity 集放得下时 fault 归零。
→ 和我们"服务端验证"同一个执法点论证，独立得出。

**ACM（2607.23809）**：agent 自主决定何时压缩，**丢弃内容无损 offload 到外部
记忆**再按需查回（短程/长程记忆分工；Qwen3.5-9B 训练后 +27% BrowseComp-Plus）。
关键设计词是 **lossless offload**——从 context 消失 ≠ 从系统消失。
这是"context 淘汰"与"记忆撤回"的正确关系：前者是驻留决策，后者是真值决策。

**ACE（2510.04618）**：brevity bias + context collapse（整体重写逐轮侵蚀细节）
的解法是结构化增量 item（条目级 append/merge，不整段覆写）——
与 2605.12978 "版本化优于块重写"在 context-playbook 侧独立同解。
+10.6% agent / +8.6% finance，无标签只靠执行反馈，DeepSeek-V3.1
在 AppWorld test-challenge 超 GPT-4.1 生产 agent。
→ ACE 是"履历/程序性记忆"以纯 context 形式实现的替代路线：
把 playbook 当记忆。我们 S·04 主体的竞争者就是它。

**Retrieval Admissibility（2610.07309）**：relevant ≠ admissible。
同一记录对"现在是什么"不可接受、对"怎么变的"必不可少——
**可接受性是查询条件化的，不是记录属性**。三态裁决
（admissible/inadmissible/unresolved）+ matched-recall 对照 +
exposure→disclosure 链：可信 namespace 预筛 top-20 锚点召回 0.432→0.533、
精确相似评测工作量 −98.3%（结构上不可能变差）；4 个读者里 1 个在
"相关但不可接受"曝光后出现字面泄漏（+0.156）。
→ 直接外部验证我们的 scope/生命周期过滤：命名空间隔离是结构性收益；
并给出新指标：inadmissible exposure 率（被注入≠被采用也要罚）。

### 协作界面新增度量
fault 率（被逐出后又被请求）/ admissible 违规率（matched-recall 下）/
exposure-vs-disclosure 分离 / writeback 保真度 / bootstrap-loss 计数 /
thrash 比（fault 多于有效工作）/ min-fidelity 驻留达标率。

## 五、五层缺陷模型（三轮后的总图）

| 层 | 缺陷 | 文献修法 | 证据强度 | 我们的位置 |
|---|---|---|---|---|
| L0' 写入忠实度 | 固化/压缩每步有损，环境非平稳 | 保留原文、门控固化、同态重 rollout（Faulty / MHM / R2） | **强**（GT 输入仍 46% 错） | L0 原文 + consolidation 默认关 + 因果屏障 |
| L1 生命周期 | 旧值永不退出 | 撤销语义（TEPA） | **强**（翻转符号 0.21→0.95） | 已有且更保守（来源授权） |
| L2 裁决权威 | 可见≠被采信 | 写侧裁决（CUPMem/我们） | 中（原型级） | Selector+retired 同构 |
| L3 读者层 | stale binding、预设顺从 | 不喂旧值+标记历史（部分） | 中（机制已证实，修法只缓解） | 硬退役对，dispute 标记雏形 |
| L4 反馈归因 | 有偏输入自我强化 | 输入侧裁决 | 弱（单篇、类型依赖） | defer_credit 雏形，资格裁决缺 |

**最大真缺口**：隐式失效（STALE Type I/II = PENDING-02）——授权句法
覆盖不到"用户没说改但世界变了"；文献确认这是最难档，
CUPMem 的 propagation-aware search 是候选方向。

**第二缺口**：排空假设（Anatomy agency tax）——维护吞吐跟不上时
记忆未消化就被检索。需要"未消化标注"或排空感知降级。

**第三缺口**：PR 预设抵抗——用户提问预设旧态时模型顺从率 70%+，
serve 层应显式标注"该前提已失效"；我们没有这类探针。

## 六、可证伪的验收（从文献直接继承的协议）

1. TEPA 相位协议：stable/light/reversal/return 分相报告 vs no-memory；
   **reversal 相 > no-memory 才算撤销机制兜底**。
2. MemDelta 单变量协议：每次只变一组件+配对检验+随机基线+写路径成本。
3. Stored Evidence 失败分解：p_exh vs p_wrong，预算事后判定。
4. EvolveScaler 答案错误分解：选记录错/聚合错/排序错分开。
5. pass@k vs avg@k 分离偶尔对与稳定对。
6. MemOps 操作级诊断：Leakage Rate（撤回值复用）+ Stale Value Rate
   （回退旧值）+ Provenance support，与答案准确率并列报告。
7. Price of Safety 良性代价：服务端拒收的**误拒率**（false quarantine）
   在无冲突流量上单独测；同配置至少三次复跑才下结论。
8. Memory-R2 同态对照：反馈/credit 归因必须以"同一记忆态下不同操作"
   为比较单位，不能跨已分叉的轨迹比。
9. Misattribution 顺序：答案层失败先做记忆层反事实（去掉候选条目重答），
   再归因读者模型。

## 七、文献没覆盖的（我们的差异点）

- 没人同时做：不可变证据层 L0 + 来源授权 + 持久任务/因果屏障 +
  池容量动力学，再在答案层测净收益。
- "错→对修正率 / 对→错污染率"联合配对指标：TEPA/MemDelta 各测了一半。
- 来源授权 vs 模型裁决两条冲突消解路线的对比（覆盖率 vs 误授权）。
- spec-first 账本用于**记忆系统侧**（边 ingest 边因果探针）：
  EvolveScaler 只做了"全历史给读者"的读侧版本。

## 备查（五轮后仍未读/未下载）
EMem/Zhou&Han（简单检索超复杂架构）、MemProbe（用户态恢复审计）、
MINJA、EverMemBench（多方协作，GroupMemBench 表 1 引）、
MemPoison×2（2605.29960 / 2607.14651，已下载未精读）、
BEAM、AgentLongBench、EMemBench、AMA-Bench、FileGramBench、
MemAgent（2507.02259）、MemFactory（2603.29493）、
PerLTQA（2402.16288，已下载未精读）、
MemPO / AgeMem / Mem-α / Mem-T / AtomMem / DeltaMem（仍摘要级）、
CE 2.0（2510.26493）、Context-Folding（2510.11967，无 HTML 仅摘要）、
AgentFold（2510.24699）、Context-as-Tool/SWE（2512.22087）、
Learn-CM（2605.30785）、Memory-as-Tool（2601.05960）、
Agent-Memory-Second-Half 综述（2602.06052）、Oracle Agent Memory（2607.13157）、
MemGPT（2310.08560）、MemOS（2507.03724）（摘要级）。

## 文件位置
PDF 已按主题分入 `reference/0X-*/`，见 `reference/README.md`；
本笔记只引 arXiv ID，文件名前缀即 ID。
