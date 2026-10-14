## 1. USER

在 LLM 拿到 MCP/agent 之前，这啥意思， MCP/agent 是跟外界交互的能力，跟你设计memory有什么关系吗，跑偏了吧

---

## 2. ASSISTANT

你这一刀切中了一处真的毛病，但不是全盘。我先把错的那句摘出来。

一、我错在哪

我上一轮的落脚点是「MCP 之后，可重取的东西不该存值，该存指针和取法」。「可重取」不是 MCP 带来的 —— RAG 时代就是存指针（doc id）+ 取法（向量检索）。我拿一个 2020 年就有的性质当成 2026 年的新前提，这是蹭名义。

但这句话里有一个差别我当时没论证出来，补上之后它才站得住：RAG 重取回来的是索引时的快照，所以存指针并不能解决过期 —— 指针解引用出来的也是旧的；agent 调工具重取回来的是系统此刻的真值。所以「存指针优于存值」这个结论在 RAG 里收益有限，在 agent 里才真正成立。这是读侧唯一真实的差别，我上一轮没说清。

二、拿「去掉 MCP 还成立吗」过一遍我自己那九节
主张	去掉工具后	判定
① 损失函数从最大召回改成最小断言	RAG 也该这样	大半是通用 memory 问题，蹭了
② 四位点（weights/context/外部记忆/世界）	「世界」这一位点消失	真依赖，但结论廉价
③ 四分型 evidence/pointer/claim/procedure	前三型 RAG 就有	只有 procedure 真依赖
④ 注入拆两点（轮首 + 循环内）	没有循环就没有第二个注入点	真依赖，且是结构性的
⑤ 工具轨迹做信用裁判	没有轨迹	完全依赖，最硬的一条
⑥ promotion 阶梯	ACE 那套无工具也成立	只有「成功工具序列固化成 skill」是新的
⑦ 五处改动	(1)(2)(4) 依赖，(3) 半依赖，(5) 不依赖	掺着
⑧ re-fetchable 桶 / 步数配对	桶不依赖，步数依赖	掺着

九节里真正由 MCP 变出来的大概四条。剩下的是我用 MCP 当包装纸讲的通用 memory 问题。你的直觉是对的。

三、但我漏掉的那一半，恰恰是真正改变 memory 设计的

你自己给的定义是「跟外界交互」。交互 = 读 + 写。我上一轮整套都在讲读（重取、指针、验证），写的那一半一个字没碰。而把 memory 问题变性的是写：

1. agent 自己成了记忆过期的原因。 没有工具时，记忆失效是外生的、不可观测的，只能靠 TTL 和衰减去猜 —— Dynamics-memory 的 core/dynamics.py 就是这个范式。有工具时，最大一类失效是我自己造成的：我刚把那个配置改了，所以三轮前记的值此刻必然是错的。这类失效可以被精确检测，不需要猜。 衰减函数在这里是错误的工具。

2. 「我做过什么」是唯一一类不可重取的事实。 文件系统记得文件变了，不记得是哪个 session 改的、改之前是什么、为什么改。世界只保留结果，不保留动作和意图。按我自己那个四分型，这是唯一必须存断言、存不了指针的东西 —— 而我上一轮把它混在 evidence 里带过去了。对 agent 来说它还偏偏是最有用的一类：避免重复劳动、避免回滚自己刚做的事、理解当前状态的由来。

3. 记忆出错第一次有了物理代价。 问答里记错 = 一个错答案，用户当场纠正。agent 里记错 = 在错的前提上执行了有副作用、可能不可撤销的动作。这才是「不确定的记忆必须降级成提示而不是断言」的真正理由 —— 不是怕污染上下文，是怕它被当成前提去执行。我上一轮给的理由（污染）是通用理由，这个才是 agent 特有的。

四、修正后的主张（比原来窄，但站得住）

工具不改变「记什么」的容量问题，它改变三件事：谁让记忆过期（从世界变成 agent 自己，于是失效从猜变成可检测）、记忆错了会发生什么（从答错变成执行错，于是断言权限必须收紧）、谁来判断记忆有没有用（从 LLM 自评变成后续工具调用的客观证伪）。读侧的「存指针」只是这三件事的副产品。

五、这对那五处改动意味着什么

优先级要翻。原来排第一的「L0 改事件日志」，我当时的理由是「要记录工具读到了什么」—— 按上面的修正，更要紧的是记录工具写了什么：哪条记忆因为这次写而必然失效。

而 Dynamics-memory 此刻的结构性障碍比我上轮说的更深一层：core/types.Memory 的 kind 只有 fact / reflection，src 指向 unit_id，而 store/schema.py::_DDL_LOG 的 units 只有 user_text / assistant_text 两列。这个系统里不存在任何能表示「agent 做了 X」的数据结构。 它接上 MCP 之后仍然只能记住「人说了什么、模型说了什么」，记不住「发生了什么」—— 而上面三条全部建立在「发生了什么」之上。

你要是觉得第三节这半边也还是绕，直说，我再拆。

1m 56s | 12 hours ago
23:11

---

## 3. USER

话说为什么要压缩记忆呢，直接读session对话原文会不会更好呢，说实在的，现在的问题无非就是用户不知道当前任务结束了没，我直接引入一个判断，用ask_tool回调询问，如果结束了，直接开一个新会话，这样就得到了一个项目里的多个session会话，如果能设计一个良好的检索跟查询算法的话，让LLM自己读日志会不会更好呢，L0 日志本来就会存，但是很少用任务区分的存，大部分人都不知到或者懒得关系某个任务完成了没，或者担心换新会话会丢失所有上下文信息，如果前面那个设计合理的话，每个session能直接标志一个任务的结束，或者你也可以session设计一个更细的颗粒度，叫什么task_session，这样不就很好了吗，因为说实话，这样压缩我并不觉得会非常好用，但不如说大部分不如context基线，只是每次基线都要预热，而且长信息容易丢，因为是线性的，如果像前面那样设计为结构化的，或许会更好

---

## 4. ASSISTANT

你这个方向我认为是对的，而且这个项目自己的评测数据就站在你这边。先把那条证据摆出来，因为它比我讲任何道理都硬。

一、项目自报的数字就在反对压缩

eval/BASELINE.md（2026-09-27，项目自述用 mock LLM、只验管道）里，三个消融 decay_only、abl_no_dedup、abl_no_tension 在 recall 和 ctx_eff 两个指标上同时高于完整版（完整版 0.792 / 0.691）。也就是把去重、张力这些「加工」关掉，效果反而更好。同一批文档里还记着「助手答错的内容也会被蒸馏成记忆」「36 轮后 M 池仍为 0」。

外部也是同一个方向：AMA-Bench（2602.22769，论文自报）在真实 agent 轨迹上发现长上下文基线持续强势、经常最好；2609.32521 测 13 种记忆方法，无一通用。你说「大部分不如 context 基线」，这是被反复测出来的事，不是你的猜测。

二、但罪名要定准：有害的不是压缩，是压缩之后把原件删了

这是整件事的要害。摘要有两种用法，命运完全不同：

摘要当替代品（原文丢弃或不可达）：错误是单向、不可恢复的。2510.04618 诊断的 brevity bias 和 context collapse 都是这一类。2604.20874 还有一条更狠的：压缩器运行在它所压缩的信道里，所以它没有能力验证自己压掉了什么。
摘要当索引（原文永远在，摘要只用来决定「要不要去读」）：摘要错了最多是多读一次或少读一次，不造成信息湮灭。

你的方案是砍掉第一种，这对。但第二种砍不掉 —— 一个 task_session 原文几万 token，总得有个东西让 agent 不读全文就判断该不该读。所以压缩会从后门回来，只是降级成了导航层。判据是：这个摘要错了，原始信息还找得回来吗。 找得回来就安全，找不回来就是在赌。

三、按任务切，是比按轮次/按 token 切更正确的切法

理由不是「更整齐」，而是三条实质的：

任务是意图一致、状态连续的最小闭包。 同一任务内的内容基本是「要么全要、要么全不要」，跨任务才需要挑。这把检索从「在几百万 token 里找 5 个片段」降维成「在几十个 task_session 里选 1–2 个」。
失败模式温和得多。 chunk 级检索选错了 agent 看不出来，因为每个 chunk 都局部自洽；整段任务选错了，agent 读进去两句就知道不对，可以再选一次。
边界标错可以修。 这是保留原文方案的隐藏优势 —— 索引是元数据，原文是事实，元数据错了可以重建。压缩方案没有这个退路。

你说的「大部分人懒得关心任务完没完、担心换新会话丢上下文」，这个观察比技术部分更重要：真正阻止人开新会话的是怕丢。如果新会话能挂载上一个 task_session，开新会话的心理成本就没了，于是边界自然变多、变准。这是个正反馈。

四、但 ask_tool 前验询问是整个方案里最弱的一环

三个问题：任务是嵌套的（「修这个 bug」套在「发版本」里，问「结束了吗」用户没法答）；任务会回溯（三天后发现上周那个修复是错的，可 session 已经封了）；打断有成本，问得勤招人烦，问得稀边界不准。

改法是把它从前验问句改成后验推断 + 事后可修订。信号现成且便宜：工具调用的目标集合突变（一直在动 repo A，突然全是 repo B）、时间间隔、git commit、测试由红转绿、用户说「好了/下一个」。ask_tool 保留，但只在推断置信度低时问一次，而且允许事后合并与拆分 —— 因为原文都在，重划边界只是重建索引。

五、这个方案真正解决不了的一件事：现势

追加日志不消解矛盾。某个值在 session 3 是 8080，session 17 改成 9090，session 20 又回滚了。三段原文都在，谁赢？靠时间戳的话，回滚那次如果只是口头说了一句而没实际执行，就会判错。

这正是 eval/l2l3/REPORT.md 里 N53 记的那个病，三链一致复现：「旧值与新候选并排端出、已作废值继续服务」—— 而那还是在有张力机制的情况下。纯原文会让它更重，不会更轻。

所以需要一层很薄的东西专管「此刻的值是什么」。它不是摘要，是一张覆盖写的键值表，每条必须带回原文位置（哪个 task_session、哪一段）。它可以错，错了能顺着指针回原文核对。这一层加上你的原文层，正好对上我上一轮说的 pointer + evidence，而被你砍掉的 claim 层确实该砍 —— 除了「当前值」这一个例外。

六、还有一个上限要知道

2609.08279 自报：在 80k / top-k 预算下，0.60–0.73 的 oracle-可答错误属于「把金证据放回上下文，同一个 reader 重跑，仍然答错」。意思是保留原文能消除的是「存储侧丢失」那部分损失，消不掉「读者侧用不上」那部分。长 session 整段灌进去，会被这个天花板吃掉一块。

所以「让 LLM 自己读日志」要落实成工具式分页读（grep、按 seq 区间取、先读骨架再展开），而不是把整段原文塞进 context。这跟你的直觉一致，只是读法要是工具调用，不是注入。

七、落到这个项目

合并下来是三层：原文全留（按 task_session 组织）+ 极薄现势表（覆盖写、带原文指针）+ 可重建的任务索引。没有摘要替代层，摘要只做导航。

具体位置：store/schema.py::_DDL_LOG 的 units 现在只有 user_text / assistant_text 两列文本 —— 要按你的方案走，这里得先加 task_session_id 和事件行（含工具动作），否则连「按任务取原文」都做不到。另外有个现成的东西被关着：schema 里对这两列已经建了 FTS，但 transport/bootstrap.py::build_default_service 的生产配置里 lex_weight=0.0，关键词这条路是关的，检索纯走向量。你要的「按符号/报错原文找回那一段」恰恰是 FTS 擅长而向量不擅长的，这一项几乎零成本就能打开。

2m 6s | 12 hours ago
23:32

---

## 5. USER

你说大部分memory不如context基线的那篇论文的arvix链接是多少

---

## 6. ASSISTANT

核验一下 ID 再给你，免得给错。

Searched the web

核验过了，两个 ID 都真实存在。

主要那篇：

AMA-Bench: Evaluating Long-Horizon Memory for Agentic Applications
https://arxiv.org/abs/2602.22769
UCSD 等，12 作者（含 Yuandong Tian、Jishen Zhao），2026-02-26 首版，现为 v4（2026-05-27），社区仓库标 ICML 26
项目页 https://ama-bench.github.io/

论文里对应的原话是 Motivation 1 一节的标题："Memory systems fall short of the long-context baseline"，正文写 "the long context baseline is consistently strong and often achieves the best performance, whereas existing memory systems ... frequently underperform"，归因是 "errors introduced by lossy memory compression and similarity-based retrieval accumulate and compound over long-horizon agentic tasks"。以上均为论文自报。

另一篇我一并提到的（13 种方法无一通用）：

MemAgent: Learning to Manage Heterogeneous Memory Providers for LLM Agents
https://arxiv.org/abs/2609.32521 （2026-09-26）
摘要自报：评测 13 种记忆方法，没有一种能跨 benchmark 通用；其路由方案平均准确率 +10.0%，路由开销 <0.3%，平均任务步数 −12%。
更正一处：我上一轮说过「8.0 vs 9.1 步」，那是我此前从正文片段记下的，这次核验只在摘要里确认了「−12%」这个口径，具体步数我没复现，先别引用那两个数。

另外这次核验顺带读到两条，跟你上一条消息的方案直接相关：

长上下文基线的强势有长度上限。 合成子集上，论文自报长上下文方法在短轨迹有竞争力，但超过 32K 后准确率显著下降，而结构化方案到 128K 仍稳。这不是在反驳你——恰恰相反，你提的按 task_session 切分，作用正是把单次投喂量压回基线仍然强势的那一段。切分是让基线继续有效的办法，不是基线的替代品。

它自己的解法和你的直觉是同一个方向。 AMA-Agent 的两个机制是 causality graph + tool-augmented retrieval（图节点搜索 + 关键词搜索）。「让 agent 用工具去搜，而且带关键词搜索」就是你说的让 LLM 自己读日志，也正是 Dynamics-memory 里 transport/bootstrap.py 把 lex_weight=0.0 关掉的那条路。它诊断失败原因时用的词是 memory systems "fail to capture causal and objective information" —— objective information 指机器生成的精确值，causal 指动作与后果的依赖，这两类恰好是被压缩最先磨掉、也最该留原文的东西。

深度声明：这篇我读的是摘要加搜索返回的正文片段（Motivation 1、6.2、附录 G、scalability 段），属主体档，没有逐页深读。

51s | 12 hours ago
23:39

---

## 7. USER

这样的话就干三个事情：按task划分日志，用各种方式建索引并开放查询入口为MCP，设计LLM在开始一个新任务前进行K轮调用接口读取相关日志来建立心智模型，而且比起压缩速度会快上不少

---

## 8. ASSISTANT

这三件事连起来是自洽的，而且它暗含了一个翻转，值得先点明：它把压缩从写侧挪到了读侧。 这才是它为什么对。

一、速度那句要分两半说

写侧确实快得多，而且这是真大头：压缩方案对每一轮都要调一次 LLM 做蒸馏，那是持续缴的在线税；你的方案写侧只有落盘 + 建索引，近乎免费。

