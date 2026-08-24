# 自演进：任务分解

本文是 [self-evolution.md](self-evolution.md)（why）、[self-evolution-implementation.md](self-evolution-implementation.md)（what）、
[self-evolution-internals.md](self-evolution-internals.md)（how）之后的**第四份**：**做什么、谁先谁后、每件事具体干什么**。

写作前核对了 [AgentDescent](https://github.com/Birfy/agentdescent) 的实际源码与 66 篇文档，
结论与前三份文档的部分假设**不一致**，第 1 节先把差异说清楚，否则会照着旧假设造一堆已经存在的轮子。

---

## 1. 核对 AgentDescent 之后的三个修正

### 修正一：OpenEvolve 不是"第二个引擎"，它已经在 AgentDescent 里

AgentDescent 移植了 **18 个已发表的自演进算法**，其中 7 个是 benchmark-faithful 端口，
**OpenEvolve 是其中之一**（`docs/algo-openevolve.md`、`examples/openevolve/openevolve_program_evolution.py`、
`bench/openevolve_agentdescent.py`、`tests/test_openevolve_example.py`）。

它在 AgentDescent 里的实现形态是**一组策略，不是一个独立后端**：

| OpenEvolve 概念 | AgentDescent 里的落点 |
|---|---|
| 程序即基因组、整体重写 | `OpenEvolveStrategy.to_diff()` |
| MAP-Elites 网格 + 岛屿 + 环形迁移 | `OpenEvolveAggregator`（共享 archive，按岛分网格） |
| 父代选择（利用/探索） | `EpsilonGreedy` 具名 `SelectionPolicy` |
| 模型变异 | 标准 `propose(rendered, task, output, reward)` |
| 候选评测 | 沙箱化 `Task` rollout + AST 门 |
| 治理层级 | `blast_radius=0.6` → L1 |

与上游 codelion/openevolve 的**有意分歧**：整文件替换而非 SEARCH/REPLACE 补丁；
固定长度分箱 + token-Jaccard 多样性；用 AgentDescent 的 worker/ledger/证据卡替换 OpenEvolve 自己的进程控制器；
入沙箱前先过 AST 门。

实测（自带的函数极小化任务，8 个评测器 6 训练 / 2 留出）：
24 rollouts、3 岛、4 worker、76,294 tokens、50.8 秒，
组合分 0.9638 → **1.4995**（上限 1.5），到最优点距离 0.5260 → **0.00057**（920×）。
获胜程序在第 15 次迭代、2 号岛出现，从 586 字符的随机搜索长成 7,848 字符的
网格搜索 + 罗盘搜索 + 单纯形精修。

**两个必须知道的坑**（文档明确点名）：
- **thinking 必须关**：开着会吃掉 96% 的 token 预算在推理上，撞 token 上限后直接搜不动。
- **`max_tokens` 不能低于 32000**：上游用 16000 是因为它发的是 SEARCH/REPLACE 补丁，
  这里是整文件重写，低于 32000 会被截断。

> **对任务分解的影响**：不需要 `pip install openevolve`、不需要写第二个 backend、
> 不需要 config.yaml 翻译层、不需要单独的 checkpoint 机制、不需要第二套事件模型。
> 需要的是：把「程序演进」作为一种**演进目标类型**接进来，和「技能演进」并列。
> 工作量从"集成一个外部框架"降到"多注册一个 target kind + 一组策略预设"。

### 修正二：前三份文档计划自研的东西，一大半 AgentDescent 已经有了

这是最要紧的一条。逐项对照：

| 能力 | AgentDescent 已提供 | ScienceAgent 还要写什么 |
|---|---|---|
| 演进主循环 | `evolve()` / `async_evolve()` | 只写 run/reward/propose 三个绑定 |
| 技能目录演进 | `evolve_skill_dir()` + `FileTree` + `LAYOUTS['claude_skill']` | 路径映射 + 写回 skill revision |
| 程序演进 | OpenEvolve 端口（见修正一） | 目标物定义 + 评测接缝 |
| 三层评分 | `ThreeLayerVerifier`：`cheap_eval` / `rule_eval` / `learned_eval` / `oracle_eval` + `VerifierBudget(oracle_budget=200)` | 三层各自的 ScienceAgent 实现 |
| 接受门 | `DefaultAcceptance`（Beta 后验 + 全留出集回归护栏）、`AdvantageAcceptance`、`StableDistanceAcceptance`、`StrictImprovement` | 选策略、定参数 |
| 信任域 | `TrustRegion` / `AdaptiveTrustRegion`（在接受门上游卡 diff 体积） | 选参数 |
| 双分支与晋升 | `Ledger`（git-backed、CAS 提交、dev/stable 双分支）+ promotion policies | 映射到 skill revision |
| 治理 L0/L1/L2 | `Layer` 枚举、`blast_radius<=0.30→L2`、`FROZEN_IDS`、`frozen=` 路径级 L0（提案过滤 + 物化后原样覆盖，双重强制） | ScienceAgent 的 frozen 清单 + L1 oracle 接人工审批 |
| 数据集导入 | `dataloader`：HF datasets-server `/rows`(带分页缓存)、`fetch_text`、gated HF(`HF_TOKEN`)、原生 split | 四种形态解析 + 列映射 UI + 试评预览 |
| train/holdout | `split_dataset(ratios, seed, stratify_key)`、`Dataset`、`held_out_frac=0.4` | 只需"锁定某些题永远在 holdout" |
| 现成打分器 | `rewards.contains/exact_match/last_number/numeric_close` | pairwise judge（这个要自己写） |
| 成本记账 | `Usage.estimated_cost()`、`result.cost_summary()`、`metered()` 包装器 | 与 model-usage 打通 + 预算闸 |
| 沙箱 | `SandboxPool`（租约制）、`LocalWorkspaceSandbox`、`ContainerProvider`（docker/podman、默认无网、内存/CPU 限制、非 root）、`SharedSandboxPool`、bwrap/seatbelt | 决定用谁的（见 §2 决策 B） |
| 统计有效性 | `Comparison.spread()/separates()/underpowered()`、`merge_of_n()/best_of_n_fork()/serial()` 三条基线 | 健康度面板的呈现 |
| 并行策略 | `DataParallel` / `TensorParallel` / `PipelineParallel` / `ClusterParallel` | 选型 |
| 选择策略 | `SingleHead` / `Beam(k)` / `MCTS` / `ParetoFrontier` / `Archive` / `EpsilonGreedy` | 选型 |
| 断点与结果 | `EvolutionResult.save()/load()`、`outcomes()`、`fusion_stats()`、`RoundInfo` | 与 run 存储对齐 |
| 调度 | `DurationEstimator`（在线校准 rollout 耗时）、`AuditScheduler`（按估计价值分配 oracle 预算）、`TaskScheduler`(UCB) | 空闲时调度的接线 |
| 写回安全 | `result.write_to()`：自动 `.bak-N` 备份、extras 只报告不删除（除非 `prune=True`）、dry-run | 接到 revision 落盘 |

**AgentDescent 明确不做、必须 ScienceAgent 全自研的**（这才是真正的工作量）：

- Episode 沉淀（会话 → 可重放环境）
- 轨迹蒸馏（全量轨迹 → 反思器能吃的结构化摘要）
- 失败模式打标与题族聚类
- 便签与 T0 检索注入
- 真实执行接缝（rollout 走 ScienceAgent 的权限/溯源/CAS）
- 全部 UI
- 把 ScienceAgent 的治理语义映射成 `Policies` 组件包

> **对任务分解的影响**：任务性质从「实现算法」变成「**绑定与适配**」。
> 前三份文档里的 §8 口径引擎、§13 采纳与发布、§15 预算调度，
> 大部分应改写成"配置 AgentDescent 的哪个 Policy"，而不是新写一套。

### 修正三：三个会咬人的执行约束

这三条不写进设计就会在集成时炸掉：

1. **闭包不能跨进程**。`docs/execution.md` 明确：`evolve()` 无法把你传的 `run=` 闭包变成 `Ref`
   —— 它构造的 spec 携带一个解析时会抛异常的引用，因为闭包没有名字。
   跨进程要用具名引用（`"agentdescent.runners:code_runner"` 这种 `module:attr`），
   **只有 `ThreadExecutor` 接受直接传入的 callable**。`ProcessExecutor` 用 spawn 而非 fork。
   → ScienceAgent 的"回调 Node"方案必须走 `ThreadExecutor`，或在侧车里注册具名 runner。见 §2 决策 A。

2. **evalcache 把单样本当真理**。缓存认为每个 `(tree, task)` 对只评测一次。
   对随机性 agent 这是错的。官方缓解手段：`temperature=0`、多数投票 reward、
   或更大的留出集（**最少 4 题**，建议更多）。
   → ScienceAgent 的 pairwise judge 天然有噪声，必须三选一，否则演进结论是噪声。

3. **接受门只读全留出集，从不读 cheap 层**。`MergeContext` 同时携带 `base_counts` 与 `base_cheap`
   就是为了强制这件事。`oracle_shares_full_set=True` 才允许复用已算的全集结果。
   → 自定义 verifier 必须实现全部四个方法，少一个会在运行中途 `AttributeError`。

---

## 2. 开工前必须拍板的四个决策

### 决策 A：rollout 的执行接缝（阻塞 A 系列全部任务）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A1（推荐）ThreadExecutor + HTTP 回调** | 侧车用 `ThreadExecutor`，`run=` 闭包直接 HTTP 回调 Node 起 ephemeral run | 侧车线程在等 HTTP，几乎不占 CPU；与 gateway `/internal/tool-exec` 同构 |
| A2 具名 runner | 在侧车注册 `sciencediscovery_evolve.runners:node_callback_runner`，可用 ProcessExecutor | 多一层间接，收益仅在侧车 CPU 密集时才有 |

推荐 A1：真正的重活（agent 调用、沙箱、溯源）都在 Node，侧车只是调度器。

### 决策 B：沙箱归属

- **技能演进的 rollout**：必须走 ScienceAgent 的 `services/runner` —— 要权限系统、CAS 溯源、模型密钥。
  不能用 AgentDescent 的沙箱。
- **程序演进（OpenEvolve）的候选评测**：两个选项 ——
  用 AgentDescent 自带的 `ContainerProvider`/bwrap/seatbelt（现成、已有 AST 门），
  还是也走 ScienceAgent runner（一致、可溯源、但要新写评测协议）。
  **建议先用 AgentDescent 自带的**，M1 阶段不引入新的沙箱工作量；等程序演进的产物要进 CAS 时再统一。

### 决策 C：暴露几个演进方法

18 个端口不能全暴露给用户。建议只出 3 个预设：

| 预设名（用户看到） | 底层 | 用途 |
|---|---|---|
| 技能改进（默认） | `evolve_skill_dir()` + `AppendRules`/`FileTree` + `DefaultAcceptance` | 主路径 |
| 程序演进 | OpenEvolve 端口（`OpenEvolveStrategy` + 岛屿 aggregator + `EpsilonGreedy`） | 用户给数据集 + 一个待优化脚本 |
| 反思式提示优化 | GEPA 端口（Pareto aggregator） | 单个提示的精修 |

其余 15 个留在配置文件里，不进 UI。

### 决策 D：pairwise judge 的噪声处理（见 §1 修正三第 2 条）

`temperature=0` / 多数投票 / 留出集 ≥8，三选一或组合。**必须在 A2 任务里定死**，
否则 A3 之后所有结论都不可信。

---

## 3. 任务分解

依赖标记：`←` 表示依赖。所有任务都写明**干什么**与**完成判据**。

### S 系列 —— 共享地基（两条演进链路都要）

#### S1 · schema 与存储骨架
**干什么**
- 新建 `packages/schema/src/evolution.ts`：`EvolutionNote` / `Episode` / `TaskFamily` / `Rubric` /
  `EvolutionRun` / `Proposal` / `EvolveTarget`。
- `EvolveTarget` 用判别联合，第一天就把两种目标分开：
  `{kind:"skill_dir", skillId, layout:"claude_skill"}` | `{kind:"program", programId, entrypoint}`。
- `services/api/src/store.ts` 增路径解析：`data/evolution/{notes,episodes,families,runs,proposals,ledger,programs}/`。
- 所有类型带 `schemaVersion`。

**完成判据**：类型编译通过；空数据目录能初始化；现有测试不回归。

#### S2 · EvolutionRun 生命周期 + 事件流 ← S1
**干什么**
- `evolution/runs.ts`：状态机 `queued → running → {succeeded, failed, cancelled, budget_exceeded}`，
  支持 stop / resume（resume 靠 `EvolutionResult.load()` + ledger）。
- **统一事件模型**，两种目标共用：`round` / `candidate` / `eval` / `merge` / `accept` / `reject` / `cost` / `log`。
  AgentDescent 侧从 `RoundInfo`、`MergeReport`、`outcomes()` 映射过来；
  OpenEvolve 的 iteration/岛屿信息塞进 `candidate.meta`，不另立一套。
- 侧车 NDJSON → API → SSE → 浏览器。
- 复用现有 Stop run 的中止贯通链路。

**完成判据**：STUB 引擎下能跑完一次 run；前端收到完整事件序列；Stop 能真中止且保留断点。

#### S3 · 侧车骨架 `services/evolve` ← S1
**干什么**
- 照 `services/gateway` 的形态：uv 项目、FastAPI、只绑 `127.0.0.1:4313`、无持久业务状态。
- `server.py`（`/health` `/evolve` `/cancel`）、`bridge.py`（run/reward/propose → HTTP 回调）、
  `runner.py`（组装 `evolve()`）、`events.py`。
- **按决策 A1 使用 `ThreadExecutor`**，并在代码里写注释说明为什么不能用 ProcessExecutor。
- `SCIENCE_AGENT_EVOLVE_{ENABLED,PORT,STUB}`；接 `scripts/start-stack.sh`、Dockerfile、docker-compose。
- **STUB 引擎**：确定性假引擎，不调模型，产出固定事件序列与一条假提案。

**完成判据**：stack 起得来；健康检查通过；STUB 端到端产出一条提案（这是前端与测试的前置，必须先做）。

#### S4 · 内部 OpenAI 兼容模型代理 ← S3
**干什么**
- Node 暴露 `/internal/evolve-llm/v1/chat/completions`，侧车的 `openai_compatible(...)` 指向它。
- 侧车拿到的是回环 URL + 一次性 run token，**永不接触真实模型密钥**。
- 所有演进期模型调用进现有 model-usage 记账。
- 用 `metered()` 包装 completion，把 AgentDescent 侧的调用数与耗时也带回来对账。

**完成判据**：一次真实 run 的花费出现在 model-usage 里，且与 `result.cost_summary()` 对得上。

#### S5 · 预算与调度闸 ← S2, S4
**干什么**
- `evolution/budget.ts`：run / 项目 / 月三级 token 与费用上限；超限自动停并保留断点。
- **「仅空闲时演进」是默认且强制**：用户开新会话立刻让出执行槽。
- 并发分开计：技能 rollout 并发（贵，默认 2）与程序评测并发（便宜，可高）。
- 开跑前用 `DurationEstimator` 给耗时预估，用 `Usage.estimated_cost()` 给费用预估。

**完成判据**：注入假成本能触发停机；活跃会话时演进被抢占；预估值与实际值同量级。

#### S6 · 治理映射与提案审批 ← S1
**干什么**
- **不新写治理引擎**，把 ScienceAgent 语义映射成 AgentDescent 的 `Policies`：
  - L0 → `frozen=` 路径清单（`SAFETY.md`、权限相关、评测集），双重强制已由框架保证。
  - L2 技能 → `blast_radius=0.2`；L1 骨架/程序 → `blast_radius=0.6` + oracle。
  - oracle 层 → 接人工审批（这是 ScienceAgent 独有的接线）。
- `evolution/proposals.ts`：提案存储、审批、**否决指纹**（同一改动被拒后不再重复提）。
- 三处强制点（提案生成、落盘前、发布前）。

**完成判据**：改 L0 路径的提案被拒；未批准的提案不落盘；被否决的改动不再出现第二次。

---

### T 系列 —— 离线轨迹分析自演进（AgentDescent 完全不覆盖，全自研）

这一系列**不依赖任何引擎**，可与 S 并行开工。

#### T1 · 便签捕获与 T0 注入（最先做，第一天就有价值）
**干什么**
- 用户一句纠正 / 👎 + 一句话 → 记为 `EvolutionNote`，带出处（sessionId / messageId / CAS 引用）。
- 作用域 session / project / global，复用现有三层继承。
- 在 `packages/agent-runtime` 的 system prompt 拼装处注入检索到的便签。
- **T0 不允许任何额外模型调用**——纯检索，用户在等结果的路径上零开销。

**完成判据**：说一次，下个会话就带上；注入前后单轮延迟无可测差异。

#### T2 · 会话 → Episode 沉淀 ← T1
**干什么**
- 触发：会话非活跃 N 分钟；必须**幂等**（同一会话重复触发不产生重复 Episode）。
- 切段：一个长会话可能含多个独立任务，要切开。
- 落四样东西：题面（用户原始问题）、输入（工作区文件 CAS 快照）、
  **基线**（用户当初实际收到并接受/纠正过的产出与轨迹）、信号（显式反馈 + 隐式：是否重跑、是否手改结果）。
- 基线是整套方案的支点：有它就能做 pairwise，不需要 gold answer。

**完成判据**：在真实历史会话上跑批，人工抽查切段准确率；同一会话跑两次产出一致。

#### T3 · 轨迹蒸馏 ← T2
**干什么**
- 全量轨迹 → 反思器能吃的结构化摘要：调用了哪些工具、在哪一步偏离、错误链、关键决策点。
- 独立子进程执行（`execFile`，与 paper worker 同样的按次子进程模式），不占 API 进程。
- `extractorVersion` 打标：**这是唯一会静默出错的地方**——不同版本蒸馏出的摘要混用会让演进学到假东西。

**完成判据**：蒸馏产物比原轨迹小 1~2 个数量级；A/B 验证——反思器用蒸馏摘要比用原始轨迹提出的改动更具体。

#### T4 · 失败模式打标与题族聚类 ← T3
**干什么**
- **按"口径"聚类，不按"任务"聚类**：一行不是"一个完整科研任务"，
  而是"一个触发了同一条规矩的检查点"（题面各异、口径共享）。
- 三层打标：① 确定性方法学规则（第一天可用）② 便签语义命中 ③ 无监督发现（后置到 M3）。
- 产出 `TaskFamily`，对上 AgentDescent 的 `KeyedRules`（一条规则一个 key）。
- 用 `split_dataset(stratify_key=...)` 做分层划分，别自己写。

**完成判据**：真实 episode 池上形成 ≥1 个样本数 ≥8 的题族。

#### T5 · 题族健康度诊断 ← T4
**干什么**
- 三个诊断，**直接用 AgentDescent 的统计工具，不自己算**：
  - 分数分布直方图 → 全 1.0 或全 0.0 提示"口径没区分度"
  - 重跑一致性 → 用 `Comparison.spread()`
  - 样本量够不够 → 用 `Comparison.underpowered()`（这个函数就是为这件事写的）
  - 题目相似度聚类 → "8 题里 6 题几乎一样，有效题目其实只有 3 道"
- <8 题时明确提示"结论不可信"并**禁用自动采纳**。

**完成判据**：能对一个坏题族给出明确的"不可信"结论与原因。

#### T6 · Episode 隐私面 ← T2
**干什么**
- 设置页给「查看 / 删除我的 episode 池」——用户必须能看见自己被记录了什么。
- 保留期策略；默认只在项目内，不跨项目。
- 删除时连带回收 CAS 快照。

**完成判据**：删除后 CAS 快照真被回收，磁盘占用下降。

---

### A 系列 —— AgentDescent 引擎接入（技能演进主路径）

#### A1 · rollout 执行接缝 ← S3, 决策 A
**干什么**
- `evolution/rollout.ts`：headless ephemeral run，复用现有 `createAgentRun`。
- **非交互权限决策器**：新增决策器，不改现有函数签名。
- rollout 必须有一个真实 Session（否则溯源链断）。
- 生命周期与回收：ephemeral session 跑完即清，但可按决策保留供看板展开。

**完成判据**：一次 rollout 在无人值守下跑完并产出可评分输出；ephemeral session 不污染用户会话列表。

#### A2 · 评分口径引擎 = `ThreeLayerVerifier` 的四个方法 ← A1, 决策 D
**干什么**
- **不新写三层架构**，实现 `ThreeLayerVerifier` 要求的四个方法：
  - `rule_eval` → 硬门：溯源检查、格式检查、必填项（失败直接 0，不进 judge）
  - `learned_eval` → pairwise judge（返回 `(score, uncertainty)`），赢 1.0 / 平 0.5 / 输 0.0，**位置随机化防偏**
  - `cheap_eval` → 组合前两层，用于候选排序（`cheap_eval_tasks=4` 默认）
  - `oracle_eval` → 人工审批 / Reviewer Specialist，受 `VerifierBudget` 约束
- **四个方法一个都不能少**，缺一个会在运行中途 `AttributeError`。
- 设 `oracle_shares_full_set` 属性（不设则 oracle 会被独立调用一遍）。
- **按决策 D 处理 judge 噪声**：`temperature=0` + 留出集 ≥8。

**完成判据**：同一对输入重跑一致性 > 阈值；`eval_counts()` 返回的全集计数能喂进接受门。

#### A3 · 侧车绑定 `evolve_skill_dir` ← S3, S6, A1, A2
**干什么**
- `runner.py` 绑 `evolve_skill_dir()`：ScienceAgent 的 `skills/<name>/SKILL.md`
  与 `LAYOUTS['claude_skill']`（`.claude/skills/<name>/`）**天然同构**，只需路径映射。
- `TreeSpec`：`max_file_bytes` 默认 28000（低于 aggregator 32000 信任域），别调高。
- `frozen=` 填 S6 的 L0 清单。
- ledger 落 `data/evolution/ledger/<runId>/`，随数据目录整体备份。
- `reflect_with=` 用便宜模型走 S4 代理。
- holdout 传递：`evolve()` 按位置切 train/holdout，`reward` **不接受 NaN**。

**完成判据**：真实跑一轮；`result.outcomes()` / `fusion_stats()` 能完整映射成提案卡字段。

#### A4 · 提案 → skill revision 落盘 ← A3, S6
**干什么**
- 提案协议是 **JSON 整文件替换**，不是 unified diff：
  `{"rationale":"...","edits":[{"path":"SKILL.md","content":"...完整文件..."}]}`。
- 用 `result.write_to()` 落盘：自动 `.bak-N` 备份、extras 只报告不删（除非 `prune=True`）、先 dry-run。
- 映射到 ScienceAgent 已有的**不可变 skill revision**（两边数据模型天然对齐）。
- dev / stable 双通道 ↔ 试用版 / 正式版；影子模式；转正闸门（K 轮无回归）；一键回滚。
- **注意**：AgentDescent 不支持文件重命名（要删+建）、不支持二进制文件。

**完成判据**：采纳后新会话真的用上新 revision；回滚一键生效且有审计记录。

#### A5 · 演进看板 UI ← S2, A3
**干什么**
- 主图：train / holdout 两条曲线，**holdout 视觉上加粗**（它是唯一可信的那条）。
- worker 泳道、采纳流水（每次 aggregator step：采纳 / 拒绝 + 原因）、成本条、随时 Stop。
- rollout 可展开查看完整对话——调试"为什么没学到东西"时这是唯一有用的东西。

**完成判据**：不看日志就能判断一次 run 为什么没产生提案。

---

### D 系列 —— 用户给数据集然后演进

**这是整条链路的解耦阀**：没有它，M1 会陷入"功能写完了但没数据可跑"。
也是唯一能让你自己 dogfood 的路径。

#### D1 · 导入向导 + 分诊 ← S1
**干什么**
- 四种形态解析（按现实性排序）：
  - **B. 输入 + 已认可的结果**（推荐）：已认可结果 = 基线，直接复用 pairwise，零额外标注。
    大多数课题组归档里都有——这是被低估的金矿。
  - **C. 一批输入 + 一份验收 checklist**：checklist 作为 judge 维度，绝对打分。
  - **A. 标准题集** CSV/JSONL：prompt 列 + gold 列，用现成的 `rewards.contains/exact_match/numeric_close`。
  - **HF 数据集名**：直接用 `dataloader` 的 HF `/rows` 支持，零额外依赖。
- **分诊（新增的关键一步）**：判断这份数据该进哪种目标类型 ——
  - 有"我认可的报告 / checklist"，目标是让 Agent 按我的路子做 → `kind:"skill_dir"`
  - 有可计算指标 + 一个待优化脚本 → `kind:"program"`（OpenEvolve 预设）
  - 两者皆可 → 让用户选，默认 skill_dir
- 列映射 + **前 3 题试评预览**（避免映射错了跑完才发现）。

**完成判据**：错误的列映射在开跑前被拦住；三种形态各能导入一份真实样例。

#### D2 · 数据集 → 题族 / 程序任务规格 ← D1, T4
**干什么**
- 三种来源（会话沉淀 / 用户导入 / 公开 benchmark）产出**同一个题族对象，只是 badge 不同**，不是三套系统。
- 用 `tasks_from()` 把 dict 行转成 `Task`；用 `split_dataset()` 切分，别自己写。
- 公开 benchmark **只当护栏，不当目标**（分布不匹配）。

**完成判据**：导入当天能起一次真实 run（这是 dogfood 阀门，必须验证）。

#### D3 · 导入数据的护栏 ← D2, A4
**干什么**
- 转正必须在**真实 episode 池**上不回归；没有真实 episode 则停在试用版。
- 给一个「我确认接受，直接转正」的手动逃生门，但要用户显式点，
  并在版本时间线上**永久标注"未经真实回归验证"**。

**完成判据**：无真实 episode 时自动转正被阻断；逃生门的标注永久可见。

---

### O 系列 —— 程序演进（OpenEvolve 预设）

因为 OpenEvolve 已在 AgentDescent 内（修正一），这一系列比原先预想的小很多。

#### O1 · 程序演进目标物定义 ← S1
**干什么**
- 定义 ScienceAgent 里"可被程序演进的对象"：一个 program artifact（分析脚本 / 特征工程 / 启发式）。
- 定产物落点：**CAS artifact + 项目产物**，而不是 skill revision——
  这条链路改进的是**用户的科研结果**，不是 Agent 自己。
- 写清"什么问题适合交给它"，并给 2 个 ScienceAgent 内的样例问题（这是给用户的，也是给你自己的验收集）。

**完成判据**：两个样例问题都能被完整描述成 `{initial_program, evaluator, metric}` 三元组。

#### O2 · 评测接缝 ← O1, 决策 B
**干什么**
- 按决策 B，M1 先用 AgentDescent 自带的沙箱（`ContainerProvider` / bwrap / seatbelt），
  它已经有 AST 门（入沙箱前拒绝不安全语法与硬编码最优解）、清空环境、只读挂载、去网络、`setrlimit`。
- **必须验证**：两种沙箱后端都不可用时框架是报错而不是裸跑（文档承诺如此，要实测确认）。
- 评测器返回的 metrics 映射到 S2 的统一事件模型。
- 失败即 0 分；artifacts 侧信道（stderr / profiling）回流成人能读懂的失败原因。

**完成判据**：死循环 / 越权候选程序不能拖垮侧车、不能出沙箱；无沙箱后端时启动即报错。

#### O3 · 侧车绑定 OpenEvolve 预设 ← S3, S4, O2
**干什么**
- 组装 `evolve()` / `async_evolve()` + `OpenEvolveStrategy` + `OpenEvolveAggregator` + `EpsilonGreedy`，
  `blast_radius=0.6`（L1，强制 oracle）。
- 暴露的参数：`--islands`(默认 3)、`--migration-interval`、`--budget-rollouts`(默认 24)、
  `--workers`(默认 4)、`--max-seconds`、`--async-ratio`、`--staleness`。
- **两个硬约束写进配置校验**：`max_tokens >= 32000`；thinking **必须关**。
  这两条任一违反，搜索直接停摆——不能靠文档提醒，要在代码里拒绝启动。

**完成判据**：复现官方样例量级的结果（组合分显著上升）；`max_tokens<32000` 或 thinking 开启时拒绝启动并给出明确原因。

#### O4 · 多目标与 MAP-Elites 呈现 ← A5, O3
**干什么**
- metrics 是 dict 不是标量：UI 要能选主指标 + 看 Pareto 前沿。
- 岛屿视图、MAP-Elites 网格、best-so-far 曲线、获胜程序出现在哪个岛哪次迭代。
- 程序代码本身要能 diff 查看（586 字符 → 7848 字符这种增长要看得见）。

**完成判据**：用户能说清"它现在最好的程序好在哪、是怎么来的"。

#### O5 · 程序演进的预算模型 ← S5, O3
**干什么**
- 迭代量级与技能演进完全不同（数十轮 vs 数百次评测），预算默认值必须**分开设**。
- 但注意：官方实测 24 rollouts / 76k tokens / 50.8 秒——**比技能演进便宜得多**，
  因为评测是跑程序不是调 agent。默认值可以给得比技能演进宽。

**完成判据**：默认配置下一次 run 的花费有上界且开跑前能预估。

---

### G 系列 —— 放手与深化（M2 / M3）

| 任务 | 干什么 | 依赖 |
|---|---|---|
| **G1** 便签 → 提案自动升级 | 便签所属题族攒够 ≥8 episode 时自动发起验证，走完整接受门 | T4, A3 |
| **G2** 夜间计划演进 | 定时 + 预算上限 + 只提交到试用通道 + 早上一封「昨夜学到了什么」摘要卡 | S5, A4 |
| **G3** 骨架级演进 | `evolve_agent_dir()`（specialist / 评审准则），`blast_radius=0.6`，强制 oracle 人工审批 | S6, A4 |
| **G4** 异步 barrier-free | `async_evolve()` + `async_ratio` + `staleness_policy`（Guarded 默认） | A3 |
| **G5** 并行策略选型 | `TensorParallel`（artifact 切不相交段，天然无冲突）对多文件技能目录最合适 | A3 |
| **G6** 技能发现 | EvoSkill 端口（有界 top-K 前沿聚合），识别重复模式固化为新技能 | A3, T4 |
| **G7** 在线轻量决策点 best-of-N | 纯文本决策（选哪个统计检验 / 什么查询式）跑 3 路 + pairwise 判优，判优结果直接是训练信号；默认关 | A2 |
| **G8** 无监督失败模式发现 | T4 的第三层，需嵌入模型，与"零必需依赖"冲突，最后做 | T4 |
| **G9** 跨项目经验迁移 | 把一个项目验证过的技能改动迁到另一个项目 | A4, D3 |

---

## 4. 依赖图与建议顺序

```
第 1 波（可完全并行，无相互依赖）
  S1 schema ──┬──────────────────────────────────┐
  T1 便签+T0注入（最先有用户价值）                  │
                                                 │
第 2 波                                           │
  S3 侧车骨架+STUB ← S1      T2 Episode 沉淀 ← T1  │
  S2 run 生命周期+事件 ← S1                        │
                                                 │
第 3 波                                           │
  S4 模型代理 ← S3      T3 轨迹蒸馏 ← T2           │
  S6 治理映射 ← S1      D1 导入+分诊 ← S1          │
  A1 rollout 接缝 ← S3                            │
                                                 │
第 4 波 —— 打通端到端（里程碑：第一次真实演进）        │
  A2 口径引擎 ← A1        T4 题族聚类 ← T3         │
  A3 绑定 evolve_skill_dir ← S3,S6,A1,A2          │
  D2 数据集→题族 ← D1,T4                          │
  A4 提案→revision ← A3,S6                        │
                                                 │
第 5 波                                           │
  S5 预算调度 ← S2,S4     A5 看板 ← S2,A3          │
  T5 健康度 ← T4          T6 隐私面 ← T2           │
  D3 导入护栏 ← D2,A4                             │
                                                 │
第 6 波 —— 程序演进                                │
  O1 → O2 → O3 → O4/O5                            │
                                                 │
第 7 波 —— G 系列                                  │
```

**关于顺序的一个判断**：前三份文档把 M0（沉淀层）整体排在 M1（演进）之前。
我建议**只把 T1 前置**，T2~T4 与 A/D 系列并行 —— 理由是 D 系列（用户导入）
才是让引擎链路当天跑通的解耦阀，而 T2~T4 需要真实会话积累，时间上本来就慢。
两条线在第 4 波汇合（A3 用 D2 的题族先跑起来，之后再换成 T4 的真实题族）。

---

## 5. 验收：四个探针

在宣称"能用"之前，这四条必须实测通过：

1. **端到端探针**：导入 20 份「输入 → 我认可的报告」，起一次真实演进，产生一条被采纳的提案，
   新会话确实用上了新 revision。
2. **有效性探针**：`Comparison.separates()` 在留出集上区分开新旧版本，
   且 `underpowered()` 返回 false（样本量够）。
3. **噪声探针**：同一候选重跑三次，pairwise 打分方差在阈值内（验证决策 D 的处理有效）。
4. **安全探针**：改 L0 路径的提案被拒；恶意程序候选被 AST 门或沙箱拦住；
   两种沙箱后端都缺失时框架报错而非裸跑。

---

## 6. 与前三份文档的差异索引

需要按本文修订的地方：

| 位置 | 原内容 | 应改为 |
|---|---|---|
| implementation §8 口径引擎 | 自研硬门/pairwise/absolute/script 四件套 | 实现 `ThreeLayerVerifier` 的四个方法（A2） |
| implementation §13 采纳与发布 | 自研双分支与转正闸门 | 配置 `Ledger` 双分支 + promotion policy（A4） |
| implementation §15 预算与调度 | 自研调度 | `DurationEstimator` + `AuditScheduler` + 自研空闲抢占（S5） |
| implementation §2.3 模块清单 | `rubric/{hard-gate,pairwise,absolute,script}.ts` 四文件 | 收敛为一个 verifier 适配层 |
| internals §0.5 | "提案协议是整文件替换" | ✅ 正确，补充 JSON schema 与 `max_file_bytes=28000` |
| internals §0.6 | "train/holdout 按位置切，reward 不接受 NaN" | ✅ 正确 |
| 全部三份 | 未提 OpenEvolve | 补入 O 系列；说明它是 AgentDescent 内的端口 |
| 全部三份 | 未提 executor 的 Ref 限制 | 补入决策 A（否则跨进程会炸） |
| 全部三份 | 未提 evalcache 单样本问题 | 补入决策 D（否则结论是噪声） |

---

## 相关文档

- [self-evolution.md](self-evolution.md) — 产品与用户视角
- [self-evolution-implementation.md](self-evolution-implementation.md) — 实现规格
- [self-evolution-internals.md](self-evolution-internals.md) — 算法与代码级实现
- AgentDescent：`docs/api.md`（完整 API）· `docs/directory-evolution.md`（技能目录演进）·
  `docs/algo-openevolve.md`（程序演进端口）· `docs/verifier.md`（三层评分）·
  `docs/acceptance-policies.md`（接受门）· `docs/governance.md`（L0/L1/L2）·
  `docs/dataloader.md`（数据集）· `docs/execution.md`（执行接缝与 Ref 限制）·
  `docs/sandboxes.md`（沙箱）· `docs/self-evolution-examples.md`（18 个算法端口）
