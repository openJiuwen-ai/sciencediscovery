# 自演进：关键机制的具体实现

[self-evolution.md](self-evolution.md) 讲**为什么**，
[self-evolution-implementation.md](self-evolution-implementation.md) 讲**有什么**（类型、接口、存储、分期），
本文讲**怎么跑**——每个机制的算法、真实调用路径与边界处理。

代码按现有仓库签名书写（`CasStore`、`createSubagentProfile`、`createAgentRun`、
`ManagedSkillRevision` 等），是设计级实现而非已编译代码：类型名与参数顺序对齐真实定义，
省略了错误包装与日志。

> **本文已按两边源码逐一核对过一次**，核对中推翻的结论记在
> [§0 与源码核对后的修正](#0-与源码核对后的修正)。先读那一节。

---

## 0. 与源码核对后的修正

早期草案有六处是按文档推断的，与真实代码不符，且都影响架构而非措辞。

### 0.1 候选技能**不需要**落成 revision，直接注入

`WorkspaceAgentOptions.skills`（[workspace.ts:239](../packages/agent-runtime/src/workspace.ts)）
是一个普通数组，`read_skill` 工具直接把 `skill.content` 返回给模型。
[runs/index.ts:889](../services/api/src/runs/index.ts) 里它由 `skillCatalog.resolve()` 填充，
但**没有任何东西要求它来自 catalog**。

于是候选技能只要构造一个合成快照即可，全程不落盘：

```ts
function candidateSnapshot(base: SkillDetail, files: Record<string, string>): RuntimeSkillSnapshot {
  const parsed = parseSkillMarkdown(files["SKILL.md"]);
  return {
    id: base.id,
    content: parsed.instructions,
    description: parsed.description,
    hash: sha256(canonicalTree(files)),
    version: base.version,
    revision: base.currentRevision,          // 仅供 Prompt Manifest 记账
    resources: base.resources,
    readResource: (path) => ({ content: files[path] ?? "", mediaType: "text/plain" }),
  };
}
```

**这一条删掉了早期草案里的整个 `candidate` 通道、30 天回收、以及"dev revision 会泄漏给用户会话"的问题。**
dev revision 只在提案被批准之后才需要——那时持久化是为了可审计，不是为了跑。

### 0.2 `AgentResourceRef.revision` 是记账，不是选择器

`SkillCatalog.resolve(ids)`（[skills.ts:944](../services/api/src/skills.ts)）只返回
`detail.currentRevision`，没有"按 revision 取历史版本"的能力。
早期草案写的 `skills: [{ id, revision }]` **钉死候选版本**是错的——那个 revision 只会进 Prompt Manifest。

影子模式要跑「历史 stable vs 候选」，同样得走 §0.1 的合成快照
（磁盘上确实有 `data/skills/<id>/revisions/<n>/`，要按 revision 读需要给 `SkillCatalog` 补一个方法）。

### 0.3 rollout 必须有一个**真实 Session**

`createWorkspaceExecutionBindings`（[workspace-bindings.ts:40](../services/api/src/agent-run/workspace-bindings.ts)）
每次执行都调 `store.assertSessionWritable(sessionId)`，provenance 按 sessionId 落盘，
工作区路径由 `store.workspacePath(sessionId)` 决定。所以早期草案里
「工作区放 `data/.tmp/evolution/...`、不进 Session 列表」在代码里跑不通。

正确形状是**照抄 subagent**：建一个真实 Session，rollout 在
`projects/<pid>/sessions/<sid>/workspace/` 下工作，跑完删除 Session。

但 `listSessions(projectId, state)`（[store.ts:1346](../services/api/src/store.ts)）只按
projectId + `archivedAt` 过滤，**没有隐藏机制**。所以需要一处最小改动：

```ts
// packages/schema/src/session.ts
export interface Session {
  /** 演进 rollout 会话；不出现在用户会话列表里。 */
  kind?: "user" | "evolution";
  ...
}
// store.ts listSessions
.filter(s => s.projectId === projectId && s.kind !== "evolution" && ...)
```

不加这个字段，用户的会话列表会被几百个 rollout 淹没。

### 0.4 非交互权限**不改**现有函数

`AgentPermissionRuntime`（[permission-runtime.ts:18](../services/api/src/agent-run/permission-runtime.ts)）
只有 `getEpoch` 和 `requirePrivilege` 两个方法。rollout 直接写第二个实现即可，
`createAgentPermissionRuntime` 一行都不用动——早期草案提议给它加 `nonInteractive` 选项是多余的侵入：

```ts
export function createRolloutPermissionRuntime(
  epoch: PermissionEpoch, bindings: AgentPermissionRuntimeBindings, onDeny: (r: PrivilegeRequest) => void,
): AgentPermissionRuntime {
  return {
    getEpoch: () => epoch,
    async requirePrivilege(req) {
      const check = await bindings.requestPermission(req.action, req.resource, req.summary, {
        executionId: req.executionId, toolCallId: req.toolCallId });
      if (check.allowed) return check.authorization;
      onDeny(req);                                   // 计数 → 硬门判 0
      throw new RolloutPermissionDenied(req.summary);
    },
  };
}
```

### 0.5 AgentDescent 的提案协议是**整文件替换**，不是 unified diff

`parse_edits`（[treestrategy.py:98](../../../Documents/agentdescent/agentdescent/treestrategy.py)）解析的是：

```
<EDITS>
{"rationale": "...", "edits": [{"path": "SKILL.md", "content": "<完整的新文件>"}]}
</EDITS>
```

`Diff.ops` 因此是 `{路径: 完整内容 | null}`。早期草案的 `applyUnifiedDiff` /
`patch-does-not-apply` 全部作废——应用一个提案就是**整文件写入**。

**风险因此反过来了**：不是"补丁打不上"，而是**静默覆盖审批期间的人工编辑**。
拦截手段是内容哈希而不是补丁冲突（§8 已改写）。

另外类名是 **`FileTree`**（`treestrategy.py` 里定义），不是 `TreeStrategy`；
`render(state)` 是 `filetree.canonical(state)`，一个带 `_: "agentdescent.filetree/1"` 的 JSON 串，
反向用 `parse_tree(rendered)`。草案里的 `strategy.render_files(...)` 不存在。

### 0.6 train/holdout 由 `evolve()` **按位置**切，`reward` 不接受 NaN

[evolution.py:1663](../../../Documents/agentdescent/agentdescent/evolution.py)：

```python
cut = max(1, round(len(tasks) * (1 - held_out_frac)))
train, held_out = tasks[:cut], tasks[cut:]
```

`AggregatorConfig` **没有** `eval_tasks` 字段（草案编的）。所以 Node 必须把任务
**排好序后再传**：训练题在前、留出题在后，`held_out_frac = |holdout| / |all|`。
`holdoutPinned` 的语义相应改成「排序时强制排到尾部」。

`_checked_reward`（[evolution.py:292](../../../Documents/agentdescent/agentdescent/evolution.py)）
要求返回值可转 float **且落在 [0,1]**，否则抛 `RewardContractError` 并让整个 run 失败。
草案用 `reward: NaN` 表示 unscorable **会直接炸掉运行**——NaN 不满足 `0 <= x <= 1`。
正确做法见 §6.4。

### 0.7 其余较小但会咬人的点

| 事实 | 影响 |
|---|---|
| `self_verify=True` 是默认，**每个提案的 rollout 翻倍** | 我们每个 rollout 是一次完整分析，必须显式传 `self_verify=False` |
| `usage=` 只有在 AgentDescent 自己的模型适配器上才有数 | 我们的 `run` 对它不透明，token 恒为 0；**成本核算只能在 Node 侧**，草案里侧车推 `cost` 事件的设计删除 |
| ledger 参数名是 `repo_path`，不是 `ledger_path`；同路径再传即续跑 | 断点续跑不用自己实现 |
| 原生 `max_rollouts` / `max_calls` / `max_seconds` + `patience` / `target_reward` | 草案手写的"连续 3 轮无采纳"直接用 `patience` |
| `artifact_id` 必须匹配 `[A-Za-z0-9_.-]+` 且不得是 `oracle` / `audit_budget` / `merge_permissions` / `safety_constraints` | 这几个是普通词，用户技能真可能叫 `oracle`；建运行时要加前缀 |
| `refresh_interval=1`（默认）下 `eta` 恒为 0 | 同步路径上 staleness policy 什么也决定不了，草案"固定 Guarded"的说法无意义 |
| `FileTree.frozen` **只过滤提案**，真正强制靠 runner 的 pristine overlay | 我们自己跑 rollout，**必须自己实现 overlay**（见 §7.3） |
| 需要 ≥4 个任务；held_out < 4 会告警 | 与产品侧"少于 8 题不可信"的提示一致，但引擎的硬下限是 4 |
| `solved_threshold` 默认 0.999 | pairwise 的 1.0 正好命中；若用 absolute 加权分（很少到 0.999）必须调低，否则每轮都让反思器去"修"一个 0.95 分的答案 |
| `ExecutionRun` 已有 `createdFiles` / `modifiedFiles` / `exitCode` | 收集产出不用 diff 目录，按 executionId 取记录即可 |

---

## 1. 三个模块的边界：蒸馏 / 打标 / 评分

「整理轨迹」和「给轨迹打分」是**两个模块**，中间还夹着第三个。
把它们合成一个「轨迹处理器」是这个系统最容易犯的结构性错误——
它们的缓存键、失效条件、治理等级、触发时机、成本量级没有一项是一样的。

| 模块 | 输入 → 输出 | 用模型 | 跑几次 | 缓存键 | 治理 |
|---|---|---|---|---|---|
| **Distiller** 蒸馏 | 原始轨迹 → `Trajectory` + `methodChain` | 否（`ast` 静态解析） | 每 episode **一次** | `codeHash + extractorVersion` | 普通设施 |
| **Labeler** 打标 | `Trajectory` → `labelKeys` → 题族归属 | 规则层否 / 便签层是 | 每 (episode, 便签) 一次 | `episodeId + noteId + noteHash + trajHash` | 规则用户可读可改 |
| **Scorer** 评分 | (episode, 候选产出, rubric) → `reward` | 是 | 一次演进跑**几百遍** | `episodeId + artifactHash + rubricId + rubricHash` | **L0 冻结，不可演进** |

```
会话闲置 10 分钟
      ↓
 ┌──────────────┐  确定性、无模型调用、结果不可变
 │  Distiller   │  → Trajectory + methodChain
 └──────┬───────┘
        ↓
 ┌──────────────┐  规则层零成本；便签层才叫模型
 │   Labeler    │  → labelKeys → 落进题族
 └──────┬───────┘
        ↓
   题族 + Rubric        ← 到这里为止都是"平时"发生的，与演进无关
        ↓
   演进 / 健康度诊断 / 影子回归  才触发
        ↓
 ┌──────────────┐  贵、跑很多遍、随 rubric 变化
 │    Scorer    │  → reward
 └──────────────┘
```

### 1.1 为什么必须分开

**变更传播面完全不同。** 这是最硬的理由：

| 改了什么 | Distiller | Labeler | Scorer |
|---|---|---|---|
| 用户调了 rubric 权重 | 不动 | 不动 | **全部失效重算** |
| 用户改了一条便签的文字 | 不动 | **只有那条便签的判定失效** | 不动 |
| 升级了方法链抽取器 | **全部失效** | 全部失效 | 部分失效（judge 提示里含方法链） |
| 新增一个 episode | 只算新的 | 只算新的 | 不动（按需） |

合成一个模块，任何一次改动都会让全部缓存失效——而 Scorer 的一次全量重算是几百次
完整分析运行。这不是洁癖问题，是**每次调一下权重就烧掉一顿演进的钱**。

**治理等级不同。** Scorer 在 L0 冻结清单里（允许演进改评分标准，系统就会学"让自己得高分"）；
Distiller 是纯技术设施，改它不涉及安全；Labeler 的规则层反而**希望**用户能改。
三种东西塞进一个模块，L0 边界就画不出来了。

**失败降级不同。**

- Distiller 失败（代码语法错误、非 Python）→ 该 episode 降级为"只有题面和基线"，仍可用于 pairwise，只是不能参与规则打标
- Labeler 失败 → 归不进题族，episode 留在未分类池
- Scorer 失败 → 该次 rollout `unscorable`（§7.4），不影响 episode 本身

**成本量级差三个数量级。** 蒸馏是毫秒级本地解析；打标是每条便签一次模型调用（且缓存）；
评分是每次演进几百次完整分析 + 几百次 judge。三者放在同一个调度器里，
慢的会饿死快的。

### 1.2 一个必须避免的建模错误

> **分数不是轨迹的属性，是（轨迹, 口径）的属性。**

不要把 `reward` 存到 `Episode` 上。同一条轨迹在不同题族的不同 rubric 下分数不同，
而且同一个 rubric 改了权重之后分数还会变。分数只能存在 `evalCache` 里，
键必须包含 `rubricHash`——没有它，用户改完权重看到的还是旧分数，且完全无从察觉。

`Episode` 上可以存的是**信号**（用户点了踩、review 报了什么），
那才是轨迹的固有属性。

### 1.3 依赖是单向的，而且 Distiller 会被调用两次

`Scorer → Distiller` 单向：硬门要读 `exitCode` 与证据链，pairwise 的 judge 提示里要放方法链。
`Distiller` 不知道 `Scorer` 存在。

容易漏的一点：**Scorer 对 rollout 的产出也要跑一次 Distiller**。
成对比较不只比最终文本，还要比方法链差异（§3.5 的反思器提示就靠它），
而 rollout 同样产生 `ExecutionRun`。所以 Distiller 有两个调用点：
沉淀时对真实会话跑一次，评分时对每个候选 rollout 跑一次。
这进一步说明它必须是独立可复用的模块，而不是沉淀流程里的一段内联代码。

### 1.4 `extractorVersion`：唯一会静默出错的地方

抽取器一旦改动（加了 `TRACKED_KWARGS`、修了别名解析、支持了新库），
**所有 methodChain 都变了**。如果不带版本号：

- 旧 episode 的 `methodSet` 是老口径，新 episode 是新口径
- 规则在新旧上命中率不同 → 题族成员莫名其妙变化
- 聚类里新旧样本落进不同簇 → 簇碎掉，且看起来"就是数据本来如此"

所以 `extractorVersion` 必须同时进 **Trajectory 记录**和**缓存键**，
并且升级时提供一次全量重蒸馏（纯本地解析，不花模型钱，几分钟内完成）。
这是整条链路上唯一一个不会报错、只会给出错误结论的失败模式。

---

## 2. 沉淀：会话 → Episode

### 2.1 触发与幂等

```ts
// evolution/episodes.ts
const SEDIMENT_IDLE_MS = 10 * 60_000;

export function scheduleSediment(sessionId: string, store: Store) {
  timers.get(sessionId)?.refresh() ?? timers.set(
    sessionId,
    setTimeout(() => void sedimentSession(sessionId, store), SEDIMENT_IDLE_MS),
  );
}
```

挂在 run 结束的同一个位置（`runs/index.ts` 里落 `SessionRun` 终态之后），
每来一条新消息就 `refresh()`。会话归档时立即执行一次。

**幂等**：Episode 的 id 取 `sha256(sessionId + segmentStartMessageId)` 的前 16 位，
重复沉淀直接覆盖同一条记录，不产生重复题目。

### 2.2 切段

一个会话可能包含多个独立任务。切段规则：

```ts
interface Segment {
  startMessageId: string;
  userPrompt: string;
  assistantMessages: ChatMessage[];
  executionRunIds: string[];
  toolCallCount: number;
}

function segment(messages: ChatMessage[], runs: ExecutionRun[]): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | undefined;

  for (const m of messages) {
    if (m.kind && m.kind !== "message") continue;          // 跳过 review_notice / timeout_notice

    if (m.role === "user") {
      if (cur && isContinuation(m, cur)) {                  // 追问、纠正 → 并入当前段
        cur.assistantMessages.push(m);
        continue;
      }
      if (cur) out.push(cur);
      cur = { startMessageId: m.id, userPrompt: m.content,
              assistantMessages: [], executionRunIds: [], toolCallCount: 0 };
    } else if (cur) {
      cur.assistantMessages.push(m);
    }
  }
  if (cur) out.push(cur);

  for (const s of out) {
    const window = timeWindowOf(s, messages);
    s.executionRunIds = runs.filter(r => within(r.startedAt, window)).map(r => r.id);
    s.toolCallCount = countToolTraces(s, window);
  }
  return out.filter(keep);
}
```

`isContinuation` 是切段的核心判断，两级：

```ts
function isContinuation(m: ChatMessage, cur: Segment): boolean {
  // 1) 廉价规则先判：短、指代性、无新名词
  if (m.content.length < 40 && CONTINUATION_HINTS.test(m.content)) return true;   // 「再/还有/改成/不对/继续」
  if (m.references?.length && sharesArtifact(m.references, cur)) return true;

  // 2) 规则不确定时才叫模型（结果缓存在 messageId 上）
  return classifyContinuation(m.content, cur.userPrompt);   // judge 模型，二分类
}
```

**为什么不纯靠模型**：一个 30 轮会话要判 15 次，纯模型判定的成本和延迟都不划算，
而 80% 的情况规则就能定。模型只处理剩下的 20%。

`keep` 过滤器（不沉淀的段）：

```ts
const keep = (s: Segment) =>
  s.userPrompt.trim().length >= 20 &&
  s.toolCallCount > 0 &&                    // 纯聊天不构成题目
  s.assistantMessages.some(m => m.role === "assistant" && m.content.trim());
```

### 2.3 fixtures 快照

fixtures 必须是**该段开始那一刻**工作区里的输入文件，不是会话结束时的。
现有 `ArtifactDerivation` 记录了每个文件由哪些 `executionRunIds` 产生，据此反推：

```ts
async function fixturesAt(sessionId: string, segment: Segment, store: Store) {
  const derivations = await store.readArtifactDerivations(sessionId);
  const producedBefore = new Set(
    derivations
      .filter(d => d.executionRunIds.some(id => isBefore(id, segment)))
      .map(d => d.path),
  );

  const files = await listWorkspaceFiles(sessionId);
  const fixtures: Record<string, string> = {};

  for (const f of files) {
    if (f.kind === "artifact") continue;              // 产出不是输入
    if (producedBefore.has(f.path)) continue;         // 本会话早先生成的也不是输入
    if (f.size > MAX_FIXTURE_BYTES) continue;         // 默认 50 MiB，超限记 skipped
    fixtures[f.path] = (await cas.put(await readFile(f.path))).hash;
  }
  return fixtures;
}
```

被跳过的大文件记在 `episode.meta.skippedFixtures`，题族健康度里提示
「这道题有 2 个输入文件因超限未快照，重放结果不可比」。

### 2.4 baseline

```ts
function baselineOf(segment: Segment, derivations: ArtifactDerivation[], manifests: PromptManifest[]) {
  const final = [...segment.assistantMessages].reverse()
    .find(m => m.role === "assistant" && m.content.trim());

  const artifacts: Record<string, string> = {};
  for (const d of derivations) {
    if (d.executionRunIds.some(id => segment.executionRunIds.includes(id))) {
      artifacts[d.path] = d.contentRef.hash;          // 已在 CAS 里，直接引用
    }
  }

  const manifest = manifests.find(m => segment.covers(m.turnId));
  return {
    responseHash: (await cas.put(final!.content)).hash,
    artifacts,
    skillRefs: manifest?.skillRefs ?? [],
    executionRunIds: segment.executionRunIds,
  };
}
```

产出文件**不需要重新入 CAS**——`ArtifactDerivation` 里已经有 `contentRef`，直接引用即可。
这是复用现有溯源体系省下来的一大块工作。

### 2.5 信号抽取

```ts
function signalsOf(segment: Segment, ctx: SedimentContext): EpisodeSignal[] {
  const out: EpisodeSignal[] = [];

  const vote = ctx.votes.get(lastAssistantId(segment));
  if (vote) out.push({ kind: "explicit", verdict: vote.verdict, text: vote.text });

  const next = ctx.nextUserMessage(segment);
  if (next && isCorrection(next.content))
    out.push({ kind: "correction", text: next.content });

  if (ctx.downloads.some(d => segment.produced(d.path)))
    out.push({ kind: "artifact-downloaded" });

  if (!next && !ctx.downloads.length)
    out.push({ kind: "session-abandoned" });

  for (const f of ctx.reviewFindings(segment))
    out.push({ kind: "review-finding", severity: f.severity, code: f.code });

  return out;
}
```

`isCorrection` 与 `isContinuation` 同构：先规则（否定词、「应该」「不对」「重新」），
不确定再叫模型。二者共用一次模型调用——同一条消息既判「是否延续」也判「是否纠正」。

---

### 2.6 轨迹蒸馏：从"全都记了"到"能用"

**原始轨迹已经是完整的，不需要新记任何东西。** 现有落盘：

| 存储 | 内容 | 对演进的用处 |
|---|---|---|
| `run-events/<sid>/<runId>/*.jsonl` | 完整事件流；`tool.started`/`tool.completed` 带 `ToolTrace(args, outputStream)`，工具输出在 `tool-<toolCallId>.jsonl` | 动作序列的唯一来源 |
| `execution-runs/<sid>.json` | code / stdout / stderr 的 CAS 引用、`exitCode`、`createdFiles`、`environmentRevisionId` | **方法链的来源** |
| `prompt-manifests/<sid>.json` | 每轮 system prompt / 输入 / 响应的 CAS 引用、`skillRefs` | 归因：当时用了哪个技能版本 |
| `mcp-invocations/<sid>.json` | 请求、原始响应、规范化结果 | 检索策略 |
| `artifact-derivations/<sid>.json` | 文件 → 产生它的 `executionRunIds` | 产物归属 |
| `artifact-reviews/<sid>.json` | review findings | 负信号 |
| `claims` / `evidence-items` / `evidence-links` | 断言与证据链 | 溯源完整率 |

**所以真正的问题不是"怎么记"，是"太全了没法用"**：一个中等会话的 run-events 有几 MB，
塞不进反思器的上下文，也没法在上面做聚类。要做的是**蒸馏**，分三层：

```
L0 原始层   已有，只增引用，不动
   ↓ 沉淀时蒸馏一次
L1 规范轨迹 Trajectory —— 定长、可比较、人能读
   ↓ 静态抽取
L2 方法指纹 methodChain —— 聚类与规则匹配的特征
```

#### L1：规范轨迹

```ts
export type TrajectoryStep =
  | { kind: "search"; provider: string; query: string; resultCount: number }
  | { kind: "fetch"; host: string; ok: boolean }
  | { kind: "mcp"; source: string; tool: string; recordCount: number; contentScope: string }
  | { kind: "code"; language: ExecutionLanguage; codeHash: string; exitCode: number | null;
      methodOps: string[]; createdFiles: string[]; stderrHead?: string }
  | { kind: "read"; path: string; bytes: number }
  | { kind: "skill"; skillId: string; revision: number }        // read_skill 命中
  | { kind: "artifact"; path: string; artifactKind: string }
  | { kind: "review"; findings: Array<{ code: string; severity: string }> }
  | { kind: "permission"; action: string; resource: string; granted: boolean }
  | { kind: "user-correction"; text: string }
  | { kind: "elided"; count: number };                           // 中段折叠

export interface Trajectory {
  episodeId: string;
  steps: TrajectoryStep[];        // 上限 200，超出折叠中段
  methodChain: string[];          // L2，见下
  methodSet: string[];            // methodChain 去重排序，规则匹配用
  turns: number;
  toolCalls: number;
  wallClockMs: number;
  trajectoryHash: string;         // sha256(methodChain)，去重与缓存键
}
```

每一步只留摘要 + CAS 引用，原文留在原处。整个 Trajectory 是几 KB，
一万个 episode 也就几十 MB。

#### L2：methodChain —— 这一节是整套聚类能成立的原因

**科研 Agent 的失败模式绝大多数体现在方法链上，而方法链在代码里，可以静态抽取。**
「做了 t 检验但没做多重比较校正」不是一个需要语义理解的判断，
它是一个**对调用集合的谓词**。

从 `ExecutionRun.code`（CAS 里的原文）用 Python `ast` 抽：

```python
# services/api 用 execFile 拉起，与 paper worker 同样的按次子进程模式
def extract(code: str) -> list[str]:
    tree = ast.parse(code)
    alias = resolve_import_aliases(tree)        # import scipy.stats as st -> st = scipy.stats
    ops = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = qualified_name(node.func, alias)      # st.ttest_ind -> scipy.stats.ttest_ind
            if name is None or not of_interest(name):
                continue
            kw = sorted(k.arg for k in node.keywords if k.arg in TRACKED_KWARGS)
            ops.append(f"{name}({','.join(kw)})" if kw else name)
    return ops
```

三条要点：

1. **只留方法名和"关键 kwarg 是否出现"，不留任何值。**
   `pd.merge(validate)` 记的是"用了 validate 参数"，不是它等于什么。
   于是 methodChain **不含用户数据**，可以放心进 judge 和聚类；原始代码仍只在 CAS 里。
2. **别名解析是必须的**，否则 `import scipy.stats as st` 和 `from scipy.stats import ttest_ind`
   会被当成两个不同的方法，聚类立刻碎掉。
3. **非 Python 降级**：R / shell 用正则 + 关键词表抽，标 `confidence: "low"`，
   聚类时权重减半。宁可标出来，不要假装抽准了。

`TRACKED_KWARGS` 是刻意窄的白名单（`validate` / `yerr` / `ci` / `stratify` /
`random_state` / `method` / `alpha` / `correction`），因为它们的**存在与否**本身就是方法学信号。

---

## 3. 失败模式聚类

三层，从零成本到贵，输出统一落到同一个 `labelKey`。

### 3.1 层一：确定性方法学规则（第一天就能用）

一条规则就是对 `methodSet` 的谓词：

```ts
export interface MethodRule {
  key: string;                       // = labelKey
  title: string;                     // 用户看到的名字
  when: { all?: string[]; any?: string[]; none?: string[] };   // glob 匹配 methodSet
  confidence: "high" | "medium";
  rationale: string;                 // 为什么这算问题，进反思器提示
}

function hits(rule: MethodRule, t: Trajectory): boolean {
  const has = (g: string) => t.methodSet.some(m => minimatch(m, g));
  return (rule.when.all ?? []).every(has)
      && ((rule.when.any ?? []).length === 0 || (rule.when.any ?? []).some(has))
      && !(rule.when.none ?? []).some(has);
}
```

内置一批（可增删，用户可见）：

| key | when | 说明 |
|---|---|---|
| `missing-multiple-testing-correction` | all: `scipy.stats.*test*`；none: `statsmodels.stats.multitest.*`, `*fdrcorrection*`, `*bonferroni*` | 做了检验没校正 |
| `plot-without-uncertainty` | any: `*.bar`, `*.barplot`, `*.pointplot`；none: `*(yerr)`, `*(ci)`, `*errorbar*` | 图没有误差表达 |
| `parametric-without-normality-check` | any: `*ttest*`, `*f_oneway*`；none: `*shapiro*`, `*normaltest*`, `*levene*` | 参数检验前未验假设 |
| `leakage-scale-before-split` | all: `sklearn.preprocessing.*.fit_transform`, `*train_test_split*` | 顺序性泄漏（需序列而非集合，见下） |
| `unvalidated-join` | all: `pandas.merge`；none: `pandas.merge(validate)` | 合并未声明基数 |
| `silent-dropna` | all: `*.dropna`；none: `*.isna`, `*.isnull` | 丢了行但没报告丢了多少 |
| `nondeterministic-run` | any: `*.sample`, `sklearn.*`；none: `*(random_state)`, `*seed*` | 结果不可复现 |

`leakage-scale-before-split` 需要**顺序**而不是集合，所以规则再多一种形式：
`before: [A, B]` —— 在 `methodChain`（有序）里 A 的首次出现早于 B。

这一层的价值不在覆盖率，在**性质**：零成本、二值、可解释、可复现、可被用户审查和修改。
一个规则命中就是一句能直接写进证据卡的话。

**规则可以从便签"编译"出来**（半自动）：用户写「以后先做 BH 校正」→
模型草拟一条 `when` → 展示给用户确认 → 存为规则。
用户确认过的规则从此零成本，不再需要每次叫模型判。

### 3.2 层二：便签语义命中（规则写不出来的部分）

规则覆盖不了「这个结论没有回答用户真正问的问题」这类判断。这一层用 judge：

```ts
async function semanticLabels(t: Trajectory, ep: Episode, notes: EvolutionNote[]) {
  const ruleHit = new Set(matchRules(t).map(r => r.key));
  const out: string[] = [];
  for (const note of notes.filter(n => n.status === "active" && inScope(n, ep))) {
    if (note.compiledRuleKey && ruleHit.has(note.compiledRuleKey)) { out.push(note.id); continue; }
    if (note.compiledRuleKey) continue;                     // 已编译成规则且没命中 → 不用问模型
    const key = `${ep.id}:${note.id}:${hash(note.text)}:${t.trajectoryHash}`;
    if (await labelCache.getOrCompute(key, () => judgeHit(note, ep, t))) out.push(note.id);
  }
  return out;
}
```

关键是**先跑规则再跑模型**：已编译成规则的便签完全不花钱，只有纯语义的才叫模型。

judge 的输入是 **methodChain + 题面 + 产出摘要**，不是完整轨迹——
方法链是高信息密度的，而且不含数据。

### 3.3 层三：无监督发现（M3）

只对**带负信号**的 episode 跑（有 `correction` / `bad` / `review-finding`），
而且只对**规则和便签都没命中**的那些跑——那才是"未知的失败模式"。

```
特征 = methodChain 的 1~3-gram（权重 1.0）
     + review finding code（权重 1.5）
     + 失败信号类型（权重 0.5）
相似度 = 加权 Jaccard
聚类 = 单链，阈值 0.6
提示条件 = 簇大小 >= 5
```

**不用嵌入模型**。方法链已经是离散符号序列，n-gram Jaccard 在这个空间上比嵌入更准也更便宜，
而且零依赖——这和仓库现状（核心零必需依赖）一致。用户纠正文本的语义相似只在
Jaccard 聚不出来时才作为 M3 的可选补充。

**输出不是"簇"，是一句人能读懂的失败模式描述。** 最后一步必须有命名：

```
给模型：簇内 5 条的 methodChain 公共子序列 + 各自的用户纠正原文 + review findings
要它输出：{"title": "...", "description": "一句话说清共同问题", "suggestedRule": {when...} | null}
        ↓
   在 Evolution 面板上作为建议卡展示，用户确认后：
     → 成为一条新便签（立刻生效）
     → 成为一个新题族（可以开始演进）
     → suggestedRule 非空时，成为层一的一条新规则（此后零成本）
```

### 3.4 为什么不按题面聚类

这是整个设计最容易走错的一步，值得写死在文档里：

> **题面相似 ≠ 失败模式相同。**
> 两次转录组分析可能一次是校正问题、一次是批次效应问题；
> 两次完全不同领域的分析可能犯同一个方法学错误。
> **按题面聚 = 聚错维度**，聚出来的题族里没有共享的口径，演进学不到任何可迁移的东西。

题面相似度只用在一个地方：健康度诊断里的 `duplicateClusters`——
提醒用户「你的 8 道题里有 6 道几乎一样，有效样本其实是 3」。

### 3.5 轨迹进反思器：propose 质量的最大杠杆

`tree_reflector` 默认只给模型 `(prompt, output, reward, gold)`——
它看不到 Agent **做了什么**，只看到**产出了什么**，所以它写出的规矩往往是关于文风的。

我们自己实现 propose 回调，所以可以给得更多：

```
这次分析得分 {reward}。

任务：{prompt}

它实际执行的方法链：
  1. pandas.read_csv
  2. pandas.merge          ← 未声明 validate
  3. scipy.stats.ttest_ind （对 47 个基因逐一）
  4. seaborn.barplot       ← 无 yerr / ci
  产出：report.md, figure.png

命中的方法学问题：
  - missing-multiple-testing-correction：做了 47 次检验但方法链里没有任何校正调用
  - plot-without-uncertainty：柱状图没有误差表达

用户当初认可的做法，方法链里多出这些步骤：
  + statsmodels.stats.multitest.multipletests
  + matplotlib.pyplot.errorbar

{EDIT_PROTOCOL}
```

最后一段——**基线方法链与候选方法链的差集**——是这里信息量最高的东西：
它直接把「当初怎么做对的」摆在模型面前，而这完全是免费的，
因为基线的 ExecutionRun 本来就在 episode 里。

注意返回值必须是 `<EDITS>{...}</EDITS>` 协议文本（§0.5），
否则 `parse_edits` 返回 `{}`、`to_diff` 返回 `None`，这一轮的提案静默丢失。

## 4. 健康度诊断

```ts
export async function diagnose(family: TaskFamily, rubric: Rubric): Promise<TaskFamilyHealth> {
  const episodes = materialize(family, await store.readEpisodes(family.projectId));
  const scores: number[] = [];
  let swapAgree = 0, swapTotal = 0, ties = 0;

  // 用当前 stable 版本跑一遍，即"基线自评"
  for (const ep of sample(episodes, MAX_DIAGNOSE_TASKS)) {          // 默认最多 12 题
    const rollout = await runRollout(ep, stableArtifact(family), { diagnose: true });
    const { reward, breakdown } = await score(ep, rollout, rubric);
    scores.push(reward);
    if (breakdown.swap) { swapTotal++; if (breakdown.swap.agreed) swapAgree++; }
    if (reward === 0.5) ties++;
  }

  const verdict =
    episodes.length < 8                        ? "too-few"
  : swapTotal && swapAgree / swapTotal < 0.6   ? "unstable"
  : ties / scores.length > 0.6                 ? "no-signal"
  : dupClusters(episodes) < episodes.length / 2 ? "duplicated"
  : "healthy";

  return { episodeCount: episodes.length, ..., verdict, message: MESSAGES[verdict] };
}
```

**诊断本身要花钱**（最多 12 次 rollout + judge），所以：
异步执行、结果缓存在 `(familyId, rubricHash, episodeSetHash)` 上、
UI 上明确写「诊断约需 ¥X，约 Y 分钟」。

`dupClusters` 用题面的 3-gram Jaccard 相似度做单链聚类，阈值 0.7——
不需要嵌入模型，够用且零依赖。

---

## 5. T0 便签注入

挂在 system prompt 组装处，紧跟技能清单之后：

```ts
// packages/agent-runtime/src/system-prompt.ts
export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts = [BASE_PROMPT, toolSection(input.tools), skillCatalog(input.skills)];
  const notes = renderNotes(input.notes, input.noteBudgetTokens);
  if (notes) parts.push(notes);
  return parts.join("\n\n");
}

function renderNotes(notes: EvolutionNote[], budget: number): string | undefined {
  if (!notes.length) return undefined;
  const ordered = [...notes].sort((a, b) =>
    scopeRank(b.scope) - scopeRank(a.scope) ||                   // session > project > global
    lastHitAt(b).localeCompare(lastHitAt(a)));                   // 最近命中优先

  const lines: string[] = [];
  let used = 0;
  for (const n of ordered) {
    const line = `- ${n.text}  [${formatDate(n.createdAt)}]`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line); used += cost;
  }
  return `## 本项目的既有约定（用户此前提出，未经自动验证）\n${lines.join("\n")}`;
}
```

被截断的便签数写进 `PromptManifest.noteRefs.truncated`，
用户在设置页能看到「本项目有 40 条便签，每轮实际注入 23 条」——
这是提醒他该把便签升级成技能的信号。

`noteRefs` 是 `PromptManifest` 的新字段：`{ id, hash }[]`，
保证「这一轮模型看到了哪些便签」可复现。

---

## 6. Rollout 执行全路径

```ts
// evolution/rollout.ts
export async function runRollout(
  ep: Episode,
  candidate: CandidateArtifact,          // { skillId, revision } 或 { files }
  opts: RolloutOptions,
): Promise<RolloutResult> {
  const rolloutId = randomUUID();
  const release = await concurrency.acquire();                   // §10

  // 1. 真实 Session（§0.3）——工作区、权限纪元、provenance 都挂在它上面
  const session = await store.createSession(ep.projectId, `evo ${opts.runId}`);
  await store.markSessionKind(session.id, "evolution");           // 不进用户会话列表
  const workspaceRoot = store.workspacePath(session.id);

  try {
    // 2. 还原 fixtures
    for (const [path, hash] of Object.entries(ep.fixtures)) {
      const dest = resolveWorkspaceFile(workspaceRoot, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await cas.read(hash));
    }

    // 3. 候选技能：合成快照，不落盘（§0.1）；frozen 路径用原始内容覆盖（§7.3）
    const base = await skillCatalog.detail(opts.skillId);
    const files = { ...candidate.files, ...frozenOverlay(base, opts.frozenGlobs) };
    const skillSnapshot = candidateSnapshot(base, files);

    // 4. 非交互权限（§0.4）
    const denied: PrivilegeRequest[] = [];
    const permission = createRolloutPermissionRuntime(
      store.getPermissionEpoch(session.permissionEpochId)!, permissionBindings,
      (req) => denied.push(req));

    // 5. profile —— 沿用 subagent 的形状
    const profile = createSubagentProfile({
      gatewayThreadId: rolloutId,
      workspaceRoot,
      skills: [{ id: skillSnapshot.id, revision: skillSnapshot.revision, version: skillSnapshot.version }],
      connectorIds: opts.grantedConnectorIds,
      deniedToolNames: DENY_IN_ROLLOUT,
      maxModelTurns: opts.maxModelTurns ?? 40,
      runTimeoutMs: opts.runTimeoutMs,
      presetId: "evolution-rollout",
    });

    const workspace: WorkspaceAgentOptions = {
      config: agentConfig,
      enabledConnectorIds: opts.grantedConnectorIds,
      skills: [skillSnapshot],                       // ← 候选内容由此进入 read_skill
      ...createWorkspaceExecutionBindings({
        executionId: rolloutId, permission, permissionScopeLabel: "in evolution rollout",
        provenanceRecorder, runnerClient, sessionId: session.id, store, workspaceRoot,
        executionTimeoutMs: timeoutSettings.runnerExecTimeoutMs,
      }),
      // MCP / web 工具按 opts.grantedConnectorIds 装配，与主会话同构
    };

    const handle = createAgentRun(profile, {
      workspace, callbackUrl: internalCallbackUrl, gatewayUrl,
      abortSignal: opts.signal,
      observer: ev => events.emit(opts.runId, { kind: "rollout", rolloutId, ev }),
    }, {
      agentRunId: rolloutId, history: [], prompt: ep.prompt,
      purpose: "subagent_task", requestExecutionId: rolloutId,
    });
    const result = await handle.execute();

    // 6. 收集产出——读 ExecutionRun 记录，不 diff 目录（§0.7）
    const execRuns = (await store.readExecutionRuns(session.id)).filter(r => r.turnId === rolloutId);
    const artifacts: Record<string, string> = {};
    for (const path of new Set(execRuns.flatMap(r => [...r.createdFiles, ...r.modifiedFiles]))) {
      artifacts[path] = (await cas.put(await readFile(resolveWorkspaceFile(workspaceRoot, path)))).hash;
    }

    return {
      rolloutId,
      output: lastAssistantText(result.finalMessages),
      artifacts,
      executionFailed: execRuns.some(r => r.exitCode !== 0),
      reviewFindings: opts.collectFindings ? await quickReview(session.id, artifacts) : [],
      permissionDenied: denied.length > 0,
    };
  } finally {
    release();
    await store.deleteSession(session.id);        // 连工作区一起删；CAS 引用已存
  }
}
```

`DENY_IN_ROLLOUT` 固定禁掉与人交互或改变全局状态的工具：

```ts
const DENY_IN_ROLLOUT = [
  "review_checkpoint",        // 评审是打分环节的事，不能让候选自己触发
  "artifact_download",        // 无人值守下不做出站下载
  "remote_job_submit",        // 远程作业每次都要单独审批，无人值守下永远拒
];
```

### 6.1 非交互权限决策器

权限运行时现在是「查授权 → 没有就挂起等用户」。rollout 要把「挂起」替换成「拒绝」：

```ts
// agent-run/permission-runtime.ts
export interface PermissionRuntimeOptions {
  /** 无人值守模式：不挂起等待，直接按策略裁决 */
  nonInteractive?: { policy: "deny-new"; onDeny: (req: PermissionRequest) => void };
}