但读侧不一定快，很可能更慢。K 轮串行工具调用是 K 次模型往返，而注入式压缩是零次额外往返。诚实的账是：用一次性的任务起点开销，换掉每轮都要交的写入税。 长任务明显划算，三轮就结束的任务反而亏。

三个能把读侧成本压回去的做法：第一轮并行广撒（3–5 个查询同时发），第二轮才根据结果收窄，这样 K=2 的往返能顶串行 K=5；这个阶段用小模型，因为它干的是路由不是推理；以及必须有个 gate 决定「这个任务值不值得 prefetch」。最后一条有警示：2607.08716 自报，未经训练的 27B memory agent 挂上去反而把性能从 0.709 拉到 0.693，而 full-bank 全量暴露比完整系统差 2.8 macro 点。决定读什么的那个东西本身是要调的，不是挂个 LLM 就行。

二、第三条有一个必须回答的问题：读完的「心智模型」放哪

如果 K 轮的工具输出就那么堆在 context 里，等于把原文搬进了窗口，32K 衰减照样吃你。如果让模型把读到的东西归纳一下再往下走 —— 那就是压缩，从后门回来了。

答案是：这一次压缩是允许的，因为它不落盘。 它是会话内的 working set，短命、一次性、错了下个任务重建，而且原文随时可再查。压缩真正的毒性来自被持久化、被反复复用，于是错误复利 —— 这正是 AMA-Bench 说的 "accumulate and compound over long-horizon agentic tasks"（论文自报）。会话内的一次压缩没有这个通道。

所以判据是：压缩可以发生在读侧，不能发生在写侧。 你这三件事天然实现了这个翻转。

三、索引按查询类型倒推，不要按技术倒推

四类查询，对应四种东西，别混成一个万能 search(query)：

查询意图	该用什么	向量能不能干
继续做那件事	task 元数据的结构化查询（时间、涉及文件/repo、状态）	不能，这是 SQL
那个报错/那个符号在哪见过	全文关键词 FTS	不能，要精确 token
跟这个情况类似的	向量	能，但这是最弱的一路
这个东西现在是什么值	现势表直接 key 查	不是检索问题

第二路是现在被低估最狠的。AMA-Agent 自报它的 tool-augmented retrieval 就是「图节点搜索 + 关键词搜索」两条腿。而 Dynamics-memory 里 store/schema.py 已经对 user_text/assistant_text 建了 FTS，transport/bootstrap.py::build_default_service 却把 lex_weight=0.0 —— 建好了没开。

MCP 工具面还有两个硬要求：必须有一个 list_tasks 类的目录接口（否则 agent 第一次查询无从下手，只能瞎猜关键词）；每个返回必须带定位符（task_session_id + seq 区间），让 agent 能二次深入读。没有定位符就只能整段灌，又回到老问题。

四、第一条要补一样东西：task 之间的边

上一轮说的嵌套和回溯，解法不是把边界划得更准，而是允许 task 之间有关系：parent / continues / supersedes。

最后那条边是关键。N53 在 eval/l2l3/REPORT.md 里三链一致复现的那个病 —— 「旧值与新候选并排端出、已作废值继续服务」—— 本质是检索层不知道哪段已经被推翻了。有了 supersedes 边，检索时自动排除被取代的 task_session，这个病在索引层就解决了，不需要靠张力机制在记忆池里打架。

五、这三件事做完，现有系统的大半就不需要了

core/dynamics.py 的衰减、core/consolidation.py、去重与张力 —— 这些全是为「压缩件组成的记忆池需要被维护」而存在的。不存压缩件，就不需要维护压缩件。

这听着重，但有项目自己的证据：eval/BASELINE.md 里 decay_only / abl_no_dedup / abl_no_tension 三个消融在 recall 和 ctx_eff 上同时高于完整版。把这些关掉本来就更好。

所以你这个方案的真实含义不是「给 Dynamics-memory 加三个模块」，而是换掉它的核心，保留的是外围那些硬骨头：授权链（agents/selector.py::authorized_change 只认用户原话）、人审水位、因果界、store/tasks.py 的事务与回执。那几样是真资产，而且恰好跟存什么无关。

改动按依赖排序只有一条路：先改 _DDL_LOG（units 加 task_session_id、加工具事件行），否则后两件事都没有地基。索引和 MCP 工具面是地基之上的，lex_weight 那一项几乎零成本。

要我把 schema 和四个工具的签名直接写出来吗？到那一步就是具体 DDL 和接口定义，比继续讨论有用。

1m 32s | 12 hours ago
23:44

---

## 9. USER

这个在你查询到的文献里，有对应的实现吗，能否作为一种新路径的探索

---

## 10. ASSISTANT

这个值得查实，我先把几条最接近的扒出来。

Searched the web

查到不少，而且结论比较清楚：三件事各自都有人做了，但按你那个组合做的没有，而且空位的位置挺有意思。

一、逐条找到的对应
你的三件事	最接近的已有实现	和你的差别
存原文不压缩 + 轻量索引 + MCP 入口	MemMachine（2604.04853）—— 自述 ground-truth-preserving，存 raw conversational episodes，句子级索引，三套接口含 MCP server，后端 PostgreSQL+pgvector / SQLite / Neo4j	对话域，按 episode（一轮）切，没有 task 概念
原件留着、摘要只做导航	ACM（2607.23809，CMU+Meta）—— manage_context 压缩并把原始消息落盘，query_memory 按 summary_id 回查原文	只在单任务会话内做，不跨任务；而且压缩由 agent 自己触发
任务起点先读一轮	MemAgent（2609.32521）的 Begin 阶段：执行前并行 probe 所有 provider 再路由取一次	路由的是 provider，不是日志；不是 K 轮迭代侦察
预取以降延迟	Maximem Synap（2607.21503）—— 明确提 speculative prefetching，「把检索从 agent 的关键路径上挪走」	是在轮级预测下一步要什么，不是任务起点的建模
按 task 切	MemoryArena（2602.16313）实验设定里写「每个 subtask 开始时检索一次（session-level memory）」，自述此举大幅降低检索频率与成本	这是 benchmark 的评测设定，不是有人把 task 当存储层的组织单元去做

产业侧更贴：engram（Go 单二进制，SQLite + FTS5，MCP server，面向 coding agent）、skillmem（同样 SQLite+FTS5+MCP）、Data Olympus（自述 MCP 检索「只返回经 validity 与 supersession 检查后仍生效的知识」—— 就是我上一轮说的 supersedes 边，已经有人做了，但是产品不是论文）、AtMem（provenance + execution evidence + SQLite + MCP）。

二、有一句话是别人先替你说的

MemMachine 讨论节 9.1 原话（论文自报）：

"systems that invest heavily in LLM-based ingestion (extracting facts, building knowledge graphs) may be over-optimizing the wrong stage. MemMachine's approach of storing raw data with lightweight indexing and investing in retrieval quality appears to be more effective per unit of engineering effort."

9.4 节还写 STM summary plus selectively retrieved raw episodes，摘要给高层背景、原文给未压缩的事实接地。这跟你的主张和我上一轮那个「摘要做索引不做替代品」的判据，是同一件事。所以这不是你我在拍脑袋，是有人测过并写进 discussion 的。

三、对「速度快」这句，找到了量化支撑

LRE（2606.20954，Learned Relevance Eviction，论文自报）：千字节级、纯 CPU、压缩时零 LLM 调用的打分器，逐字保留而非摘要。AppWorld 上恢复全历史准确率的 93%（41.1 vs 44.0），峰值 prompt 降 52%；对照组 ACON（LLM 压缩）一个任务要 49 次 LLM + 8 次 compressor 调用，LRE 19 次调用完成，比不压缩还少 37%。

这正是你说的写侧省钱，而且省的是调用数不是 token 数。

四、三条必须知道的反证

1. 「原文留着」不等于「取得回来」。 ACM 的公开 referee report 指出：lossless 是架构属性（原始消息在磁盘上），但取回这一步是由一个 querier LLM 做的、输出还有预算截断，操作上仍然有损。换句话说，你把压缩从写侧挪到读侧，没有消灭压缩，只是让它变成每次可重做的。好处是不累积，代价是每次都要付。

2. 「原文 + agent 自己检索」已经被测过，不够。 AMA-Bench 的 baseline 描述里写，MemGPT 跟其他系统的区别恰恰是「存 raw trajectory，靠 agent 的检索能力在查询时取回相关片段」—— 这就是你的方案雏形，而它在 AMA-Bench 上不在最强之列。结论不是方案错，是索引质量决定一切，原文和工具只是必要条件。

3. 跨轨迹的原文有量级问题。 2605.28224 自报：跨轨迹注入完整原文不可行（8–15 步 × 约 500 token × 最多 5 条历史轨迹，超出典型预算），「reflection 和 fact extraction 存在的理由正是压缩这段历史」。不过这一条对你不直接适用 —— 他们说的是注入，你说的是工具按需分页查。这个区分恰恰是你方案的立足点，但也意味着你必须守住它：一旦退化成整段灌，这条限制立刻生效。

五、novelty 判断

部件全是现成的，所以不算新路径。 但现有工作里有个空位没人占：把 task 当成存储与检索的一等单元。现在的粒度要么是 turn / episode / sentence（MemMachine）、要么是 trajectory（ExpRAG、Memento）、要么是 provider（MemAgent）、要么是 summary 段（ACM）。task 只出现在 MemoryArena 的评测设定里。

而这个空位值得占，理由是 AMA-Bench 自己给的诊断：现有系统失败是因为 "fail to capture causal and objective information"，它的解法是建 causality graph —— 那是要花 LLM 调用去抽因果的。任务边界 + supersedes 边是几乎免费的因果结构：任务内的步骤天然有序，任务间的取代关系是元数据。

所以这里有一个干净、可证伪的假设，而且现成有人替你把对照组建好了：

在 AMA-Bench 上，用「task 分段的原文 + FTS + 结构化元数据 + supersedes 边 + 工具化按需查」，能不能逼近 AMA-Agent 的 57.22%，而把记忆构建侧的 LLM 调用降到接近零？

这个能跑出来就是实打实的结果 —— 它同时回答了准确率和成本两件事，而 AMA-Bench 的数据集、长上下文基线、13 个记忆系统对照全是现成的。

深度声明：本节所有论文我读的是摘要和搜索返回的正文片段（MemMachine 的 9.1/9.4、ACM 的工具定义与 referee report、LRE 的 Figure 1 与附录表、MemAgent 的 Begin 开销），属主体档，没有逐页深读。那几个 GitHub 项目我只读了列表里的一句话描述，没验证过代码。

1m 53s | 12 hours ago
23:51

---

## 11. USER

我是觉得只要日志读得详细一些，就你直接给context100k的窗口建立心智，应该足够了吧（我是让LLM自己主动查询+向量匹配算法一起做）就可以建立足够的心智模型（可以给每个最细颗粒度的对话带上一个时间戳，这样LLM就能自己知道时间的演化了），100K 全量灌入 + 时间戳 ，不是把log直接塞到context里的，我是用对话级做匹配（这个是真塞入），然后给出这些对话所在的任务，任务的其他对话信息由LLM自己进行阅读补全，主要是建立一条自洽的，完整的合理的心智模型，用来进行当前的任务里，我针对的是coding场景，其他那种太过细碎的应用场景，还不如直接用context基线呢

---

## 12. ASSISTANT

这个澄清很重要 —— 你说的是细粒度命中 + 任务级扩展的两段式，不是全量灌。这个结构是对的，MemMachine 里有同构的机制（它叫 contextualized retrieval，用 nucleus episode 向邻近扩展成 episode cluster，自述是为了解决对话数据固有的 embedding dissimilarity 问题）。差别是它按时间邻接扩展，你按任务归属扩展 —— 你这个更好，因为任务是意图边界，邻接只是巧合。

既然你把场景钉死在 coding，那就该吃到这个限定的红利。有三件事会因此变样。

一、匹配单元不该是「对话」，该是「事件」

coding agent 的一轮里，文本部分常常是「好的，我看一下这个文件」这种废话，真正有判别力的东西在 tool call 的参数和结果里：读了哪个文件、diff 是什么、测试输出什么、报错栈长什么样。

如果向量匹配的单元是「对话」，你是在拿一堆客套话做匹配，而把真正的索引材料扔了。这正是 Dynamics-memory 现在的毛病 —— store/schema.py::_DDL_LOG 的 units 只有 user_text / assistant_text 两列。

所以最细粒度应该是事件：一次 tool call + 它的结果算一条，可独立检索、独立带时间戳。你的「对话级匹配」改成「事件级匹配」，任务级扩展的逻辑不变。

二、在 coding 场景，向量应该降为兜底

通用对话里向量是主路。coding 里反过来，因为查询词往往是精确符号：函数名、文件路径、错误码、commit hash。

embedding 在这上面是反着的 —— get_user_id 和 get_user_ids 的向量几乎重合但指的是两个东西；UserAuth 和「认证模块」向量不像但是同一个东西。前一种错是致命的（给你拿回邻居函数的历史），后一种错 FTS 也救不了但代价小。

所以主路应该是精确匹配（FTS / trigram / 符号索引），向量用来接「说不出关键词」的那部分查询。AMA-Agent 自报它的 tool-augmented retrieval 就是图节点搜索 + 关键词搜索两条腿，在 coding 场景这个配比还要更偏关键词。

三、你还没用上 coding 场景最大的那块免费午餐：git

我前面让你搞 task 边界推断、supersedes 边，在 coding 场景这些大半是免费的：

commit 是天然任务边界，commit message 就是任务描述，diff 就是结果
分支切换、测试由红转绿，都是边界信号
revert 和「后续 commit 改了同一处」直接给出 supersedes 关系

把对话事件日志和 git 历史按时间戳 join 一下，任务切分、任务描述、取代关系三样一起拿到，不需要 LLM 去推断。这是 coding 场景独有的，通用场景没有这种权威的结构化旁证。

四、时间戳那条要泼一点冷水

「带上时间戳，LLM 就能自己知道时间的演化」—— 在 coding 场景这个假设有风险，而且风险的形状很特别：时间戳不会让 LLM 更准，但会让它更自信。

因为代码状态的演化不是线性的。时间戳只能告诉你 A 在 B 之前，不能告诉你 A 后来被 revert 了、A 在一个废弃分支上、A 之后有次失败尝试又改回去了。

具体的坏情况：日志里 10:00 说端口是 8080，14:00 说改成 9090，15:00 那次回滚因为措辞不同没被检索到。LLM 看到两条带时间戳的记录，会非常笃定地选 9090 —— 时间戳给了它虚假的确定性。这就是 eval/l2l3/REPORT.md 里 N53 三链一致复现的那个病：「旧值与新候选并排端出、已作废值继续服务」。

但 coding 场景有个干脆的解法：别从日志推演当前状态，直接读代码。 文件系统和 git 就是权威真值源。分工应该是：

「现在是什么」→ 读世界（文件、git、测试输出）
「为什么是现在这样 / 试过什么没成功 / 那个坑在哪」→ 读日志

日志的不可替代价值恰恰在第二类 —— 失败的尝试、被否决的方案、某个坑的成因，这些世界里不留痕迹，只在轨迹里。而第一类交给日志，是在用一个不权威的副本去对抗一个权威的原件。

