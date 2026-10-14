# 深读文献逐篇卡片（11 篇）

对 `notes-agent-memory-efficacy.md` 主题式笔记的补充：每篇一张卡——
方法 / 协议 / 关键结果 / 局限 / 可抄点。数字均为论文自报，未复核 artifact。
阅读证据：正文逐段（问题定义→方法→结果表→失败分析→limitations）。

---

## 1. TEPA（2608.07429）— 可撤销先例记忆

**一句话**：把记忆建成带生命周期状态的键控先例，污染被证明可修。

**方法**：precedent `p=(k,v,s,f,σ,τ)`——冲突键 k、断言值 v、支持/冲突计数、
状态 σ∈{Hypothesis, Active, Revoked}、创建时间。Beta-Bernoulli 后验
`q=(s+1)/(s+f+2)`；同键新证据到达时同值 s+1、异值 f+1；
q<θ_rev（n_min=5 次观测后）或近期成功率<θ_rec=0.34（n_rec≥3）→ Revoked
进 archive（可审计、可再晋升），检索只吃 Active。
TEPA-Full 增加试用晋升：候选先过 3 次试验（1 支持 + 1 反事实 + 1 无关域
污染检查），≥60% 正且 ≥1 次支持成功才晋升。

**协议**：相位化流（stable→light→reversal→return），50 seeds，分相位对
no-memory 报 MPI（pollution index = 相对 no-mem 的差）；机制基线同后端同
评测器：append-only / temporal recency / semantic / sliding window /
reactive forgetting / last-write-wins / oracle reset；bootstrap CI +
单侧配对置换 + Holm 校正。

**关键结果**：
- 受控反转：append-only 0.210 < no-mem（污染成立），TEPA 0.950；
  reactive forgetting 0.796，oracle reset 0.812。
- 可执行文件 I/O 复现：append 0.203 < no-mem 0.298（MPI=0.319），TEPA 0.950。
- 偏好更新流：append 0.138 vs no-mem 0.837；LWW 0.686 仍低于 no-mem；
  LWW+同一验证规则 0.863；TEPA-Full 0.910 ≈ no-mem（差 0.002, p=1.0）。
- SH-6k：TEPA-Rev 0.890 = last-write-wins（净单跳下当前键替换即足够），
  NoRev 0.630，append 0.583。
- 消融：去撤销 → 0.211（等于 append）；θ_rev∈[0.2,0.4]、θ_pro∈[0.5,0.7]
  稳健；过大 recent window 是主要负离群。
- **边界**：SH-32k 0.680、MH-6k 0.040、SH-262k 0.000——事实级撤销
  不解决多跳链构造与超长上下文选择。

**局限**：假设冲突键可抽取（开放记忆更难）；键噪声下平滑退化但确有退化；
机制基线共评测器，非跨实现对比。

**可抄**：superseded/withdrawn/retired 三态与其同构但更保守（我们要求来源
授权）；晋升前的"无关域污染检查"可加到 C→M 晋升；相位协议 + MPI 是
"修好没有"的验收范式；ξη>b 的污染形式化可直接用作判别式。

---

## 2. STALE（2605.06527）— 隐式冲突基准 + CUPMem 写侧裁决

**一句话**：把记忆建模为潜在用户状态追踪，第一个系统评测"没被明说的失效"。

**方法**：属性集 A、值域 V_a；隐式冲突两公理——信念不相容（m_n 在世界
知识下蕴含 ¬v_o(a)）+ 非显式失效（之后无任何语句明说）。类型：
Type I 共指（同属性新值，不提属性名）/ Type II 传播（更新属性 A，经
常识依赖 A→B 级联废掉 B 的旧值）。CUPMem 原型：写侧裁决候选集
`C_t = Direct(Δ_t) ∪ Affected_θ(Δ_t,Ω) ∪ Global_k`，裁决器输出
KEEP/STALE/REPLACE/UNKNOWN；读侧受限——active=grounding、stale=仅历史、
unresolved 阻止旧值当前提。

**协议**：本体分层主题采样 persona→生成 m_o→"逻辑攻击者"造 m_n（Type II
用"推理小说家"人设埋隐线）→严格裁判三标准（独立合理性/状态冲突/隐式性，
句法明显的直接拒）→多轮会话包装→haystack。400 专家复核场景、1200 查询；
探针含 premise resistance（预设旧态的抵抗力）。

