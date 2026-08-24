# 打分标准（评分卡）—— 从目标生成，用于接受判断

用户只给一个目标。系统要据此**制定一套打分标准**：几条判据、各自的权重、若干条不可逾越的
否决项。这套标准既给候选排名，也决定一次合入**接不接受**。

> 与另外两份的分工：evolve-goal-scoring.md 定义**分从哪来**（四种测量方式：数据集指标 /
> 测试门 / 评分脚本 / LLM 评审）；**本文定义分怎么组成、谁来定、以及它如何变成接受或拒绝的判断**。
> 一条判据的 `measure` 就是那四种之一。

---

## 1. 打分标准 = 一张评分卡

```
Scorecard
 ├─ 判据 criteria[]      名字 · 测量方式 · 方向 · 归一化 · 权重
 ├─ 否决项 constraints[]  硬性：违反即不合入（不是扣分）
 ├─ 聚合规则             加权和（默认）/ 加权几何平均（不许有短板）
 └─ 元信息               从哪句目标推出、谁确认的、冻结哈希
```

从「把细胞类型分类准确率做上去，别太慢，也别把稀有类型丢了」推出来的一张卡：

| 判据 | 测量 | 方向 | 归一化 | 权重 |
|---|---|---|---|---:|
| 宏 F1 | `dataset_metric` | max | identity | 0.6 |
| 稀有类召回 | `custom_script` | max | identity | 0.3 |
| 训练时长 | `dataset_metric`(runtime) | min | 相对 baseline | 0.1 |

| 否决项 | 判据 | 条件 |
|---|---|---|
| 太慢 | 训练时长 | `> 300s` |
| 牺牲稀有类 | 稀有类召回 | `< baseline × 0.8` |
| 测试挂了 | 测试门 | 必须通过 |

**否决项为什么不能折进权重。** 权重表达"多重要"，否决表达"绝不接受"。
把「不许比 baseline 慢两倍」写成 −0.2 的权重，搜索会算这笔账：多拿 0.3 的 F1，慢三倍也划算。
一个能被交易掉的约束不是约束。

---

## 2. 两条通路：排名用标量，接受用标量 + 否决

```
候选 ──▶ 每条判据在分片上测量 ──▶ 归一化 ──▶ 加权聚合 ──▶ reward ∈ [0,1] ──▶ 搜索排名（树 / 岛屿）
                    │                                                      └──▶ 统计接受门（Beta 后验）
                    └──▶ 每维原始数值 ─────────────────────────────────────▶ 否决项判断
```

引擎的 reward 契约是**一个标量**，这条不可协商：排名、Beta 后验、`solved` 判定全靠它。
所以否决项不能挤进 reward，只能走接受策略。

### 2.1 `ScorecardAcceptance`：包装，不替换

照 `AdvantageAcceptance(inner, strength)` 的形态——上游注释把理由写死了：
*wraps rather than replaces：Beta 检验、回归护栏和它们的历史原样保留；
替换会悄悄丢掉这些护栏，「a codebase forgets what it paid to learn」*。

```python
class ScorecardAcceptance:
    """先查否决项，再 defer 给 inner。否决改的是合不合入，不是排名。"""

    def __init__(self, inner, scorecard, metrics_cache) -> None:
        self.inner, self.card, self.cache = inner, scorecard, metrics_cache

    def accept(self, ctx: MergeContext) -> AcceptDecision:
        # 每维原始数值按 (候选内容哈希, 全量留出集) 从评测缓存取 —— 不重算。
        violated = self.card.violations(self.cache.full(ctx.candidate))
        if violated:
            return AcceptDecision(accept=False, category="constraint-violated",
                                  detail=violated[0].explain(),
                                  observed_delta=self.card.delta(ctx))
        return self.inner.accept(ctx)
```

三条要点：

1. **`category` 不是装饰。** 上游写得很清楚：「门说这些提案没用」和「它们根本没到门口」
   需要相反的修复，布尔值表达不了。我们新增的 `constraint-violated` 是第三种，
   看板与图上必须与 `below-threshold` 分开显示（§8）。