async function decide(req: PermissionRequest, opts: PermissionRuntimeOptions) {
  const grant = findActiveGrant(req);
  if (grant) return { allow: true, grantId: grant.id };

  if (opts.nonInteractive) {
    opts.nonInteractive.onDeny(req);
    return { allow: false, reason: "evolution-noninteractive" as const };
  }
  return await suspendAndAskUser(req);          // 原路径不变
}
```

被拒的次数记在 `deniedCount(rolloutId)`，
`RolloutResult.permissionDenied` 让硬门直接判 0，同时在运行看板聚合成
「N 题因权限受限失败」——这是用户排查策略配错的唯一线索。

---

## 7. 评分引擎

### 7.1 入口与短路

```ts
export async function score(ep: Episode, r: RolloutResult, rubric: Rubric) {
  const gate = checkHardGate(ep, r, rubric.hardGate);
  if (!gate.passed) return { reward: 0, breakdown: { gate, judged: false } };

  const cacheKey = `${ep.id}:${artifactHash(r)}:${rubric.id}:${rubricHash(rubric)}`;
  const hit = await evalCache.get(cacheKey);
  if (hit) return hit;

  const out = rubric.mode === "pairwise" ? await pairwise(ep, r, rubric)
            : rubric.mode === "absolute" ? await absolute(ep, r, rubric)
            : await viaScript(ep, r, rubric);

  await evalCache.set(cacheKey, out);
  return out;
}
```

```ts
function checkHardGate(ep: Episode, r: RolloutResult, g: RubricHardGate) {
  if (r.permissionDenied)                              return fail("permission-denied");
  if (g.requireExecutionSuccess && r.executionFailed)  return fail("execution-failed");
  if (g.requireArtifacts.length
      ? !g.requireArtifacts.every(p => Object.keys(r.artifacts).some(a => minimatch(a, p)))
      : Object.keys(r.artifacts).length === 0)         return fail("artifacts-missing");
  if (g.requireEvidenceChain && hasBrokenChain(r))     return fail("evidence-chain-broken");
  if (g.maxReviewFindingSeverity
      && r.reviewFindings.some(f => severityGT(f.severity, g.maxReviewFindingSeverity)))
                                                       return fail("review-severity");
  return { passed: true };
}
```

### 7.2 Pairwise：完整实现

```ts
const JUDGE_PROMPT = `你在比较两份针对同一个科研分析任务的产出，判断哪一份更好。

# 任务
{prompt}

# 评判维度
{dimensions}

# 产出 A
{a}

# 产出 B
{b}

只依据上面的维度判断。不要因为篇幅长、格式花哨而偏好某一份。
如果两份在所有维度上都难分高下，输出 tie。

只输出 JSON，不要任何其他文字：
{"winner": "A" | "B" | "tie", "reason": "一句话"}`;
```

```ts
async function pairwise(ep: Episode, r: RolloutResult, rubric: Rubric) {
  const baseline = await renderSide(ep.baseline);
  const candidate = await renderSide(r);
  const dims = rubric.dimensions.map(d => `- ${d.key}：${d.description}`).join("\n");

  const first = await askJudge(rubric, ep.prompt, dims, baseline, candidate);   // A=baseline
  if (!rubric.swapCheck) {
    return toReward(first.winner === "B" ? "win" : first.winner === "A" ? "loss" : "tie");
  }

  const second = await askJudge(rubric, ep.prompt, dims, candidate, baseline);  // A=candidate
  const firstSaysCandidate  = first.winner === "B";
  const secondSaysCandidate = second.winner === "A";

  const agreed =
    (first.winner === "tie" && second.winner === "tie") ||
    (first.winner !== "tie" && second.winner !== "tie" && firstSaysCandidate === secondSaysCandidate);

  if (!agreed) {
    return { reward: 0.5, breakdown: { judged: true, swap: { agreed: false }, verdict: "tie-by-disagreement" } };
  }
  const verdict = first.winner === "tie" ? "tie" : firstSaysCandidate ? "win" : "loss";
  return { reward: verdict === "win" ? 1 : verdict === "tie" ? 0.5 : 0,
           breakdown: { judged: true, swap: { agreed: true }, verdict,
                        reason: first.reason } };
}
```

`renderSide` 是**对称截断**——两侧必须用同一口径，否则截断本身就成了偏好来源：

```ts
async function renderSide(side: { responseHash?: string; output?: string; artifacts: Record<string,string> }) {
  const text = side.output ?? await cas.read(side.responseHash!);
  const files = await Promise.all(
    Object.entries(side.artifacts).sort(([a],[b]) => a.localeCompare(b)).slice(0, MAX_FILES)
      .map(async ([p, h]) => `### ${p}\n${truncate(await readTextish(h), PER_FILE_CHARS)}`));
  return `${truncate(text, RESPONSE_CHARS)}\n\n${files.join("\n\n")}`;
}
```

二进制产出（图片、pdf）只列文件名与大小，不进 judge 上下文。

`askJudge` 走既有模型调用路径，记账类型 `evolution-judge`，
请求与响应入 CAS 并写 PromptManifest。解析失败重试一次，再失败记 tie 并计入
`judgeParseFailures`——连续失败率高说明 judge 模型选得不对，健康度里要报出来。

### 7.3 Absolute

```ts
async function absolute(ep: Episode, r: RolloutResult, rubric: Rubric) {
  const w = rubric.autoSignalWeights ?? { hardGate: 0.4, provenance: 0.3, semantic: 0.3 };
  const provenance = evidenceChainCompleteness(r) * citationPassRate(r);
  const semantic = rubric.dimensions.length
    ? (await askScorer(rubric, ep.prompt, await renderSide(r))).weightedMean / 10
    : 1;
  return { reward: clamp01(w.hardGate * 1 + w.provenance * provenance + w.semantic * semantic),
           breakdown: { judged: true, provenance, semantic } };
}
```

硬门项恒为 1 是因为没过硬门早就返回 0 了——这一项的作用是"过了硬门就先拿 0.4 分"，
让「跑通但质量一般」和「没跑通」拉开距离。

### 7.4 Script

```ts
async function viaScript(ep: Episode, r: RolloutResult, rubric: Rubric) {
  const payload = JSON.stringify({
    prompt: ep.prompt,
    candidate: { output: r.output, artifacts: r.artifacts },
    baseline: { responseHash: ep.baseline.responseHash, artifacts: ep.baseline.artifacts },
  });
  const res = await runner.execute({
    language: "python",
    code: await cas.read(rubric.script!.sourceHash),
    stdin: payload,
    timeoutMs: rubric.script!.timeoutMs,
    networkPolicy: "none",
  });
  const last = res.stdout.trim().split("\n").at(-1) ?? "";
  const v = Number.parseFloat(last);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    return { reward: null, breakdown: { unscorable: true, stderr: res.stderr.slice(0, 500) } };
  }
  return { reward: v, breakdown: { judged: true, script: true } };
}
```

`reward: null` 是 `unscorable` 的载体，**不能记 0**（记 0 等于告诉引擎"候选在这题上很差"，
污染梯度），**更不能返回 NaN**——`_checked_reward` 要求落在 `[0,1]`，NaN 会抛
`RewardContractError` 让整个 run 失败（§0.6）。

引擎没有"跳过一道题"的入口，所以处理必须发生在**进入引擎之前**：

- **建题集时**就把已知不可评分的 episode 剔除（脚本口径先在健康度诊断里试评一遍）；
- **运行期**出现的 unscorable，侧车的 `reward` 回调返回 `0.5`（中性，不产生梯度）
  并把 taskId 记进 `unscorable[]` 回传 Node；
- Node 侧统计：unscorable 比例 > 30% 时暂停运行并报「你的评分脚本有问题」。

---

## 8. evolve 侧车

### 8.1 `server.py`

```python
app = FastAPI()
RUNS: dict[str, Run] = {}