**关键结果**：识别过时 ≠ 应用更新；模型对预设旧态的查询抵抗力近零；
Type II 全面最难。CUPMem（同 GPT-4o-mini）整体 8.7%→68.0%，
PR 78.0%/75.0%（Type I/II）vs 基线近零——**写侧裁决把预设抵抗从
读者侧难题变成状态侧已决问题**。

**局限**：属性 schema 化（开放域未覆盖）；CUPMem 只是原型、单模型；
级联只到一跳依赖。

**可抄**：Type II = 我们 PENDING-02 的文献对应，授权句法永远触发不了它；
三探针（识别/应用/预设抵抗）是我们 efficacy 评测应直接继承的轴；
"unresolved 槽阻止旧默认值当前提"是 serve 层的具体动作。

---

## 3. Stale Binding / CICM（2609.38866）— 新旧都在场仍答旧值的机制

**一句话**：stale binding 是选择瓶颈不是记忆缺失——当前值可读但被注意力跳过。

**方法**：CICM 基准=偏好对话更新 + 修订约束决策 + 操作日志三类；
matched-placement 阶乘（200 对话/条件）。机制分析四步：复述效应 →
线性探针查可恢复性 → 注意力漂移 → 组件替换因果干预。理论附录：RoPE
下无全局时近保证（得分函数 g(d) 是三角多项式、可复现反转）；
旧赋值累积命题——每加一个同键旧候选严格拉低 current/old 赔率；
无关候选不改两两赔率。

**关键结果**：
- 查询附近复述一次旧值 → 旧值错误率 75.5-94.5%；94.5-100% 的旧值答案
  就是被复述的那个；显式标"historical"只降到 25.5%。
- 探针：答错时当前值仍可恢复（84.8%/82.2%）→ 输在**选择**不在表征。
- 注意力：失败时 old-share 高 19.4pp，集中在晚期层；五模型复现。
- 因果：换晚期隐状态恢复 78.1%（早中层 -0.5）；换旧值 key 49.2%；
  Pythia 摘除旧值偏好头纠正 38.4%（随机对照 8.7%）。
- 注意力路由干预：紧邻查询修复率 92.8%，隔几轮只剩 8.7%——
  **修复必须在查询时维持，写时修一次没用**。
- 前沿：GPT-5.6 Sol / Opus 4.8 在复杂历史上照样答旧值（GPT-5.6 9/40）。

**局限**：部署中失败率未知；内部测量只覆盖开源模型；路由干预需权重访问
+标注校准+结构解析器，API 模型不可部署。

**可抄**：serve 层禁"新旧值并列呈现"（复述本身即污染）；有效性必须每次
查询时重裁决（我们 retired 不进检索是唯一能部署的修法）；
dispute 展示要带显式状态标注而非原文并置。

---

## 4. EvolveScaler（2609.08435）— 状态演化语料的代码先行合成

**一句话**：人写操作语义规格、LLM 合成可执行模拟器、执行重放定 gold——
难度可控、监督可验证。

**方法**：规格 Π（状态转移+记录有效性+难度控制+答案逻辑）→ LLM 按固定
生成契约合成自包含模拟器 P_Π（硬约束编译成 transition guard + 运行时
assert）→ 多变种子执行 + 不变量保持 + 确定性重放 + checklist 一致才保留
→ >20 标注员复核。五长度档 very_short→very_long，pass@5/avg@5 分报。

**关键结果**：14 模型中位 avg@5：71.2/67.8/50.5/21.9/11.3；
GPT-5.5-xhigh 72.8 居首，6 模型 very_long <10；难题档拉开区分度
（very_long 范围 4.8-59.3 vs very_short 59.0-81.7）。
**错误分解**：Invalid-Record ≤5.5%（挑有效记录不难）、
Retrieval&Counting 17-21%、**Net-Change Aggregation 46-56%（主死法）**、
Ranking&Tie 19-30%、Verdict 1-8.5%。训练迁移：A3B+GRPO 6k 例在 8 个 OOD
基准 +5.25 均分；混合长度 > 单档。

**局限**：离散、程序化指定的状态转移；部分观测/连续/多模态是未来工作。

**可抄**：失败三分解正交性——选错（stale binding）/ 选对不用（裁决）/
用了合错（聚合）是三种不同失败；我们答案分类缺"单条对、合成错"；
"原子 checklist 首失败项"是现成的失败定位协议。

---

## 5. Useful Memories Become Faulty（2605.12978）— 固化本身的衰减

