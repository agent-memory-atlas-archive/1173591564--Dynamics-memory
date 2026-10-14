# 工作区索引

## tasklog/ — 当前项目（可运行）
按任务分段的事件日志，coding agent 的记忆层。写入侧零 LLM。TypeScript + SQLite/FTS5 + MCP。

- `README.md` — 项目说明、快速开始、五个工具、MCP 接入配置
- `src/db/` — schema 与连接（events / tasks / task_edges / symbols / commits / FTS）
- `src/ingest/` — 事件写入、符号抽取（纯正则，零 LLM）、大结果落盘
- `src/tasks/` — git 扫描、任务划分、supersedes 边
- `src/query/` — 五个查询接口 + 遥测
- `src/mcp/server.ts` — MCP 工具面
- `src/cli.ts` — 本地验证与运维
- `scripts/make-demo.ts` — 造真实 git 仓库（含一次 revert）+ 事件日志
- `src/adapters/` — OpenCode 与 Devin 原始日志导入、出处及只读源快照
- `src/eval/` — 切点快照、B 完整原文、C-model 工具循环、API/OpenCode/Devin 模型后端、独立脱敏视图与三臂执行
- `src/query/vector.ts` — embedding provider、完整原文分片、秩融合与定位符
- `scripts/pilot.ts` — `.devin/pilot.json` 干跑与实际执行入口
- `test/` — 九个套件共 322 项机制/集成检查；含 HTTP/Devin 协议→MCP→改代码→独立验收，不是有效性结论
- `scripts/audit-devin.ts` / `prepare-history.ts` / `validate-pilot.ts` — 真实源逐条校验、独立脱敏与历史修复验收核查
- `.devin/pilot-devin.json` — 已有真实历史任务子任务配置；按用户 CMD 的模型目录校验 SWE-2 Max 的 262K 声明窗口，自动烟测与进度输出

状态：全部机制测试通过，`tsc --noEmit` 零错误。已导入 Devin 的 12 个真实会话、23,424 条去重事件并核对原文。Devin ACP provider 已打通（凭据本地注入、隔离会话库、`swe-2-max` 身份逐请求核验）；**首个真实三臂已跑完：A/B′/C 均 `checks_failed`，该任务上记忆未展示收益**（n=1，见设计文档第 11 节结果表）。**`node_modules` 不入快照，换机器先 `npm install`；`.tasklog/` 含私人原始日志，不上传。**

## design/ — 设计文档
- `agent-memory-design.md` — 完整设计：核心主张、数据模型、五个接口、裁剪规则、
  验证门、与 Dynamics-memory 的对照改动点、同前沿模型三臂评估计划、已知风险

## research/ — 研究输入（事实来源）
- `dm-code-read.md` — Dynamics-memory 源码通读笔记。`hybrid_memory/` 全部 67 个 py、
  `.opencode/` 插件与三个 agent、README、eval 报告。三档标注 `[代码]`/`[文档]`/`[目标]`。

## uploads/ — 用户上传（勿修改）
- `notes-agent-memory-efficacy.md`（81 篇五轮主题笔记）、`deep-read-cards.md`（11 篇深读卡）
- `literature-report.html`、`review-mechanism-report.html`、`README.md`

## archive/ — 前序任务成果
- `literature/` — `lit-report.html`、`lit-deck.html`，生成器在 `build/`（改内容改生成器再跑）
- `pr1538/` — `pr1538-report.html`、`pr1538-deck.html`