2. **否决必须读全量留出集。** `MergeContext` 把 `base_counts`/`cand_counts`（全量）与
   `base_cheap`/`cand_cheap`（子采样）分成不同字段，正是因为这个 bug 上游已经犯过一次：
   回归护栏读了 cheap 层，于是调小 `cheap_eval_tasks` 会让「质量下降」这个判断出自一个
   四任务样本。**排名可以用 cheap 数，决定合入不行。**
3. **每维数值从哪来。** `EvidenceCard` 没有自由的 metrics 字段，`MergeContext` 只给标量
   `(successes, failures)`。所以由我们的评测器按 **(候选内容哈希, 分片)** 缓存每维原始数值
   （与框架 `evalcache` 同一套 key 思路），策略按哈希查。
   **不要为了塞多维数据去改框架的数据类**——那是 vendor 分叉的开始。

### 2.2 为什么不把否决写成"违反就给 0 分"

所有违规候选并列 0，树就没有梯度了：ERA 的利用项是**按排名**的，一堆 0 会把它压死；
而且「跑挂了」和「违规但很有前途」变得无法区分——后者恰恰是最该被反思器看见的那类候选。
**违规候选照常拿它的分、照常进树、照常可被选中扩展，只是不许合入。**

---

## 3. 归一化：每条判据到 `[0,1]`

| 指标形态 | 归一化 |
|---|---|
| 有界且越大越好（准确率、F1、召回） | `identity` |
| 无界且越小越好（RMSE、时长、内存） | `1/(1+x)` 或 **相对 baseline**：`clamp(baseline/x, 0, 1)` |
| 有界且越小越好 | `1 − x/max` |
| 布尔（测试通过） | `0 / 1` |

两条硬规则：

1. **必须单调**——否则卡的排序与用户的偏好会打架（evolve-command.md §3.3 的老问题，
   现在是每条判据都要过一遍）。
2. **参照物固定为 baseline，不能用"当前最优"。** 用当前最优的话，分数会随搜索漂移：
   昨天的 0.8 和今天的 0.8 不是一回事，接受门的先验会被污染，回放同一批候选也得不到同样的分。

---

## 4. 聚合：加权和还是几何平均

| 规则 | 行为 | 什么时候用 |
|---|---|---|
| 加权和（默认） | 可解释、可交易：一维弱可以被另一维补回来 | 多数情况 |
| 加权几何平均 | 任何一维接近 0 都把总分拉到 0 | 「不许有短板」 |

建议：默认加权和；当用户目标里出现「同时 / 兼顾 / 不能牺牲」这类词时，
起草 agent **主动提议**几何平均并说明差别——这是它最该给出的判断之一。

---

## 5. 谁来制定：起草 → 确认 → 冻结

### 5.1 起草 agent 的输出是**整张卡**，不是一句指标

输入：目标那句话 · 工作区 · 数据抽样 · baseline。
输出：**2–3 张完整评分卡并排**，每张带判据、权重、否决项、理由，以及最关键的一句：
**这张卡会让搜索偏向什么。**

> 「卡 A 奖励更复杂的模型：F1 权重 0.6 而时长只有 0.1，搜索大概率会往集成方法走。
> 如果你在意推理成本，选卡 B（时长 0.3 + 300s 否决）。」

用户没有能力判断一张卡对不对，但**有能力在两张卡之间选**——尤其当每张都标出了它的偏向。

### 5.2 确认：权重是滑块，否决项是开关

- 拖动权重实时显示：**用这张卡重排，baseline 与试跑候选的相对次序会不会变**。
  这是唯一能让用户直观理解权重后果的反馈。
- **至少一条否决项**，默认给两条：不许比 baseline 差、必须在超时内跑完。

### 5.3 冻结

确认后整张卡取哈希进 L0 冻结集，run 期间不可改。**改卡 = 新 run**——
旧 run 的分数与新卡不可比，续跑也不行（`--resume` 校验卡哈希，不一致直接拒绝）。