**一句话**：每次 LLM 固化都是有损重写；原始轨迹才是最可靠的载体。

**方法**：ARC-AGI/ALFWorld/ScienceWorld/WebShop/AppWorld 多环境；
记忆操作 Auto（agent 自主 Retain/Delete/Consolidate）vs Force（每步强制
固化无 episodic 留存）；episodic buffer + abstract store 双池。
七框架（LangMem/Mem0/ProPlay/ACE/AWM/Letta/DynamicCheatsheet）×
5 backbone + OpenCode agent 全自主管理 + GEPA 提示优化对照。

**关键结果**：
- 全部框架至少在一种设置下从峰值退化；GPT-5.4 固化后在原 100% 题上
  答错 54%。
- OpenCode 自主管理也退：GLM-5.2 回到 no-mem、DeepSeek-V4-Pro 跌破。
- 填充到 ~790K token 变化 <4 分——不是长度伪影；GEPA 只部分挽回
  （且方式是让 solver 不信任记忆）。
- **episodic-only ≥ Auto > Force**：收益几乎全在原始轨迹里；agent
  自主时 episode buffer 先饱和、abstract store 始终稀疏。
- 失效机制：误分组（强制固化跨类合并；自主要 71 步才收敛干净分组）、
  干涉（重复抽象逐轮侵蚀至低于 zero-shot；任务切换覆写已学）、
  过概括（剥掉适用条件的"经验"在邻近任务上误导）。
- 原则：CLS 双系统——快 episodic + 慢 schema，抽象 opt-in 且门控。

**局限**：agentic 环境为主；固化退化是平均效应非逐例定律；ARC-AGI 流
是人工流。

**可抄**：`consolidation_on=False`、L0 一等公民、事实只版本化从不整段
重写——三个默认被直接验证；Reviewer 的 consolidation 提案若开启，
约束应为"不可整段覆写、适用条件必保留"。

---

## 6. MemoryAgentBench（2507.05257）— 四能力基准

**一句话**：AR / 测试时学习 / 长程理解 / 选择性遗忘四维分测；
选择性遗忘全业界未解。

**方法**：既有数据集重组 + 两个新数据集 EventQA（事件级插入问答）与
FactConsolidation（SH 直接替换 / MH 多跳冲突消解，6K 与 32K 两档长度）。
评测四类 agent：长上下文、BM25/dense RAG、GraphRAG、商业记忆 agent
（MIRIX/Mem0 系）。

**关键结果**：BM25 平均 38.8 > text-embed 31.0 > MIRIX 15.9 >
GraphRAG 14.7——**裸检索在冲突消解上打商业记忆系统**。
FactCon 验证：o4-mini SH 100@6K→61@32K、MH 80@6K→14@32K——
任务本身可解，死在长输入下的更新维护。
选择性遗忘（尤其 MH）是所有系统的最弱维。

**局限**：预算所限 agent 覆盖不全；substring EM 粗粒度；
选择性遗忘数据是合成的。

**可抄**：四能力分类是我们评测的骨架之一；FactCon-MH ≤28% 说明
"多跳冲突消解"是高区分度探针；BM25 对照是必含的地板基线。

---

## 7. Supersede（2606.27472）— 更新鸿沟的命名与测量

**一句话**：agent 不是读不懂更新，是在有界记忆下维护不了更新——
supersession gap。

**方法**：LongMemEval knowledge-update oracle（78 题）。
full-context（上限）vs bounded-memory：300 字符 notes 字段、逐会话
重写、原始会话不再回喂。规模实验：_s 分片 48 会话/122k token；
等比记忆（150 字符/会话 ≈7,150 字符）对照。配对 McNemar。
训练环境：程序化生成 2000 episode（6-8 会话，引入事实后被取代，
更新埋在干扰会话中），GRPO+LoRA 训 Qwen2.5-3B；程序化 matcher
（黄金值变体切分+0.6 token 重叠兜底；同时对陈旧值跑 matcher 罚分）。

**关键结果**：
- gap 显著且不随模型缩小：gpt-4.1-mini 82→63（p=.0035）、
  gpt-4.1 91→64、gpt-5.4 92→77（p=.0033；19vs4 / 13vs1 翻转）。
- 24× 历史长度在固定记忆下 68→28（p=.002）；**24× 记忆容量 28→28
  零恢复**——失败追会话长度不追压缩比。