@app.post("/evolve")
async def evolve_endpoint(req: EvolveRequest):
    bridge = Bridge(req.callback_url, req.run_id, req.signature_key)
    run = Run(req, bridge)
    RUNS[req.run_id] = run
    return StreamingResponse(run.stream(), media_type="application/x-ndjson")

@app.post("/cancel/{run_id}")
async def cancel(run_id: str):
    RUNS[run_id].cancel()
    return Response(status_code=202)
```

`Run.stream()` 在线程里跑 `evolve()`，把 `on_round` 回调塞进队列，主协程从队列读并 yield NDJSON。

### 8.2 `bridge.py`

```python
class Bridge:
    def post(self, kind: str, **payload):
        body = {"runId": self.run_id, **payload}
        for attempt in range(3):
            r = httpx.post(f"{self.base}/internal/evolve-cb/{kind}",
                           json=body, headers=self._sign(body), timeout=self.timeout)
            if r.status_code < 500:
                r.raise_for_status()
                return r.json()
            time.sleep(2 ** attempt)
        raise BridgeError(f"{kind} failed after retries")
```

签名复用 gateway `/internal/tool-exec` 的同一套回环请求签名（含新鲜度窗口）。
`run` 回调超时设为 `runTimeoutMs + 30s`，比 rollout 本身长——超时意味着 Node 侧真的挂了。

### 8.3 `runner.py`：绑定 AgentDescent

```python
from agentdescent import evolve, async_evolve, Task
from agentdescent.treestrategy import FileTree
from agentdescent.filetree import parse_tree

