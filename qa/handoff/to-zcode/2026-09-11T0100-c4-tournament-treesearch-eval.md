# C4 评估：假设锦标赛 + 搜索树双策略的 SD 承载机制（附 C2 finish-gate 结论）

日期：2026-09-11 · 作者：Claude（K3）· 状态：待用户裁决 → 裁决后进入实施
方法：DA 侧机制级勘察（hypothesis-engine 四技能 / workflow-engine 2614L / debate-ranking 127L / research-state 499L / orchestrator+team-manager / checkpoints+pre-finish-gate）× SD 侧承载候选勘察（evolve 全栈 / subagents / run 循环 / 持久化原语 / skills 系统）× 业界对照（Co-Scientist / AI-Scientist-v2 BFTS / OpenDDE / RD-Agent）

---

## 1. 要承载的两个策略（机制拆解）

### 1.1 Elo 假设锦标赛（DA hypothesis-tournament 技能实测设计）

七阶段：问题界定（research_state 钉目标）→ **多视角生成**（强制 council 派 3-5 异质视角子 agent；"禁止主上下文自扮多视角——单上下文同源，Elo 失去独立性"是 DA 实测踩坑后的硬纪律）→ 批评者四维评审（正确性/证据强度/新颖性/可行性）→ 两两辩论判定喂 tournament_rank（**Elo 数学由工具算，不许手算**）→ 进化改写（前 2-3 名吸收批评出 v2）→ 输出 → meta-review。
机制需求清单：①多视角并行生成（上下文隔离）②pairwise 判定收集 ③Elo 算术+divergence 趋同度 ④状态承载（候选/证据/排除）⑤完成审计（防"嘴上说跑了实际没跑"）。
业界对照：Co-Scientist 同构（Generation/Reflection/Ranking-Elo/Evolution/Proximity/Meta-review 六角色）。

### 1.2 假设树搜索（DA tree-search 技能 + AI-Scientist-v2 BFTS）

树编码在 research_state（plan 项 = 节点，`[TREE N07 parent=N03 op=improve depth=2 score=7.5]` 前缀约定），工件落盘，greedy best-first 主循环 select→expand→evaluate→prune，预算表钉死（≤12 节点/深度≤4/宽度 3-4/分支因子 1-2/debug 链≤2/墙钟 60min 软约束），**算子 improve/debug/crossover/replicate 显式**，消融复现（replicate 换种子聚合均值±方差），**终局排名只用留出信号**（防阶段内评分自膨胀——AIRA 教训），软评分分支自动收缩（防 reward hacking）。
业界对照：AI-Scientist-v2 BFTS（实验树 manager agent）、OpenDDE（确定性循环编排器：LLM 只做有界决策，预算/门控/多样性约束全代码强制）、RD-Agent（R-D 双环+假设知识库沉淀）。

### 1.3 一个关键的架构分歧（必须先想清）

| | DA 路线（技能层承载） | OpenDDE 路线（引擎层承载） |
|---|---|---|
| 循环控制 | prompt 纪律 + pre-finish 审计兜底 | Python 确定性编排器，LLM 不碰循环状态 |
| 预算强制 | 技能文本约定 + 审计抽查 | 代码硬闸（超预算拒绝执行） |
| 树完整性 | 约定编码 + 审计双向比对（幽灵节点/工件=critical） | 结构即数据，不存在"声称有树而没建" |
| 成本 | 零新引擎，全靠已有机制 | 引擎开发量大，但不变量不可绕过 |

DA 的 audit 技能锚点设计（双锚点核查 workflow_run 真实执行、Elo 核查"有分无调用=critical"、节点-工件双向比对）说明：**纯技能层路线的不变量保证全部来自事后审计**，审计本身又是 LLM（fail-open）。业界实证（ResearchGym：GPT-5 agent 子任务完成率 26.5%）支持下沉关键不变量。

## 2. SD 承载候选三方对照

### 候选 A：技能 + task 子代理编排（轻量路线，零新引擎）

- 多视角生成：`task` 工具 ×N（并发≤10、累计≤50/run、上下文强制隔离 historyPolicy:isolated、`specialistId` 角色化通道现成、`outputJsonSchema` 结构化回收现成）
- 状态：research_state（C1 已交付纯模块）+ 工作区文件工件
- Elo：tournament_rank 纯算法工具（DA 127L 直搬）
- 审计：SD 已有 review_checkpoint + reviewer_correction 循环（一审多轮是真机制，非 prompt 摆设）
- **缺口**：子代理不能再派子代理（编排者必须是主 agent ✔ 符合锦标赛拓扑）；子代理间不能直接对话（辩论靠编排者多轮中继 ✔ DA 也是这样）；无 skill frontmatter 强制（SD `allowed-tools` 明确"not enforced"）
- **适配度：锦标赛八成现成，树搜索七成现成（树编码约定+预算纪律全靠 prompt+审计）**