这也顺带解决了你的心智模型「自洽」问题：自洽性的锚点不在日志内部的时序推理，而在当前代码状态。先读世界定住现状，再用日志补因果。

五、100K 那个预算要有纪律

你的设计里「任务的其他对话由 LLM 自己阅读补全」是无界的。实际观察里 agent 很容易过度阅读，读着读着 100K 就满了，然后 AMA-Bench 自报的那个 32K 后衰减开始吃你。

需要两样东西：补全读取的步数/token 上限，以及读完发现没用的内容能被丢出去（ACM 的 manage_context 就是干这个的，原文落盘、ID 可回查）。另外停止条件要显式给 agent —— 「你要建立的心智模型是为了回答什么」，没有这个它不知道什么时候算读够了。

六、你那个场景限定是对的

「细碎场景不如直接用 context 基线」这个判断我同意，补一个理由：记忆系统的收益全部来自跨越边界，细碎场景单任务短、边界少，收益自然小；而 coding 的单任务能跨几十轮几十万 token，跨任务复用又频繁，边界密度正好。再加上 coding 有权威真值源可以把「现势」这个最难的问题外包出去 —— 别的场景没这个便宜占。

现在这套东西已经有五六个具体决策散在对话里了（事件级粒度、FTS 主路、git join、读世界定现状、补全预算）。要不要我整理成一份设计文档落到工作区，省得后面回头找？

1m 32s | 11 hours ago
0:03

---

## 13. USER

就有一些场景是需要读日志的，比如为什么这样决策，帮我继续完成XX任务等等的问题，但是有一些看现有的代码就可以了，比如现在项目是用JWT吗之类的，信息可以从实际存在的东西跟历史痕迹来区分，只要做了正确的匹配，问题会比较轻松

---

## 14. ASSISTANT

这条线你划对了，而且它比「现状 vs 历史」还能再精确一格。我说说它在哪里会断，以及一个几乎免费的补法。

一、三处会断的地方

第一处：代码能回答「是什么」，回答不了「可不可以动」。

「现在用 JWT 吗」看代码就行。但 agent 问这个通常不是为了知道，是为了在上面改。而「能不能这么改」是约束问题，约束大半在日志里：上周讨论过要迁走所以别加新依赖、这套鉴权是临时的、某个方案已经被否过一次。代码给你事实，给不了意图。

第二处：代码是权威的，但代码不告诉你哪部分算数。

仓库里有 test fixture、examples、vendored 的第三方、注释掉的旧实现。grep 到 JWT 不等于项目用 JWT —— 可能命中的是 examples/，也可能 JWT 和 session 两套并存，其中一套是上次迁移没清干净的死代码。光看代码会答「两套都有」，正确答案是「JWT，另一套是残留」。这个判断只在日志里。

第三处：两边冲突本身是最有价值的信号。

日志说「决定用 JWT」，代码里却是 session —— 说明中间发生了日志没记的事（别人改的，或者 agent 自己改完没记）。这种时候静默选一边是最糟的处理，因为无论选哪边都有可能错，而且不留痕迹。它应该被检出来并明确报给 agent：你的心智模型这里有个洞。

二、所以别去追求「分类分对」，去做交叉校验

你说「只要做了正确的匹配」—— 难点正在这。用 LLM 判断查询该走哪边，又脆又多一次调用。

更好的做法是：路由可以猜错，但两边要能互相校验，而且校验必须是零 LLM 的。 coding 场景里这个条件恰好满足，因为代码侧的答案天然带位置。

流程是这样：按最廉价的先验路由（问句里有「为什么/之前/怎么决定的」走日志，有「现在/当前/有没有」且能定位到符号走代码，有「继续/接着/上次」走任务恢复）。走代码得到答案后，拿那个文件路径或符号去反查日志，问一句「这个符号最近一次被讨论是什么时候、说了什么」。这是一次 FTS 查询，几毫秒。一致就收工，不一致就把两边都端出来、标明冲突。

关键在于：校验的 key 是符号，不是语义。 所以它是确定性的，不会有「语义上像不像」的模糊地带。你不需要分类器准，你只需要这个廉价的回查兜住分类错误。

三、符号就是连接两个世界的 join key

顺着上面这条，索引该抽什么也就定了。每条事件进库时，零 LLM 地抽出它触碰过的符号集合：文件路径、标识符、错误码、commit hash、测试名。正则加可选的 tree-sitter 就够，不需要模型。

这一下带来三件事：

「这个函数的历史」变成一次倒排查询，不是向量近似；日志和代码之间有了确定性的 join；而且上一轮说的「事件级匹配」的索引材料问题也解决了 —— 一个事件的可检索内容，本来就不该是它那句自然语言，而是它碰过哪些东西。

这也正是向量在 coding 场景干不了的活：get_user_id 和 get_user_ids 的 embedding 几乎重合，但倒排里它们是两个不同的 key。

四、「帮我继续完成 XX 任务」跟「为什么这样决策」不是一类

你把这两个都归到读日志，没错，但它们要的东西完全不同：

「为什么这样决策」是点查询 —— 找一个特定的决策点及其上下文，top-k 片段就行。

「继续完成 XX 任务」是状态重建 —— 要的是做到哪一步了、原计划下一步是什么、有什么挂着没解决的。这不是检索，top-k 片段对它几乎没用，因为重要的是完整性和未闭合项，不是相关性。

它该取的是：整个 task 的时间线骨架（每个事件压成一行：做了什么、结果是什么）+ 尾部若干步的原文 + 显式标出未闭合的东西（计划了没执行的、报错了没解决的、开了没关的 TODO）。

所以工具面上它得是独立的一个接口，比如 resume_task(task_id)，不能当成 search 的一种用法。否则 agent 会拿 top-k 去恢复状态，恢复出一个有洞的心智模型 —— 而且它不会知道有洞。

这样算下来，查询侧其实就四类，各自有自己的取法：点查历史（倒排+向量，top-k）、任务恢复（骨架+尾部+未闭合项）、查现状（读世界，带符号回查校验）、查某符号的全部历史（纯倒排）。你前面说的「做了正确的匹配问题会比较轻松」，轻松就轻松在这四类的边界其实挺清楚，不需要一个聪明的分类器去猜。

1m 15s | 11 hours ago
0:08

---

## 15. USER

也都都做，反正核心是建立正确的心智模型，那我觉得直接读log得到的信息可能会比强制合成一个场景强的多，而且更方便

---

## 16. ASSISTANT

「强制合成一个场景」这个说法很准 —— 蒸馏出来的记忆条目就是一个被重新编造的场景，它跟真实发生过的事只有相似关系。它弱在三个地方，其中第一个是结构性的，不是模型不够强能解决的：

显著性是查询条件化的。 写入时的那个 LLM 不可能知道未来会被问什么，它只能按通用显著性压缩。但实际查询往往要的正是当时看起来不重要的细节 —— 某次报错的具体行号、某个试错用的参数值。所以"写入时决定留什么"这个动作本身就注定错，换多强的模型都一样。这跟 2610.07309 说的「可接受性是查询条件化的、不是记录属性」是同一件事的另一面。

合成会抹掉「看起来」和「实际是」的差别。 日志里 agent 说"已经修好了"、下一条测试没过，两条并列时矛盾是可见的；蒸馏一遍很可能变成"修复了 X 问题"，错误被洗成事实。eval/BASELINE.md 里原话记的就是这个：「助手答错的内容也会被蒸馏成记忆」。

"更方便"这点你说得轻，其实是最硬的。 不做合成，就没有写入管道、没有一致性维护、没有冲突消解、没有衰减策略、没有池容量管理，以及这些东西各自的 bug。差的是一个数量级的工程复杂度，这也是 MemMachine 那句 "over-optimizing the wrong stage" 的实际含义。

但「都做 + 直接读 log」有一个风险要守住

全量暴露不是上界，它会主动变坏。2607.08716 自报：full-bank 全量暴露比它完整系统差 2.8 macro 点。

原因在 coding 场景特别突出：日志里有大量失败尝试、被推翻的结论、中间状态，这些在原文里是平铺的，没有任何标记说哪些已经作废。agent 读进来 50 条事件，其中 30 条是死路，它不一定分得清 —— 而且分不清的时候它不会说自己分不清。

所以「直接读 log 更强」要加个前提：读的是经过裁剪的 log。而裁剪依据不能是"重要性"，那又回到合成了。有个不需要 LLM 的规则：

成功路径只给结果，失败路径给全过程。

因为成功路径的过程在代码里 —— 代码就是成功路径的产物，要细节直接读代码。失败路径在世界上不留任何痕迹，只有日志有，那才是日志不可替代的部分。再叠一条：被 revert、被 supersede 的默认不出现在首次返回里，但可以追问调出来。

这两条合起来是纯机械的，靠 git 和任务边界就能判，不用模型。

还差一个验证门

你说核心是建立正确的心智模型 —— 但建完之后，现在没有任何东西说它是对的。coding 场景里有个很便宜的办法：

心智模型里凡是可被世界证伪的断言，建模完成时批量去证伪一次。 模型说"认证走 JWT，在 auth/middleware.py"，这就是一条可验证断言，grep 一下就知道。验证失败说明日志相对代码已经过期，这时候报出来，比让 agent 带着错误前提干活强太多。

这个门零 LLM、一次性、可以并行跑完。而且它正好落在 2604.20874 说的位置上 —— 验证必须在被验证的信道之外进行，而这里的"外部"就是代码库本身。coding 场景白送你一个外部验证器，别浪费。

整轮下来这套东西已经收敛了：事件级日志 + git join 出任务与取代关系 + 符号倒排为主向量为辅 + 四个查询接口 + 任务起点建模 + 建模后批量证伪，写侧零 LLM，压缩只发生在会话内且不落盘。

我把它整理成一份设计文档放工作区吧 —— 包含数据模型（事件表、任务表、符号倒排）、四个工具的签名与返回结构、裁剪与验证规则，以及对照 Dynamics-memory 现有文件的改动点。散在对话里的决策容易丢，落成文件你也好改。要我动手就说一声。

59s | 11 hours ago
0:12

---

## 17. USER

清理一下Workspace，这样是真可以干个大的了

---

## 18. ASSISTANT

先看看现在有什么，再决定怎么动。

Ran commands
2

工作区很干净，没有垃圾文件 —— 该做的是归档整理，不是删除。这些都是你的成果。

used
Bash
275ms
Edited files
2
工作区索引
MD
工作区索引
design/ — 当前项目
agent-memory-design.md — coding 场景 agent-memory 设计文档（首版，未实现）
讨论收敛的结果：写侧零 LLM、事件级日志按 task 分段、符号倒排为主、五个 MCP 工具、
任务起点并行建模、建模后批量证伪。含与 Dynamics-memory 的对照改动点、评估计划、待决策项。
research/ — 研究输入（事实来源）
dm-code-read.md — Dynamics-memory 源码通读笔记。
hybrid_memory/ 全部 67 个 py、.opencode/ 插件与三个 agent、README、eval 报告。
三档标注：[代码] / [文档] / [目标]。含自我更正段与精确未读清单。
uploads/ — 用户上传（勿修改）
notes-agent-memory-efficacy.md — 81 篇五轮主题笔记
deep-read-cards.md — 11 篇深读卡
literature-report.html、review-mechanism-report.html、README.md
archive/ — 前序任务成果
literature/ — lit-report.html、lit-deck.html，生成器在 build/
（改内容改生成器再跑，不要直接改 HTML）
pr1538/ — pr1538-report.html、pr1538-deck.html
Open
agent-memory 设计文档（coding 场景）
MD
agent-memory 设计文档（coding 场景）

状态：讨论收敛后的首版，未实现。
标注约定沿用 research/dm-code-read.md：[代码] 实际源码事实（附文件名）、[文档] 项目文档声称、[目标] 尚未实现的目标态、[自报] 论文自己报告的数字。

0. 一句话

不在写入侧做任何 LLM 加工：把 agent 的完整事件日志按任务分段存下来，用符号倒排和 git 结构建索引，通过工具接口让 agent 在任务起点自己把心智模型读出来；压缩只允许发生在会话内，且不落盘。

1. 范围

做： coding agent 的跨会话记忆。单项目、单仓库、本地优先。

不做：

通用对话场景的记忆（单任务短、边界少、没有权威真值源，收益不足以覆盖复杂度）
跨项目的知识迁移
任何形式的持久化摘要

场景限定带来的三项红利，整个设计建立在这三条之上：

世界是可寻址且权威的（文件系统、git、测试结果）
任务边界大半是免费的（commit、分支切换、测试由红转绿）
查询词多为精确符号（函数名、路径、错误码），适合倒排远胜向量
2. 核心主张

2.1 显著性是查询条件化的，所以写入时的取舍必错。
写入时的 LLM 无法预知未来会被问什么，只能按通用显著性压缩；而实际查询常常要的正是当时看起来不重要的细节。这是结构性的，换更强的模型解决不了。

2.2 压缩的罪不在压缩，在压缩后删原件。
判据：这个加工件错了，原始信息还找得回来吗。找得回来就安全。因此摘要只允许做导航（决定读不读），不允许做替代（替代原文被消费）。

2.3 "现在是什么"问世界，"为什么是这样 / 试过什么没成"问日志。
代码和 git 是现势的权威来源。用日志去推演当前状态，是用不权威的副本对抗权威的原件，且时间戳会让错误变得更自信。

2.4 全量暴露不是上界。
日志里平铺着大量失败尝试和被推翻的结论，没有作废标记。必须裁剪，但裁剪依据不能是"重要性"（那等于又做了一次合成），只能是机械规则（见第 8 节）。

3. 数据模型

设计原则：没有 memory 表，没有 summary 表。 全部是事实表加索引。

3.1 events — 最细粒度单元是事件，不是对话
SQL
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

要点：

tool_call 与 tool_result 分两行（时间不同，各自可检索），用 call_id 配对。
大结果不进 text。读了一个 5000 行文件，text 只存摘要行（路径、行数、前若干行），原文落 blob_ref。否则 FTS 索引会被单次文件读淹没。
role='tool' 的行是现在 Dynamics-memory 完全没有的东西，见第 10 节。
3.2 tasks — 存储与检索的一等单元
SQL
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

boundary_src 必须保留，因为边界是推断出来的、允许事后修订。原文是事实，边界只是索引 —— 索引错了可以重建，这是本方案相对压缩方案的核心退路。

supersedes 边是 N53 那个病的解法（见第 10 节）：检索时自动排除被取代的任务。

3.3 symbols — coding 场景的主索引
SQL
CREATE TABLE symbols (
  sym      TEXT    NOT NULL,
  kind     TEXT    NOT NULL,            -- path | ident | errcode | sha | testname
  event_id INTEGER NOT NULL,
  PRIMARY KEY (sym, kind, event_id)
);
CREATE INDEX idx_symbols_event ON symbols(event_id);

抽取零 LLM：正则为主（路径、错误码、commit sha、测试名），标识符可选接 tree-sitter。
这是日志与代码之间的确定性 join key。 一个事件的可检索内容不是它那句自然语言，而是它碰过哪些东西。

3.4 FTS 与向量
SQL
CREATE VIRTUAL TABLE events_fts USING fts5(text, content='events', content_rowid='id');