- 失败形态：相关事实被压掉或没被覆写。
- 训练部分闭合：held-out 9.0→16.7%，单调、~step 100 奖励饱和时启动；
  175 步自终止（组内优势归零）。
- 产业佐证：OpenAI Dreaming 自报时效更新成功率仅 75.1%。

**局限**：规模实验 n=25（主结果 78）；distractor 增长≠被跟踪事实的
更新数增长；判分两套（judge vs matcher）不可直接互比；单训练种子；
3B 课程会饱和。

**可抄**：bounded-vs-full 差值是"记忆维护税"的直接度量；等比容量对照
是必做的混淆排除；"状态更新是策略不是白送的能力"支持我们走服务端
裁决而非指望模型自觉。

---

## 8. MHM（2607.01523）— 递归记忆的多头冗余

**一句话**：整体文本块每次更新都是赌博式覆写；分头+分步把保留变成
结构保证。

**方法**：多记忆头 + stage-wise 更新（先选头、再写内容，两步分开）。
对照：MHM-Concur（选头+更新合并一步）、MHM-Relevance（模型自选头）、
MHM-LRU（规则路由）。指标拆分 MCR（捕获率）/ MRR（保留率）。

**关键结果**：
- 诊断：捕获率全程稳定，**保留率随长度崩**——单调块 896K 处 MRR<30%。
- Concur：MCR 更高但 MRR 54.12 vs 73.96（896K）——并发指令复杂度
  让模型在写新内容时顺带擦掉已保留内容；**分步是关键设计**。
- Relevance：模型自选头比 LRU 差——相关性预测噪声使更新集中、
  其余头饿死；**规则路由胜过模型路由**。
- 跨模型：gpt-oss-120b MemAgent MRR<40% vs MHM-LRU 68.85；
  Qwen2.5-32B 78.02 vs 81.91；BABILong 10 任务全胜，QA4-6 关系链最大。
- 成本：短中长更快更省 token（112K 25.9s vs 31.5s；7K 142.8 vs 330.6
  token）——单头更新天然摊薄生成量。
- 案例：多头间自发冗余复制，把答案从连续覆写中救回（91-95 步）。

**局限**：冗余是副本不是语义去重；每头内部仍是文本重写（L0' 风险
只是被摊薄）；规则路由不解决"什么值得记"。

**可抄**："把保留负担从模型行为转移到结构屏蔽"= 我们"版本化条目
而非块重写"的同构思想；stage-wise（先路由再写入）对 Hauler→Selector
管线是现成佐证；MCR/MRR 分解可作为我们写入侧的两个独立指标。

---

## 9. Eywa（2605.30771）— evidence before belief 全架构

**一句话**：文献里离我们最近的系统——不可变证据 + 验证函数 +
确定性读路径。

**方法**：两级 canonical 写入（raw episode 原文 + 派生 belief）；
确定性信号检测器生成候选 → 验证函数（源文重叠 ∧ 硬锚值精确匹配 ∧
主语在窗口 ∧ 保留否定）→ belief 带生命周期。SQLite 权威存储，
向量/图作幂等可重建投影。读路径零 LLM：route preservation +
raw-episode rescue（24→6 条 ≤1,300 字符）+ 推理支持检索
（0.7cos+0.3lex→8 条）→ budget B 打包。**answer_instructions 与
context 分离**为独立字段（strict/balanced/advanced 三档策略）——
同一检索架构配不同答题策略，把"敢不敢推理"变成产品决策。
ReadResult 五元组携带 route 计数/错误/延迟，失败可定位到
覆盖/抽取/检索/打包/答题/测量六桶之一。

**关键结果**：
- LoCoMo C1-C4（Sonnet4.6 写+答）：多跳 93.97 / 时序 89.41 /
  推理 78.13 / 单跳 90.61；对照外部表 True Memory Pro 93.0、
  Hindsight 89.61、MemOS 75.8、Mem0 64.6、Zep 59.2（协议不同仅供参考）。
- LongMemEval-S 500 题 88.2%（knowledge update 96.2 最强，
  assistant 记忆 73.2 最弱）；残余失败桶：未检索 27 /
  进不了 context 12 / 未抽取 12 / 需组装 7 / 有了不用 1。
- BEAM 700 rubric 81.45%（矛盾消解 93.2、知识更新 70.0 最弱）。
- 跨角色诊断：Qwen3-32B 自写自答 69.09% → 读 Sonnet 写的记忆 79.68%
  ——**写路径质量是独立因子**。
