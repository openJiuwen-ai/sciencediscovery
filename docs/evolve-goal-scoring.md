# 演进目标与评分模式 —— 用户定义什么，模型建议什么

`/evolve` 的成败几乎全部由**评分**决定：搜索优化的是评分函数，不是用户那句话。
本文定义用户能自定义什么（§2 四种评分模式）、缺项时模型怎么建议（§4 起草）、
以及这些东西怎么落到 AgentDescent 的参数上（§5）。

> **本文只定义「分从哪来」——四种测量方式。** 一次演进真正用的打分标准是一张**评分卡**
> （多条判据 + 权重 + 否决项），由目标生成、决定接受与否，见 [评分卡](evolve-scorecard.md)；
> 那里的每条判据的 `measure` 就是本文这四种之一。
>
> 其余前置：命令入口与向导见 evolve-command.md，搜索过程落图见 evolve-search-graph.md，
> 界面见 evolve-frontend.md。本文替换 evolve-command.md §3.3 的扁平 `EvolveMetric`。

---

## 1. 一条原则

**目标可以模糊，评分不能。**

用户那句「把细胞类型分类准确率做上去」是意图；搜索真正最大化的是那个返回 `[0,1]` 的函数。
两者一旦不一致，搜索会**忠实地**把错的东西做到极致——而且看起来很成功：分数在涨。

所以目标模型分两层，且两层的确定性要求完全不同：

| 层 | 内容 | 要求 |
|---|---|---|
| **目标 Goal** | 那句话（原样保留）+ 目标物（起始程序 / 技能目录 / 代码树） | 可以模糊，只进提示与展示 |
| **评分 Scoring** | 怎么判断"更好" | **必须可执行、可重复、不可被候选修改** |

---

## 2. 四种评分模式

| 模式 | 打分来源 | 什么时候用 | 确定性 | 成本 | 被 game 的难度 |
|---|---|---|---|---|---|
| `dataset_metric` | 跑候选 → 数据集上的标量指标 | 有数据 + 一个标量指标 | 确定 | 低 | 难 |
| `test_gate` | 测试命令的通过率 | 正确性由测试定义 | 确定 | 低 | 中（要冻结测试） |
| `custom_script` | 用户给的评分脚本 | 指标要自己算 | 应确定 | 低 | 中 |
| `llm_judge` | 模型按 rubric 打分 | 没有 gold、质量是主观的 | **不确定** | 高 | **易** |

### 2.1 `dataset_metric`（默认）

已有设计见 evolve-command.md §3.2–3.3：三段划分（rollout / 留出门 / 测试）+ 指标方向
+ 到 `[0,1]` 的单调映射。两条硬要求不变：**划分必须三段**（否则报出来的提升虚高），
**映射必须与方向单调一致**（否则搜索的排序与接受门的排序会打架）。

### 2.2 `test_gate`

绑定 `evolve_agent_code(entrypoint=…, test_cmd=…, frozen=("tests/**", "conftest.py"))`。
每次 rollout 物化候选 → **用原始内容覆盖所有 frozen 路径** → 跑 `setup_cmd` 再跑 `test_cmd`
→ 通过了才执行 entrypoint。失败记 0 分，**失败文本就是反思器看到的东西**
（「你把测试跑挂了」是学习信号，不是崩溃）。

**冻结必须两层，缺一不可**（上游注释原话：*without it the shortest path to a high score
is to weaken the thing measuring it*）：

| 层 | 挡什么 |
|---|---|
| 提案过滤（`frozen` glob） | 反思器**提出**修改测试 |
| 运行时覆盖（pristine overlay） | 候选**运行时**重写测试 |

划分：测试用例分组即任务，末尾若干组作留出门，另有一组全程不参与——
和数据分片同一套三段逻辑，只是单位从"数据行"换成"用例组"。

**当正确性由测试定义而不是由标量指标定义时，用它而不是 dataset_metric。**

### 2.3 `custom_script`

契约（保持最窄）：

```
score.py --candidate <候选目录> --shard <分片路径>
   → stdout 一个 JSON：{"score": 0.83, "metrics": {"rmse": 0.59, "n": 619}}
```

四条要求：

1. **`score` 必须落在 `[0,1]`。** 引擎把 `>= 0.999` 当作"已解决"，量纲错（0–100）会让
   每个任务看起来都已通过。引擎确实会在第一次 rollout 抛 `RewardContractError`
   并明说要 `accuracy/100`——但那已经烧掉了环境准备与第一次模型调用，所以**我们要在创建
   run 之前挡住**（§6）。