def build_and_run(req, bridge, emit):
    strategy = FileTree(initial_files=req.artifact.files,
                        editable=req.editable, frozen=req.frozen,
                        max_files_per_diff=req.config.max_files_per_diff)

    tasks = [Task(id=t.id, prompt=t.prompt, meta=t.meta) for t in req.tasks]

    def run(rendered, task):
        # rendered 是 filetree.canonical(state) 的 JSON 串,不是 dict
        return bridge.post("run", taskId=task.id,
                           artifact={"files": parse_tree(rendered)})["output"]

    def reward(task, output):
        r = bridge.post("reward", taskId=task.id, rolloutId=bridge.last_rollout(task.id))
        if r.get("unscorable"):
            unscorable.append(task.id)
            return 0.5                          # 中性;绝不能是 NaN 或 None（§0.6）
        return r["reward"]

    def propose(rendered, task, output, reward_value):
        # 返回值必须是 EDIT_PROTOCOL 的 <EDITS>{...}</EDITS> 文本,由 parse_edits 解析
        return bridge.post("propose", taskId=task.id, reward=reward_value,
                           artifact=parse_tree(rendered))["proposal"]

    engine = async_evolve if req.config.asynchronous else evolve
    return engine(
        tasks, reward, run=run, propose=propose, strategy=strategy,
        artifact_id=req.artifact_id, blast_radius=req.config.blast_radius,
        rounds=req.config.rounds, n_workers=req.config.n_workers,
        max_concurrency=req.config.max_concurrency,
        fusion_tournament=req.config.fusion_tournament,
        held_out_frac=req.config.held_out_frac,   # 任务已按 训练在前/留出在后 排好（§7.4）
        self_verify=False,                        # 默认 True 会让 rollout 翻倍（§0.7）
        solved_threshold=req.config.solved_threshold,
        max_rollouts=req.config.max_rollouts,
        max_seconds=req.config.max_seconds,
        patience=req.config.patience,             # 收敛早停,不用自己数（§0.7）
        on_round=emit,
        repo_path=req.repo_path,                  # 同路径再传即续跑
    )