理由还是上游那句：能改写"判断它的东西"的产物，是结构性事实，不是测量出来的。

---

## 6. 一次合入要过四关

看板必须能分别显示卡在哪一关——这四关的修复方向完全不同：

| # | 关卡 | 谁 | 拒绝时 | 该怎么修 |
|---|---|---|---|---|
| 1 | 信任域 | `TrustRegion` | 卡片没到门口 | diff 太大，调 `trust_region_ops` 或让反思器改小 |
| 2 | 陈旧度 | staleness policy | 卡片没到门口 | 基版本漂移，调 `async_ratio` / 换 staleness 策略 |
| 3 | **否决项** | `ScorecardAcceptance`（新增） | `constraint-violated` | **卡的问题或候选的问题**——看是哪条被触发 |
| 4 | 统计接受 | `DefaultAcceptance` | `below-threshold` | 提升不显著；加预算或改判据 |

L1（`blast_radius=0.6`，程序演进就是）在 4 之上还有 oracle 强制。

---

## 7. 数据模型

```ts
export interface ScorecardCriterion {
  id: string;
  name: string;
  /** 四种测量方式之一，定义见 evolve-goal-scoring.md §3。 */
  measure: EvolveScoring;
  direction: "minimize" | "maximize";
  normalize:
    | { kind: "identity" }
    | { kind: "reciprocal" }
    | { kind: "relative_to_baseline" }       // clamp(baseline/x, 0, 1)
    | { kind: "clamp"; lo: number; hi: number };
  weight: number;                            // 归一后和为 1
}

export interface ScorecardConstraint {
  id: string;
  name: string;
  criterionId: string;
  op: "<" | "<=" | ">" | ">=";
  value: number | { relativeToBaseline: number };
  severity: "veto";                          // v1 只有 veto
}

export interface EvolveScorecard {
  schemaVersion: 1;
  criteria: ScorecardCriterion[];
  constraints: ScorecardConstraint[];
  aggregate: "weighted_sum" | "weighted_geomean";
  solvedThreshold: number;                   // 按最"软"的那条判据定，见 evolve-goal-scoring §3
  hash: string;                              // L0 冻结用；--resume 校验
  derivedFrom: { statement: string; draftRunId: string };
  confirmedBy: string; confirmedAt: string;  // 事后复盘"这卡是谁定的"
}
```

`EvolveGoal.scoring: EvolveScoring` 改为 **`scorecard: EvolveScorecard`**。
单指标就是 `criteria.length === 1` 的退化情形——**不要为"简单情况"留第二条代码路径**，
两条路径会立刻在归一化与冻结这两件事上分叉。

---

## 8. 校验（起跑前）

在 evolve-goal-scoring.md §6 那张表之上，整卡再加五条：

| 校验 | 不过怎么办 |
|---|---|
| 权重和为 1（或自动归一并提示） | 提示 |
| 每条判据在 baseline 上都测得出数 | 测不出的判据直接删，**不许留占位** |
| **整卡判别力**：baseline 与劣化样本的**总分**必须不同 | 拒绝创建 run |
| **baseline 自己必须通过全部否决项** | 拒绝创建 run |
| 归一化参照物是 baseline 且已随卡冻结 | 拒绝创建 run |
| 从产物起跑时，评测输入的产物版本已钉死 | 拒绝创建 run —— 输入版本浮动的话，"提升"可能来自数据变了 |

两条值得单独说：

- **整卡判别力**：单条判据有区分度，加权之后被抹平，是真实存在的情形
  （权重 0.05 的那维再灵敏也没用）。所以判别力探针要按**总分**验，不是按维验。
- **baseline 自违规**是最常见的配置错误：用户把否决项设得比现状还严
  （「训练不许超过 60 秒」而 baseline 要 90 秒），于是搜索第一步就无法接受任何东西，
  跑完一整轮预算、看板上全是 `constraint-violated`。这个必须在起跑前就说清楚：
  **「你的 baseline 现在就违反了『太慢』这条，先改约束或先优化它」。**