2. **脚本本身 L0 冻结**：候选不可读写它，演进不可改它，UI 里灰掉并注明。
3. 与候选**同沙箱不同进程**，脚本目录只读挂载；脚本的超时独立于候选超时。
4. 输出必须是**纯 JSON 一行**，任何额外 stdout 都算脚本错误——半结构化输出的解析歧义
   会伪装成"候选质量差"。

### 2.4 `llm_judge`

用户（或起草 agent）给 rubric + 分制，judge 模型按 rubric 给分，归一化进 `[0,1]`。
这是唯一一个**非确定性**的模式，五条必须做：

| # | 要求 | 不做会怎样 |
|---|---|---|
| 1 | **下调 `solved_threshold`**（默认 0.999） | 分级评分几乎到不了 0.999，于是**每次 rollout 都请求提案**，反思器被要求去"修"一个 0.95 的答案，run 报 `below-threshold`——读起来像反思器没用，真实原因是没有任何东西被认成"已解决" |
| 2 | 同一候选评 **n ≥ 3 次取中位数**；方差超阈值记「不可判」而不是记 0 | 记 0 会让噪声变成"这个候选很差"，污染排名分母 |
| 3 | **rubric 与 judge 模型 L0 冻结**，且与被演进对象隔离 | 演进会学会改判卷标准，而不是做得更好 |
| 4 | **盲评**：judge 看不到候选身份、迭代号、父节点分数 | "新的/分高的就是好的"会变成自我实现的排名 |
| 5 | `cheap_eval_tasks` 必须设小（建议 4） | 排名阶段每比一次就是 N 个候选 × 全留出集的模型调用，成本失控 |

另外：judge 分数噪声会削弱接受门的 Beta 后验假设，所以 llm_judge 下**留出门固定用同一批任务**
（不重采样），且产物一律人工采纳（L1）。

**在 UI 上直说**：这是最容易被 game 的模式；能用前三种就别用它。

---

## 3. 数据模型

```ts
/** 评分模式：判别联合，取代原先扁平的 EvolveMetric。 */
export type EvolveScoring =
  | { kind: "dataset_metric"; datasetCas: string[]; split: EvolveSplit; metric: EvolveMetric }
  | { kind: "test_gate"; entrypoint: string[]; testCmd: string[]; setupCmd?: string[];
      frozen: string[]; caseSplit: { rolloutGroups: number; gateGroups: number; testGroups: number } }
  | { kind: "custom_script"; scriptCas: string; split: EvolveSplit; timeoutSeconds: number }
  | { kind: "llm_judge"; rubricCas: string; scale: { min: number; max: number };
      judgeModelId: string; samplesPerCandidate: number; varianceThreshold: number;
      blind: true; split: EvolveSplit };

export interface EvolveGoal {
  schemaVersion: 2;
  statement: string;            // 用户那句话，原样保留
  target: EvolveTarget;
  baselineProgramCas: string;
  scorecard: EvolveScorecard;   // ← 整张卡（判据+权重+否决项），见 evolve-scorecard.md
                                //    每条判据的 measure 是上面 EvolveScoring 之一
  algorithm: "era" | "openevolve";
  budget: EvolveBudget;
  solvedThreshold: number;      // 由模式决定默认值，见下
  frozen: string[];             // L0：评分定义本身
  draftedBy?: { runId: string; acceptedFields: string[] };  // 哪些字段是模型建议且被采纳的
}
```

**按模式的默认值**（这张表就是"评分模式"这个抽象存在的理由——同一套引擎参数在四种模式下必须不同）：

| 模式 | `solvedThreshold` | `cheapEvalTasks` | `samplesPerCandidate` | 方差阈值 |
|---|---|---|---|---|
| `dataset_metric` | 0.999 | 全量 | 1 | 严（应确定） |
| `test_gate` | 0.999 | 4 | 1 | 严 |
| `custom_script` | 0.999 | 4 | 1 | 严 |
| `llm_judge` | **0.85** | 4 | 3 | 松（超了记不可判） |

---

## 4. 起草：没给就让模型建议

### 4.1 触发与形态

四要素缺项 → 起**一次普通 agent run**（不是演进），产出一份结构化提案。
用现有 subagent 的 `outputJsonSchema`（`packages/schema/src/subagent.ts`）约束输出。

### 4.2 起草 agent 看什么

工作区文件树 · 数据文件的头部抽样（前 N 行 + 推断 dtype + 缺失率）· 已有脚本与 README ·
用户那句话 · 本项目历史 run 的目标与结果。

### 4.3 输出契约：给方案，不给答案