```

**为什么是 `TreeStrategy` 而不是 `evolve_skill_dir`**：后者自带 `tree_runner`，
会在侧车本地物化目录并调本地 agent 跑——那样 rollout 就绕过了 Node 的沙箱与权限。
我们要的是它的 state-key-是文件路径 的合并语义（改不同文件 fuse、改同一文件按 holdout 裁决），
执行必须留在 Node。

`FileTree.frozen` **只过滤提案**，不保证物化出来的文件是原始的——真正的强制在
`runners.tree_runner` 的 pristine overlay 里，而我们不用它（rollout 在 Node 侧）。
所以 **overlay 必须由 Node 自己做**：`strategy.frozen_files(base_files)` 拿到原始内容，
在 §5 组装候选快照时最后覆盖一遍（`{ ...candidate.files, ...frozenOverlay(...) }`）。
漏掉这一步，候选就能通过改 `scripts/**` 影响自己的评分。

### 8.4 holdout 的传递

**`AggregatorConfig` 没有 `eval_tasks` 字段**（§0.6）。切分完全由 `evolve()` 内部按位置完成：

```python
cut = max(1, round(len(tasks) * (1 - held_out_frac)))
train, held_out = tasks[:cut], tasks[cut:]
```

所以分离是 **Node 侧排序 + `held_out_frac`** 的组合，且必须成对传：

```ts
const train   = episodes.filter(e => !isHoldout(e, family));
const holdout = episodes.filter(e =>  isHoldout(e, family));
const tasks   = [...train, ...holdout];                     // 顺序即语义
const heldOutFrac = holdout.length / tasks.length;
```

两条护栏：`shuffle` 必须保持 `false`（默认），否则引擎会打乱这个顺序；
`tasks.length >= 4` 且 `holdout.length >= 4`，后者不满足引擎只告警不报错，
所以要在 Node 侧自己拦。

---

## 9. 提案落地为 dev revision

```ts
// evolution/channels.ts
export async function approve(proposalId: string): Promise<{ skillId: string; revision: number }> {
  const p = await store.readProposal(proposalId);
  if (p.layer === "L0") throw new ForbiddenError("frozen-layer");
  if (p.status !== "pending") throw new ConflictError(p.status);

  const skill = await skills.detail(p.target.id);
  const patched = applyDiff(skill, p.diff);                    // 见下

  // 复用既有技能更新路径 → 产生真实的不可变 revision
  const updated = await skills.update(p.target.id, {
    name: skill.name,
    description: patched.frontmatter.description ?? skill.description,
    instructions: patched.instructions,
    expectedRevision: skill.currentRevision,                   // 乐观锁
    metadata: { ...skill.frontmatter.metadata, evolvedFrom: p.runId },
  });

  await store.appendChannel({
    skillId: p.target.id, revision: updated.currentRevision, channel: "dev",
    origin: { kind: "evolution", runId: p.runId, proposalId },
    evidence: p.evidence,
    shadow: { passed: 0, required: settings.shadowRequiredPasses, regressions: 0 },
    createdAt: nowIso(),
  });

  await store.updateProposal(proposalId, { status: "approved", decision: { by: "user", at: nowIso() } });
  return { skillId: p.target.id, revision: updated.currentRevision };
}
```

**`skills.update` 会把新 revision 写进 catalog，`currentRevision` 前进。**
这里有一个必须处理的语义冲突：`currentRevision` 前进后，那些按
`enabledSkillIds` 选中该技能的会话会自动用上新版本——而 dev 版本不应该被用户会话看到。

解决办法是在技能解析时加一层通道过滤：

```ts
// skills.ts：运行开始时解析冻结快照
export function resolveForRun(skillId: string): AgentResourceRef {
  const stable = channels.latestStable(skillId);              // 没有记录 → 视为 stable
  return { id: skillId, revision: stable ?? descriptor.currentRevision };
}
```

`channels.latestStable` 返回该技能最后一个 `channel: "stable"` 的 revision。
手工编辑产生的 revision 在写入时自动记 `channel: "stable"`，
所以现有行为完全不变；只有演进产生的 revision 默认落在 dev。

### 9.1 `applyDiff`

提案的 `ops` 是 **`{路径: 完整新内容 | null}`**，不是 unified diff（§0.5）。
所以"应用"就是整文件写入——风险不是补丁打不上，而是**静默覆盖审批期间的人工编辑**。
拦截靠内容哈希，不靠补丁冲突：

```ts
function applyOps(skill: SkillDetail, p: Proposal) {
  const files = toFileMap(skill);                              // SKILL.md + resources

  // 候选是基于提案生成那一刻的内容算出来的。技能在排队期间被手工改过 →
  // 整文件写入会悄悄吃掉那次手工编辑。所以先比哈希。
  if (sha256(canonicalTree(files)) !== p.baseTreeHash) {
    throw new ConflictError("skill-changed-since-proposal");
  }

  for (const [path, content] of Object.entries(p.ops)) {
    if (FROZEN_GLOBS.some(g => minimatch(path, g))) throw new ForbiddenError(`frozen:${path}`);
    if (content === null) delete files[path];                  // ops 里的 null = 删除
    else files[path] = content;                                // 整文件替换
  }
  const parsed = parseSkillMarkdown(files["SKILL.md"]);        // 复用既有解析与校验
  if (!parsed.ok) throw new ValidationError(parsed.diagnostics);
  return parsed;
}
```

`skill-changed-since-proposal` 时提案置 `superseded`，UI 提示
「技能已被手工修改，这条建议需要重新演进」——**不做自动 rebase**，
因为整文件替换根本没有可合并的粒度，而科研技能的语义冲突也不能靠三方合并猜。

`Proposal` 因此要多存一个 `baseTreeHash`（生成候选时的技能树哈希）与
`ops: Record<string, string | null>`（替代早期草案的 `diff: Record<string,string>`）。
展示给用户的 unified diff 是**渲染时现算**的 `ops` vs 当前内容，不落盘。

---

## 10. 影子回归与转正

### 10.1 影子调度

```ts
// evolution/shadow.ts —— 挂在沉淀完成之后
export async function onEpisodeSedimented(ep: Episode) {
  if (!settings.enabled) return;
  const candidates = await channels.devRevisions(ep.projectId);
  for (const c of candidates) {
    if (!episodeCoversSkill(ep, c.skillId)) continue;          // 这道题没用到该技能，跳过
    await shadowQueue.push({ episodeId: ep.id, ...c });
  }
}

async function processShadow(job: ShadowJob) {
  const family = await families.forEpisode(job.episodeId);
  const rubric = await store.readRubric(family.rubricId);

  const devRun    = await runRollout(ep, { skillId: job.skillId, revision: job.revision }, opts);
  const stableRun = await runRollout(ep, { skillId: job.skillId, revision: stableOf(job.skillId) }, opts);

  const { reward } = await scorePair(ep, devRun, stableRun, rubric);   // dev 作为候选，stable 作为基线
  if (reward >= 0.5) {
    await channels.bumpShadow(job, { passed: +1 });
  } else {
    await channels.bumpShadow(job, { passed: "reset", regressions: +1 });
  }
}
```

**为什么要跑两次 rollout 而不是拿 episode.baseline 当对照**：baseline 是用户当初收到的，
可能是在更老的技能版本、甚至是手工修正过的。判「dev 比 stable 好」必须两边都现跑，
否则测的是「dev 比历史好」，那不是转正需要的证据。

影子作业**只在空闲时跑**，队列深度上限 20，超出丢弃最旧的——
影子是锦上添花，不能拖垮交互。

### 10.2 转正闸门

```ts
export async function promote(skillId: string, revision: number, force = false) {
  const rec = await channels.get(skillId, revision);
  if (rec.channel !== "dev") throw new ConflictError("not-a-dev-revision");

  if (!force) {
    if (rec.shadow!.passed < settings.shadowRequiredPasses)
      throw new PreconditionError("shadow-incomplete", rec.shadow);

    if (settings.requireRealRegression) {
      const real = await runRegressionCheck(skillId, revision, { source: "sediment" });
      if (real.episodeIds.length === 0) throw new PreconditionError("no-real-episodes");
      if (!real.result.passed)          throw new PreconditionError("real-regression", real);
    }
  }

  await channels.setChannel(skillId, revision, "stable", {
    promotedAt: nowIso(),
    unverified: force || undefined,        // 逃生门留痕，时间线上永久标注
  });
}
```

### 10.3 回归检查

```ts
async function runRegressionCheck(skillId: string, candidate: number, filter: { source: EpisodeSource }) {
  const eps = (await episodesUsing(skillId)).filter(e => e.source === filter.source);
  const sample = pick(eps, MAX_REGRESSION_TASKS);              // 默认 10

  const results = await mapLimit(sample, concurrency.limit, async ep => {
    const family = await families.forEpisode(ep.id);
    const rubric = await store.readRubric(family.rubricId);
    const dev    = await runRollout(ep, { skillId, revision: candidate }, opts);
    const stable = await runRollout(ep, { skillId, revision: stableOf(skillId) }, opts);
    return { ep, reward: (await scorePair(ep, dev, stable, rubric)).reward };
  });

  const regressed = results.filter(r => r.reward < 0.5).map(r => r.ep.id);
  return { result: { passed: regressed.length === 0, delta: mean(results.map(r => r.reward)) - 0.5, regressed },
           episodeIds: sample.map(e => e.id) };
}
```

判据是**零回归**，不是平均分提升——一条学到的规矩让任何一道真实题变差，都不该进正式版。

---

## 11. 并发闸与调度

```ts
// evolution/budget.ts
class RolloutGate {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    while (true) {
      if (settings.idleOnly && await hasActiveSessionRun()) {
        await sleep(IDLE_POLL_MS);                             // 默认 5s
        continue;
      }
      if (this.inFlight < settings.rolloutConcurrency) break;
      await new Promise<void>(r => this.queue.push(r));
    }
    this.inFlight++;
    return () => { this.inFlight--; this.queue.shift()?.(); };
  }
}
```

`hasActiveSessionRun()` 查现有的 `RuntimeStatus.sessionRuns`。
**在途 rollout 不中断**——已花的 token 不退，杀掉纯亏。
用户点 Stop 才走真正的中止链路。

预算硬停挂在同一个闸上：

```ts
async acquire() {
  if (run.costCents >= run.config.budget.maxCostCents) throw new BudgetExhausted();
  if (Date.now() - startedAt >= run.config.budget.maxWallClockMs) throw new BudgetExhausted();
  if (run.rolloutCount >= run.config.budget.maxRollouts) throw new BudgetExhausted();
  ...
}
```

`BudgetExhausted` 传到侧车 → 侧车停止派发新任务 → 干净收尾 → 状态置 `budget-exhausted`，
ledger 保留可续跑。

### 11.1 收敛判定

```ts
function checkConvergence(run: EvolutionRun): boolean {
  const recent = run.rounds.slice(-settings.convergenceRounds);   // 默认 3
  return recent.length === settings.convergenceRounds
      && recent.every(r => r.accepted === 0);
}
```

命中即 `converged` 停止。UI 文案是「在当前口径下已达上限，继续投入不会更好」——
这是**正确结果**，不能显示成失败。

---

## 12. 导入解析

### 12.1 形态 B（输入 + 已认可结果）

```
批次目录/
  case-001/
    prompt.txt          # 可选；缺省用目录名
    input/              # → fixtures
      raw.csv
    output/             # → baseline.artifacts
      report.md
      figure.png
```

```ts
async function parseDirectoryBatch(root: string, projectId: string): Promise<Episode[]> {
  const out: Episode[] = [];
  for (const dir of await subdirs(root)) {
    const prompt = (await readIfExists(join(dir, "prompt.txt"))) ?? humanize(basename(dir));
    const fixtures = await putAll(join(dir, "input"));
    const artifacts = await putAll(join(dir, "output"));
    if (!Object.keys(fixtures).length && !prompt) { skipped.push(dir); continue; }

    out.push({
      id: `imp_${sha256(`${root}:${dir}`).slice(0, 16)}`,
      source: "import", projectId, prompt, fixtures,
      baseline: {
        responseHash: (await cas.put(await synthesizeResponse(artifacts))).hash,
        artifacts, skillRefs: [], executionRunIds: [],
      },
      signals: [{ kind: "explicit", verdict: "good" }],       // 用户认可过，所以是正例
      labels: [], holdoutPinned: false, createdAt: nowIso(),
    });
  }
  return out;
}
```

`synthesizeResponse` 把 output 目录的文件清单 + 主文档正文拼成一段"当初的回复"，
因为 pairwise judge 需要文本侧的对照。若 output 里有 `report.md` 就直接用它。

### 12.2 形态 A（CSV/JSONL）

preview 阶段返回列名与**猜测的映射**：

```ts
const GUESS = {
  prompt: [/^(prompt|question|query|input|题面|问题)$/i],
  gold:   [/^(gold|answer|expected|output|label|答案)$/i],
  files:  [/^(files?|attachments?|inputs?)$/i],
};
```

用户确认后 commit。`gold` 列直接进 `baseline.responseHash`。

### 12.3 三题试评

```ts
async function preview(batch: ImportBatch, rubric: Rubric) {
  const sample = batch.episodes.slice(0, 3);
  const trials = await mapLimit(sample, 1, async ep => {
    const r = await runRollout(ep, stableRef(batch.targetSkillId), { diagnose: true });
    const s = await score(ep, r, rubric);
    return { prompt: ep.prompt, reward: s.reward, reason: s.breakdown.reason,
             gate: s.breakdown.gate };
  });
  return { batchId: batch.id, trials, estimatedCostCents: batch.episodes.length * perTrialCost(trials) };
}
```

三题全 0 或全 1 时前端直接拦：「映射或口径可能有问题，先看看这三题的判分理由」。

---

## 13. 事件桥接

侧车 NDJSON → Node → SSE，中间只做一次转换：

```ts
// evolution/runs.ts
for await (const line of ndjson(evolveResponse.body)) {
  const ev = JSON.parse(line) as EvolveEvent;
  await appendJsonl(runEventsPath(runId), ev);          // 落盘，供刷新后重放

  switch (ev.kind) {
    case "round":
      run.rounds.push(ev.payload);
      run.costCents += ev.payload.costCents;
      break;
    case "accept":
      await proposals.createFromDraft(runId, ev.payload);      // 建 Proposal
      break;
    case "cost":
      run.costCents += ev.payload.deltaCents;
      if (run.costCents >= run.config.budget.maxCostCents) void stopRun(runId, "budget");
      break;
    case "done":
      run.status = ev.payload.status;
      run.endedAt = nowIso();
      break;
  }
  sse.broadcast(runId, ev);
  await store.writeRun(run);
}
```

前端刷新时先 `GET /runs/:id` 拿终态，再从 `run-events` 重放画曲线，
最后接上 SSE——与现有 `run-stream` 的处理方式一致。

---

## 14. 自动采纳路径

`autoAcceptL2 = true` 时，`accept` 事件不进待审队列，直接走 `approve()`：

```ts
async function onAccept(runId: string, draft: ProposalDraft) {
  const p = await proposals.createFromDraft(runId, draft);
  const auto = settings.autoAcceptL2
    && p.layer === "L2"
    && !isScheduledRun(runId)                             // 夜间运行强制人工
    && family.health?.verdict === "healthy"               // 题集不健康不自动
    && p.evidence.effectProbability >= 0.9
    && p.evidence.noRegression.unchanged === p.evidence.noRegression.total;

  if (auto) await approve(p.id, { by: "auto" });
}
```

四个额外条件都是必须的：夜间无人、题集不健康、有效概率不够、有任何回归——
任一命中就退回人工。**自动采纳仍然只进 dev 通道**，转正永远要人点。

---

## 15. 否决指纹

「永久否决此类改动」需要一个跨运行稳定的指纹：

```ts
function vetoFingerprint(p: Proposal): string {
  const normalized = Object.entries(p.diff)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([path, patch]) => `${path}\n${addedLines(patch).map(normalizeText).join("\n")}`)
    .join("\n---\n");
  return sha256(`${p.target.kind}:${p.target.id}:${normalized}`).slice(0, 32);
}
```

`normalizeText`：去标点、压空白、转小写。只看**新增行**，不看上下文，
所以同一条规矩在技能不同位置被再次提出时仍然命中同一个指纹。

新提案生成时先查否决表，命中则直接标 `vetoed` 不入队。

---

## 16. 相关文档

- [self-evolution.md](self-evolution.md) — 产品与用户视角
- [self-evolution-implementation.md](self-evolution-implementation.md) — 数据模型、接口、存储、分期
- [control-plane.md](control-plane.md) — 运行编排与权限系统（rollout 复用其执行路径）
- [review-provenance.md](review-provenance.md) — CAS、ArtifactDerivation、PromptManifest
- [subagent-orchestration.md](subagent-orchestration.md) — SubagentProfile 契约