向量索引单独一张表，降为兜底，只接"说不出关键词"的查询。
理由：get_user_id 与 get_user_ids 的 embedding 几乎重合但指不同的东西，这类错在 coding 场景是致命的；倒排里它们是两个 key。

4. 写入路径（零 LLM）
text
agent 运行时 → 事件落 events（同步，仅 insert）
            → 抽符号落 symbols（同步，正则）
            → FTS 自动更新
            → 大结果落 blob
（异步/批）  → git 扫描 → 划 tasks、回填 task_id、建 task_edges

全程不调用任何模型。没有抽取、没有去重、没有冲突消解、没有衰减。
这是"更方便"的实际含义：少掉的是写入管道、一致性维护、池容量管理，以及它们各自的 bug。

任务边界的来源，按可信度排序
git commit / 分支切换（boundary_src='git'，最可信）
测试由红转绿、文件集合突变、长时间间隔（heuristic）
用户显式说"好了 / 下一个"，或低置信时主动问一次（user）

不采用"每轮询问任务是否结束"：任务是嵌套的、会回溯的，且打断有成本。

5. 查询接口（MCP 工具面）

五个工具，语义边界互不重叠。每个返回都必须带定位符（task_id + seq 区间），否则 agent 只能整段灌。

工具	用途	关键返回
list_tasks(filter, limit)	目录。第一次查询的落脚点	task 列表 + 标题 + 状态 + 时间 + 关联 commit
search_history(query, symbols?, task_id?, k)	点查历史："为什么这样决策"	命中事件 + 所属任务 + 定位符
symbol_history(sym, kind?, limit)	某符号的全部历史。纯倒排	按时间排序的事件行
resume_task(task_id)	状态重建："继续完成 XX"	骨架 + 尾部原文 + 未闭合项
read_events(task_id, seq_from, seq_to)	分页读原文	原始事件
两个要点

search_history 的返回形态就是两段式检索本身：事件级精确命中（高精度小粒度），同时带出它所属的任务（粗粒度容器），任务内其他内容由 agent 自己用 read_events 按需补全。扩展依据是任务归属而非时间邻接 —— 任务是意图边界，邻接只是巧合。

resume_task 不能退化成 search 的一种用法。 状态重建要的是完整性和未闭合项，不是相关性；用 top-k 去恢复状态，会恢复出一个有洞的心智模型，而 agent 不会知道有洞。它返回三样：

时间线骨架（每个事件压成一行：做了什么、结果是什么）
尾部 N 步的原文
显式未闭合项（计划了没执行的、报错了没解决的、开了没关的 TODO）
6. 任务起点建模
text
任务开始
  → 第 1 轮：并行广撒 3–5 个查询（list_tasks + symbol_history + search_history）
  → 第 2 轮：按结果收窄，read_events 补全
  → 批量证伪（第 9 节）
  → 进入执行循环

并行是关键：K=2 轮的往返能达到串行 K=5 的覆盖。串行只在"必须根据上一次结果决定下一次查什么"时才需要。

成本参考 [自报]：MemAgent（2609.32521）的 Begin 阶段开销约 370 tokens（中位 268，最大 2.2K），整任务注入约 1.2K tokens，占任务 token 的 <0.5%。

必须有预算上限和停止条件。 agent 很容易过度阅读，读满 100K 后会撞上 AMA-Bench [自报] 的长上下文 32K 后显著衰减。停止条件要显式告知 agent："你要建立的心智模型是为了回答什么。"

7. 路由与交叉校验

不追求"查询分类分对"，追求"分错了能被廉价兜住"。

廉价先验（零 LLM，看问句形态）：

含"为什么 / 之前 / 怎么决定的" → 日志
含"现在 / 当前 / 有没有"且能定位到符号 → 读世界
含"继续 / 接着 / 上次" → resume_task

符号级回查（这才是关键）： 走读世界得到答案后，拿那个文件路径或符号去 symbol_history 反查一次 —— 几毫秒的倒排查询。一致则收工；不一致则两边都端出、明确标注冲突。

校验的 key 是符号不是语义，所以是确定性的。冲突本身是高价值信号：它意味着心智模型有洞，静默选一边是最糟的处理。

8. 裁剪规则（机械，零 LLM）

成功路径只给结果，失败路径给全过程。
理由：成功路径的过程在代码里（代码就是它的产物），要细节直接读代码；失败路径在世界上不留痕迹，只有日志有 —— 那才是日志不可替代的部分。

被 revert / 被 supersede 的任务默认不出现在首次返回，但可追问调出。

依据 [自报]：2607.08716 报告 full-bank 全量暴露比其完整系统差 2.8 macro 点。全量暴露会主动变坏。

9. 验证门

建模完成时，把心智模型里所有可被世界证伪的断言批量证伪一次。

例：模型认为"认证走 JWT，在 auth/middleware.py" → grep 验证。失败说明日志相对代码已过期，报给 agent，而不是让它带着错误前提开工。

零 LLM、一次性、可并行。
依据 [自报]：2604.20874 Root Theorem 推论 —— 验证必须在被验证的信道之外进行。coding 场景白送一个外部验证器（代码库本身）。

10. 与 Dynamics-memory 的对照

以下均为 [代码]，来自 research/dm-code-read.md 的通读记录。

现状	本设计
store/schema.py::_DDL_LOG 的 units 只有 user_text/assistant_text 两列文本，FTS 也只建这两列	events 表含工具事件行；没有任何能表示"agent 做了 X"的结构是当前最大的结构性障碍
transport/dto.py::observe_payload 只有两个字符串；memory-bridge.ts 两处只收 part.type==="text"	工具世界被过滤两次，必须打开
transport/bootstrap.py::build_default_service 设 lex_weight=0.0	FTS 已建好却关着，coding 场景它该是主路。接近零成本
core/types.Memory 的 kind 只有 fact/reflection，无 locator、无 TTL	不需要 Memory 类型；事实表 + 定位符
service/recall.py 每轮注入一次、在工具循环之前	改为任务起点一次 prefetch + 循环内按需查
core/dynamics.py 衰减、core/consolidation.py、去重与张力	不存压缩件就不需要维护压缩件，整体不需要

保留的部分（与"存什么"无关，是真资产）：

agents/selector.py::authorized_change 的授权链（只认用户原话）
人审水位、因果界
store/tasks.py 的事务与回执

项目自身的佐证： eval/BASELINE.md（2026-09-27，mock LLM）记录三个消融 decay_only/abl_no_dedup/abl_no_tension 在 recall 与 ctx_eff 上同时高于完整版（完整版 0.792/0.691）；同文件记「助手答错的内容也会被蒸馏成记忆」。eval/l2l3/REPORT.md 的 N53 三链一致复现「旧值与新候选并排端出、已作废值继续服务」，原话「当前检索质量的主要敌人是内核不是模型」。

11. 评估计划

主假设（可证伪）：

在 AMA-Bench 上，用「task 分段的原文 + FTS + 结构化元数据 + supersedes 边 + 工具化按需查」，能否逼近 AMA-Agent 的 57.22%，同时把记忆构建侧的 LLM 调用降到接近零？

选它的理由：数据集、长上下文基线、13 个记忆系统对照全是现成的，且它测的是真实 agent 轨迹（状态/动作/观测/工具输出），而非对话。

必报的三项：

准确率 vs 长上下文基线（基线在该集上 [自报] 持续强势、经常最好）
记忆构建侧的 LLM 调用数（本方案的主张是接近零；对照 LRE [自报] 零 compressor 调用、19 次调用完成对 ACON 的 49 LLM + 8 compressor）
任务步数配对（2609.32521 [自报] 路由方案减少 12% 平均步数）
12. 已知风险
"原文留着"不等于"取得回来"。 ACM（2607.23809）的公开 referee report 指出：lossless 是架构属性，取回由 querier LLM 中介且输出有预算截断，操作上仍有损。把压缩挪到读侧没有消灭压缩，只是让它每次可重做 —— 好处是不累积，代价是每次都付。
"原文 + agent 自检索"已被测过且不够。 AMA-Bench 的 baseline 描述里，MemGPT 正是"存 raw trajectory，靠 agent 检索能力取回"，而它不在最强之列。结论不是方案错，是索引质量决定一切，原文和工具只是必要条件。
过度阅读。 见第 6 节的预算上限。
符号抽取的召回。 正则漏抽等于那条事件在主索引里不存在。需要 unindexed_event 遥测。
task 边界错划。 可修订，但修订需要重建 task_id 回填，要设计成幂等。
13. 待决策（开工前必须定）
新建还是改造 Dynamics-memory。 第 10 节的对照显示要动的是地基（schema），保留的是外围。
语言与运行时。 Dynamics-memory 是 Python，opencode 插件面是 TS。SQLite+FTS5 两边都好接。
宿主。 先接 opencode（已有 .opencode/plugin/memory-bridge.ts 可改），还是做成通用 MCP server。
第一个里程碑的范围。
附：相关工作中最接近的实现（均 [自报]，主体档，未逐页深读）
MemMachine（2604.04853）：存 raw episodes、句子级索引、含 MCP server。讨论节 9.1 原话："systems that invest heavily in LLM-based ingestion ... may be over-optimizing the wrong stage"。按时间邻接扩展，无 task 概念。
ACM（2607.23809，CMU+Meta）：manage_context 压缩并落盘原文，query_memory 按 id 回查。只在单任务会话内。
MemAgent（2609.32521）：Begin 阶段并行 probe 后路由。路由的是 provider 不是日志。
Maximem Synap（2607.21503）：speculative prefetching，把检索移出关键路径。
MemoryArena（2602.16313）：实验设定里"每个 subtask 开始时检索一次"，但这是评测设定，不是存储层组织原则。
LRE（2606.20954）：千字节级 CPU 打分器、压缩时零 LLM 调用、逐字保留。
产业侧：engram（Go + SQLite + FTS5 + MCP）、Data Olympus（MCP 检索只返回经 validity 与 supersession 检查后仍生效的知识）、AtMem（provenance + execution evidence）。

novelty 判断： 部件全是现成的。没人占的空位是把 task 当成存储与检索的一等单元 —— 现有粒度是 turn/episode/sentence、trajectory、provider 或 summary 段。值得占的理由是 AMA-Bench 自己的诊断：现有系统失败于 "fail to capture causal and objective information"，而它的解法 causality graph 要花 LLM 调用去抽；任务边界 + supersedes 边是几乎免费的因果结构。

Open
Summary
代码基线：新建一个干净仓库，还是在 Dynamics-memory 上改？
新建干净仓库
语言与运行时？
TypeScript
第一个里程碑做到哪？
直接做到五个工具可用
3m 9s | 11 hours ago
0:21

三个都定了：新建仓库、TypeScript、直接做到五个工具可用。先探环境。

Ran commands
4

ABI 不匹配导致段错误。降到支持 Node 20 的版本。

used
Bash
3.2s

better-sqlite3 v11 正常，SQLite 3.49.2 带 FTS5。装齐依赖。

used
Bash
10s

依赖齐了。现在写核心代码。

Edited files
11
segment.ts
JS
/**
 * 任务划分与回填。
 *
 * 边界来源按可信度排序：
 *   1. git commit / 分支切换  (boundary_src='git')
 *   2. 时间间隔、文件集合突变  (boundary_src='heuristic')
 *   3. 用户显式标注            (boundary_src='user')
 *
 * 不采用"每轮询问任务是否结束"：任务是嵌套的、会回溯的，且打断有成本。
 * 边界允许事后修订 —— 原文是事实，边界只是索引，索引错了可以重建。
 */

import type { DB } from '../db/open.ts';

export interface SegmentOptions {
  /** 超过这个静默时长视为新任务（毫秒）。默认 45 分钟。 */
  gapMs?: number;
  /** 文件集合 Jaccard 低于此值视为换了主题。 */
  jaccardSplit?: number;
  /** 文件集合 Jaccard 高于此值且非相邻，建 continues 边。 */
  jaccardContinues?: number;
}

export interface SegmentResult {
  tasks: number;
  assigned: number;
  edges: { supersedes: number; continues: number };
  fromGit: number;
  fromHeuristic: number;
}

interface EvRow {
  id: number;
  ts: number;
  session_id: string;
  seq: number;
}

interface CommitRow {
  sha: string;
  ts: number;
  subject: string;
  branch: string | null;
  files_json: string;
  reverts_sha: string | null;
}

/**
 * 重建全部任务划分。幂等：清空 tasks 后重算，events.task_id 通过
 * ON DELETE SET NULL 自动置空再回填。
 */