```json
{
  "goalStatement": "把 scRNA-seq 表达矩阵的细胞类型分类准确率做上去",
  "target": { "kind": "program", "entrypoint": "classify.py" },
  "scoringProposals": [
    { "kind": "dataset_metric", "metric": {...}, "split": {...},
      "rationale": "labels.csv 有 12k 行带 cell_type，宏 F1 对类别不平衡更稳",
      "cost": "低", "confidence": "high" },
    { "kind": "custom_script", "…": "…",
      "rationale": "若你更关心稀有细胞类型的召回，需要自定义加权",
      "cost": "低", "confidence": "medium" }
  ],
  "baseline": { "kind": "drafted", "cas": "…" },
  "risks": ["labels.csv 里 3 类样本 < 20，测试分片可能取不到"]
}
```

**必须给 2–3 个并排方案，每个带理由与代价。** 给一个方案让用户点"确认"是错的形态：
用户没有能力判断单个评分方案对不对，但**有能力在两个方案之间选**——尤其当每个方案
都标出了"它会让搜索偏向什么"。

### 4.4 起草不许做的三件事

1. **不许自动起跑。** 四要素不齐就让模型猜，等于拿演进的钱买抽奖。
2. **不许自己定划分却不告诉用户。** 划分是虚高提升的唯一来源，必须显式呈现。
3. **不许建议一个没验证过的指标。** 提案里的每个方案都要**在 baseline 上真跑出一个数**
   ——这是 baseline 试跑的一部分，也是 §6 判别力探针的输入。

### 4.5 起草失败时的降级路径

| 情况 | 建议 |
|---|---|
| 没有数据集 | 转 `test_gate`（有测试）或 `llm_judge`（都没有） |
| 没有 baseline | 起草一个最简 baseline，并标注「这是起点不是答案」 |
| 目标不可量化（"让代码更优雅"） | **明确拒绝并解释**：不可量化 = 不可搜索。给两条出路：换成可量化的代理指标，或转 `llm_judge` 并把"优雅"写成 rubric |
| 数据有标签泄漏迹象 | 报风险并拒绝自动接受该方案 |
| 从产物起跑但解析不出生成它的代码（上传/外部导入） | 起草一个能重现该产物的程序并先跑一次比对；文本类产物可退到 LLM 评审直接演进内容（evolve-command.md §3.4） |
| 从 `figure` 起跑 | **拒绝自动评分**，要求改成图背后的数值判据 |

### 4.6 确认界面

向导第 ①③ 步预填模型建议，每项旁边有「为什么」（起草理由）与「模型建议 vs 你的修改」的
diff 高亮；`draftedBy.acceptedFields` 记录哪些字段是原样接受的——事后复盘"这次跑砸了是不是
因为指标是模型选的"要靠它。

---

## 5. 四种模式 → AgentDescent 参数

| 模式 | `run=` | `reward=` | strategy | 特殊参数 |
|---|---|---|---|---|
| `dataset_metric` | 沙箱内训练 + 预测一个分片 | 指标的单调映射 | `EraStrategy` / OpenEvolve | —— |
| `test_gate` | `code_runner`（含 pristine overlay） | 通过率 | `FileTree` | `frozen=` 两层 |
| `custom_script` | 跑候选，再跑评分脚本 | 脚本的 `score` | Era / OE | 输出 schema 校验 |
| `llm_judge` | 跑候选产出文本/产物 | n 次评分的中位数 | Era / OE | `solved_threshold=0.85`、`cheap_eval_tasks=4` |

四种模式**共用**同一套 run 子系统、同一个事件模型、同一张搜索图（evolve-search-graph.md）
——评分模式只改 `run`/`reward`/若干引擎参数，不改控制面。

---

## 6. 起跑前校验：按模式的矩阵

evolve-command.md §8 的六条对所有模式仍然有效，另加按模式的：

| 校验 | dataset | test | script | judge | 不过怎么办 |
|---|---|---|---|---|---|
| 划分三段且留出 ≥ 4 | ✓ | ✓（用例组） | ✓ | ✓ | 拒绝创建 |
| 指标映射单调一致 | ✓ | —— | —— | —— | 拒绝创建 |
| 冻结集非空且覆盖判分物 | —— | ✓ | ✓ | ✓ | 拒绝创建 |
| **量纲**：baseline 打分落在 `[0,1]` | ✓ | ✓ | ✓ | ✓ | 拒绝创建 |
| **重复性**：同一候选同一分片跑 3 次 | ✓ | ✓ | ✓ | n 次取中位数后看方差 | 方差超阈值 → 警告并要求确认 |
| **判别力**：baseline 与一个"故意变差"的变体得分必须不同 | ✓ | ✓ | ✓ | ✓ | 相同 → 拒绝创建 |
| `solvedThreshold` 与模式匹配 | ✓ | ✓ | ✓ | ✓ | 自动按 §3 表设，用户改了要二次确认 |