### 候选 B：扩展 evolve sidecar（重路线）

- 现成：flat-PUCT best-first 选择、树数据模型、五维预算钉扎（硬闸！）、事件溯源+断点续跑、沙箱、判别性探针、文本候选一等公民、judge 通道（盲评/多次采样中位数/方差闸）、UI 事件流卡片
- 缺口：算子只有 mutation+repair（improve/debug/crossover/replicate 需显式化）；judge 全是标量打分无 pairwise；无 Elo 域；**run 内无 paused 状态**（HITL 需新增）；树本体靠事件重放无直接序列化
- **适配度：树搜索的"确定性引擎"终态形态（七成就绪），锦标赛需新写 TournamentEngine（Engine Protocol 接缝就是为此设计）**

### 候选 C：新裁剪 workflow runner（中路线，DA workflow-engine 的 council+pipeline 两模式直搬）

- DA workflow-engine 的 council（上下文隔离+crossReview 轮+brief 指针回填+综合审计）是久经实测的实现，2614L 整搬其中两模式约 1200L
- 但 SD 的 task 子代理基建（隔离/handoff/结构化回收/SSE 观测）已覆盖 council 的 80% 价值，**重复建设面大**

## 3. 决策建议（交用户裁决）

**推荐：A 先行（本阶段），B 后置为"确定性引擎化"演进（阶段 V），C 不做。**

1. **锦标赛 MVP（候选 A）**：tournament_rank 工具（本次已写纯模块）+ hypothesis-tournament/idea-debate 技能移植 + 主 agent 编排 task 子代理。多视角独立性由"task 强制隔离 + skill 纪律 + review_checkpoint 审计"三层保证。
2. **树搜索 MVP（候选 A）**：tree-search 技能移植（树编码进 research_state，工件落盘）——DA 已证明该编码在 500 行通用状态机上跑得动。
3. **关键不变量下沉（候选 A 的补强，对齐 OpenDDE 教训）**：预算/终止条件不只写进 skill 文本——research_state 的 markTried/plan caps 已是代码闸；再加一层"预算钉住后由工具校验"（tree-search 技能 set-goal 写预算，tournament_rank/tree 工具在超限调用时返回结构化警告而非靠自觉）。**这一步是 A 路线对 B 路线核心优势的低成本收割**。
4. **B（evolve 引擎化）触发条件**：当①锦标赛/树搜索被真实使用 ②prompt 纪律失效案例出现（审计抓到幽灵树/手算 Elo）③需要无人值守长跑（>1h）时，启动 TournamentEngine/算子显式化的 sidecar 扩展。evolve 的 Engine Protocol + 预算闸 + 事件溯源使该演进不用推倒重来。
5. **HITL checkpoint**：复用 permission runtime 的 blocked/waitForDecision 模式（`packages/governance/permission-runtime.ts` + `services/api/permissions/index.ts`——等人期间暂停空闲钟、SSE 通知、超时、取消全部已解决），不新造机制。

## 4. 附：C2 finish-gate 评估结论（勘察顺带完成）

- DA 机制：skill frontmatter 声明 `preFinishVerification` → finish 被拦截 → audit 技能作为同会话子代理跑 → score≥minScore 且无 critical 才放行（fail-open：`audit_` 前缀技能禁声明防递归）。
- SD 现状：**review_checkpoint 工具 + reviewer_correction run purpose + 语义评审子代理（citation-reviewer 等）已是真机制**；但 skills 系统无任何 frontmatter 强制（`allowed-tools` 都不 enforce），无"finish 拦截"概念。
- **建议**：不重造 DA 的 frontmatter 门。SD 路线 = ①锦标赛/树搜索技能在 prompt 层声明"完成前必须 review_checkpoint"（现有工具即可）；②中期把"skill 声明的 finish 前审计"做成 native-agent 循环的一个可选钩子（TurnLifecycle 已有 beforeTurn/afterTurn 接缝，加 beforeFinish 是小改动）；③审计输入必须含**完整工具轨迹**而非截断摘要（DA 教训：轨迹截前 20 条时 tournament_rank 最易被截，审计误判）。

## 5. 本次已先行落地（不依赖裁决的纯算法部分）

- `packages/workspace/src/research-state.ts`（+test）：C1 完成，7/7 测试绿。两个 DA 缺陷修复：corrupt 判定不再吞（ENOENT 才视为新鲜状态）；ruledOut/triedActions 到顶改 LRU/FIFO 逐出+报告（DA 硬报错死路，因工具无删除动作）。
- `packages/workspace/src/tournament-rank.ts`（+test）：Elo（K=32/初始 1000/循环赛）+ divergence（token Jaccard，>8 字符 token 拆 bigram——CJK 兼容）+ 配对归一（反向配对翻转/缺配对补平局/重复后者覆盖）。工具注册待 zcode W9 提交后做（workspace.ts 共享高危文件）。