export function rebuildTasks(db: DB, opts: SegmentOptions = {}): SegmentResult {
  const gapMs = opts.gapMs ?? 45 * 60 * 1000;
  const jSplit = opts.jaccardSplit ?? 0.15;
  const jCont = opts.jaccardContinues ?? 0.6;

  const result: SegmentResult = {
    tasks: 0,
    assigned: 0,
    edges: { supersedes: 0, continues: 0 },
    fromGit: 0,
    fromHeuristic: 0,
  };

  const events = db
    .prepare(`SELECT id, ts, session_id, seq FROM events ORDER BY ts ASC, id ASC`)
    .all() as EvRow[];
  if (events.length === 0) return result;

  const commits = db
    .prepare(`SELECT sha, ts, subject, branch, files_json, reverts_sha FROM commits ORDER BY ts ASC`)
    .all() as CommitRow[];

  const tx = db.transaction(() => {
    db.exec(`DELETE FROM task_edges; DELETE FROM tasks;`);

    // ---------- 第一刀：按 commit 时间切 ----------
    type Seg = {
      evIds: number[];
      startTs: number;
      endTs: number;
      commit: CommitRow | null;
      src: 'git' | 'heuristic';
    };
    const segs: Seg[] = [];

    if (commits.length > 0) {
      let ci = 0;
      let cur: Seg = {
        evIds: [],
        startTs: events[0]!.ts,
        endTs: events[0]!.ts,
        commit: null,
        src: 'git',
      };
      for (const ev of events) {
        // 该事件之前已经发生的 commit，全部用来封段
        while (ci < commits.length && commits[ci]!.ts <= ev.ts) {
          cur.commit = commits[ci]!;
          cur.endTs = commits[ci]!.ts;
          if (cur.evIds.length > 0) segs.push(cur);
          ci++;
          cur = { evIds: [], startTs: ev.ts, endTs: ev.ts, commit: null, src: 'git' };
        }
        cur.evIds.push(ev.id);
        cur.endTs = ev.ts;
      }
      if (cur.evIds.length > 0) {
        cur.src = 'git';
        segs.push(cur);
      }
    } else {
      segs.push({
        evIds: events.map((e) => e.id),
        startTs: events[0]!.ts,
        endTs: events[events.length - 1]!.ts,
        commit: null,
        src: 'heuristic',
      });
    }

    // ---------- 第二刀：段内按时间 gap 再切（heuristic） ----------
    const tsById = new Map(events.map((e) => [e.id, e.ts]));
    const refined: Seg[] = [];
    for (const seg of segs) {
      let bucket: number[] = [];
      let prevTs: number | null = null;
      for (const id of seg.evIds) {
        const ts = tsById.get(id)!;
        if (prevTs !== null && ts - prevTs > gapMs && bucket.length > 0) {
          refined.push({
            evIds: bucket,
            startTs: tsById.get(bucket[0]!)!,
            endTs: prevTs,
            commit: null,
            src: 'heuristic',
          });
          bucket = [];
        }
        bucket.push(id);
        prevTs = ts;
      }
      if (bucket.length > 0) {
        refined.push({
          evIds: bucket,
          startTs: tsById.get(bucket[0]!)!,
          endTs: prevTs ?? seg.endTs,
          // 只有最后一个 bucket 继承 commit（commit 发生在段尾）
          commit: seg.commit,
          src: seg.commit ? 'git' : seg.src,
        });
      }
    }

    // ---------- 落 tasks ----------
    const insTask = db.prepare(/* sql */ `
      INSERT INTO tasks (title, started_ts, ended_ts, status, branch, commit_sha, boundary_src)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const setTask = db.prepare(`UPDATE events SET task_id = ? WHERE id = ?`);

    const taskIds: number[] = [];
    const shaToTask = new Map<string, number>();

    refined.forEach((seg, idx) => {
      const isLast = idx === refined.length - 1;
      const status = seg.commit ? 'done' : isLast ? 'open' : 'abandoned';
      const title = seg.commit?.subject ?? null;
      const info = insTask.run(
        title,
        seg.startTs,
        seg.endTs,
        status,
        seg.commit?.branch ?? null,
        seg.commit?.sha ?? null,
        seg.src,
      );
      const tid = Number(info.lastInsertRowid);
      taskIds.push(tid);
      if (seg.commit) shaToTask.set(seg.commit.sha, tid);
      if (seg.src === 'git') result.fromGit++;
      else result.fromHeuristic++;
      for (const eid of seg.evIds) {
        setTask.run(tid, eid);
        result.assigned++;
      }
    });
    result.tasks = taskIds.length;

    // ---------- 任务标题兜底：无 commit 的段取首条 user 文本 ----------
    const firstUserText = db.prepare(/* sql */ `
      SELECT text FROM events
       WHERE task_id = ? AND role = 'user' AND text IS NOT NULL AND TRIM(text) <> ''
       ORDER BY ts ASC LIMIT 1
    `);
    const updTitle = db.prepare(`UPDATE tasks SET title = ? WHERE id = ? AND title IS NULL`);
    for (const tid of taskIds) {
      const r = firstUserText.get(tid) as { text: string } | undefined;
      if (r?.text) updTitle.run(oneLine(r.text, 90), tid);
    }

    // ---------- supersedes：revert 是强信号 ----------
    const insEdge = db.prepare(
      `INSERT OR IGNORE INTO task_edges (src, dst, rel, note) VALUES (?, ?, ?, ?)`,
    );
    for (const c of commits) {
      if (!c.reverts_sha) continue;
      const srcTid = shaToTask.get(c.sha);
      if (!srcTid) continue;
      if (c.reverts_sha === 'unknown') {
        // 只有 "Revert ..." 字样：回滚目标用 subject 反查
        const target = c.subject.replace(/^revert[\s:"']+/i, '').replace(/["']$/, '').trim();
        const hit = commits.find((x) => x.sha !== c.sha && x.subject.trim() === target);
        const dst = hit ? shaToTask.get(hit.sha) : undefined;
        if (dst && dst !== srcTid) {
          insEdge.run(srcTid, dst, 'supersedes', 'revert by subject match');
          result.edges.supersedes++;
        }
        continue;
      }
      const dstSha = [...shaToTask.keys()].find((s) => s.startsWith(c.reverts_sha!));
      const dst = dstSha ? shaToTask.get(dstSha) : undefined;
      if (dst && dst !== srcTid) {
        insEdge.run(srcTid, dst, 'supersedes', `reverts ${c.reverts_sha.slice(0, 10)}`);
        result.edges.supersedes++;
      }
    }

    // ---------- continues：文件集合高度重叠且非相邻 ----------
    const fileSets = new Map<number, Set<string>>();
    const pathRows = db
      .prepare(
        /* sql */ `SELECT e.task_id AS tid, s.sym AS p
                   FROM symbols s JOIN events e ON e.id = s.event_id
                   WHERE s.kind = 'path' AND e.task_id IS NOT NULL`,
      )
      .all() as Array<{ tid: number; p: string }>;
    for (const r of pathRows) {
      if (!fileSets.has(r.tid)) fileSets.set(r.tid, new Set());
      fileSets.get(r.tid)!.add(r.p);
    }
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 2; j < taskIds.length; j++) {
        const a = fileSets.get(taskIds[i]!);
        const b = fileSets.get(taskIds[j]!);
        if (!a || !b || a.size < 2 || b.size < 2) continue;
        if (jaccard(a, b) >= jCont) {
          insEdge.run(taskIds[j]!, taskIds[i]!, 'continues', 'file-set overlap');
          result.edges.continues++;
        }
      }
    }

    void jSplit; // 文件集合突变切分留待接入 diff 粒度后启用
  });

  tx();
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** 用户显式修订某段事件的任务归属。索引错了可以重建，这是本方案的退路。 */
export function reassign(db: DB, eventIds: number[], taskId: number): number {
  const upd = db.prepare(`UPDATE events SET task_id = ? WHERE id = ?`);
  const markUser = db.prepare(`UPDATE tasks SET boundary_src = 'user' WHERE id = ?`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of eventIds) n += upd.run(taskId, id).changes;
    markUser.run(taskId);
  });
  tx();
  return n;
}

Open
git.ts
JS
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

Open
symbols.ts
JS
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

/** 每个事件最多抽多少符号。防止一次大文件读把索引撑爆。 */
const MAX_SYMBOLS_PER_EVENT = 240;

const CODE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|kts|scala|sql|sh|bash|zsh|fish|ps1|yaml|yml|toml|ini|cfg|conf|env|json|jsonc|md|mdx|txt|lock|gradle|make|mk|proto|graphql|gql|vue|svelte|astro|css|scss|less|html|xml|csv|tsv';

/** 路径：含目录分隔符，或带已知代码扩展名的裸文件名 */
const RE_PATH_WITH_DIR = new RegExp(
  String.raw`(?:^|[\s"'\`(\[<=:,])((?:\.{0,2}/)?(?:[\w.@-]+/){1,}[\w.@-]+(?:\.(?:${CODE_EXT}))?)`,
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

  // 截断：path / errcode / test / sha 优先于 ident
  const order: Record<SymbolKind, number> = { path: 0, errcode: 1, test: 2, sha: 3, ident: 4 };
  const all: ExtractedSymbol[] = [...found.entries()]
    .map(([key, kind]) => ({ sym: key.split('\u0000')[1]!, kind }))
    .sort((a, b) => order[a.kind] - order[b.kind] || a.sym.localeCompare(b.sym));

  return all.slice(0, MAX_SYMBOLS_PER_EVENT);
}

Open
schema.ts
JS
open.ts
JS
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { DDL, SCHEMA_VERSION } from './schema.ts';

export type DB = Database.Database;

export interface OpenOptions {
  /** 数据库文件路径。默认 .tasklog/log.db */
  path?: string;
  readonly?: boolean;
}

export function defaultDbPath(root = process.cwd()): string {
  return join(root, '.tasklog', 'log.db');
}

export function blobDir(dbPath: string): string {
  return join(dirname(resolve(dbPath)), 'blobs');
}

export function openDb(opts: OpenOptions = {}): DB {
  const path = resolve(opts.path ?? process.env.TASKLOG_DB ?? defaultDbPath());
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(blobDir(path), { recursive: true });

  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  if (!opts.readonly) migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(DDL);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current === 0) {
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  } else if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}，请升级 tasklog。`,
    );
  }
  // 未来的迁移在这里按 current -> SCHEMA_VERSION 逐级应用。
}

export function dbExists(path?: string): boolean {
  return existsSync(resolve(path ?? process.env.TASKLOG_DB ?? defaultDbPath()));
}

Open
types.ts
JS
/**
 * 核心类型。对应 design/agent-memory-design.md 第 3 节。
 *
 * 设计原则：没有 Memory 类型，没有 Summary 类型。
 * 全部是事实（events）加索引（tasks / symbols / fts）。
 */

export type Role = 'user' | 'assistant' | 'tool' | 'system';

/**
 * 事件种类。最细粒度单元是事件，不是对话 —— coding agent 一轮里
 * 文本部分常是客套话，有判别力的内容在 tool_call 的参数和 tool_result 里。
 */
export type EventKind = 'text' | 'tool_call' | 'tool_result' | 'error';

export type Outcome = 'ok' | 'error';

export interface EventInput {
  sessionId: string;
  /** 会话内单调序号。与 sessionId 构成唯一键，重复写入幂等。 */
  seq: number;
  /** epoch ms。最细粒度时间戳。 */
  ts: number;
  role: Role;
  kind: EventKind;
  toolName?: string | null;
  /** tool_result 借此指回它的 tool_call */
  callId?: string | null;
  /** tool_call 的完整参数 */
  args?: unknown;
  /** 文本内容。大结果只存摘要行，原文走 blobRef。 */
  text?: string | null;
  /** 大结果的落盘路径 */
  blobRef?: string | null;
  /** 原始结果字节数（即使内容落盘也记录） */
  nbytes?: number | null;
  outcome?: Outcome | null;
}

export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  ts: number;
  task_id: number | null;
  role: Role;
  kind: EventKind;
  tool_name: string | null;
  call_id: string | null;
  args_json: string | null;
  text: string | null;
  blob_ref: string | null;
  nbytes: number | null;
  outcome: Outcome | null;
}

export type TaskStatus = 'open' | 'done' | 'abandoned';

/**
 * 边界来源。必须保留：边界是推断出来的、允许事后修订。
 * 原文是事实，边界只是索引 —— 索引错了可以重建。
 * 这是本方案相对压缩方案的核心退路。
 */
export type BoundarySource = 'git' | 'heuristic' | 'user';

export interface TaskRow {
  id: number;
  title: string | null;
  started_ts: number;
  ended_ts: number | null;
  status: TaskStatus;
  branch: string | null;
  commit_sha: string | null;
  boundary_src: BoundarySource;
}

/** parent: 嵌套；continues: 回溯续做；supersedes: src 取代 dst */
export type TaskRel = 'parent' | 'continues' | 'supersedes';

/**
 * 符号类型。这是日志与代码之间的确定性 join key。
 * 一个事件的可检索内容不是它那句自然语言，而是它碰过哪些东西。
 */
export type SymbolKind = 'path' | 'ident' | 'errcode' | 'sha' | 'test';

export interface ExtractedSymbol {
  sym: string;
  kind: SymbolKind;
}

export interface GitCommit {
  sha: string;
  ts: number;
  author: string;
  subject: string;
  body: string;
  branch: string | null;
  files: string[];
  /** 从 message 解析出的被回滚 commit（Revert "..." / This reverts commit <sha>） */
  revertsSha: string | null;
}

/** 查询返回里必须带的定位符，否则 agent 只能整段灌 */
export interface Locator {
  taskId: number | null;
  sessionId: string;
  seq: number;
  eventId: number;
}

Open
tsconfig.json
JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]
}

Open
package.json
JSON
{
  "name": "tasklog",
  "version": "0.1.0",
  "description": "Task-segmented event log as agent memory for coding agents. Zero-LLM write path.",
  "type": "module",
  "license": "MIT",
  "bin": {
    "tasklog": "./src/cli.ts"
  },
  "scripts": {
    "cli": "tsx src/cli.ts",
    "mcp": "tsx src/mcp/server.ts",
    "demo": "tsx scripts/make-demo.ts",
    "test": "tsx test/run.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.1",
    "better-sqlite3": "^11.10.0",
    "zod": "^4.6.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^26.6.5",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2"
  }
}

Open

核心库写完了。现在造一份真实的 demo（真 git 仓库、真 revert），用来端到端验证。

Write
tasklog/scripts/make-demo.ts
257 lines
open
make-demo.ts
JS
/**
 * 造一份端到端的 demo：真实 git 仓库（含一次 revert）+ 对应的 agent 事件日志。
 *
 * 场景刻意覆盖讨论里那个关键例子：
 *   端口 8080 -> 9090 -> revert 回 8080。
 *   只看日志会被 9090 骗（时间戳让错误更自信），有 supersedes 边才排得掉。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, defaultDbPath } from '../src/db/open.ts';
import { Ingestor } from '../src/ingest/events.ts';
import { syncCommits } from '../src/tasks/git.ts';
import { rebuildTasks } from '../src/tasks/segment.ts';
import type { EventInput } from '../src/types.ts';

const ROOT = resolve(process.argv[2] ?? join(process.cwd(), 'demo-repo'));
const DB_PATH = resolve(process.env.TASKLOG_DB ?? join(ROOT, '.tasklog', 'log.db'));

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 14, 9, 0, 0); // 2026-09-14 09:00 UTC

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitAt(msg: string, tsMs: number): string {
  const iso = new Date(tsMs).toISOString();
  git(['add', '-A']);
  git(['commit', '-m', msg, '--no-gpg-sign'], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  });
  return git(['rev-parse', 'HEAD']).trim();
}

function w(rel: string, content: string): void {
  const p = join(ROOT, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

// ============================================================
// 1) 建仓库
// ============================================================
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'demo']);
git(['config', 'user.email', 'demo@example.com']);
git(['config', 'commit.gpgsign', 'false']);

w('README.md', '# demo service\n');
w('config/server.yaml', 'server:\n  host: 0.0.0.0\n  port: 8080\n');
w('src/server.ts', 'export function start() { /* ... */ }\n');
commitAt('chore: scaffold', T0 - DAY);

// --- 任务 A: JWT 认证 ---
w(
  'src/auth/middleware.ts',
  `import jwt from 'jsonwebtoken';

export function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'missing token' });
  const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  req.user = { id: payload.sub, exp: payload.exp };
  next();
}
`,
);
const shaAuth = commitAt('feat(auth): add JWT middleware', T0 + 3 * 3600 * 1000);

// --- 任务 C: 改端口 ---
w('config/server.yaml', 'server:\n  host: 0.0.0.0\n  port: 9090\n');
const shaPort = commitAt('chore(config): switch port 8080 -> 9090', T0 + 3 * DAY);

// --- 任务 D: revert 端口 ---
git(['revert', '--no-edit', '--no-commit', shaPort]);
const shaRevert = commitAt(
  `Revert "chore(config): switch port 8080 -> 9090"\n\nThis reverts commit ${shaPort}.\n\n9090 与网关冲突。`,
  T0 + 4 * DAY,
);

console.log('git repo:', ROOT);
console.log('  auth   ', shaAuth.slice(0, 10));
console.log('  port   ', shaPort.slice(0, 10));
console.log('  revert ', shaRevert.slice(0, 10), '-> reverts', shaPort.slice(0, 10));

// ============================================================
// 2) 造事件日志
// ============================================================
let seq = 0;
const ev: EventInput[] = [];
const S = 'sess-demo';

function text(role: 'user' | 'assistant', ts: number, t: string): void {
  ev.push({ sessionId: S, seq: seq++, ts, role, kind: 'text', text: t });
}
function call(ts: number, tool: string, args: unknown, id: string): void {
  ev.push({
    sessionId: S,
    seq: seq++,
    ts,
    role: 'assistant',
    kind: 'tool_call',
    toolName: tool,
    callId: id,
    args,
  });
}
function result(ts: number, tool: string, id: string, out: string, ok = true): void {
  ev.push({
    sessionId: S,
    seq: seq++,
    ts,
    role: 'tool',
    kind: 'tool_result',
    toolName: tool,
    callId: id,
    text: out,
    outcome: ok ? 'ok' : 'error',
    nbytes: Buffer.byteLength(out, 'utf8'),
  });
}

// ---- 任务 A：实现 JWT 认证（成功，落 commit） ----
let t = T0;
text('user', t, '给这个服务加上 JWT 认证，接口要能校验 Authorization 头。');
t += 40_000;
text('assistant', t, '先看一下现有的 src/server.ts 和路由结构。');
t += 20_000;
call(t, 'read_file', { path: 'src/server.ts' }, 'c1');
t += 5_000;
result(t, 'read_file', 'c1', 'export function start() { /* ... */ }\n');
t += 60_000;
call(t, 'write_file', { path: 'src/auth/middleware.ts' }, 'c2');
t += 8_000;
result(t, 'write_file', 'c2', 'wrote src/auth/middleware.ts (9 lines)');
t += 30_000;
text(
  'assistant',
  t,
  '用 jsonwebtoken 的 verifyToken 做中间件，密钥从 JWT_SECRET 读。注意 payload.exp 要带出去给上层判过期。',
);
t += 20_000;
call(t, 'bash', { command: 'npm test -- auth' }, 'c3');
t += 25_000;
result(t, 'bash', 'c3', 'PASS test/auth.test.ts\n  verifyToken\n    ✓ rejects missing token\n\n1 passed');

// ---- 任务 B：refresh token（放弃，无 commit） ----
t = T0 + DAY;
text('user', t, '再加上 refresh token 吧。');
t += 30_000;
call(t, 'read_file', { path: 'src/auth/middleware.ts' }, 'c4');
t += 6_000;
result(t, 'read_file', 'c4', 'export function verifyToken(req, res, next) { ... }');
t += 90_000;
call(t, 'write_file', { path: 'src/auth/refresh.ts' }, 'c5');
t += 7_000;
result(t, 'write_file', 'c5', 'wrote src/auth/refresh.ts (34 lines)');
t += 40_000;
call(t, 'bash', { command: 'npm test -- auth' }, 'c6');
t += 30_000;
result(
  t,
  'bash',
  'c6',
  "FAIL test/auth.test.ts\n  ● refreshToken › rotates\n\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at refreshToken (src/auth/refresh.ts:21:18)\n\n1 failed, 1 passed",
  false,
);
t += 60_000;
text(
  'assistant',
  t,
  'refresh.ts 里取 payload.exp 时 payload 可能是 undefined。TODO: refresh token 的过期处理还没做完，先搁置。',
);

// ---- 任务 C：改端口（成功，落 commit） ----
t = T0 + 3 * DAY - 20 * 60_000;
text('user', t, '把服务端口从 8080 改成 9090。');
t += 25_000;
call(t, 'edit_file', { path: 'config/server.yaml', old: 'port: 8080', new: 'port: 9090' }, 'c7');
t += 5_000;
result(t, 'edit_file', 'c7', 'config/server.yaml: 1 replacement');
t += 15_000;
text('assistant', t, '已改 config/server.yaml，端口现在是 9090。');

// ---- 任务 D：revert 端口（落 revert commit → supersedes） ----
t = T0 + 4 * DAY - 15 * 60_000;
text('user', t, '端口改回去，9090 跟网关冲突了。');
t += 20_000;
call(t, 'bash', { command: `git revert --no-edit ${shaPort.slice(0, 10)}` }, 'c8');
t += 12_000;
result(t, 'bash', 'c8', `[main ${shaRevert.slice(0, 7)}] Revert "chore(config): switch port 8080 -> 9090"`);
t += 10_000;
text('assistant', t, '已回滚，config/server.yaml 的 port 恢复为 8080。');

// ---- 任务 E：查 500（open，含未闭合项与悬挂调用） ----
t = T0 + 6 * DAY;
text('user', t, '登录接口偶尔返回 500，帮我查一下。');
t += 30_000;
call(t, 'grep', { pattern: 'status(500', path: 'src' }, 'c9');
t += 8_000;
result(t, 'grep', 'c9', 'src/routes/login.ts:44:    res.status(500).json({ error: e.message });');
t += 45_000;
call(t, 'bash', { command: 'npm test -- login' }, 'c10');
t += 35_000;
result(
  t,
  'bash',
  'c10',
  "FAIL test/login.test.ts\n  ● login › handles expired token\n\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at verifyToken (src/auth/middleware.ts:8:38)\n\n1 failed",
  false,
);
t += 50_000;
text(
  'assistant',
  t,
  'middleware.ts 第 8 行 jwt.verify 失败时 payload 是 undefined，和上次 refresh.ts 是同一类问题。先读一下 middleware。',
);
t += 15_000;
call(t, 'read_file', { path: 'src/auth/middleware.ts' }, 'c11'); // 故意不给 result → dangling_call

// 一条超过 INLINE_LIMIT 的大结果，验证 blob 落盘
t += 20_000;
call(t, 'bash', { command: 'npm run build --verbose' }, 'c12');
t += 40_000;
result(
  t,
  'bash',
  'c12',
  Array.from({ length: 400 }, (_, i) => `[build] step ${i} compiling module_${i}.ts ... ok`).join('\n'),
);

// ============================================================
// 3) 入库
// ============================================================
mkdirSync(join(ROOT, '.tasklog'), { recursive: true });
const db = openDb({ path: DB_PATH });
const ing = new Ingestor(db, DB_PATH);
const stats = ing.addMany(ev);
const nCommits = syncCommits(db, ROOT);
const seg = rebuildTasks(db);

console.log('\ningest:', stats);
console.log('commits synced:', nCommits);
console.log('segment:', JSON.stringify(seg));
console.log('\ndb:', DB_PATH);
db.close();

Open
used
Bash
1.1s

ESM 下不能用 require。修掉。

Edit
tasklog/src/ingest/events.ts
×2
events.ts
JS
used
Bash
1.2s

端到端通了：34 事件 / 323 符号 / 5 任务 / 1 条 supersedes 边（revert 检出）。现在写 CLI 验证五个查询。

Write
tasklog/src/cli.ts
256 lines
open
cli.ts
JS
#!/usr/bin/env -S npx tsx
/**
 * tasklog CLI —— 用于本地验证与运维。
 * agent 走 MCP（src/mcp/server.ts），人走这里。
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDb, defaultDbPath } from './db/open.ts';
import { Ingestor, reindexSymbols, readBlob } from './ingest/events.ts';
import { syncCommits, currentBranch } from './tasks/git.ts';
import { rebuildTasks } from './tasks/segment.ts';
import {
  listTasks,
  searchHistory,
  symbolHistory,
  resumeTask,
  readEvents,
  health,
} from './query/index.ts';
import type { EventInput, TaskStatus } from './types.ts';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}
function positional(n: number): string | undefined {
  const rest = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !arr[i - 1]?.startsWith('--'));
  return rest[n];
}

const repoRoot = resolve(flag('repo') ?? process.cwd());
const dbPath = resolve(
  flag('db') ?? process.env.TASKLOG_DB ?? join(repoRoot, '.tasklog', 'log.db'),
);
const asJson = has('json');

function out(v: unknown): void {
  if (asJson) {
    console.log(JSON.stringify(v, null, 2));
  } else {
    console.dir(v, { depth: 6, maxArrayLength: 200, colors: process.stdout.isTTY });
  }
}

function ts(n: number): string {
  return new Date(n).toISOString().replace('T', ' ').slice(0, 16);
}

const db = openDb({ path: dbPath });

switch (cmd) {
  case 'health': {
    out({ db: dbPath, branch: currentBranch(repoRoot), ...health(db) });
    break;
  }

  case 'sync': {
    const n = syncCommits(db, repoRoot);
    const seg = rebuildTasks(db, {
      gapMs: flag('gap') ? Number(flag('gap')) * 60_000 : undefined,
    });
    out({ commits: n, ...seg });
    break;
  }

  case 'reindex': {
    out(reindexSymbols(db));
    break;
  }

  case 'ingest': {
    const file = positional(0);
    if (!file) {
      console.error('用法: tasklog ingest <events.json>');
      process.exit(2);
    }
    const data = JSON.parse(readFileSync(resolve(file), 'utf8')) as EventInput[];
    const ing = new Ingestor(db, dbPath);
    out(ing.addMany(data));
    break;
  }

  case 'tasks': {
    const rows = listTasks(db, {
      status: (flag('status') as TaskStatus | undefined) ?? 'any',
      q: flag('q'),
      touching: flag('touching'),
      includeSuperseded: has('all'),
      limit: Number(flag('limit') ?? 30),
    });
    if (asJson) {
      out(rows);
      break;
    }
    for (const t of rows) {
      const mark = t.superseded ? ' [SUPERSEDED]' : '';
      const err = t.errors > 0 ? `  err=${t.errors}` : '';
      console.log(
        `#${String(t.taskId).padStart(3)}  ${t.status.padEnd(9)} ${ts(t.startedTs)}  ` +
          `${(t.commit ?? '-').padEnd(10)} ${t.boundarySrc.padEnd(9)} ev=${String(t.events).padStart(3)}${err}${mark}`,
      );
      console.log(`      ${t.title ?? '(无标题)'}`);
      if (t.topPaths.length) console.log(`      paths: ${t.topPaths.join(', ')}`);
    }
    break;
  }

  case 'search': {
    const q = positional(0);
    const hits = searchHistory(db, {
      query: q,
      symbols: flag('sym') ? [flag('sym')!] : undefined,
      taskId: flag('task') ? Number(flag('task')) : undefined,
      k: Number(flag('k') ?? 8),
      includeSuperseded: has('all'),
    });
    if (asJson) {
      out(hits);
      break;
    }
    if (hits.length === 0) console.log('(无命中)');
    for (const h of hits) {
      const sup = h.task.superseded ? ' [SUPERSEDED]' : '';
      console.log(
        `[${h.score.toFixed(1)}] ${h.matchedBy.join('+').padEnd(11)} ` +
          `task#${h.task.taskId ?? '-'} seq=${h.locator.seq} ${ts(h.ts)}${sup}`,
      );
      console.log(`      ${h.brief.line}`);
      console.log(
        `      ↳ 任务: ${h.task.title ?? '-'} (${h.task.status ?? '-'}, ${h.task.events} 事件` +
          `${h.task.seqRange ? `, seq ${h.task.seqRange[0]}..${h.task.seqRange[1]}` : ''})`,
      );
    }
    break;
  }

  case 'sym': {
    const s = positional(0);
    if (!s) {
      console.error('用法: tasklog sym <symbol>');
      process.exit(2);
    }
    const r = symbolHistory(db, s, {
      kind: flag('kind') as never,
      limit: Number(flag('limit') ?? 40),
      includeSuperseded: has('all'),
    });
    if (asJson) {
      out(r);
      break;
    }
    console.log(`符号 ${r.symbol}  kinds=[${r.kinds.join(',')}]  命中 ${r.total} 次\n`);
    for (const e of r.timeline) {
      console.log(
        `${ts(e.ts)}  task#${e.taskId ?? '-'} seq=${String(e.seq).padStart(3)}` +
          `${e.superseded ? ' [SUPERSEDED]' : ''}  ${e.line}`,
      );
    }
    break;
  }

  case 'resume': {
    const id = Number(positional(0));
    if (!id) {
      console.error('用法: tasklog resume <taskId>');
      process.exit(2);
    }
    const r = resumeTask(db, id, { tail: Number(flag('tail') ?? 8) });
    if (asJson) {
      out(r);
      break;
    }
    console.log(`任务 #${id}: ${r.task?.title ?? '(无)'}  [${r.task?.status}]`);
    console.log(`commit=${r.task?.commit ?? '-'}  事件=${r.task?.events}  错误=${r.task?.errors}`);
    if (r.related.supersededBy.length)
      console.log(`!! 已被任务 ${r.related.supersededBy.join(',')} 取代`);
    if (r.related.supersedes.length) console.log(`   取代了任务 ${r.related.supersedes.join(',')}`);
    if (r.related.continues.length) console.log(`   续自任务 ${r.related.continues.join(',')}`);

    console.log(`\n--- 骨架 (${r.skeleton.length}) ---`);
    for (const e of r.skeleton) console.log(`  seq=${String(e.seq).padStart(3)}  ${e.line}`);

    console.log(`\n--- 未闭合项 (${r.openItems.length}) ---`);
    for (const o of r.openItems)
      console.log(`  [${o.kind}] seq=${o.locator.seq}  ${o.detail}`);

    console.log(`\n--- 尾部原文 (${r.tail.length}) ---`);
    for (const e of r.tail) console.log(`  seq=${String(e.seq).padStart(3)}  ${e.line}`);
    console.log(`\n${r.hint}`);
    break;
  }

  case 'read': {
    const r = readEvents(db, {
      taskId: flag('task') ? Number(flag('task')) : undefined,
      sessionId: flag('session'),
      seqFrom: flag('from') ? Number(flag('from')) : undefined,
      seqTo: flag('to') ? Number(flag('to')) : undefined,
      limit: Number(flag('limit') ?? 40),
    });
    if (asJson) {
      out(r);
      break;
    }
    for (const e of r.events) {
      console.log(`seq=${String(e.seq).padStart(3)} ${ts(e.ts)} ${e.role}/${e.kind}`);
      if (e.text) console.log(`    ${e.text.replace(/\n/g, '\n    ').slice(0, 1200)}`);
      if (e.blob) console.log(`    [blob ${e.blob}]  用 tasklog blob ${e.blob} 取回原文`);
    }
    console.log(`\n共 ${r.total} 条，nextSeq=${r.nextSeq ?? '(末尾)'}`);
    break;
  }

  case 'blob': {
    const h = positional(0);
    if (!h) {
      console.error('用法: tasklog blob <hash>');
      process.exit(2);
    }
    const c = readBlob(dbPath, h);
    console.log(c ?? '(未找到)');
    break;
  }

  default:
    console.log(`tasklog —— 按任务分段的事件日志，coding agent 的记忆层

用法:
  tasklog health                     索引健康度与遥测
  tasklog sync [--repo DIR] [--gap M] 同步 git 并重建任务划分
  tasklog reindex                    重抽符号（改了正则后用）
  tasklog ingest <events.json>       批量写入事件

查询（五个接口）:
  tasklog tasks [--status S] [--q T] [--touching SYM] [--all]
  tasklog search <query> [-k N] [--sym S] [--task N] [--all]
  tasklog sym <symbol> [--kind K] [--all]
  tasklog resume <taskId> [--tail N]
  tasklog read --task N [--from S] [--to E]

辅助:
  tasklog blob <hash>                取回落盘原文

全局: --db PATH  --repo DIR  --json
`);
}

