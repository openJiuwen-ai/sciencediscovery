# 自演进（RSI）完整实现设计

> **与源码核对后有六处架构性修正**，见
> [self-evolution-internals.md §0](self-evolution-internals.md#0-与源码核对后的修正)。
> 本文已同步，但那一节记录了为什么。

本文是自演进能力的**实现规格**：数据模型、存储、接口、服务、算法、前端、测试与分期。
产品与用户视角（为什么这么做、用户看到什么）见 [self-evolution.md](self-evolution.md)，
本文不重复论证，只在需要时引用其小节号。

后端演进循环由 [AgentDescent](https://github.com/Birfy/agentdescent) 承担；
Node 控制面继续独占治理、真实执行与溯源。

---

## 1. 范围

**做**：便签与 T0 注入、Episode 沉淀、题族与题集导入、评分口径引擎、离线演进、
提案审批、技能 dev/stable 双通道、影子回归、回滚、预算与调度、前端全部界面。

**不做**（明确排除）：多用户/多租户、云端演进、模型微调（只演进文本与目录产物）、
自动修改 L0 层、跨机分布式 worker。

---

## 2. 总体架构

### 2.1 新增常驻进程

| # | 进程 | 启动 | 监听 | 角色 |
|---|---|---|---|---|
| 4 | **Evolve** | `data/envs/evolve/bin/python -m sciencediscovery_evolve.server` | `127.0.0.1:4313` | 跑 AgentDescent 循环，通过回调驱动 Node |

与 gateway 完全同构：uv 项目、只绑回环、**无持久业务状态**（ledger 除外，落在 data 目录）。
默认随 `start-stack.sh` 拉起，可用 `SCIENCE_AGENT_EVOLVE_ENABLED=0` 关闭（关闭时所有自演进 API 返回 501）。

### 2.2 数据流

```
浏览器 :4310
    │  REST + SSE（题族/运行/提案）
    ▼
┌──────────────────────────────────────────────────────────────┐
│ services/api (Node)                                          │
│  · 题族/Episode/提案/预算 存储与治理                            │
│  · rollout 真实执行（复用 createAgentRun）                      │
│  · 评分口径引擎（硬门 + judge + 脚本）                           │
│  · 提案 → skill dev revision 落盘                              │
└───┬──────────────────────────────────────────┬───────────────┘
    │ POST /evolve  (题集、资产、超参、callback_url)  │ 回调 :4310
    ▼                                          │ /internal/evolve-cb/{run,reward,propose}
┌────────────────────────┐                     │
│ services/evolve (Py)   │─────────────────────┘
│  agentdescent.evolve() │
│  ledger → data/evolution/ledger/<runId>/
└────────────────────────┘
    │ 事件流（NDJSON）：round / merge / accept / reject / cost
    ▼  回 API → SSE → 浏览器
```

**关键约束**：evolve 侧车**从不直接碰**工作区、runner、模型密钥、技能文件。
它只做调度与合并决策，一切副作用经回调回到 Node。这与 gateway 的 `/internal/tool-exec` 完全同构。

### 2.3 模块新增清单

```
packages/schema/src/
  evolution.ts              # 全部新增类型（§3）
services/api/src/
  evolution/
    index.ts                # 路由装配
    episodes.ts             # 沉淀（§9）
    families.ts             # 题族与聚类（§9.3）
    rubric/
      index.ts              # 口径引擎入口（§8）
      hard-gate.ts
      pairwise.ts
      absolute.ts
      script.ts
    rollout.ts              # headless ephemeral run（§7）
    runs.ts                 # EvolutionRun 生命周期 + SSE
    proposals.ts            # 提案、审批、否决表
    channels.ts             # skill dev/stable 通道（§13）
    shadow.ts               # 影子回归（§13.3）
    notes.ts                # 便签 + T0 检索（§10）
    import.ts               # 题族导入（§11）
    governance.ts           # L0/L1/L2 执行（§12）
    budget.ts               # 预算与调度（§15）
    evolve-client.ts        # → :4313
services/evolve/            # 新 uv 项目
  src/sciencediscovery_evolve/
    server.py               # FastAPI: /health /evolve /cancel
    bridge.py               # run/reward/propose → HTTP 回调
    runner.py               # 组装 agentdescent evolve() / async_evolve()
    events.py               # 事件流
apps/web/src/
  evolution/                # 前端（§14）
```

---

## 3. 数据模型

全部新增类型放 `packages/schema/src/evolution.ts`。

### 3.1 Note（便签）

T0 立刻生效的未验证经验。

```ts
export type NoteScope = "session" | "project" | "global";
export type NoteStatus = "active" | "promoted" | "retired";

export interface EvolutionNote {
  id: string;
  text: string;                    // 用户原话或模型规整后的祈使句
  rawText: string;                 // 用户原话，永不改写
  scope: NoteScope;
  scopeId: string;                 // projectId / sessionId；global 为 ""
  status: NoteStatus;
  /** 出处：哪一轮触发的 */
  origin: {
    sessionId: string;
    messageId: string;
    turnId?: string;
    promptManifestId?: string;
  };
  /** 命中它的 episode（回填） */
  episodeIds: string[];
  /** 升级后指向的题族与提案 */
  promotedTo?: { familyId: string; proposalId?: string };
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 Episode（可复盘案例）

```ts
export type EpisodeSource = "sediment" | "import" | "benchmark";
export type EpisodeSignal =
  | { kind: "explicit"; verdict: "good" | "bad"; text?: string }
  | { kind: "correction"; text: string }          // 用户下一轮的纠正
  | { kind: "artifact-downloaded" }
  | { kind: "session-abandoned" }
  | { kind: "review-finding"; severity: "info" | "warning" | "error"; code: string };

export interface Episode {
  id: string;
  source: EpisodeSource;
  projectId: string;
  /** 题面：用户的原始请求 */
  prompt: string;
  /** 输入 fixtures：workspace 相对路径 → CAS hash */
  fixtures: Record<string, string>;
  /** 基线：用户实际收到并接受/纠正过的产出 */
  baseline: {
    /** 最终助手回复的 CAS 引用 */
    responseHash: string;
    /** 产出文件：相对路径 → CAS hash */
    artifacts: Record<string, string>;
    /** 生成基线时生效的技能快照，用于可复现对照 */
    skillRefs: AgentResourceRef[];
    executionRunIds: string[];
  };
  signals: EpisodeSignal[];
  /** 失败模式标签 = 题族 key（§9.3） */
  labels: string[];
  /** 沉淀来源 */
  origin?: { sessionId: string; runId: string };
  /** 导入来源 */
  importRef?: { batchId: string; row: number };
  /** 该 episode 是否被锁定在 holdout */
  holdoutPinned: boolean;
  createdAt: string;
}
```

**为什么 baseline 里要存 `skillRefs`**：一年后重跑对照时，必须知道基线是在哪个技能版本下产生的，
否则「候选 vs 基线」的差异里混进了不可归因的部分。

### 3.3 Rubric（评分口径）

```ts
export type RubricMode = "pairwise" | "absolute" | "script";

export interface RubricHardGate {
  requireExecutionSuccess: boolean;
  requireArtifacts: string[];        // glob，空表示"至少产出一个文件"
  requireEvidenceChain: boolean;     // claims/evidence 链无断裂
  maxReviewFindingSeverity?: "info" | "warning";
}

export interface Rubric {
  id: string;
  familyId: string;
  mode: RubricMode;
  hardGate: RubricHardGate;
  /** pairwise / absolute 共用的判分维度 */
  dimensions: Array<{
    key: string;                     // accuracy / completeness / methodology / ...
    weight: number;                  // absolute 模式用；pairwise 模式仅作为 judge 提示
    description: string;
  }>;
  /** absolute 模式的自动信号权重 */
  autoSignalWeights?: {
    hardGate: number;                // 默认 0.4
    provenance: number;              // 默认 0.3
    semantic: number;                // 默认 0.3
  };
  /** script 模式 */
  script?: { language: "python"; sourceHash: string; timeoutMs: number };
  /** judge 模型；缺省用 reviewModelId */
  judgeModelId?: string;
  /** 交换 A/B 判两遍 */
  swapCheck: boolean;                // 默认 true
  updatedAt: string;
}
```

### 3.4 TaskFamily（题族）

```ts
export interface TaskFamilyHealth {
  episodeCount: number;
  trainCount: number;
  holdoutCount: number;
  /** 口径试评分布，长度 = episodeCount */
  scoreHistogram: number[];
  tieRate?: number;                  // pairwise 模式
  judgeAgreement?: number;           // swapCheck 一致率
  duplicateClusters: number;         // 题面近似聚类数
  verdict: "healthy" | "too-few" | "no-signal" | "unstable" | "duplicated";
  message: string;
}

export interface TaskFamily {
  id: string;
  projectId: string;
  name: string;
  /** 失败模式 key；沉淀来源的 episode 靠它归族 */
  labelKey?: string;
  source: EpisodeSource;
  episodeIds: string[];
  rubricId: string;
  split: { holdoutRatio: number; seed: number };
  health?: TaskFamilyHealth;
  healthCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 3.5 EvolutionRun

```ts
export type EvolutionRunStatus =
  | "queued" | "running" | "merging" | "completed"
  | "stopped" | "failed" | "budget-exhausted" | "converged";

export interface EvolutionRunConfig {
  familyId: string;
  /** 演进目标 */
  target: { kind: "skill" | "specialist" | "review-criteria"; id: string };
  rounds: number;
  nWorkers: number;
  maxConcurrency: number;
  asynchronous: boolean;
  asyncRatio?: number;
  fusionTournament: boolean;
  blastRadius: number;               // 由 target.kind 推导，用户不可直接设
  /** 任务按 训练在前/留出在后 排序后传给引擎；切分由 evolve() 按位置完成 */
  heldOutFrac: number;
  /** 默认 true 会让每个提案的 rollout 翻倍，我们恒传 false */
  selfVerify: false;
  /** pairwise 用 0.999；absolute 加权分要调低，否则每轮都去"修"0.95 分的答案 */
  solvedThreshold: number;
  rolloutModelId: string;
  reflectModelId: string;            // 便宜模型
  budget: { maxCostCents: number; maxWallClockMs: number; maxRollouts: number };
}

export interface EvolutionRunRound {
  index: number;
  trainReward: number;
  holdoutReward: number;
  accepted: number;
  rejected: Array<{ reason: string; count: number }>;
  costCents: number;
  startedAt: string;
  endedAt?: string;
}

export interface EvolutionRun {
  id: string;
  projectId: string;
  config: EvolutionRunConfig;
  status: EvolutionRunStatus;
  rounds: EvolutionRunRound[];
  /** agentdescent ledger 目录 */
  ledgerPath: string;
  /** 断点续跑 */
  resumable: boolean;
  costCents: number;
  rolloutCount: number;
  error?: string;
  startedAt: string;
  endedAt?: string;
}
```

### 3.6 Proposal（待采纳改动）

```ts
export type ProposalStatus =
  | "pending" | "approved" | "rejected" | "vetoed" | "auto-accepted" | "superseded";

export interface ProposalEvidence {
  /** 逐题分数变化，只列变化的 */
  taskDeltas: Array<{ episodeId: string; title: string; before: number; after: number }>;
  holdoutBefore: number;
  holdoutAfter: number;
  /** P(Δ>0)，来自 Beta 后验 */
  effectProbability: number;
  /** 无回归：分数未下降的题数 / 总题数 */
  noRegression: { unchanged: number; total: number };
  fusion?: { contested: boolean; winRate?: number; meanGain?: number };
}

export interface Proposal {
  id: string;
  runId: string;
  projectId: string;
  target: EvolutionRunConfig["target"];
  layer: "L0" | "L1" | "L2";
  /**
   * AgentDescent 的 `Diff.ops`：路径 → 完整新内容，`null` 表示删除。
   * 不是 unified diff —— 提案协议是整文件替换，见 internals §0.5。
   * 展示用的 diff 在渲染时现算。
   */
  ops: Record<string, string | null>;
  /** 生成候选时的技能树哈希；应用前必须与当前一致，否则会吃掉人工编辑 */
  baseTreeHash: string;
  /** 落地后的候选 dev revision（批准后才有；rollout 期间不需要） */
  candidateRevision?: number;
  evidence: ProposalEvidence;
  status: ProposalStatus;
  decision?: {
    by: "user" | "auto" | "oracle";
    reason?: string;
    at: string;
  };
  /** 否决指纹：用于「永久否决此类改动」 */
  vetoFingerprint: string;
  createdAt: string;
}
```

### 3.7 技能通道与影子

```ts
/**
 * `candidate` 已删除：rollout 用合成快照注入，不落盘（internals §0.1）。
 * 通道只区分用户会话看到的 stable 与影子中的 dev。
 */
export type SkillChannel = "stable" | "dev";

/** 挂在 ManagedSkillRevision 上的扩展，不改原结构 */
export interface SkillRevisionChannelRecord {
  skillId: string;
  revision: number;
  channel: SkillChannel;
  /** 来源 */
  origin: { kind: "manual" | "evolution"; runId?: string; proposalId?: string };
  /** 采纳时的证据快照 */
  evidence?: ProposalEvidence;
  /** 影子进度 */
  shadow?: { passed: number; required: number; regressions: number };
  promotedAt?: string;
  createdAt: string;
}

export interface RegressionCheck {
  id: string;
  skillId: string;
  candidateRevision: number;
  baselineRevision: number;
  /** 在真实沉淀 episode 上跑的对照 */
  episodeIds: string[];
  result: { passed: boolean; delta: number; regressed: string[] };
  createdAt: string;
}
```

### 3.8 设置

```ts
export interface EvolutionSettings {
  enabled: boolean;                          // 默认 false
  sedimentEnabled: boolean;                  // Episode 沉淀，默认 true（enabled 后）
  noteInjectionEnabled: boolean;             // T0 注入，默认 true
  noteInjectionMaxTokens: number;            // 默认 800
  autoAcceptL2: boolean;                     // 默认 false
  shadowRequiredPasses: number;              // 默认 5
  requireRealRegression: boolean;            // 默认 true（§13.4 护栏 2）
  rolloutConcurrency: number;                // 默认 2
  idleOnly: boolean;                         // 默认 true，且强制生效
  rolloutPermissionPolicy: "deny-new" | "inherit-granted";  // 默认 deny-new
  budget: { monthlyCostCents: number; perRunCostCents: number };
  rolloutModelId?: string;
  reflectModelId?: string;
  judgeModelId?: string;
  schedule?: { cron: string; familyIds: string[] };
}
```

加入 `RuntimeSettingsField`：`evolutionEnabled`、`enabledNoteScopes`，走既有 Global→Project→Session 继承。

---

## 4. 存储布局

沿用现有 `data/<collection>/<ownerId>.json` 约定：

```
data/
  evolution/
    settings.json                        # EvolutionSettings（global）
    notes/<projectId>.json               # EvolutionNote[]
    episodes/<projectId>.json            # Episode[]
    families/<projectId>.json            # TaskFamily[]
    rubrics/<projectId>.json             # Rubric[]
    runs/<projectId>.json                # EvolutionRun[]
    run-events/<runId>.jsonl             # 事件流（SSE 重放）
    proposals/<projectId>.json           # Proposal[]
    vetoes/<projectId>.json              # vetoFingerprint[]
    regression/<skillId>.json            # RegressionCheck[]
    channels.json                        # SkillRevisionChannelRecord[]
    ledger/<runId>/                      # agentdescent git-backed ledger
    import-batches/<batchId>.json        # 导入批次元数据
  cas/sha256/...                         # 复用：fixtures、baseline、diff、judge 请求响应
```

**全部内容体一律进 CAS**，记录里只存 hash——与 `provenance.ts` 现有口径一致。
Episode 的 fixtures 与 baseline artifacts 因此天然去重：同一个输入 CSV 出现在 20 个 episode 里只存一份。

`data/evolution/` 随数据目录整体备份；删除数据目录即抹除全部演进状态。

---

## 5. API 接口

全部挂 `/api/evolution/*`，沿用既有 bearer 鉴权与 `http/index.ts` 装配方式。

### 5.1 设置

```
GET    /api/evolution/settings                 → EvolutionSettings + sources
PUT    /api/evolution/settings                 ← Partial<EvolutionSettings>
```

### 5.2 便签

```
GET    /api/evolution/notes?projectId=&scope=  → EvolutionNote[]
POST   /api/evolution/notes                    ← { text, scope, origin }
PATCH  /api/evolution/notes/:id                ← { text?, scope?, status? }
DELETE /api/evolution/notes/:id
POST   /api/evolution/notes/:id/promote        → { familyId }  # 便签 → 题族
```

### 5.3 Episode 与题族

```
GET    /api/evolution/episodes?projectId=&familyId=&label=
GET    /api/evolution/episodes/:id             → Episode + 预览（题面/fixtures 列表/基线摘要）
DELETE /api/evolution/episodes/:id             # 用户可删（隐私）
POST   /api/evolution/episodes/from-session    ← { sessionId }  # 手动沉淀

GET    /api/evolution/families?projectId=
POST   /api/evolution/families                 ← { name, labelKey?, episodeIds, rubric }
GET    /api/evolution/families/:id             → TaskFamily + Rubric + health
PATCH  /api/evolution/families/:id
DELETE /api/evolution/families/:id
POST   /api/evolution/families/:id/health      → TaskFamilyHealth   # 试评，异步
PUT    /api/evolution/families/:id/rubric      ← Rubric
POST   /api/evolution/families/:id/split       ← { holdoutRatio, seed }
```

### 5.4 导入

```
POST   /api/evolution/import/preview           ← multipart / { hfDataset } / { sessionIds }
                                               → { batchId, columns[], sample: Episode[3], suggestedMapping }
POST   /api/evolution/import/commit            ← { batchId, mapping, familyId? }
                                               → { familyId, imported, skipped[] }
```

上传边界沿用 skills 导入的口径：单包 ≤ 25 MiB，解压 ≤ 50 MiB，≤ 500 文件，
路径穿越/符号链接/加密/重复路径一律拒绝。

### 5.5 演进运行

```
POST   /api/evolution/runs                     ← EvolutionRunConfig → EvolutionRun
                                               （先返回预估：rollout 数、费用区间、时长）
GET    /api/evolution/runs?projectId=
GET    /api/evolution/runs/:id                 → EvolutionRun
GET    /api/evolution/runs/:id/events          → SSE（round/merge/accept/reject/cost/rollout）
POST   /api/evolution/runs/:id/stop
POST   /api/evolution/runs/:id/resume           # 从 ledger 断点续跑
GET    /api/evolution/runs/:id/rollouts/:rid   → 单次 rollout 的完整对话（调试用，§13 决策 5）
```

### 5.6 提案与发布

```
GET    /api/evolution/proposals?projectId=&status=
POST   /api/evolution/proposals/:id/approve    → { skillId, candidateRevision }
POST   /api/evolution/proposals/:id/reject     ← { reason }
POST   /api/evolution/proposals/:id/veto       # 写 vetoFingerprint

GET    /api/evolution/channels?skillId=        → SkillRevisionChannelRecord[]
POST   /api/evolution/channels/promote         ← { skillId, revision }  # dev → stable
POST   /api/evolution/channels/rollback        ← { skillId, revision }
GET    /api/evolution/regression?skillId=      → RegressionCheck[]
```

### 5.7 内部回调（evolve 侧车 → Node）

```
POST /internal/evolve-cb/run
  ← { runId, taskId, artifact: { files: Record<string,string> } }
  → { output: string, artifacts: Record<string,string>, rolloutId, failed?: string }

POST /internal/evolve-cb/reward
  ← { runId, taskId, rolloutId }
  → { reward: number, breakdown: {...} }

POST /internal/evolve-cb/propose
  ← { runId, taskId, rolloutId, reward, artifact }
  → { proposal: string | null }

POST /internal/evolve-cb/event
  ← { runId, kind, payload }        # round/merge/accept/reject/cost
```

鉴权用与 `/internal/tool-exec` 相同的回环请求签名机制；`runId` 必须匹配在途运行。

---

## 6. services/evolve 侧车

### 6.1 接口

```
GET  /health                → { ok, agentdescentVersion }
POST /evolve                → NDJSON 事件流
POST /cancel/{runId}        → 202
```

`POST /evolve` 请求体：

```json
{
  "runId": "…",
  "callbackUrl": "http://127.0.0.1:4310",
  "tasks": [{ "id": "ep_…", "prompt": "…", "meta": { "holdout": false } }],
  "artifact": { "kind": "tree", "files": { "SKILL.md": "…", "references/x.md": "…" } },
  "frozen": ["scripts/**"],
  "editable": ["SKILL.md", "references/**"],
  "config": { "rounds": 12, "nWorkers": 2, "maxConcurrency": 2,
              "asynchronous": false, "blastRadius": 0.2,
              "fusionTournament": false, "maxFilesPerDiff": 2 }
}
```

### 6.2 与 AgentDescent 的绑定

`runner.py` 只做一件事——把回调包成 `run` / `reward` / `propose` 三个 Python 函数：

```python
def build(bridge: Bridge, req: EvolveRequest):
    def run(rendered_files: dict, task: Task) -> str:
        return bridge.post("run", task_id=task.id, artifact={"files": rendered_files})["output"]

    def reward(task: Task, output: str) -> float:
        return bridge.post("reward", task_id=task.id, rollout_id=bridge.last_rollout(task))["reward"]

    def propose(rendered, task, output, reward_value):
        return bridge.post("propose", task_id=task.id, reward=reward_value,
                           artifact=rendered)["proposal"]

    tree, strategy, cfg = build_tree(req.artifact.files, editable=req.editable, frozen=req.frozen)
    return dict(tasks=..., reward=reward, run=run, propose=propose,
                strategy=strategy, agg_config=cfg,
                blast_radius=req.config.blast_radius, ...)
```

**沿用 `TreeStrategy`（`evolve_skill_dir` 内部用的那套）**：state key 是文件路径，
两个 worker 改不同文件自动 fuse，改同一文件按 holdout 分裁决。
不直接调 `evolve_skill_dir()`，因为 rollout 必须由 Node 执行——我们要的是它的 strategy 与 aggregator，
不是它的 `tree_runner`。

同步走 `evolve()`，`asynchronous=True` 走 `async_evolve()`；
staleness 策略固定 **Guarded**（版本门控），不暴露给用户。

### 6.3 Ledger 与断点

`Ledger` 指向 `data/evolution/ledger/<runId>/`（git-backed）。
运行中断（用户 Stop、预算耗尽、进程崩溃）后 `POST /runs/:id/resume` 用同一 ledger 重开，
已完成的 commit 不重跑。

### 6.4 事件

侧车把 `RoundInfo` 回调转成 NDJSON 推给 Node，Node 落 `run-events/<runId>.jsonl` 并转 SSE：

| kind | payload |
|---|---|
| `round` | index, trainReward, holdoutReward, accepted, rejected[] |
| `rollout` | taskId, rolloutId, status, durationMs |
| `merge` | artifactId, decision, reason |
| `accept` | proposalDraft（Node 据此建 Proposal） |
| `cost` | costCents 增量 |
| `done` | status, finalReward |

---

## 7. Rollout 执行（headless ephemeral run）

### 7.1 复用现有接缝

Rollout **不新建 agent 机制**，直接复用
[`createSubagentProfile`](packages/agent-runtime/src/run-profile.ts:89) +
[`createAgentRun`](services/api/src/agent-run/create-agent-run.ts:31)：

```ts
const profile = createSubagentProfile({
  gatewayThreadId: `evo-${runId}-${rolloutId}`,
  workspaceRoot: ephemeralDir,                    // data/.tmp/evolution/<runId>/<rolloutId>/
  skills: [{ id: skillId, revision: candidateRevision }],   // ← 钉死候选版本
  connectorIds: grantedConnectorIds,              // 只给已授权的
  deniedToolNames: DENY_IN_ROLLOUT,               // §7.3
  maxModelTurns: 40,
  runTimeoutMs: settings.rolloutTimeoutMs,
  presetId: "evolution-rollout",
});
```

`SubagentProfile` 的 `historyPolicy: { inputPolicy: "orchestrator-only", kind: "isolated" }`
正是 rollout 需要的语义：不带外层会话历史、独立工作区、有 turn 上限。

### 7.2 生命周期

```
1. 创建 ephemeral 工作区 data/.tmp/evolution/<runId>/<rolloutId>/
2. 从 CAS 还原 episode.fixtures 到工作区
3. 候选 artifact 写成 skill dev revision（§13.1），拿到 revision 号
4. createAgentRun(profile, bindings, { prompt: episode.prompt, history: [], purpose: "subagent_task" })
5. execute() → 收集最终回复 + 工作区新增/修改文件
6. 产出入 CAS，返回 { output, artifacts, rolloutId }
7. 删除工作区（保留 CAS 引用与 Prompt Manifest）
```

**不进 Session 列表**：rollout 不写 `data/projects/*/sessions/`，只写
`data/prompt-manifests/evo-<runId>.json` 与 `data/execution-runs/evo-<runId>.json`，
保证可审计但不污染用户会话。

### 7.3 非交互权限运行时

**这是必须显式实现的一条**：rollout 无人值守，绝不能弹权限卡片。
`rollout.ts` 给 `permission-runtime` 注入一个非交互决策器：

```ts
const decision = (req: PermissionRequest): PermissionDecision => {
  if (policy === "deny-new") {
    return hasActiveGrant(req) ? "allow" : { deny: "evolution-noninteractive" };
  }
  return hasActiveGrant(req) ? "allow" : { deny: "evolution-noninteractive" };
};
```

被拒的 rollout **不是异常，是该题得 0 分**（硬门失败），照常进入统计。
`networkPolicy: "none"` 与 bubblewrap 隔离一律不变——演进不放宽任何沙箱约束。

### 7.4 并发与抢占

- 全局信号量 `rolloutConcurrency`（默认 2），与 runner 队列共用天花板
- `idleOnly=true`（默认且强制）：检测到任何活跃 session run 时，**新 rollout 不再派发**，
  在途 rollout 允许跑完（不中途杀，否则浪费已花的 token）
- 用户点 Stop → 复用现有中止贯通链路（gateway abort + 杀 bwrap + 清 runner 队列）

---

## 8. 评分口径引擎

`evolution/rubric/index.ts` 的唯一出口：

```ts
export async function score(
  episode: Episode, rollout: RolloutResult, rubric: Rubric
): Promise<{ reward: number; breakdown: ScoreBreakdown }>;
```

### 8.1 硬门（先跑，失败直接 0，不进 judge）

```ts
if (rubric.hardGate.requireExecutionSuccess && rollout.executionFailed) return 0;
if (!matchesAny(rollout.artifacts, rubric.hardGate.requireArtifacts)) return 0;
if (rubric.hardGate.requireEvidenceChain && hasBrokenEvidenceChain(rollout)) return 0;
if (exceedsSeverity(rollout.reviewFindings, rubric.hardGate.maxReviewFindingSeverity)) return 0;
```

硬门省掉了绝大多数昂贵的 judge 调用——跑挂的 rollout 不值得判分。

### 8.2 Pairwise（默认）

```
输入：episode.baseline.responseHash + artifacts  vs  rollout.output + artifacts
判两遍：(A=baseline, B=candidate) 与 (A=candidate, B=baseline)
两遍结论一致 → 采用；不一致 → 记 0.5（平局）并计入 judgeAgreement 统计
reward = 赢 1.0 / 平 0.5 / 输 0.0
```

judge prompt 要点（模板固化在代码里，属 L0 不可演进）：

- 只给两份产出与题面，**不告诉 judge 哪份是基线**
- 判分维度 = `rubric.dimensions`
- 强制输出 `{"winner":"A"|"B"|"tie","reason":"…"}`
- 产出过长时按 `maxJudgeChars` 截断，并在两侧用同一口径截断

judge 的请求与响应入 CAS，走 `prompt-manifest` 记账，调用类型标 `evolution-judge`
（扩展现有 `ModelInvocationUsage` 的调用类型枚举）。

### 8.3 Absolute

```
reward = w.hardGate  × 1
       + w.provenance × (evidence 链完整率 × citation 检查通过率)
       + w.semantic   × (judge 六维加权 / 10)
```

### 8.4 Script

用户脚本在**现有 runner 沙箱**里跑，输入通过 stdin 给 JSON（题面、产出路径、baseline 路径），
stdout 最后一行必须是 `[0,1]` 的浮点。超时或非法输出 → 该题标 `unscorable`，
**从本轮统计中剔除**而不是记 0（避免脚本 bug 污染梯度）。

### 8.5 缓存

`(episodeId, artifactHash, rubricId)` → reward 落 `evalcache`（sqlite 表）。
同一候选在多轮里被重复评估时直接命中——AgentDescent 的 fusion tournament 会大量重复评估，
没有这层缓存成本翻倍。

---

## 9. 沉淀层（T1）

### 9.1 触发

会话进入非活跃状态（最后一次 run 结束后 N 分钟无新消息，默认 10 分钟）或用户显式归档时，
投递一个后台任务。**不在 run 结束时同步做**——沉淀要读完整历史与工作区，不能挤占交互路径。

### 9.2 Episode 抽取

```
1. 题面 = 该会话第一条用户消息；若会话有多个独立任务，按「用户消息 → 直到下一条用户消息」切段，
   每段产出一个 candidate episode，再由长度与工具调用数过滤掉闲聊段
2. fixtures = 该段开始时刻工作区中的 data/file 类文件（排除 artifact 类产出）→ CAS
3. baseline = 该段最后一条助手回复 + 该段 executionRun 产生的 artifact → CAS
4. skillRefs = 该段 prompt-manifest 里记录的技能快照
5. signals：
     explicit          ← 用户 👍/👎
     correction        ← 下一条用户消息被判定为纠正（模型二分类，或含否定关键词）
     artifact-downloaded ← 下载记录
     session-abandoned ← 段后无后续且无下载
     review-finding    ← 该段的 ArtifactReviewRun findings
6. labels = §9.3
```

**排除规则**（不沉淀）：会话被删除、段内无任何工具调用、题面 < 20 字符、
产出为空、用户在设置里关掉了本项目的沉淀。

### 9.3 失败模式打标与题族聚类

两级，都要实现：

**一级——便签驱动（M0 主力，便宜且可解释）**

```
对每个 active 便签 note：
  用 judge 模型判「这个 episode 是否触发了 note 描述的情形」
  是 → episode.labels += note.id，note.episodeIds += episode.id
```

判定结果缓存在 `(episodeId, noteId)` 上，便签文本变了才重判。

**二级——自动发现（M3）**

对 `signals` 里含 `correction` / `bad` / `review-finding` 的 episode，
抽取「失败原因」短语，做嵌入聚类；簇大小 ≥ 5 时提示用户「发现一个新的失败模式，要不要建题族」。

**题族 = 一个 label 下的 episode 集合**。同一个 episode 可以属于多个题族（多标签），这是刻意的。

### 9.4 划分

`split(familyId, holdoutRatio, seed)`：按 `hash(episodeId + seed)` 稳定分桶，
`holdoutPinned` 的强制进 holdout。**划分一旦确定就冻结**，加入新 episode 时只增量分配，
不重新洗牌——否则历史运行的 holdout 分数不可比。

### 9.5 保留与隐私

- 设置页提供「查看 / 导出 / 删除我的 Episode 池」
- 默认保留期无限；提供按项目、按时间范围批量删除
- 删除 Episode 只删记录，CAS 对象因去重不删（与现有 CAS「只增不改」一致）

---

## 10. T0 便签检索注入

### 10.1 注入点

在 `packages/agent-runtime` 组装 system prompt 的位置，技能清单之后追加一段：

```
## 本项目的既有约定（用户此前提出，未经自动验证）
- 报告显著性前先做多重比较校正   [来自 2026-07-02 的会话]
- 图表必须标注 n 与误差棒        [来自 2026-07-11 的会话]
```

标注「未经自动验证」是刻意的——让模型和用户都知道这些和已验证的技能内容不同权重。

### 10.2 检索

M0 用**全量注入 + 预算截断**，不做向量检索：

```
候选 = scope 匹配的 active 便签（session ⊃ project ⊃ global）
排序 = 最近命中优先（episodeIds 里最新的 episode 时间）
截断 = 累计 token 达 noteInjectionMaxTokens（默认 800）为止
```

单项目便签量级在几十条，全量注入完全可行，且比向量检索可预测。
量级超过 200 条时再上检索（M3）。

### 10.3 与技能的关系

便签**不写进技能文件**。它是独立的一段 prompt，因此：
删便签立刻生效、不产生 revision、不进 Prompt Manifest 的 `skillRefs`
（但要进 manifest 的一个新字段 `noteRefs`，保证可复现）。

---

## 11. 导入实现

四种形态（[self-evolution.md §4.8](self-evolution.md)）统一走 preview → commit 两步。

| 形态 | 解析 | 生成的 Episode |
|---|---|---|
| **B 输入+已认可结果** | 目录：每个子目录一道题，约定 `input/` 与 `output/` | fixtures ← input/，baseline.artifacts ← output/，prompt ← `prompt.txt` 或目录名 |
| **C 输入+验收标准** | 目录 + 一份 checklist Markdown | fixtures ← 子目录，无 baseline，rubric.mode = absolute + checklist 转 dimensions |
| **A 标准题集** | CSV/JSONL + 列映射 | prompt ← prompt 列，baseline.responseHash ← gold 列 |
| **D 只有输入** | 目录 | fixtures 有、baseline 空 → 只能 absolute 模式 |
| **HF** | `agentdescent.dataloader.hf_rows`（在 evolve 侧车里调，结果回传 Node） | 同 A，且强制 `source: "benchmark"` |

**preview 必须试评 3 道题**：用当前 stable 技能跑 3 个 rollout 并按选定 rubric 打分，
把分数和 judge 理由回给用户确认。列映射错、口径选错是最常见的两种失败，
而它们只有跑一次才暴露。这 3 次 rollout 的成本计入预算并在 UI 上说明。

`source: "benchmark"` 的 episode **不允许进 holdout**，只能进训练集，
且在题族页有明显 badge（护栏 3）。

---

## 12. 治理执行

### 12.1 层级判定

```ts
export function classify(target: EvolutionRunConfig["target"]): "L0" | "L1" | "L2" {
  if (FROZEN_TARGETS.has(target.id)) return "L0";
  const radius = BLAST_RADIUS[target.kind];     // skill 0.2 / specialist 0.6 / review-criteria 0.6
  return radius <= 0.30 ? "L2" : "L1";
}

export const FROZEN_TARGETS = new Set([
  "permission-system", "sandbox-policy", "approval-logic", "cas-provenance",
  "model-secrets", "rubric", "evolution-budget", "judge-prompt-template",
]);
```

阈值 0.30 与 AgentDescent 的 `FAST_MAX` 对齐，且**只在这一处定义**。

### 12.2 强制点（三处，缺一不可）

1. **创建运行时**：`target` 命中 `FROZEN_TARGETS` → 400，且这些目标在 UI 上根本不可选
2. **提案落地时**：`layer === "L1"` → 强制 `status: "pending"`，忽略 `autoAcceptL2`
3. **文件级**：候选 artifact 的 `frozen` 列表包含 `scripts/**` 与安全相关文件，
   evolve 侧车用 `TreeStrategy` 的 frozen overlay 在物化时覆盖回原文件——
   **候选在运行时改写这些文件也不会生效**

### 12.3 内置技能

内置技能（`source: "built-in"`, `readOnly: true`）的演进产出**不改仓库文件**，
而是创建一个 managed 技能 fork（`<name>-evolved`），原技能保持只读。
这样 M1 完全不用碰 L1。

### 12.4 审计

每次采纳写一条不可变记录：proposalId、diff hash、evidence、决策人、决策时间、
当时生效的 rubric hash。挂在 `data/evolution/proposals/` 里（append-only，不允许改历史记录）。

---

## 13. 采纳与发布

### 13.1 候选落成 dev revision

提案批准 → 把 diff 应用到当前 stable 技能内容 → 调既有的技能更新路径产生**真实的不可变 revision**，
同时在 `channels.json` 写一条 `{ channel: "dev", origin: { kind: "evolution", runId, proposalId } }`。

`channel: "dev"` 的 revision：

- 不出现在 Global/Project/Session 的技能选择列表里
- 但可以被 `AgentResourceRef{ id, revision }` 精确引用（rollout 与影子用）
- `candidate` 通道是演进过程中的临时候选，运行结束未被采纳的自动回收（保留 30 天）

**这一步是复用现有机制的关键**：冻结快照、包哈希、Prompt Manifest 的 `skillRefs`
一行都不用改，dev revision 天然可审计、可复现。

### 13.2 采纳后的技能选择

用户会话仍然只用 `stable`。dev revision 只在两处被引用：影子对照、后续演进的基线。

### 13.3 影子模式

```
新会话结束并沉淀出 episode 后：
  若该项目存在 channel=dev 的候选技能：
    在空闲时用候选版本重跑这个 episode（一次 rollout）
    按该 episode 所属题族的 rubric 与 stable 版产出做 pairwise
    赢或平 → shadow.passed++
    输     → shadow.regressions++，且 passed 归零重来
  passed >= shadowRequiredPasses（默认 5）→ 提示用户「可以转正」
```

对应 AgentDescent 的 dev→stable 提升语义（K 轮无回归，一次回归重置计时）。
影子 rollout 同样受 `idleOnly` 与并发限制约束。

### 13.4 转正闸门

```ts
async function canPromote(skillId: string, revision: number): Promise<PromoteVerdict> {
  const shadow = getShadow(skillId, revision);
  if (shadow.passed < settings.shadowRequiredPasses) return { ok: false, reason: "shadow-incomplete" };
  if (settings.requireRealRegression) {
    const real = await runRegressionCheck(skillId, revision, { source: "sediment" });
    if (!real.result.passed) return { ok: false, reason: "real-regression", detail: real };
    if (real.episodeIds.length === 0) return { ok: false, reason: "no-real-episodes" };
  }
  return { ok: true };
}
```

`no-real-episodes` 时前端给「我确认接受，直接转正」的逃生门（[§13 决策 8](self-evolution.md)），
点了之后该 revision 在版本时间线上**永久标注「未经真实回归验证」**。

### 13.5 回滚

把任一历史 revision 设为 stable。回滚前弹确认，列出"这会丢掉的已学经验"
（该 revision 之后所有 origin=evolution 的 proposalId 与其证据摘要）。
回滚不删除 revision，只改通道指针。

---

## 14. 前端

### 14.1 组件

```
apps/web/src/evolution/
  EvolutionPanel.tsx          # 三 tab 容器
  FamilyList.tsx / FamilyDetail.tsx / FamilyHealth.tsx
  EpisodeTable.tsx / EpisodePreview.tsx
  RubricEditor.tsx            # 模式切换 + 维度 + 权重滑杆 + 实时直方图
  ImportWizard.tsx            # 拖拽 → 列映射 → 3 题试评 → 确认
  RunDashboard.tsx            # 双曲线 + worker 泳道 + 采纳流水 + 成本条 + Stop
  RolloutInspector.tsx        # 单次 rollout 完整对话（调试）
  ProposalQueue.tsx / ProposalCard.tsx
  NoteBadge.tsx               # Composer 上方徽章
  NoteList.tsx
apps/web/src/
  SkillVersionTimeline.tsx    # 挂进现有 SkillManager
  EvolutionSettingsEditor.tsx # 挂进 System Settings
```

### 14.2 事件到 UI

SSE 事件流复用现有 `run-stream` 的模式：

| 事件 | UI |
|---|---|
| `round` | 曲线新增一个点；两条线（train 细、holdout 粗） |
| `rollout` | worker 泳道对应格子变色 |
| `accept` | 采纳流水追加一行 + 提案队列徽章 +1 |
| `reject` | 采纳流水追加一行，标原因 |
| `cost` | 成本条推进；超 80% 变黄，超 100% 自动停 |
| `done` | 终态卡片 + 「查看提案」CTA |

### 14.3 i18n

所有新文案进 `apps/web/src/i18n`，中英双份。术语按
[self-evolution.md §3](self-evolution.md) 的翻译表，**不出现 RSI/blast radius/staleness**。

---

## 15. 并发、预算与调度

### 15.1 预估

创建运行前算：

```
rollouts ≈ rounds × nWorkers × |train| + rounds × |holdout|   （接受门每轮扫一遍留出集）
cost     ≈ rollouts × 单次 rollout 平均 token × 单价
           + judge 调用数 × judge 平均 token × 单价
```

单次 rollout 平均 token 用该项目最近 20 次真实 run 的中位数；无历史时用保守默认并标注「估计不准」。

### 15.2 硬上限

`maxCostCents` / `maxWallClockMs` / `maxRollouts` 任一触顶 → 状态置 `budget-exhausted`，
停止派发新 rollout，等在途结束，保留 ledger 可续跑。
月度上限跨运行累计，触顶后拒绝新建运行。

### 15.3 调度

- `idleOnly`：活跃 session run 存在时不派发新 rollout
- `schedule.cron`：夜间自动演进，只提交到 dev 通道（`autoAcceptL2` 对夜间运行**强制为 false**）
- 收敛停止：连续 `convergenceRounds`（默认 3）轮无采纳 → `converged`，
  UI 明说「在当前口径下已达上限，继续投入不会更好」

---

## 16. 失败与降级矩阵

| 情况 | 检测点 | 行为 | 用户看到 |
|---|---|---|---|
| 题目 < 8 | 创建运行 | 允许跑，禁用自动采纳 | 「样本太少，结论不可信」，提案标低置信 |
| 口径无区分度 | health check | 拒绝创建运行 | 直方图 + 修改建议 |
| judge 一致率 < 0.6 | health check | 拒绝创建运行 | 「评分不稳定，先修口径」 |
| rollout 连续失败 > 50% | 运行中 | 暂停运行 | 列出失败原因分布（多半是权限或超时） |
| 权限被拒 | rollout | 该题 0 分，不算异常 | 运行看板标注「N 题因权限受限失败」 |
| 连续无采纳 | 运行中 | `converged` 停止 | 「已达当前口径上限」——正确结果，不是失败 |
| 预算耗尽 | 运行中 | `budget-exhausted` | 保留断点，一键续跑 |
| 模型不可用 | 回调 | 已完成 rollout 不浪费，evidence 结算回池 | 明确错误 + 续跑按钮 |
| evolve 侧车崩溃 | 心跳 | 运行置 `failed`，ledger 保留 | 续跑按钮 |
| 影子回归 | 影子 | `passed` 归零 | 时间线标注「出现一次回归，重新计数」 |
| 用户回滚 | 手动 | 只改通道指针 | 列出会丢掉的经验 |

---

## 17. 安全边界

| 威胁 | 缓解 |
|---|---|
| **评分作弊**（演进学会取悦 judge） | rubric、judge prompt 模板、硬门实现全部在 L0 `FROZEN_TARGETS`；候选无法读取或改写它们 |
| **测试/护栏被改写** | `frozen` overlay 在物化后覆盖，运行时改写无效（对齐 `evolve_agent_code` 的做法） |
| **Prompt 注入经 episode 传播** | episode 的题面与 fixtures 来自用户会话，本就是不可信数据；rollout 在既有沙箱内跑，`networkPolicy: none` 不变 |
| **judge 被产出内容操纵** | judge 只看两份产出，双向交换判两遍；不一致即平局，操纵一侧无法稳定获胜 |
| **无人值守下的权限提升** | `deny-new` 非交互策略；rollout 不能创建新授权 |
| **资源耗尽** | 并发上限 + idleOnly + 三重预算 + ephemeral 工作区跑完即删 |
| **数据外泄** | 演进不新增任何出站通道；judge 调用走既有模型注册表与配额 |
| **磁盘膨胀** | fixtures/baseline 走 CAS 去重；candidate 通道 30 天回收；ephemeral 工作区即时删除 |

---

## 18. 测试计划

### 18.1 单元

- `rubric/*`：硬门各分支、pairwise 顺序交换、script 超时与非法输出、缓存命中
- `families.ts`：稳定分桶、增量加题不重洗、holdoutPinned
- `governance.ts`：三处强制点、FROZEN_TARGETS、阈值单一来源
- `channels.ts`：dev revision 不出现在选择列表、回滚只改指针
- `episodes.ts`：切段算法、排除规则、signals 抽取

### 18.2 集成（无网络）

参考 AgentDescent 自己的做法——用**确定性 stub**跑通整条链路：

- stub agent：`run` 返回按候选文本决定的确定性输出
- stub judge：按关键词判胜负
- 断言：holdout 分数单调上升、提案被创建、L1 强制 pending、预算触顶正确停

这套测试**不需要任何 API key**，进 CI。

### 18.3 端到端

Playwright：导入 → 试评 → 创建运行 → 看板出现曲线 → 提案审批 → 时间线出现 dev → 转正 → 回滚。
用 stub 侧车（`SCIENCE_AGENT_EVOLVE_STUB=1`）。

### 18.4 探针（发布前必做）

[self-evolution.md](self-evolution.md) 落地第一步的四个判据，在真实模型上跑一次并记录数字：
rollout 成功率 > 90%、judge 一致率 > 75%、平局率 < 60%、单次演进时长实测。

---

## 19. 可观测性

新增 `evolution.log`（走 `packages/operational-logging`，与现有五个日志文件同规格）：

- 记录：runId、rolloutId、taskId、耗时、reward、采纳/拒绝原因、成本增量
- **不记录**：prompt 原文、产出内容、judge 理由（这些在 CAS 里，日志只存 hash）

指标（`/api/runtime-status` 扩展）：在途 rollout 数、队列深度、本月累计成本、
各项目的 episode 数与题族健康度概览。

---

## 20. 分期与文件级工作分解

### M0 — 沉淀层（无 AgentDescent 依赖）

| 工作 | 文件 |
|---|---|
| 类型 | `packages/schema/src/evolution.ts`（Note、Episode、TaskFamily、Rubric 部分） |
| 便签 CRUD + T0 注入 | `evolution/notes.ts`、`packages/agent-runtime`（system prompt 拼装） |
| 沉淀任务 | `evolution/episodes.ts` + 会话非活跃触发钩子 |
| 打标（便签驱动） | `evolution/families.ts` |
| 存储 | `store.ts` 新增 6 个路径解析 |
| API | `/api/evolution/{settings,notes,episodes,families}` |
| 前端 | `NoteBadge`、`NoteList`、`EpisodeTable`、`FamilyList`、`EvolutionSettingsEditor` |

**独立价值**：一个带出处的项目级记忆。

### M1 — 第一次演进

| 工作 | 文件 |
|---|---|
| 侧车 | `services/evolve/` 全部 + `scripts/start-stack.sh` |
| rollout | `evolution/rollout.ts`、`agent-run/permission-runtime.ts`（非交互决策器） |
| 口径引擎 | `evolution/rubric/*` |
| 运行生命周期 + SSE | `evolution/runs.ts`、`evolve-client.ts` |
| 提案与通道 | `evolution/proposals.ts`、`channels.ts`、`governance.ts` |
| **导入**（§11） | `evolution/import.ts`、`ImportWizard.tsx` |
| 预算 | `evolution/budget.ts` |
| 前端 | `RunDashboard`、`ProposalQueue/Card`、`SkillVersionTimeline`、`RubricEditor` |

**验收**：探针四个判据 + 集成测试全绿 + 一次真实演进产生一条被采纳的提案。

### M2 — 放手

影子模式（`shadow.ts`）、便签→提案自动升级、夜间调度、健康度诊断完整版、
成本预估、`SandboxPool` 接管并发、`RolloutInspector`。

### M3 — 更深

`evolve_agent_dir` 路径（specialist / 评审准则，L1 + oracle）、`async_evolve`、
自动失败模式发现（嵌入聚类）、技能发现、在线轻量决策点 best-of-N、跨项目经验迁移。

---

## 21. 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `SCIENCE_AGENT_EVOLVE_ENABLED` | `0` | 是否拉起 evolve 侧车 |
| `SCIENCE_AGENT_EVOLVE_PORT` | `4313` | 侧车端口（仅回环） |
| `SCIENCE_AGENT_EVOLVE_STUB` | `0` | 测试用确定性 stub |
| `SCIENCE_AGENT_EVOLVE_ROLLOUT_CONCURRENCY` | `2` | 初值；持久化后以设置页为准 |
| `SCIENCE_AGENT_EVOLVE_MONTHLY_BUDGET_CENTS` | `0` | 0 = 不限（不建议） |

与现有约定一致：**环境变量仅作为新数据目录的初值**，首次持久化后以设置页为准。

---

## 22. 未决问题

1. Episode 切段（§9.2）在多任务长会话上的准确率——需要在真实历史上测一版再定阈值
2. judge 模型选型：用 `reviewModelId` 还是独立配置？独立配置更灵活但多一个用户负担
3. `candidate` 通道 30 天回收窗口是否够——取决于用户审批提案的实际拖延时长
4. 自动失败模式发现（§9.3 二级）需要嵌入模型，与「零必需依赖」的现状冲突，M3 再定
5. 影子 rollout 的成本归属：算在项目预算里，还是单独一档？

---

## 相关文档

- [self-evolution.md](self-evolution.md) — 产品与用户视角（本文的 why）
- **[self-evolution-internals.md](self-evolution-internals.md) — 每个机制的算法与代码级实现（本文的 how）**
- [architecture.md](architecture.md) — 进程与模块边界
- [control-plane.md](control-plane.md) — 运行编排与权限系统
- [review-provenance.md](review-provenance.md) — CAS、claims/evidence、Prompt Manifest
- [skill-progressive-disclosure.md](skill-progressive-disclosure.md) — 技能冻结快照
- [sandbox-execution.md](sandbox-execution.md) — rollout 的执行边界
- [subagent-orchestration.md](subagent-orchestration.md) — SubagentProfile 契约（rollout 复用它）