---

## 9. 看板与落图

- **候选详情**：分维条形图（每条判据的原始值 + 归一值 + 权重贡献）+ 总分 +
  触发了哪条否决项。只给总分的话，用户看不出"它是被时长否掉的"。
- **候选流水**的拒绝原因必须三分：`constraint-violated` / `below-threshold` /
  没到门口（信任域或陈旧度）。
- **落图**（evolve-search-graph.md §1.2 的平铺原则）：`SearchNode` 加
  `scorecard_hash` · 每维分数平铺成 `crit_<id>` · `rejected_by`（否决项 id）。
  于是图上能直接问：**哪些候选是被时长否掉的**、换一张卡的话哪些本来能合入。

---

## 10. 测试

| # | 探针 | 判据 |
|---|---|---|
| 1 | **否决不改排名** | 注入一批"违规但高分"的候选：树的 rank 顺序与关掉否决时**完全一致**，但它们一个都没合入 |
| 2 | **否决读全量** | `cheap_eval_tasks` 从全量调到 2，否决判定结果不变 |
| 3 | **baseline 自违规** | 起跑前被拒，且提示指名是哪条约束 |
| 4 | **整卡判别力** | 单维有区分但权重 0.02 → 总分相同 → 起跑前被拒 |
| 5 | **卡冻结** | run 中改卡被拒；`--resume` 卡哈希不一致被拒 |
| 6 | **category 三分** | 三种拒绝在事件流、看板、图上都分得开 |
| 7 | **参照物固定** | 搜索中最优提升后回放同一批早期候选，得到**同样的分** |
| 8 | **几何平均** | 一维为 0 时总分为 0；加权和下同一候选总分 > 0 |

---

## 11. 实现顺序

| # | 任务 | 完成判据 | 依赖 |
|---|---|---|---|
| **C1** | `EvolveScorecard` 类型 + 归一化/聚合纯函数 + 单测 | 探针 7、8 | S1 |
| **C2** | 评测器缓存每维原始数值（(候选哈希, 分片) key） | 同一候选重复评测只算一次；每维可查 | S2 |
| **C3** | `ScorecardAcceptance`（包装 `DefaultAcceptance`）+ `constraint-violated` | 探针 1、2 | C2 |
| **C4** | 起跑前整卡校验五条 | 探针 3、4 | C1 |
| **C5** | 起草 agent 产出 2–3 张完整卡 + 偏向说明 | 用户能在两张卡之间选，每张都有 baseline 实测数 | S7 |
| **C6** | 权重滑块 + 重排预览 + 分维详情 + 三分拒绝原因 | 探针 6；不看日志能说出"它被哪条否了" | F5/F6 |
| **C7** | 落图：`scorecard_hash` / `crit_<id>` / `rejected_by` | 图上能查"被时长否掉的候选" | G2 |

```
C1 ── C2 ── C3 ──┬── C6
      └── C4 ── C5 ── C6
                 C7（跟 G2）
```

**里程碑在 C3**：那时"目标 → 卡 → 排名 → 否决 → 接受"这条链第一次完整跑通，
而卡还可以是手写的 JSON——C5 的起草是体验，C3 才是机制。

---

## 12. 待定

1. **否决项要不要软等级**（`severity: "veto" | "warn"`）。建议 v1 只有 veto：
   warn 会立刻变成"没人看的黄条"，而它想表达的东西其实是"权重"。
2. **判据数量上限**。建议 ≤ 5：每加一条判据，每个候选的评测成本按维数线性涨，
   而接受门要的是全量留出集。
3. **允不允许用户直接写聚合表达式**（而不是选加权和/几何平均）。建议不允许：
   一个可执行的表达式就是第五种评分模式，且必然要进沙箱与冻结体系。
4. **`solvedThreshold` 按整卡怎么定**。建议取所有判据里最"软"的那条的阈值
   （有一条 LLM 评审就按 0.85 走），但这会让纯确定性判据也变松——待评审。