db.close();

Open
used
Bash
2.1s

划分全对，被 revert 的任务自动标 SUPERSEDED 并默认隐藏。现在测关键场景 —— 讨论里那个端口的例子。

used
Bash
2.1s

正是讨论里那个场景：默认只返回回滚后的 8080，9090 被 supersedes 边自动排除。现在测状态重建。

used
Bash
1.6s

三处要修：unresolved_error 漏检（npm test 失败后 npm build 成功被误判为已解决）、grep 骨架行取错参数、大结果骨架行太长。

Edit
tasklog/src/query/index.ts
×2
index.ts
JS
used
Bash
1.4s

三处全修好。现在写 MCP server —— 先确认 SDK 的 API 形态。

Ran commands
2

API 清楚了。现在写 MCP server —— 工具描述要写好，那是 agent 决策时唯一能看到的东西。

Write
tasklog/src/mcp/server.ts
269 lines
open
server.ts
JS
#!/usr/bin/env -S npx tsx
/**
 * tasklog MCP server —— 把按任务分段的事件日志开放为查询入口。
 *
 * 设计要点（design/agent-memory-design.md 第 5 节）：
 *  - 五个工具语义边界互不重叠，不给一个万能 search。
 *  - 每个返回都带定位符，agent 可二次深入读，不必整段灌。
 *  - resume_task 不是 search 的一种用法：状态重建要完整性，不是相关性。
 *  - 被 supersedes 取代的任务默认不返回（可用 include_superseded 调出）。
 *
 * 注意：stdio 传输下 stdout 属于协议，日志一律走 stderr。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, join } from 'node:path';
import { openDb } from '../db/open.ts';
import { readBlob } from '../ingest/events.ts';
import {
  listTasks,
  searchHistory,
  symbolHistory,
  resumeTask,
  readEvents,
  health,
} from '../query/index.ts';
import type { SymbolKind, TaskStatus } from '../types.ts';

const repoRoot = resolve(process.env.TASKLOG_REPO ?? process.cwd());
const dbPath = resolve(process.env.TASKLOG_DB ?? join(repoRoot, '.tasklog', 'log.db'));
const db = openDb({ path: dbPath });

const server = new McpServer(
  { name: 'tasklog', version: '0.1.0' },
  {
    instructions: `tasklog 是本项目的历史日志，按任务分段存放原始事件（含工具调用与结果），不做摘要。

什么时候查它：
  - 「为什么当初这样决策」「上次为什么没选那个方案」 -> search_history
  - 「继续做上次那个任务」「上次做到哪了」          -> resume_task
  - 「这个文件/函数以前出过什么事」                  -> symbol_history
  - 不知道从哪下手                                    -> list_tasks 先看目录

什么时候不要查它：
  - 「现在用的是什么」这类当前状态问题，直接读代码和 git —— 它们才是权威。
    日志回答的是「为什么是现在这样」和「试过什么没成功」。
  - 失败的尝试、被否决的方案、某个坑的成因，世界上不留痕迹，只有这里有。

用法约定：
  - 每个返回都带 locator（task_id / session_id / seq / event_id）。
    想看更多就用 read_events 按 seq 区间翻页，不要指望一次拿全。
  - 默认不返回已被 revert / 取代的任务。要看历史演变过程才加 include_superseded。`,
  },
);

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }],
});

// ============================================================
// 1. list_tasks
// ============================================================
server.registerTool(
  'list_tasks',
  {
    title: '列出任务',
    description:
      '按任务列出项目历史的目录。不知道该查什么时先用它。' +
      '每条给出标题（优先取 commit message）、状态、时间、关联 commit、事件数、错误数、' +
      '最常触碰的文件。默认不含已被取代的任务。',
    inputSchema: {
      status: z
        .enum(['open', 'done', 'abandoned', 'any'])
        .optional()
        .describe('open=进行中；abandoned=无 commit 产出（失败路径，往往信息量最大）'),
      q: z.string().optional().describe('标题/commit 的模糊匹配'),
      touching: z
        .string()
        .optional()
        .describe('只要触碰过该文件路径或符号的任务，例如 src/auth/middleware.ts'),
      include_superseded: z.boolean().optional().describe('含已被 revert / 取代的任务'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(
      listTasks(db, {
        status: (a.status as TaskStatus | 'any') ?? 'any',
        q: a.q,
        touching: a.touching,
        includeSuperseded: a.include_superseded ?? false,
        limit: a.limit ?? 30,
      }),
    ),
);

// ============================================================
// 2. search_history
// ============================================================
server.registerTool(
  'search_history',
  {
    title: '点查历史',
    description:
      '在历史事件里点查，回答「为什么当初这样做」这类问题。' +
      '命中是事件级的（精确、小粒度），但每条都会带出它所属的任务 —— ' +
      '想看该任务的其余部分，用返回里的 task_id 和 seq 区间调 read_events 补全。' +
      '主路是符号倒排（文件路径、函数名、错误码都走这条），全文检索只作兜底。',
    inputSchema: {
      query: z.string().optional().describe('自然语言或关键词；其中像符号的 token 会自动走倒排'),
      symbols: z
        .array(z.string())
        .optional()
        .describe('精确符号，如 ["src/auth/middleware.ts","verifyToken"]'),
      task_id: z.number().int().optional().describe('限定在某个任务内查'),
      kinds: z
        .array(z.enum(['path', 'ident', 'errcode', 'sha', 'test']))
        .optional()
        .describe('限定符号类型'),
      k: z.number().int().min(1).max(50).optional(),
      include_superseded: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(
      searchHistory(db, {
        query: a.query,
        symbols: a.symbols,
        taskId: a.task_id,
        kinds: a.kinds as SymbolKind[] | undefined,
        k: a.k ?? 8,
        includeSuperseded: a.include_superseded ?? false,
      }),
    ),
);

// ============================================================
// 3. symbol_history
// ============================================================
server.registerTool(
  'symbol_history',
  {
    title: '符号的全部历史',
    description:
      '某个文件、函数、错误码、测试名在历史上的全部出现，按时间排序。' +
      '改动某处代码之前用它看看这里以前出过什么事。' +
      '这是精确匹配：get_user_id 和 get_user_ids 是两个不同的 key，不会混。',
    inputSchema: {
      symbol: z.string().describe('文件路径、标识符、错误码、commit sha 或测试名'),
      kind: z.enum(['path', 'ident', 'errcode', 'sha', 'test']).optional(),
      limit: z.number().int().min(1).max(300).optional(),
      include_superseded: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) =>
    ok(
      symbolHistory(db, a.symbol, {
        kind: a.kind as SymbolKind | undefined,
        limit: a.limit ?? 40,
        includeSuperseded: a.include_superseded ?? false,
      }),
    ),
);

// ============================================================
// 4. resume_task
// ============================================================
server.registerTool(
  'resume_task',
  {
    title: '恢复任务状态',
    description:
      '接着做某个任务之前用它。它不是检索 —— 它给的是完整性而不是相关性：' +
      '整条时间线的骨架（每个事件一行）、尾部若干步的原文、以及显式的未闭合项' +
      '（报错后没重做成功的、悬挂的工具调用、TODO）。' +
      '不要用 search_history 代替它来恢复状态，那样会漏掉未闭合项，而你不会察觉。' +
      '如果该任务已被取代，返回里会标出取代它的任务。',
    inputSchema: {
      task_id: z.number().int(),
      tail: z.number().int().min(1).max(60).optional().describe('尾部给多少条原文，默认 12'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => ok(resumeTask(db, a.task_id, { tail: a.tail ?? 12 })),
);

// ============================================================
// 5. read_events
// ============================================================
server.registerTool(
  'read_events',
  {
    title: '分页读原文',
    description:
      '按 seq 区间读某个任务或会话的原始事件。配合 search_history / resume_task 返回的定位符使用。' +
      '一次只取一段 —— 把整个任务灌进上下文会让长上下文衰减开始吃你。' +
      '返回里的 next_seq 是下一页的起点。',
    inputSchema: {
      task_id: z.number().int().optional(),
      session_id: z.string().optional(),
      seq_from: z.number().int().optional(),
      seq_to: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => {
    const r = readEvents(db, {
      taskId: a.task_id,
      sessionId: a.session_id,
      seqFrom: a.seq_from,
      seqTo: a.seq_to,
      limit: a.limit ?? 40,
    });
    return ok({ events: r.events, next_seq: r.nextSeq, total: r.total });
  },
);

// ============================================================
// 辅助：取回落盘原文 / 健康度
// ============================================================
server.registerTool(
  'read_blob',
  {
    title: '取回被截断的原文',
    description:
      '事件里标了 [blob xxxx] 的，说明原始输出过大、只在日志里留了摘要行。' +
      '用这个句柄把完整原文取回来。原件从未被删除，这是本系统与摘要式记忆的根本差别。',
    inputSchema: {
      blob: z.string().describe('事件返回里的 blob 句柄'),
      max_bytes: z.number().int().min(256).max(200_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => {
    const c = readBlob(dbPath, a.blob);
    if (c === null) return ok({ error: 'blob 未找到', blob: a.blob });
    const cap = a.max_bytes ?? 40_000;
    return ok({
      blob: a.blob,
      bytes: Buffer.byteLength(c, 'utf8'),
      truncated: Buffer.byteLength(c, 'utf8') > cap,
      content: c.slice(0, cap),
    });
  },
);

server.registerTool(
  'index_health',
  {
    title: '索引健康度',
    description:
      '事件/任务/符号规模与遥测。unindexed_rate 是抽不出任何符号的非文本事件占比 —— ' +
      '它偏高说明正则漏抽，那些事件在主索引里等于不存在。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => ok({ db: dbPath, repo: repoRoot, ...health(db) }),
);

// ============================================================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[tasklog] MCP server ready  db=${dbPath}`);

Open

MCP server 写好了。现在写测试，用真实 MCP client 连进去验证。

Write
tasklog/test/run.ts
215 lines
open
run.ts
JS
/**
 * 测试：符号抽取单测 + 经真实 MCP client 的端到端验证。
 * 运行前需要 demo 数据：npm run demo
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { extractSymbols } from '../src/ingest/symbols.ts';
import { openDb } from '../src/db/open.ts';
import { searchHistory, resumeTask, listTasks, health } from '../src/query/index.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const REPO = resolve(process.argv[2] ?? join(process.cwd(), 'demo-repo'));
const DB = join(REPO, '.tasklog', 'log.db');

if (!existsSync(DB)) {
  console.error(`缺少 demo 数据：先跑 npm run demo`);
  process.exit(2);
}

// ============================================================
console.log('\n[1] 符号抽取');
// ============================================================
{
  const s = extractSymbols({
    text: 'jwt.verify 在 src/auth/middleware.ts:8 抛 TypeError，跑 npm test -- auth 复现，commit 32e32b7644',
    argsJson: JSON.stringify({ path: 'config/server.yaml' }),
    toolName: 'read_file',
  });
  const has = (sym: string, kind?: string) =>
    s.some((x) => x.sym.toLowerCase() === sym.toLowerCase() && (!kind || x.kind === kind));

  check('抽出带目录的路径', has('src/auth/middleware.ts', 'path'));
  check('从 args 抽出路径', has('config/server.yaml', 'path'));
  check('抽出异常类名', has('TypeError', 'errcode'));
  check('抽出 commit sha', has('32e32b7644', 'sha'));
  check('抽出工具名', has('read_file', 'ident'));
  check('抽出点号表达式', s.some((x) => x.sym.includes('jwt.verify')));

  const noise = extractSymbols({ text: '这是一段普通的中文说明，没有任何代码符号在里面。' });
  check('纯自然语言不产生噪音符号', noise.length === 0, `得到 ${noise.length} 个`);

  const stop = extractSymbols({ text: 'if the value is true then return null for this object' });
  check('关键字与常见词被过滤', stop.length === 0, JSON.stringify(stop.map((x) => x.sym)));

  const casing = extractSymbols({ text: 'getUserId 与 get_user_ids 是两个不同的函数' });
  check(
    '形近标识符不合并',
    casing.some((x) => x.sym === 'getUserId') && casing.some((x) => x.sym === 'get_user_ids'),
  );
}

// ============================================================
console.log('\n[2] 查询层（直连 DB）');
// ============================================================
{
  const db = openDb({ path: DB, readonly: true });
  const h = health(db);
  check('事件已入库', h.events > 30, `events=${h.events}`);
  check('无孤儿事件（全部归属到任务）', h.orphanEvents === 0, `orphan=${h.orphanEvents}`);
  check('非文本事件全部有符号索引', h.unindexedRate === 0, `rate=${h.unindexedRate}`);
  check('检出被取代的任务', h.supersededTasks === 1, `n=${h.supersededTasks}`);

  // --- 核心场景：端口被 revert 之后，默认不应再端出 9090 ---
  const hits = searchHistory(db, { query: 'config/server.yaml', k: 10 });
  const texts = hits.map((x) => x.brief.line).join(' | ');
  check('默认检索不返回被取代任务的事件', !hits.some((x) => x.task.superseded), texts.slice(0, 120));
  check('默认检索不出现已作废的 9090', !/9090/.test(texts) || /恢复为 8080/.test(texts), texts.slice(0, 160));

  const all = searchHistory(db, { query: 'config/server.yaml', k: 10, includeSuperseded: true });
  check('include_superseded 能调出历史演变', all.some((x) => x.task.superseded));
  check('被取代的事件带 superseded 标记', all.filter((x) => x.task.superseded).length >= 1);

  // --- 任务划分 ---
  const tasks = listTasks(db, { status: 'any', includeSuperseded: true, limit: 50 });
  check('任务数正确', tasks.length === 5, `n=${tasks.length}`);
  check('revert 的任务来自 git 边界', tasks.some((t) => t.boundarySrc === 'git' && t.commit));
  check('无 commit 产出的段标为 abandoned', tasks.some((t) => t.status === 'abandoned'));
  check('最后一段为 open', tasks.some((t) => t.status === 'open'));

  // --- 状态重建 ---
  const open = tasks.find((t) => t.status === 'open')!;
  const r = resumeTask(db, open.taskId, { tail: 4 });
  const kinds = r.openItems.map((o) => o.kind);
  check('resume 检出未解决的错误', kinds.includes('unresolved_error'), JSON.stringify(kinds));
  check('resume 检出悬挂的工具调用', kinds.includes('dangling_call'), JSON.stringify(kinds));
  check('resume 给出完整骨架', r.skeleton.length === open.events, `${r.skeleton.length}/${open.events}`);
  check('resume 尾部不超过请求数', r.tail.length <= 4);

  const abandoned = tasks.find((t) => t.status === 'abandoned')!;
  const r2 = resumeTask(db, abandoned.taskId);
  check('abandoned 任务检出 TODO', r2.openItems.some((o) => o.kind === 'todo'));

  const sup = tasks.find((t) => t.superseded)!;
  const r3 = resumeTask(db, sup.taskId);
  check('被取代的任务会告知取代者', r3.related.supersededBy.length === 1);

  // --- 签名严格性：npm test 失败后 npm build 成功不算解决 ---
  const errItem = r.openItems.find((o) => o.kind === 'unresolved_error');
  check(
    '未闭合判定用调用签名而非只看工具名',
    !!errItem && /npm test/.test(errItem.detail),
    errItem?.detail.slice(0, 80) ?? '(无)',
  );

  db.close();
}

// ============================================================
console.log('\n[3] MCP 端到端');
// ============================================================
{
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', resolve('src/mcp/server.ts')],
    env: { ...process.env, TASKLOG_DB: DB, TASKLOG_REPO: REPO } as Record<string, string>,
  });
  const client = new Client({ name: 'tasklog-test', version: '0.1.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    '五个查询接口 + 两个辅助全部注册',
    ['index_health', 'list_tasks', 'read_blob', 'read_events', 'resume_task', 'search_history', 'symbol_history']
      .every((n) => names.includes(n)),
    names.join(','),
  );
  check(
    '每个工具都有非空描述',
    tools.tools.every((t) => (t.description ?? '').length > 40),
  );
  check(
    '全部标记为只读',
    tools.tools.every((t) => t.annotations?.readOnlyHint === true),
  );

  const callJson = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const t = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    return JSON.parse(t);
  };

  const lt = await callJson('list_tasks', {});
  check('list_tasks 默认隐藏被取代任务', Array.isArray(lt) && lt.every((t: any) => !t.superseded));
  check('list_tasks 带 topPaths 供下一步定位', lt.some((t: any) => t.topPaths?.length > 0));

  const sh = await callJson('search_history', { query: 'verifyToken', k: 5 });
  check('search_history 有命中', sh.length > 0, `n=${sh.length}`);
  check(
    'search_history 每条都带定位符',
    sh.every((h: any) => h.locator?.eventId && typeof h.locator.seq === 'number'),
  );
  check(
    'search_history 每条都带所属任务与可展开范围',
    sh.every((h: any) => h.task && (h.task.seqRange === null || h.task.seqRange.length === 2)),
  );

  const symh = await callJson('symbol_history', { symbol: 'src/auth/middleware.ts' });
  check('symbol_history 跨任务串起时间线', symh.timeline.length >= 4, `n=${symh.timeline.length}`);
  check(
    'symbol_history 时间有序',
    symh.timeline.every((e: any, i: number) => i === 0 || e.ts >= symh.timeline[i - 1].ts),
  );

  const openTask = lt.find((t: any) => t.status === 'open');
  const rt = await callJson('resume_task', { task_id: openTask.taskId, tail: 3 });
  check('resume_task 返回骨架/尾部/未闭合三段', !!rt.skeleton && !!rt.tail && !!rt.openItems);
  check('resume_task 给出行动提示', typeof rt.hint === 'string' && rt.hint.length > 0);

  const re = await callJson('read_events', { task_id: openTask.taskId, limit: 3 });
  check('read_events 分页并给出 next_seq', re.events.length === 3 && re.next_seq !== null);

  // blob 回取：原件从未被删除
  const big = re.events.find((e: any) => e.blob) ??
    (await callJson('read_events', { task_id: openTask.taskId, limit: 50 })).events.find((e: any) => e.blob);
  check('大结果落盘并留下 blob 句柄', !!big, '未找到 blob 事件');
  if (big) {
    const blob = await callJson('read_blob', { blob: big.blob });
    check('read_blob 能取回完整原文', blob.bytes > 4096, `bytes=${blob.bytes}`);
    check('取回的原文含被截断的尾部内容', /module_399/.test(blob.content));
  }

  const hh = await callJson('index_health', {});
  check('index_health 暴露 unindexed_rate', typeof hh.unindexedRate === 'number');

  await client.close();
}

// ============================================================
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}

Open
used
Bash
2.0s

45 项全过，含真实 MCP client 端到端。跑个类型检查。

used
Bash
889ms
Edited files
2
工作区索引
MD
工作区索引
tasklog/ — 当前项目（可运行）

按任务分段的事件日志，coding agent 的记忆层。写入侧零 LLM。TypeScript + SQLite/FTS5 + MCP。

README.md — 项目说明、快速开始、五个工具、MCP 接入配置
src/db/ — schema 与连接（events / tasks / task_edges / symbols / commits / FTS）
src/ingest/ — 事件写入、符号抽取（纯正则，零 LLM）、大结果落盘
src/tasks/ — git 扫描、任务划分、supersedes 边
src/query/ — 五个查询接口 + 遥测
src/mcp/server.ts — MCP 工具面
src/cli.ts — 本地验证与运维
scripts/make-demo.ts — 造真实 git 仓库（含一次 revert）+ 事件日志
test/run.ts — 45 项检查，含真实 MCP client 端到端

状态：全部测试通过，tsc --noEmit 零错误。node_modules 不入快照，换机器先 npm install。

design/ — 设计文档
agent-memory-design.md — 完整设计：核心主张、数据模型、五个接口、裁剪规则、
验证门、与 Dynamics-memory 的对照改动点、AMA-Bench 评估计划、已知风险
research/ — 研究输入（事实来源）
dm-code-read.md — Dynamics-memory 源码通读笔记。hybrid_memory/ 全部 67 个 py、
.opencode/ 插件与三个 agent、README、eval 报告。三档标注 [代码]/[文档]/[目标]。
uploads/ — 用户上传（勿修改）
notes-agent-memory-efficacy.md（81 篇五轮主题笔记）、deep-read-cards.md（11 篇深读卡）
literature-report.html、review-mechanism-report.html、README.md
archive/ — 前序任务成果
literature/ — lit-report.html、lit-deck.html，生成器在 build/（改内容改生成器再跑）
pr1538/ — pr1538-report.html、pr1538-deck.html
Open
tasklog
MD
tasklog

按任务分段的事件日志，作为 coding agent 的记忆层。写入侧零 LLM 调用。

不存摘要、不存提炼出来的"记忆条目"。存的是 agent 实际做过的事：
每一次工具调用、每一个返回、每一条报错，按任务切分，用符号倒排建索引，
通过五个 MCP 工具开放给 agent 按需查询。

设计文档：../design/agent-memory-design.md

为什么不压缩

显著性是查询条件化的。 写入时的模型无法预知未来会被问什么，只能按通用显著性压缩；
而实际查询往往要的正是当时看起来不重要的细节。这是结构性的，换更强的模型解决不了。

压缩的罪不在压缩，在压缩后删原件。 判据只有一条：这个加工件错了，原始信息还找得回来吗。
所以摘要只允许做导航（决定读不读），不允许做替代。本项目里超过 4KB 的工具输出会落盘，
事件里只留机械截断的摘要行加一个 blob 句柄 —— 原件一个字节都没少。

"现在是什么"问世界，"为什么是这样"问日志。 代码和 git 才是现势的权威来源。
用日志推演当前状态，是用不权威的副本对抗权威的原件，而时间戳会让这种错误显得更自信。
日志不可替代的是另一半：失败的尝试、被否决的方案、某个坑的成因 —— 这些世界上不留痕迹。

快速开始
Bash
npm install          # node_modules 不入工作区快照，换机器要重装
npm run demo         # 造一个真实 git 仓库（含一次 revert）+ 对应事件日志
npm test             # 45 项检查，含真实 MCP client 端到端

然后查：

Bash
export TASKLOG_DB=$PWD/demo-repo/.tasklog/log.db

npx tsx src/cli.ts tasks                              # 目录
npx tsx src/cli.ts search "config/server.yaml"        # 点查
npx tsx src/cli.ts sym src/auth/middleware.ts         # 符号历史
npx tsx src/cli.ts resume 5                           # 状态重建
npx tsx src/cli.ts read --task 5 --from 25 --to 30    # 分页读原文
npx tsx src/cli.ts health                             # 遥测
demo 里那个关键场景

端口 8080 → 9090 → revert 回 8080。revert commit 被解析成一条 supersedes 边，
于是默认检索自动排除已作废的那一段：

text
$ npx tsx src/cli.ts search "server.yaml 端口"
[3.0] symbol  task#4 seq=24   assistant: 已回滚，config/server.yaml 的 port 恢复为 8080。

$ npx tsx src/cli.ts search "server.yaml 端口" --all
[3.0] symbol  task#3 seq=20 [SUPERSEDED]  assistant: 已改 config/server.yaml，端口现在是 9090。
[3.0] symbol  task#4 seq=24                assistant: 已回滚，…… 恢复为 8080。

要看演变过程才加 --all。这是"旧值与新候选并排端出、已作废值继续服务"的解法，
而且它发生在索引层，不需要任何模型参与裁决。

五个工具
工具	回答什么	关键性质
list_tasks	不知道从哪下手	目录。没有它 agent 第一次查询只能瞎猜关键词
search_history	「为什么当初这样决策」	事件级精确命中 + 带出所属任务，其余由 agent 按需补全
symbol_history	「这个文件/函数以前出过什么事」	纯倒排。get_user_id 与 get_user_ids 是两个 key，不会混
resume_task	「继续做上次那个任务」	给完整性而非相关性：骨架 + 尾部原文 + 未闭合项
read_events	展开某一段	分页。一次只取一段，不把整个任务灌进上下文

辅助：read_blob（取回被截断的原文）、index_health（遥测）。

resume_task 刻意不做成 search 的一种用法：状态重建要的是完整性，
用 top-k 去恢复状态会恢复出一个有洞的心智模型，而 agent 不会察觉有洞。
它检出三类未闭合项：报错后没有"同一件事"成功重做的、悬挂的工具调用、TODO。

"同一件事"用调用签名判定而不是只看工具名 ——
npm test 失败之后 npm run build 成功，不代表测试的问题解决了。

接入 MCP 客户端
JSON
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

server 的 instructions 里写明了什么时候该查日志、什么时候该直接读代码 ——
工具描述是 agent 决策时唯一能看到的东西，所以它承担了路由职责。

数据模型
text
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

写入路径全程无模型调用： insert → 正则抽符号 → FTS 触发器 → 大结果落盘。
任务划分是异步批处理：扫 git log，按 commit 时间切段，revert 建 supersedes 边。

边界来源记在 tasks.boundary_src（git / heuristic / user）。
保留它是因为边界允许事后修订 —— 原文是事实，边界只是索引，索引错了可以重建。
这是本方案相对压缩方案的核心退路：压缩件错了没有退路。

现状

45 项测试通过（符号抽取 9 / 查询层 19 / MCP 端到端 17），tsc --noEmit 零错误。
demo 库规模：34 事件 / 323 符号 / 5 任务 / 1 条 supersedes 边，unindexed_rate = 0。

还没做
真实 agent 接入 —— 现在只有 demo 数据。需要一个 hook 把 opencode / Claude Code
的事件流落到 events 表（对应 Dynamics-memory 的 memory-bridge.ts 那一层）。
验证门 —— 建模完成时批量证伪可被代码推翻的断言（设计文档第 9 节）。
需要接文件系统做 grep，是"读世界"那一侧的职责。
新鲜度检查 —— 比对文件 mtime 与日志里最后一次改动，提示日志可能已过期。
向量兜底 —— 目前只有倒排 + trigram FTS。向量是接"说不出关键词"的查询，
在 coding 场景属于第三优先级。
AMA-Bench 对照 —— 设计文档第 11 节的主假设，是检验这条路线是否成立的实验。
已知限制
任务边界在没有 git 的项目里只能靠时间 gap，质量会明显下降。
符号抽取是正则，漏抽等于那条事件在主索引里不存在 —— 用 index_health 的
unindexed_rate 盯着，改了正则跑 cli.ts reindex 重建。
supersedes 目前只从 revert 推断。"后续 commit 改了同一处"是更弱的信号，暂未启用。
落盘原文取回仍需一次工具调用，不是零成本 —— 原件不删解决的是不可恢复损失，
不是取回成本。
Open
used
Bash
315ms
清理

没有垃圾文件，所以是归档而不是删除：

text
archive/pr1538/      ← PR #1538 两份报告
archive/literature/  ← 文献报告 + 生成器（build/）
research/            ← dm-code-read.md（Dynamics-memory 通读笔记）
design/              ← 新增：agent-memory-design.md
uploads/             ← 原封未动

顶层 
README.md
 是索引。

然后按你选的三项干了

新建仓库、TypeScript、直接做到五个工具可用。tasklog/ 现在是能跑的：

src/db/ — events / tasks / task_edges / symbols / commits / FTS5(trigram)
src/ingest/ — 事件写入（幂等）、符号抽取（纯正则，零 LLM）、>4KB 落盘留 blob 句柄
src/tasks/ — git 扫描、按 commit 切任务、revert 自动建 supersedes 边
src/query/ — 五个接口 + 遥测
src/mcp/server.ts — MCP 工具面（5 个核心 + read_blob + index_health）
scripts/make-demo.ts — 造真 git 仓库（真的 git revert）+ 对应事件日志

45 项测试全过（符号抽取 9 / 查询层 19 / 真实 MCP client 端到端 17），tsc --noEmit 零错误。

讨论里那个端口场景，跑通了
text
$ tasklog search "server.yaml 端口"
[3.0] task#4 seq=24   assistant: 已回滚，config/server.yaml 的 port 恢复为 8080。

$ tasklog search "server.yaml 端口" --all
[3.0] task#3 seq=20 [SUPERSEDED]  assistant: 已改…端口现在是 9090。
[3.0] task#4 seq=24                assistant: 已回滚…恢复为 8080。

默认不端出已作废的 9090，要看演变才加 --all。裁决发生在索引层，没有任何模型参与。

resume_task 也按设计检出了三类未闭合项。其中「同一件事有没有成功重做」用的是调用签名而不是工具名 —— npm test 失败后 npm run build 成功，不算解决，这个 bug 第一版有，已修。

还差的

最关键的是 1：现在只有 demo 数据，需要一个 hook 把真实 agent 的事件流落进 events 表。其余是验证门、新鲜度检查、向量兜底、AMA-Bench 对照 —— 都列在项目 README 末尾。

node_modules 不进工作区快照，换机器先 npm install（better-sqlite3 要 v11，v13 跟 Node 20 的 ABI 不合会段错误，package.json 已经钉死）。

14m 30s | 11 hours ago
0:42

---

## 19. USER

你做了啥

---

## 20. ASSISTANT

四件事：

1. 清理工作区 — 没有垃圾文件，所以是归档不是删除。archive/（PR 报告 + 文献报告）、research/（Dynamics-memory 通读笔记）、design/、uploads/ 原封不动，顶层加了 README 索引。

2. 把前面几轮的讨论落成设计文档 — 
agent-memory-design.md
。之前所有决策散在对话里，容易丢。

3. 问了你三个决策（代码基线 / 语言 / 里程碑），你选了新建仓库、TypeScript、直接做到五个工具可用。

4. 按这个把 tasklog/ 写出来了 —— 约 1800 行 TS，能跑。

真的部分：

SQLite schema（事件表 / 任务表 / 符号倒排 / FTS5）跑通
符号抽取是纯正则，零 LLM，demo 库上 unindexed_rate = 0
git 扫描 → 按 commit 切任务 → revert 自动建 supersedes 边，这条跑通了
五个查询接口 + MCP server，用真实 MCP client 连进去测过
45 项测试通过，tsc --noEmit 零错误

假的部分（要说清楚）：

demo 数据是我编的，不是真实 agent 轨迹。那个 git 仓库是真的（真的跑了 git revert），但 34 条事件日志是我手写的剧本。
所以「这套路线有没有收益」这个问题，现在一点证据都没有。跑通 ≠ 有用。

没做的：

真实 agent 接入（最关键，没有它就只是个空壳）
验证门、新鲜度检查、向量兜底
AMA-Bench 对照 —— 这才是能回答「有没有收益」的那一步

要我接着往哪走，你说。

20s | 11 hours ago
0:45