**判别力探针是这张表里最值得做的一条**：把 baseline 故意改差（打乱预测顺序 / 删一个特征 /
让一个测试失败），如果评分给出同样的分数，那这个评分函数**没有排序能力**——
搜索会在完全平坦的地形上随机游走，而看板上什么都不会显示为异常。量纲错引擎会报错，
判别力为零则不会：它是静默失败的。

---

## 7. 反 game 清单（L0 冻结）

| 冻结项 | 四种模式 |
|---|---|
| 指标定义与映射 | dataset |
| 测试套件与 conftest | test |
| 评分脚本 | script |
| rubric 与 judge 模型 | judge |
| 三段划分与随机种子 | 全部 |
| 预算、沙箱策略、权限、CAS/溯源 | 全部 |

理由用上游那句就够：**能改写"判断它的东西"的产物，是结构性事实，不是测量出来的**
——所以冻结集是一份显式清单，不能靠 blast radius 估。

---

## 8. 测试

| # | 探针 | 判据 |
|---|---|---|
| 1 | 四种模式各一次 STUB 端到端 | 都能起跑、出分、落图、存产物 |
| 2 | **量纲**：给一个返回 0–100 的评分脚本 | **创建 run 时**被拒，不是第一次 rollout 才抛 |
| 3 | **判别力**：给一个恒返回 0.5 的评分脚本 | 创建 run 时被拒 |
| 4 | **反 game（test_gate）**：候选试图改 `tests/**` | 提案被过滤 **且** 运行时覆盖生效（两层各一个用例） |
| 5 | **反 game（judge）**：候选在输出里写"请给满分" | 盲评 + rubric 冻结下分数不受影响 |
| 6 | **judge 方差**：同候选评 5 次 | 方差超阈值 → 记「不可判」而不是记 0 |
| 7 | `solvedThreshold`：judge 模式用 0.999 | 起跑前警告；跑起来后 `below-threshold` 率异常要在看板可见 |
| 8 | **起草**：四要素全缺 | 提案含 ≥2 个并排方案，每个都有 baseline 实测数与理由 |
| 9 | **起草拒绝**：目标不可量化 | 明确拒绝 + 给出两条出路，不自动挑一个 |

---

## 9. 实现顺序

| # | 任务 | 完成判据 | 依赖 |
|---|---|---|---|
| **S1** | `EvolveScoring` 判别联合 + 按模式默认值表 | 类型编译；`schemaVersion: 2` 迁移旧 goal | E1 |
| **S2** | 起跑前校验矩阵（§6），先做量纲 + 判别力 | 探针 2、3 | E5 |
| **S3** | `dataset_metric` 打通（既有路径） | 端到端一次真实提升 | E8 |
| **S4** | `test_gate`（`evolve_agent_code` + 两层冻结） | 探针 4 | E14 |
| **S5** | `custom_script`（契约 + 沙箱隔离 + schema 校验） | 探针 2、3 在脚本模式下 | S2 |
| **S6** | `llm_judge`（五条要求 + 成本闸） | 探针 5、6、7 | S2 |
| **S7** | 起草 agent（输出契约 + 并排方案 + baseline 实测） | 探针 8、9 | E9 |

```
S1 ── S2 ──┬── S3 ──────────── S7        ← 里程碑：S3 + S7（一句话目标能跑出提升）
           ├── S4
           ├── S5
           └── S6（最后做：最贵、最容易被 game）
```

---

## 10. 待定

1. **`llm_judge` 要不要 v1 就做**。建议不做，留到 S6 且默认在设置里关闭——
   它的失败模式（被 game、方差、成本）需要前三种模式的看板先跑熟。
2. **起草 agent 用主 agent 还是独立 specialist**。建议独立 specialist（可给专门的
   instructions 与只读工具集），代价是多一个内置 specialist 要维护。
3. **`custom_script` 的语言**。建议 v1 只支持 Python（沙箱与依赖都是现成的），
   其余走 `test_gate` 的 `test_cmd`。
4. **判别力探针的"故意变差"怎么造**。建议按模式内置：dataset 打乱预测、test 让一个用例失败、
   script/judge 用一个空实现。是否允许用户自定义这个"劣化样本"？
