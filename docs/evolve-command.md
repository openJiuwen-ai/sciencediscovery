# `/evolve` —— 设计

用户输入 `/evolve`，给一个目标，系统演进出一个**能执行该任务的程序**，并给出「它好在哪、
怎么来的、凭什么说它更好」。

搜索循环用 [AgentDescent](https://github.com/Birfy/agentdescent) 的两个端口：
**ERA**（Flat UCB 树搜索，默认）与 **OpenEvolve**（MAP-Elites 岛屿）。
Node 控制面持有治理、预算、记账、溯源。

> **一套 run 子系统，算法是目标模型里的一个字段。** `/era`、`/openevolve` 是同一个向导的
> 别名入口（§2），不是第二套 run。搜索过程如何落进 Neo4j 科学记忆图谱、
> 以及"一次搜索 = 一个 SubTask 节点 + 它绑定的那张图"，见
> [搜索过程落图](evolve-search-graph.md)；界面（向导 / 看板 / 搜索图 / 产物屏）见
> [前端设计](evolve-frontend.md)；**目标与评分模式（四种测量方式 + 缺项时的模型起草）见
> [目标与评分](evolve-goal-scoring.md)，从目标生成的打分标准与它如何决定接受见
> [评分卡](evolve-scorecard.md)**。

---

## 1. 用户流程

```
/evolve 把这份表达矩阵的细胞类型分类准确率做上去
      ↓
  ① 起草 —— 一次普通 agent run（不是演进）：读工作区，起草三元组
      ↓
  ② 确认 —— 向导预填：baseline 脚本 · 数据划分 · 指标 · 预算预估      ← 不可跳过
      ↓
  ③ 试跑 —— baseline 跑一次，把起点分数摆出来                        ← 不可跳过
      ↓
  ④ 演进 —— 看板：分数曲线 · 搜索结构 · 候选流水 · 成本条
      ↓
  ⑤ 产物 —— 最优程序 + 三个分数 + 与 baseline 的 diff + [存为产物]
```

②③ 不可跳过的理由：指标选错、划分切错，是这类功能最常见的失败，而这两种错都要跑完一整轮
昂贵演进才会暴露。**baseline 试跑一次的成本是一次程序执行，比一次演进便宜三个数量级。**

「一句话就能演进」在体验上靠 ① 成立：用户只写目标，三元组由 Agent 起草，用户改或确认。
不做「一句话直接起跑」——四要素不齐时让模型去猜，等于拿演进的钱买抽奖。

---

## 2. 命令解析

`/evolve` 是**前端拦截并打开面板，不创建 run**（现有 `/web-usage` 就是这个模式，
`/web-refresh` 那种「剥前缀进后端」的形态不适用）。

```
apps/web/src/session/model.ts   解析 → { kind: "evolve", goal?, algorithm?, resumeRunId? }
apps/web/src/App.tsx            命中即开 EvolveWizard，不调 sendMessage
```

| 输入 | 行为 |
|---|---|
| `/evolve` | 打开向导，四要素全空，算法选择器默认 `era` |
| `/evolve <一句话目标>` | 打开向导，起一次「起草三元组」的普通 run 预填 |
| `/evolve --algorithm openevolve <目标>` | 同上，算法预置为 OpenEvolve |
| `/era <目标>` | **别名**：等价于 `/evolve --algorithm era`，向导里仍可改 |
| `/openevolve <目标>` | **别名**：等价于 `/evolve --algorithm openevolve` |
| `/evolve --resume <runId>` | 从 ledger 断点续跑；算法由该 run 的记录决定，**不可改** |

三个入口打开的是**同一个向导、同一套 run**：算法（`algorithm`）是目标模型里的一个字段（§3.1），
不是两条代码路径。别名只做一件事——把 `algorithm` 预置好，省掉用户在向导里选一次。
续跑不许换算法：树和岛屿的状态不可互转，换算法等于开新 run。

---

## 3. 目标模型

> **§3.2 / §3.3 只覆盖四种评分模式里的一种**（`dataset_metric`）。测试门、评分脚本、
> LLM 评审三种，以及四要素缺项时的模型起草，见 [目标与评分](evolve-goal-scoring.md)。

### 3.1 四要素

```
① 目标物   起始程序 —— **从产物目录选一个产物（§3.4，最常用）** / 上传 / 从工作区选 / Agent 起草
② 评测     数据集 + 三段划分
③ 评分     四选一：数据集指标 / 测试门 / 评分脚本 / LLM 评审（见 evolve-goal-scoring.md）
④ 预算     扩展次数 · wall clock · token · 费用，任一触顶即停
⑤ 算法     era（默认，一批数据 + 一个标量指标）| openevolve（多目标 / 要看质量多样性）
```

### 3.2 划分必须三段

```
数据集
 ├─ 训练部分          候选程序自己用
 └─ 尾部切成等长分片
     ├─ rollout 分片   搜索能看到分数的        默认 4
     ├─ 留出门分片     接受门用，搜索看不到    默认 4
     └─ 测试分片       全程不参与，最后报一次  默认 4
```

只有两段的话，报出来的提升是在「搜索优化过的那个分片集」上，必然虚高。
三个数字在 UI 上分开显示：**能对外说的只有测试分片那个。**

### 3.4 从产物起跑：`kind: "artifact"`

最常见的入口不是敲 `/evolve`，而是**在产物目录里看着一个结果说「把这个做得更好」**。
所以产物是一等的起跑点，但要先分清一件事：

> **产物本身通常不可演进，可演进的是生成它的代码。**
> 一张 PNG、一份 CSV 没有"改进"的操作；改进的是产出它的那段程序。

| 产物 kind | `role` | 演进什么 | 评分默认建议 |
|---|---|---|---|
| `other`（`.py`）· `notebook` | `program` | 产物本身 | 数据集指标 / 测试门 |
| `dataset`（csv/parquet） | `product` | 生成它的代码 | 数据集指标（若有标签列） |
| `report` · `markdown` | `product` | 生成它的代码；若无代码则内容本身 | LLM 评审 + rubric |
| `figure` | `product` | 生成它的代码 | **不可自动评分**，见下 |
| `json` · `html` · `structure` | `product` | 生成它的代码 | 评分脚本 |

**解析链路（不依赖科学记忆）**：`ScientificArtifactVersion.executionRunIds` 直接给出产出该版本的
执行，`ArtifactVersionProvenance.code[]` 给出那段代码本身——都在 store 里，**图关掉也能用**
（图只在跨会话追溯时更强）。所以：

```
选中 Artifact(id, version)
  ├─ artifact.origin == "user_upload" | "mcp_download"  → 没有生成它的代码
  ├─ executionRunIds 为空                                → 同上
  └─ 否则 provenance.code[] → baseline 程序，role = "product"
```

**解析不出来时不要猜**，给两条明确出路：

1. 让 Agent 起草一个**能重现这个产物**的程序，人工确认后演进它（起草的程序先跑一次，
   与原产物比对，不一致就说清楚差在哪）；
2. 仅文本类产物（report / markdown）：直接演进内容本身，评分只能用 LLM 评审。

**`figure` 要当面拒绝自动评分**：图的好坏没有标量表达。让用户改成指向它背后的数值判据
（"R² 更高"而不是"图更好看"），或明确接受 LLM 评审这种弱信号。不写这条，用户会得到一次
在平坦地形上的随机游走（评分卡文档 §8 的判别力问题）。

**两条这个入口独有的校验**：

| 校验 | 为什么 |
|---|---|
| 评测输入的**版本必须钉死** | `inputArtifactVersionIds` 不锁版本的话，"提升"可能来自输入数据变了，而不是程序变好 |
| 产出落回是**新版本**，不覆盖 | 胜出程序重新生成的产物注册为 v(N+1)，与旧版本之间连 `supersedes`；L1 治理下要人点一下才落 |

### 3.3 指标映射必须与方向单调一致

框架的 reward 是 `[0, 1]`，而用户的指标可能是任意量纲、任意方向。映射必须保证
**树的排序与接受门的排序完全一致**，否则两者会对「哪个程序更好」产生分歧。

```
RMSE（最小化）  → reward = 1 / (1 + rmse)     严格单减，诱导与 -rmse 相同的排序 ✅
准确率（最大化） → reward = identity                                              ✅
```

创建 run 时校验单调性，不一致直接拒绝。**指标定义本身不可被演进修改**——
允许改指标，系统就会学「让自己得高分」而不是「做得更好」。

---

## 4. 数据模型

`packages/schema/src/evolution.ts`，全部类型带 `schemaVersion`。

```ts
/** 目标物：判别联合，第一天就把两种目标分开。 */
export type EvolveTarget =
  | { kind: "program"; programId: string; entrypoint: string }
  | { kind: "skill_dir"; skillId: string; layout: "claude_skill" }
  | { kind: "agent_dir"; agentId: string; layout: "claude_agent" }
  /** 从 Project 产物目录里挑一个产物起跑（§3.4）。
   *  role 决定"演进的到底是什么"：产物本身是代码时演进它，
   *  产物是输出时演进**生成它的代码**，产物负责定义"更好"。 */
  | { kind: "artifact"; artifactId: string; version: number; role: "product" | "program" };

export interface EvolveMetric {
  name: string;
  direction: "minimize" | "maximize";
  reward: { kind: "reciprocal" } | { kind: "identity" } | { kind: "clamp"; lo: number; hi: number };
}

export interface EvolveSplit {
  trainRows: number | null;      // null = 全部
  rolloutShards: number;         // 搜索可见，>= 4
  gateShards: number;            // 接受门用，>= 4
  testShards: number;            // 全程不参与
  shardRows: number;
  seed: number;
}

export interface EvolveBudget {
  expansions: number;            // 必须能被 workers 整除
  maxSeconds: number;
  maxTokens: number;
  maxCostCents: number;
  candidateTimeoutSeconds: number;
}

export interface EvolveGoal {
  schemaVersion: 1;
  statement: string;             // 用户那句话，原样保留
  target: EvolveTarget;
  baselineProgramCas: string;
  /** 从目标生成的整张评分卡：判据 + 权重 + 否决项 + 聚合规则。
   *  单指标是 criteria.length === 1 的退化情形。定义见 evolve-scorecard.md §7；
   *  每条判据的 measure 是四种测量方式之一，见 evolve-goal-scoring.md §2。 */
  scorecard: EvolveScorecard;
  /** 由评分模式决定默认值：分级评分（LLM 评审）必须下调，否则每次 rollout
   *  都会请求提案，run 报 below-threshold 而看起来像反思器坏了。 */
  solvedThreshold: number;
  /** L0：评分定义本身（指标 / 测试套件 / 评分脚本 / rubric / 划分种子）。 */
  frozen: string[];
  algorithm: "era" | "openevolve";
  budget: EvolveBudget;
}

/** 统一事件模型，两个算法共用；算法专属信息只进 meta。 */
export type EvolveEvent =
  | { type: "round"; index: number }
  | { type: "candidate"; id: string; parentId: string | null; code: string; meta: EraMeta | OpenEvolveMeta }
  | { type: "eval"; candidateId: string; shard: string; metrics: Record<string, number> }
  | { type: "merge"; candidateId: string; accepted: boolean; reason: string }
  | { type: "cost"; tokens: number; cents: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

interface EraMeta { algorithm: "era"; nodeIndex: number; parentIndex: number | null; visits: number; depth: number; rankScore: number; puct: number; }
interface OpenEvolveMeta { algorithm: "openevolve"; nodeIndex: number; programId: string; parentId: string | null; island: number; iteration: number; complexityBin: number; diversityBin: number; inspirationIds: string[]; }
```

存储：

```
data/evolution/
  programs/<programId>/   起始程序与每个候选（CAS 引用）
  runs/<runId>/           run 元数据 + NDJSON 事件日志
  ledger/<runId>/         AgentDescent 的 git-backed ledger
  results/<runId>/        EvolutionResult.save() 落点，续跑靠它
```

---

## 5. 架构与接缝

```
                       浏览器 :4310
                            │  /evolve → EvolveWizard（不创建 run）
              ┌─────────────▼──────────────┐
              │  services/api (Node)       │  目标/运行/产物存储、治理、预算、
              │                            │  记账、SSE 广播、CAS 落盘
              └──┬────────────┬────────────┘
   POST /evolve  │            │ ① 模型代理  /internal/evolve-llm/v1/chat/completions
                 │            │ ② 沙箱能力  探测结果随请求下发
                 ▼            │ ③ 事件回传  NDJSON
      ┌──────────────────────┐│
      │ services/evolve      ││  ThreadExecutor
      │ (Python, 回环 :4313)  │┘  vendored: era/ · openevolve/
      │  evolve()/async_evolve│    packaged: FlatPuct · Ledger · Verifier · Policies
      └───────┬──────────────┘
              │ 候选执行（bwrap / seatbelt）
              ▼
      候选程序（模型写的，不可信）
```

五条约束：

1. **侧车形态照 `services/gateway`**：uv 项目、只绑 `127.0.0.1:4313`（4310/4311/4312 已占）、
   无持久业务状态。
2. **必须用 `ThreadExecutor`**。`evolve()` 无法把传入的 `run=` 闭包变成 `Ref`——它构造的 spec
   携带一个解析时会抛异常的引用，因为闭包没有名字。只有 `ThreadExecutor` 接受直接传入的
   callable。这条要写成代码注释，否则后人会「优化」成多进程然后炸掉。
3. **侧车永不接触模型密钥**。`agentdescent.agents.openai_compatible()` 在**调用时**从环境读
   base URL 与 key，所以侧车拿到的是回环 URL + 一次性 run token。
   用 `metered()` 包装，把调用数与耗时带回来对账，进现有 model-usage。
4. **STUB 引擎优先做**：确定性假引擎，不调模型、不起沙箱，产出固定事件序列与一个假产物。
   前端与集成测试的前置。
5. 侧车 → API 走 NDJSON，API → 浏览器复用现有 SSE 与 Stop run 的中止贯通链路。

### 要 vendor 什么

两个端口的算法主体在 AgentDescent 的 `examples/` 下，不进 wheel（`pyproject.toml` 只打包
`agentdescent*`）。包内能直接用的：`evolve()` / `async_evolve()`、`Ledger`（git-backed、
dev/stable 双分支）、`ThreeLayerVerifier`、`DefaultAcceptance` / `TrustRegion`、
`SandboxPool`、`evolve_agent_code()` / `evolve_skill_dir()`、以及 **ERA 的选择策略
`selection.FlatPuct`**。

要搬进 `services/evolve/vendor/` 的（记录上游 commit）：

| 来源 | 行数 | 处理 |
|---|---:|---|
| `examples/era/era_empirical_software.py` | 923 | 取 `Node`/`EraTree`/`EraStrategy`/`EraTreeAggregator` 段，约 430 行 |
| `examples/era/_era_support.py` | 695 | 通用部分（AST 门、程序提取、变异提示）留；任务部分（S3E1 分片、RMSE）换成 §3 的目标模型 |
| `examples/era/_era_runner.py` | 130 | **整份原样保留**，见 §8 |
| `examples/openevolve/openevolve_program_evolution.py` | 1,103 | 取 `OpenEvolveStrategy`/`Aggregator`/`Archive`/`EpsilonGreedy` 段，约 500 行 |
| `examples/openevolve/_openevolve_support.py` | 540 | 同上拆分 |
| `examples/openevolve/_openevolve_runner.py` | 145 | 整份保留 |
| `examples/_common.py` | 431 | 只取 `completion_for` 与预算换算 |
| `tests/test_era_example.py` · `test_openevolve_example.py` | 833 | **必须一起搬**，见 §12 |

`OpenEvolve` 的选择策略 `EpsilonGreedy` 也在示例里（不是包内具名策略），
所以两个算法的 vendor 边界不对称：ERA 只需搬树与聚合器，OpenEvolve 要连选择策略一起搬。

---

## 6. 引擎绑定：ERA（默认算法）

```python
result = evolve(
    build_tasks(gate_shards),          # 一个留出分片 = 一个 Task
    reward_program,                    # 1 / (1 + rmse)
    run=make_run(...),                 # 沙箱内训练 + 预测一个分片
    propose=make_propose(tree, ...),   # FlatPuct 选点 → 变异提示 → 新程序
    strategy=EraStrategy(),            # 单槽程序物，to_diff 带父节点树索引
    aggregator_factory=factory,        # EraTreeAggregator：执行、入树、提交 dev head
    blast_radius=0.6,                  # L1
    rounds=expansions // workers,
)
```

搜索规则：所有节点按分数排名，`rank_score = rank / (N−1)`（单节点取 0.5），
`puct = rank_score + c_puct · (1/N) · √(Σvisits) / (1 + visits)`，
`argmax(puct)` 在**全部节点**上取——没有从根往下的下降，这是「flat」的含义。

**四条不能为了「优化」而改的保真度要求**：

| 要求 | 为什么 |
|---|---|
| `c_puct = 1.0`、rank 归一化（含单节点 0.5）、先验 `P = 1/N` | 上游单元测试的 fixture 直接钉住 |
| **失败的扩展也要入树**（记 `-inf`） | 丢掉它会改变后续每一次迭代的排名分母与先验 |
| 访问数在**选择时**预留（虚拟损失），不是执行后回传 | 单提案时与上游等价；N 提案时不预留会让所有 worker 拿到同一个父节点 |
| 框架 reward 与指标排序严格一致（§3.3） | 否则树和接受门会对「哪个更好」分歧 |

**「按排名而非分值」是选它当默认的理由**：探索常数的含义与指标量纲无关，所以同一套默认参数
能同时用在 RMSE、准确率、对数似然上，不必为每个新指标重调参；而且一个 `-inf` 的失败候选
不会像原始分值那样把利用项压死。

---

## 7. 引擎绑定：OpenEvolve（第二算法）

```
OpenEvolveStrategy + OpenEvolveAggregator + OpenEvolveArchive + EpsilonGreedy
blast_radius=0.6   self_verify=False   eval_concurrency=workers   solved_threshold=1.0
```

| 参数 | 默认 | 说明 |
|---|---:|---|
| `islands` | 3 | 每岛一张 MAP-Elites 网格 |
| `feature_bins` | 4 | 固定长度分箱 + 插入时 token-Jaccard 多样性 |
| `exploitation_ratio` | 0.7 | `EpsilonGreedy` 的利用比例 |
| `migration_interval` | 4 | 环形迁移 |
| `archive_size` | 20 | |
| `max_code_length` | 20,000 | |
| `held_out_frac` | 0.5 | |
| `task_count` | ≥ 8 | 小于 8 时留出集不足 4 片 |

与 ERA 的形态差异：程序是**整文件重写**而非补丁，所以 token 需求高一档（§9）；
适用场景是「多目标 / 要看 Pareto 前沿 / 解空间宽需要质量多样性」，
而 ERA 适用「一批数据 + 一个标量指标」。

---

## 8. 起跑前校验

框架**不会**帮你拦这些。它只在收到空回复之后发 `RuntimeWarning`，而空回复在 ERA 里会被记成
一个 `-inf` 节点——**与「程序真的跑不起来」完全无法区分**。所以必须在创建 run 时校验：

| 校验 | era | openevolve | 不过怎么办 |
|---|---|---|---|
| `max_tokens` | ≥ 16000 | ≥ 32000 | 拒绝创建 run |
| `thinking` | 必须 disabled | 必须 disabled | 拒绝创建 run |
| `expansions % workers == 0` | 必须 | 必须 | 向导内挡住 |
| `gateShards ≥ 4` | 必须 | 必须 | 拒绝创建 run |
| 指标映射单调一致 | 必须 | 必须 | 拒绝创建 run |
| 量纲 · 重复性 · **判别力**（按评分模式，见 evolve-goal-scoring.md §6） | 必须 | 必须 | 拒绝创建 run |
| 沙箱后端可用 | 必须 | 必须 | 拒绝创建 run |

两个算法的 token 阈值不同：OpenEvolve 重写整个基因组，ERA 的程序更小。
thinking 开着会让推理模型把预算全花在隐藏思考上，回复空着回来。

---

## 9. 候选执行与沙箱

候选是**模型写的、未审查的代码**，而且 ERA 形态下它需要 pandas / numpy / scikit-learn ——
一个能读文件、能起进程的栈。**AST 门在这里不构成边界**：放行整个科学栈就等于放行了门本来要
拦的大部分东西。门还买到的是「普通事故（候选去 shell、调 `open`、碰 dunder）在进程内以可读
信息失败」。真正约束候选的是沙箱，两个后端都缺失时**拒绝启动而不是裸跑**。

方案：

```
执行     = vendored 沙箱（bwrap / sandbox-exec），不进 runner 队列
能力探测 = ScienceAgent 的 probeSandboxCapability（packages/sandbox-capability/src/index.ts）
产物     = CAS
```

三条理由：

1. **不能把接受门放进 runner 队列。** 每张存活的证据卡都要在留出分片上**重新完整执行**，
   而且跑在合并线程上——实测占一次 run 的 96% 墙钟。runner 是 `workerConcurrency: 1`
   （[server.ts:348](services/runner/src/server.ts:348)），演进的门会和用户手头的代码执行
   排同一条队，用户会看到自己的 cell 卡住几分钟。
2. **但沙箱后端的判断要用 ScienceAgent 那套。** Docker 里 bwrap 能做什么这个仓库已经踩完了
   （`disableUserns`、新建 procfs 被拒时回退 bind）。做法：Node 探测一次，把结果
   （后端名 + 是否需要 `--disable-userns` + procMode）随 `POST /evolve` 下发给侧车。
3. **`_era_runner.py` 整份保留，语义一个字不能改。** 里面有一条非显然的东西：`RLIMIT_CPU`
   按**跨线程累计的 CPU 秒**计，所以一个热心起了 8 线程的 OpenBLAS 会在 8 秒墙钟内烧掉
   60 秒预算，然后候选**因为跑得快而被杀**。端口为此把线程钉死（`OMP_NUM_THREADS=1` 及同类）。
   重写必炸，且症状伪装成候选质量问题。

代价写明：v1 的候选执行**不走 ScienceAgent 的权限系统**，产物是执行完之后才进 CAS。
等 runner 有了演进评测独立 lane，再把执行统一过去。

---

## 10. 第二种目标：agent 程序

用户那句「演进一个 code **或者 agent 程序**」的后半截，用包内 API，不需要 vendor：

| 目标 | 函数 | blast radius | 产物 |
|---|---|---|---|
| 技能目录 | `evolve_skill_dir(path, data, agent=…, layout="claude_skill")` | 0.2（L2） | skill revision |
| 子代理 / harness | 同函数，`layout="claude_agent"`（`evolve_agent_dir`） | 0.6（L1，强制 oracle） | skill revision |
| 代码树 + 测试门 | `evolve_agent_code(path, data, entrypoint=…, test_cmd=…, frozen=("tests/**",…))` | —— | CAS artifact |

`evolve_agent_code()` 是第三种形态、值得单独用的一种：它每次 rollout 物化候选、
**用原始内容覆盖所有 `frozen` 路径**、跑 `setup_cmd` 再跑 `test_cmd`，只有通过了才执行
`entrypoint + [task.prompt]`。测试门失败记 0 分，**失败文本就是反思器看到的东西**——
「你把测试跑挂了」变成学习信号而不是崩溃。
**当任务的正确性由测试定义而不是由标量指标定义时，用它而不是 ERA。**

落点是现成的：技能是不可变 revision，`skills/<id>/revisions/<n>/` + `revision.json`（含哈希），
与 AgentDescent 的 `LAYOUTS['claude_skill']`（`.claude/skills/<name>/`）天然同构，只需路径映射。

两条框架限制写进 UI 文案：**不支持文件重命名**（要删+建）、**不支持二进制文件**。
`TreeSpec.max_file_bytes` 取 28000（低于 aggregator 的 32000 信任域），别调高。

分期：`kind: "program"` 先做，`skill_dir` / `agent_dir` 跟在后面——它们的 rollout 必须走
ScienceAgent 的真实执行（权限、CAS、密钥），依赖 headless ephemeral run 那条接缝。

---

## 11. 治理

| 层 | 内容 | `/evolve` 里的体现 |
|---|---|---|
| **L0 冻结** | 权限系统、沙箱策略、审批逻辑、CAS/溯源、模型密钥、**指标定义**、预算 | `frozen=` 路径清单；设置页灰掉并注明「自演进永远无法修改」 |
| **L1 需批准** | 生成的程序（`blast_radius=0.6`）、子代理定义 | 产物不自动进工作区，要用户点「存为产物」 |
| **L2 可自动** | 用户自建技能 | 可开自动采纳，仍留审计与一键回滚 |

**无人值守的权限策略**：候选评测不弹权限卡片（没有在场的用户可以点）。
v1 的候选跑在 vendored 沙箱里，本来就没有网络、没有权限系统入口——这既是限制也是保护。
执行迁到 runner 之后要接非交互决策器：**任何新的权限请求一律拒绝并记为该候选失败。**

---

## 12. 预算与并发

程序演进比技能演进便宜得多——评测是跑程序不是调 agent。ERA 的量级参考：
6 次扩展 / 6 次模型调用 / 8,962 tokens / 99 秒模型时间 / 427 秒墙钟。默认值可以给得宽：

| 项 | 默认 |
|---|---:|
| 扩展次数 | 6 |
| worker | 3 |
| 评测并发 | 4 |
| 单候选超时 | 60s |
| wall clock 上限 | 1800s |
| token 上限 | 200k |

三条并发规则：

1. **worker 数不是杠杆。** 瓶颈在接受门的重新执行（96% 墙钟），可并行的只有模型调用
   （那 99 秒）。UI 上把 `workers` 放进高级设置，把 `eval-concurrency` 放到主面板，
   并在 `workers` 旁边直说「提高它几乎不会更快」。
2. **程序评测并发与技能 rollout 并发分开计。** 前者便宜可高，后者贵且抢用户执行槽。
3. **「仅空闲时演进」对程序演进不必强制**（它不占 runner 队列），但 token 与费用闸统一。

向导里就给预估：`扩展次数 × 一次变异的 token 估计 × 单价` + 预计时长
（用 `DurationEstimator` 在线校准）。超限自动停并保留 ledger 断点，`--resume` 可续。

---

## 13. 看板

> 组件落点、实时更新策略、状态矩阵与可达性见 [前端设计](evolve-frontend.md)；
> 本节只定四块的判据。

判据一句话：**不看日志就能判断这次为什么没变好。** 四块，缺一块达不到：

| 块 | 内容 | 为什么必须有 |
|---|---|---|
| **主图** | 三条线：rollout / 留出门 / 测试，**留出门加粗** | 留出门是搜索的排名依据，测试是唯一能对外说的数字 |
| **搜索结构** | ERA：树（节点标 visits / rank / 深度）· OpenEvolve：岛屿 + MAP-Elites 网格 | 异步会让树根重（第一轮在任何兄弟插入前就派发了多个提案，此时 `argmax(puct)` 只能返回根），所以深度必须与分数并列，不能塞进脚注 |
| **候选流水** | 每次扩展：选中了谁 → 变异摘要 → 分数 → 采纳/拒绝 + 原因 | 「模型返回空 → 记成 `-inf` 节点」必须在这里看得出来，否则与「程序跑不起来」无法区分 |
| **成本条** | token / 费用 / 时间 vs 上限；接受门耗时与 worker 饥饿时间单列 | 让用户看见时间花在门上，而不是怀疑系统卡了 |

程序代码本身要能 diff 查看——获胜程序常常从几百字符长到几千字符，这种增长要看得见。

---

## 14. 测试

**保真度测试必须跟着 vendor 一起搬。** 上游 `tests/test_era_example.py` 里有三个关键测试：
两个用上游 `futs_test.py` 的原始 fixture 钉住 rank 与 puct 公式，第三个
（`test_serial_tree_reproduces_upstream_futs`）用同一个 mock generator 与 executor 驱动
本端口的树和一份 `futs.search` 的逐行转写，断言每一步扩展同一个节点、最终访问向量相同。
搬代码不搬测试，等于把「benchmark-faithful」这个声明扔掉。

四个验收探针：

1. **端到端**：`/evolve` 一句话 → 起草 → baseline 试跑 → 若干次扩展 →
   测试分片上有可报告的提升 → 产物存进工作区。
2. **安全**：恶意候选（写沙箱外、开 socket、fork 炸弹、死循环）拦得住，
   而且**对着内核验证**而不是读回 profile（上游有这个测试，照搬）；
   两个后端都缺失时拒绝启动。
3. **配置**：§8 那张表的六条校验各有一个失败用例。特别是 thinking 开着必须拒绝启动。
4. **一致性**：同一候选在同一分片上重跑三次，指标方差在阈值内。程序演进的指标本该是确定性的，
   方差大说明评测环境有污染（随机种子、线程数，或候选在读它不该读的东西）。

---

## 15. 实现顺序

| # | 任务 | 完成判据 |
|---|---|---|
| **E1** | schema 与存储骨架（§4） | 类型编译通过；空数据目录能初始化 |
| **E2** | 侧车骨架 + **STUB 引擎** + `ThreadExecutor` 注释 | stack 起得来；STUB 端到端产出一个假产物 |
| **E3** | run 生命周期 + 统一事件模型 + NDJSON→SSE + Stop 贯通 | STUB 下前端收到完整事件序列；Stop 真中止且留断点 |
| **E4** | 模型代理 `/internal/evolve-llm/...` + 一次性 token + `metered()` 对账 | 一次真实 run 的花费出现在 model-usage 里，且与 `cost_summary()` 对得上 |
| **E5** | 目标模型：四要素、三段划分、指标映射单调性校验（§3） | 错的映射在开跑前被挡住 |
| **E6** | vendor ERA + 保真度测试搬迁（§5） | 上游三个保真度测试在仓内通过 |
| **E7** | 沙箱接缝：Node 探测 → 下发；vendored profile 执行；产物进 CAS（§9） | 探针 2 全通 |
| **E8** | 侧车绑定 ERA + §8 六条起跑校验 | 真实跑一轮有可报告提升；六条校验各有失败用例 |
| **E9** | `/evolve` 命令 + 向导（含起草 run 与 baseline 试跑） | 一句话目标能走到「开始演进」 |
| **E10** | 看板四块（§13） | 不看日志能判断一次 run 为什么没变好 |
| **E11** | 产物屏 + 存为工作区产物 + 代码 diff | 三个分数分开显示 |
| **E12** | 预算闸与费用预估（§12） | 注入假成本能触发停机；预估与实际同量级 |
| **E13** | vendor OpenEvolve + 岛屿/MAP-Elites 视图 + 第二算法 | 上游测试通过；组合分显著上升 |
| **E14** | `evolve_agent_code` 目标（测试门形态，§10） | 测试挂了记 0 分且失败文本进了反思上下文 |
| **E15** | `skill_dir` / `agent_dir` 目标 | 采纳后新会话真的用上新 revision；一键回滚有审计 |

```
E1 ──┬── E2 ── E4
     ├── E3
     └── E5 ── E6 ── E7 ── E8 ──┬── E9 ── E10 ── E11     ← 里程碑：第一次真实演进
                                └── E12
                                     E13 · E14 · E15
```

里程碑在 E11：那时 `/evolve` 已经能对着一个真实数据集跑出可报告的提升。
OpenEvolve（E13）是第二算法，不在关键路径上。

---

## 16. 待定

1. **候选执行的沙箱归属**（§9）。建议 vendored 沙箱 + ScienceAgent 能力探测的混合方案，
   代价是 v1 候选执行不走权限系统。替代方案是先给 runner 加一条演进评测独立 lane
   ——工作量落在 runner 上，但一次解决。
2. ~~**默认预设**~~ **已定**：一套 run 子系统，算法是目标模型里的字段，默认 `era`；
   `/era` / `/openevolve` 是同一向导的别名入口（§2）。
3. **vendor 还是 submodule**。约 3,500 行示例代码 + 833 行测试，随上游演进。
   建议 vendor 并记录上游 commit（示例文件本来就不承诺 API 稳定），代价是上游修 bug 要手动同步。
4. **`/evolve <一句话>` 能不能直接起跑**。建议不能，必须过向导 + baseline 试跑（§1）。
5. **产物默认落哪**。建议 CAS artifact + 项目产物，不自动写工作区（L1 要人点一下）。
   要不要给「自动写入工作区」开关？
6. **要不要第三个算法 GEPA**（反思式提示优化）。它优化的是单个提示，与 `/evolve`
   「演进程序」的心智模型不同，建议不进 `/evolve`，另开入口。