- 延迟：交互检索 ~150-200ms（6,320 事实库），读路径无 LLM 调用。

**局限**：单作者公司白皮书、未经同行评审；BEAM 是作者自建基准；
外部对照行协议不一；验证是词面级（"源文有没有这个值"）非授权级
（"谁有资格改"）。

**可抄**：V_hard/V_act 可借作 Hauler 候选的服务端前置过滤；
context 与 answer_instructions 分字段 = serve 层注入格式的正交设计；
六桶失败定位可直接映射我们的 Gap_write/retrieve/select/read；
episode rescue 通道 = L0 原文回查的实现先例。

---

## 10. MemOps（2607.12893）— 记忆生命周期操作级评测

**一句话**：记忆不是 QA 是操作序列——每个操作带触发/目标/范围/状态转移/
证据，逐个可判分。

**方法**：五种操作 remember/forget/update/reflect/trajectoryops；
六种探针 OperationTrace / TargetBinding / StateTransition /
CandidateDisambiguation / OperationApplication / StateTrajectory；
每探针带黄金 provenance（原文引句 + 轮次定位），多跳题带可审计推理链
（缺链不给分）。构造：100 主题→403 证据会话（生成 727 留 403，55.4%）→
确定性门槛 + LLM 语义校验 → 撒入无关会话池（adjacent ~2.6k token /
long-context ~60.8k token）+ 每题 5.7 个语义邻近的 context distractor。

**关键结果**：
- **会话级 RAG ≫ 轮次级 RAG**（轮次切碎证据链）；MemOS 全面压 Mem0，
  OperationTrace/StateTrajectory 差最大；Temp-LoRA 参数化记忆全面弱。
- CandidateDisambiguation 强模型近天花板（备选项列明就能排错），
  **StateTrajectory 最弱**——认得事实 ≠ 重建状态轨迹。
- 长上下文保答题分但状态轨迹重建明显退化——窗口大不等于状态被追踪。
- 结论："维持可审计状态，而非无结构文本档案"。

**局限**：合成对话；探针判分部分依赖 LLM judge；规模中等（2006 QA）。

**可抄**：操作级 F1 + provenance support + leakage + stale-value 率
就是我们 operation 指标的完整清单；adjacent/long-context 配对设计
直接隔离检索因子；trajectoryops 探针是我们没有的——状态演化链重建。

---

## 11. Memory-R2（2605.21768）— 记忆归因的 LoGo-GRPO

**一句话**：记忆让环境非平稳——同轨迹中间记忆态分叉后轨迹级奖励分不清
功过；解法是从同一中间态局部重 rollout。

**方法**：共享参数的 extractor-manager 双角色；LoGo-GRPO：
global rollout 拿端到端奖励 + **local rerollout 从缓存的中间记忆态
只重做第 t 轮**比 advantage；课程学习按会话跨度渐长；
压缩惩罚 λ_comp=0.3；仅用 2 条 LoCoMo 会话训练。
Answer agent 单训：top-30 记忆注入、<answer> 标签、token-F1 规则奖励、
F1≥0.25 过滤噪声样本。

**关键结果**：
- LoCoMo：F1 50.60 vs Memory-R1 43.14；B1 44.01；judge 80.99。
  7B 训练的 answer agent 超过 GPT-OSS-120B 冻答版。
- 泛化：LongMemEval-oracle F1 27.88→50.60；Qwen2.5-3B F1 10.3→46.8；
  增益主要来自记忆模块训练（换答题器仍高）。
- 消融：**-curriculum → F1 24.12、M-Fail 46.5%**（直接 32 会话训练
  峰值 0.47 后崩到 0.27、M-Fail 72.1%——早期错误跨会话传播腐蚀记忆）；
  单 agent 合角色 39.14；分参数 44.31；manager-only 45.34；
  **extractor-only 28.30（抽取端最脆弱）**。
- 训练还降延迟（生成更简洁稳定）。

**局限**：只用 2 条训练会话（数据效率卖点也是外推风险）；M-Fail 是
诊断指标非因果度量；奖励仍是答案正确性，"当前值正确"未被直接奖励。

**可抄**：local rerollout = 我们"因果屏障+冻结回放"的 RL 表述——
没有同中间态对照，使用统计就是噪声；extractor 比 manager 更脆的消融
支持 Hauler 端放更多结构约束；curriculum 崩坍曲线是"早期错误经记忆
自我强化"的最直观量化证据。
