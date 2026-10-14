# reference/ 索引

论文按**主要贡献**归入一个目录（不复制、不做软链）；跨主题的联系写在
`notes-agent-memory-efficacy.md`，不靠目录表达。文件名 = `arXivID-短名.pdf`，
笔记里只引 arXiv ID。11 篇深读文献的逐篇卡片在 `deep-read-cards.md`；
`literature-report.html` 为可视化汇总（离线单文件）。

| 目录 | 收什么 |
|---|---|
| 01-stale-memory-pollution | 问题层：旧值/过期记忆为何让"有记忆"比"无记忆"更差，含读者侧机制（stale binding、前摄干扰、实体追踪） |
| 02-write-consolidation | 写入/固化层：压缩、重写、递归更新本身的有损性与修法 |
| 03-benchmarks | 基准与评测数据生成（含状态演化语料合成） |
| 04-eval-methodology | 评测方法学：混淆变量、规模条件、饱和、复现性、反方对照 |
| 05-security-governance | 投毒、偏差经记忆传播、治理框架 |
| 06-systems | 生产/经典记忆系统基线 |
| 07-learned-memory-policies | RL 学得的记忆读写策略与奖励设计 |
| 08-context-memory | context 工程 × memory 工程界面：窗口层级、驻留/驱逐契约、写回校验、admissibility |

归类争议的处理：Memory Contagion 讲的是非对抗性污染传播，归 05 而非 01；
Supersede 既是诊断也是训练环境，按其核心命题（更新鸿沟）归 01；
STALE 同时是基准与原型，按核心命题归 01；
MemGPT/MemOS 是系统但按其对"窗口-记忆层级"的贡献归 08 而非 06；
retrieval-admissibility 按"相关性 vs 可用性"界面命题归 08 而非 01。
