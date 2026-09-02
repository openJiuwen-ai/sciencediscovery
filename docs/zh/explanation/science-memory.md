# 科学记忆（任务链与引用链）

科学记忆是 ScienceDiscovery 的一个**实验性、默认关闭**的可选功能，把一个会话的执行过程与论证过程存成一张 Neo4j 图。它的价值是让"这个结论是怎么来的"可被回溯与点击：从研究目标，到每一步任务、跑的代码、产出的文件，再到最终报告里的每一条带引用的断言（Claim）及其支撑证据。

图谱里两条核心链路：

- **任务链（Task chain）**：`ResearchGoal → Task → ToolCall → Code/Artifact/Paper`，由 `next` 时序边与 `produces` 产出边串起来，回答"做了哪些事、按什么顺序"。
- **引用链（Citation chain）**：`报告 Artifact ←stated_in— Claim ←supports— Evidence ←extracts— Paper`，由 declare 工具显式写入，回答"报告里每句话引用了什么"。

两者在 **Claim** 与 **Artifact** 节点交汇：一条 Claim 既被其支撑的 Evidence/Artifact 通过 `supports` 边指向，又被报告 Artifact 通过 `stated_in` 边记录；一个 Artifact 既是任务链里 `ToolCall -produces->` 的产物，又可能是引用链里被 `supports` 指向的对象。

## 1. 主要模块

科学记忆横跨四个层，各自职责：

- **前端 `apps/web`**：只读。渲染图谱（缩略卡 + 全屏浏览器）、把报告里的 `[alias]` 渲染成可点 chip、点击后分发到证据/产物/图节点详情。不直接连图谱，所有读请求经 Node API。
- **共享包 `packages`**：`schema` 定义跨包类型（节点/边、Declare 输入、ComposerReference、报告版本 references）；`agent-runtime` 定义 LLM 可调的工具（`query_graph` / `declare_*`）并在功能开启时把 declare 流程注入系统提示。两者让前端、Node、工具三者不漂移。
- **控制面 `services/api`（Node）**：唯一与图谱直连的客户端。做两件事——① 执行事件发生时 fire-and-forget 镜像写图、接收 LLM 工具回调做 declare；② 对浏览器反向代理 `/api/memory/*` 读请求。报告版本落盘时把 chip references drain 到版本上。
- **图侧车 `services/memory-graph`（Python）**：FastAPI 服务，回环 `:17674`，Bearer 鉴权。把 Node 发来的写入落成 Neo4j 节点/边（`persistence.py`），响应读查询（`query.py`）。Neo4j 不可达时静默降级，不抛错。

四层交互流向（写与读两条独立路径，都经 Node API）：

```
【写】执行事件 / LLM 工具回调 ──触发──> Node API ──fire-and-forget 写──> Python 侧车 ──Cypher──> Neo4j
【读】浏览器 ────────────────────────> Node API ──反向代理──────────> Python 侧车 ──Cypher──> Neo4j

旁路：agent-runtime 定义 LLM 工具、schema 定义跨包类型（约束工具/类型，不直接参与数据流）
```

写图全部由 Node API 发起（执行镜像 + declare），浏览器只读、gateway 与 runner 不参与；Python 侧车只被 Node API 访问，是闭环单客户端。

### 1.1 节点类型（9 类）

| 节点 label | 代表 | 唯一键 / 来源 |
|------------|------|---------------|
| `ResearchGoal` | 本会话的研究目标 | `goal_id`（Node 侧确定性生成，重发幂等） |
| `Task` | subagent 的 scope（每个 subagent 运行一个节点，`task_type='subagent'`） | `task_id` |
| `ToolCall` | 一步具体任务——一次代码执行或一次文献检索 | `task_id` |
| `Code` | 一段执行的代码 | `code_id` |
| `Artifact` | 产出文件版本（图、CSV、报告本身……） | `artifact_id` |
| `Paper` | 文献记录 | 复合 `(session_id, link)`，`link` 经 `_normalize_link` 归一化 |
| `Evidence` | 从 Paper 抽取的一条证据 | `evidence_id` |
| `Claim` | 报告里一条带引用的断言 | `claim_id` |
| `SourceFile` | 用户上传的输入文件（CSV/图片/JSON/PDF……） | `file_id`（确定性 `source_file:session:<sid>:<path>`，重传幂等） |

### 1.2 边类型（9 类）

| 边类型 | 方向 | 含义 | 属于 | 写入方 |
|--------|------|------|------|--------|
| `next` | ResearchGoal→head / ToolCall→ToolCall / Task(scope)→首个 ToolCall | 时序链：按 `finished_at` 排序的执行先后（subagent 的 scope 通过 `next` 连到其首个子 ToolCall） | 任务链 | `_link_subtasks_by_finish_time`（重建式幂等） |
| `produces` | ToolCall→Code/Artifact/Paper；Task(scope)→子 ToolCall 的 Code/Artifact | 一步任务产出了什么（subagent 的 scope 产出的是其子任务的产品，scope 自身不产） | 任务链 + 引用链 | `upsert_execution` / `upsert_mcp_search` / `declare_claim` |
| `extracts` | Paper→Evidence | 证据从哪篇文献抽取 | 引用链 | `declare_evidence` |
| `supports` | Evidence/Artifact→Claim | 断言的支撑来自什么 | 引用链 | `declare_claim` |
| `stated_in` | Claim→报告 Artifact | 这条 claim 记录在哪份报告 Artifact 里 | 引用链（任务链↔引用链交汇） | `declare_claim`（传 artifact_id 时）/ `link_claims_to_report` |
| `supersedes` | Artifact(新)→Artifact(旧) | 该版本取代其前驱 | 版本谱系（任务链） | `upsert_execution` |
| `input` | Artifact(读取版本)/SourceFile→Code | 这次代码执行把该 artifact 版本或上传文件作为输入读了 | 数据依赖（任务链） | `upsert_execution` |
| `contains` | Task(scope)→首个子 ToolCall | subagent 的 scope 把它的子任务步归组 | 任务链（subagent 作用域） | `_link_subtasks_by_finish_time` |
| `feeds` | SourceFile→ResearchGoal | 该上传文件为本研究提供输入 | 上传镜像（任务链前置） | `upsert_source_file`（上传完成即 fire-and-forget） |

## 2. 主要流程

### 2.1 任务链的被动镜像（无 LLM 参与）

任务链不需要 LLM 显式声明，由 Node API 在执行事件发生时 fire-and-forget 镜像到图：

1. **上传文件** → `MemoryGraphSink.observeUploadFile` → sidecar `POST /observe/upload-file` → `upsert_source_file`：MERGE `SourceFile`（`file_id` 确定性）+ 建 `SourceFile -[:feeds]-> ResearchGoal`。上传完成即镜像，fire-and-forget（图谱不可达 = no-op，上传本身不受影响）。`ResearchGoal` 可能尚未存在（上传可能早于首条消息），此时**不建占位 goal 节点**——文件先悬空（有节点、无 `feeds` 边），等首条消息时由 `upsert_session_first_message` MERGE 真实 goal 后统一补挂本会话所有悬空 SourceFile。重传同名文件 MERGE 命中同一 `file_id`，不造重复节点。
2. **首条用户消息** → `MemoryGraphSink.observeSessionFirstMessage` → sidecar `POST /observe/session-first-message` → 写 `Session` + `ResearchGoal` + `has_goal`。
3. **提出 plan** → `observeSessionPlan` → `POST /observe/session-plan` → 用 `plan.scope` **修正** `ResearchGoal` 的 `core_objective`/`domain`（不镜像 plan steps 成 ToolCall，避免 PENDING 骨架污染）。
4. **每次代码执行完成** → `observeExecution` → `POST /observe/execution` → `upsert_execution`：
   - MERGE 一个 `ToolCall`（`task_type='code_execution'`）+ `Code`，建 `ToolCall -[:produces]-> Code`；
   - 执行 diff 只记录 Derivation 与 CAS，不把尚未声明的文件作为 `produced_artifacts` 写图；
   - 调 `_link_subtasks_by_finish_time` 重建本会话 `next` 时序链（先删本会话旧 `temporal_chain` 边再重连，`ResearchGoal → head → … → last`）。
5. **每次文献检索（MCP）完成** → `observeMcpInvocation` → `POST /observe/mcp-search` → `upsert_mcp_search`：MERGE `ToolCall`（`task_id="subtask:mcp:<invocation_id>"`）+ 批量 MERGE `Paper`（按 `(session_id, normalized_link)` 去重，命中则 `retrieval_count+1`），建 `ToolCall -[:produces]-> Paper`。
6. **subagent 运行** → `observeSubagent` → `POST /observe/subagent` → MERGE 一个 scope `Task`（`task_type='subagent'`）；subagent 内部的代码执行/文献检索镜像成子 `ToolCall` 节点，通过 `contains` + `next` 挂到 scope 下，`produces` 边走 `scope → 子的 Code/Artifact`（scope 拥有其子的产品，自身不产）。

任务链成型后，从前端"工作区面板"即可看到一张随执行增长的有向图：研究目标在顶，`ToolCall` 沿 `next` 排成时间线（subagent 的 scope 通过 `contains` 归组其子 `ToolCall`），每个 `ToolCall` 向下 `produces` 它的代码、文件、文献。

### 2.2 引用链的显式 declare（LLM 在最终报告时驱动）

引用链只在 LLM 写**最终总结报告**时建立。系统提示（`runtime.ts`，仅功能开启时注入）规定了三条核心约束：

- **只在写最终报告时 declare**：中间闲聊/进度回复不建 Claim、不进图；
- **必须建立引用链**：报告要带可点 `[alias]` chip，无 chip 报告视为未完成；
- **静默**：绝不向用户叙述图谱/工具/节点/id。

两条 cite 路径（同一 claim 可混用）：

**路径 A — 文献证据（`[evidence1]`）**
```
declare_evidence(content, source_paper_link, locator, evidence_type, …)
  → sidecar 校验 Paper 存在 → CREATE Evidence + extracts→Paper → 返回 evidence_id
declare_claim(content, cites_evidence_aliases={"evidence1": evidence_id}, …)
  → CREATE Claim + supports←Evidence → 返回 chip_map={"evidence1": {kind:"evidence", id, label:"evidence1"}}
报告正文写 [evidence1]
```

**路径 B — 代码产出（`[artifact1]`，无文献）**
```
run_python → 写工作区文件并记录 Derivation/CAS
declare_artifact(path) → 注册 Project 产物版本并返回 artifact_id
  → 将已声明的该版本镜像为 Code -produces-> Artifact
declare_claim(content, cites_artifact_aliases={"artifact1": artifact_id}, …)
  → CREATE Claim + supports←Artifact → 返回 chip_map={"artifact1": {kind:"artifact", id, label:"artifact1"}}
报告正文写 [artifact1]
```

> `declare_claim` 的 `cites_*_aliases` 两件套（evidence/artifact）是对称设计：alias 是 LLM 写进报告的短 token，对应的 id（evidence_id / artifact_id）在图里解析。代码生成的文件必须先经 `declare_artifact` 取得稳定 `artifact_id`，未声明文件不能成为图谱 Artifact。最终报告文件同样必须显式声明；声明时会把本轮 claims 与报告版本通过 `stated_in` 边（Claim → 报告 Artifact）关联。

### 2.3 前端渲染与点击分发

报告打开时（`MarkdownRenderer` + `version.references`），`remarkGraphChips` 插件把 `[alias]` token 替换成 `graph://<kind>/<id>` 链接，渲染成可点 button（`Markdown.tsx`）。`App.tsx` 的 `handleChipClick` 按 `reference.kind` 分发：

| chip kind | 点击行为 |
|-----------|----------|
| `evidence` | 打开 `EvidenceModal`（显示证据 + 经 `getMemoryChain` 拿到的来源 Paper） |
| `artifact` | 在 Project 产物目录中按 artifact_id 找到稳定身份 → 打开 `ArtifactModal` 直接看图/数据 |

### 2.4 链路查看（View chain）

`get_chain` 是链路查看的后端，以 `kind` 为键——一个按按钮区分的遍历 key，查 `_BUTTON_CHAIN_HOPS` 表（`query.py`）。每个节点 label 有自己的一组按钮（`MemoryGraphExplorer.tsx` 的 `CHAIN_BUTTONS` 矩阵）；每个按钮的 `kind` 选一小段定向跳表（一组 `(edge, direction, target_label, …)` 元组），由 `_walk_hops` 逐跳展开。已不再有全局的 `full`/`task`/`artifact` 分派——每条链都是一段短而 label 专属的走法。

| 源 label | 按钮（`kind`） | 各走什么 |
|---|---|---|
| `Task` | `viewPrevTask` / `viewNextTask` | 沿 `next` 的单侧最近 `Task`（in/out，limit 1） |
| `Task` | `viewGoal` | 沿 `next` 回溯到 `ResearchGoal`（`1..`，变长） |
| `Code` | `viewInput` / `viewOutput` / `viewProducingTask` | 该 Code 读过的 Artifact 版本（`input`）；它 `produces` 的 Artifact；产出该 Code 的 `ToolCall` |
| `Paper` | `viewExtractedEvidence` / `viewCitingClaim` / `viewCitingArtifact` | 正向引用链：`extracts→Evidence`，再 `+supports→Claim`，再 `+stated_in→报告 Artifact` |
| `Paper` | `viewSearchingTask` | 产出该 Paper 的 `ToolCall` |
| `Evidence` | `viewSourcePaper` / `viewCitingClaimForEvidence` / `viewCitingArtifactForEvidence` | 上游 `extracts←Paper`；下游 `supports→Claim`、`+stated_in→Artifact` |
| `Claim` | `viewCitingEvidenceForClaim` / `viewContainingArtifact` | 支撑该 Claim 的 Evidence/Artifact（`supports` in）；它 `stated_in` 的报告 Artifact |
| `Artifact` | `viewContainedClaims` / `viewCitingClaimForArtifact` / `viewProducingCode` / `viewCitingEvidenceForArtifact` / `viewCitedPaper` / `viewRelatedTask` | `stated_in` 该报告的 claims；该 Artifact `supports` 的 claims；产出它的 `Code`；多跳引用溯源 `stated_in→Claim→supports→Evidence`；再 `+extracts→Paper`；以及完整任务尾巴 `produces→Code→ToolCall→next→ResearchGoal` |

定向逐跳行走让每条链短且只走一条有向路径（每跳到达的节点作为下一跳的种子，所以是"追踪"而非"扇出"）。某跳找不到边就把整条链清空（全或无），这正是前端先调 `chain_exists` 把会空的按钮置灰的原因。`ResearchGoal` 与 `ToolCall` 不暴露链路按钮（它们是上述走法的端点）。

前端入口：`ScientificArtifacts.tsx` / `EvidenceModal.tsx` 的 **"在 ScienceMemory 中查看此 {x}"** 按钮（仅科学记忆功能开启时显示）→ 打开 `MemoryGraphExplorer` 并传 `autoChain`，挂载时跑 `getMemoryChain` 展开入口节点、跑 `chainExists` 点亮或置灰各 label 的按钮。文案中英双语，随系统语言切换（i18n key 前缀 `chain.`；`{x}` 占位解析为 `chain.product` 或 `chain.evidence`）。

### 2.5 产物真实性溯源（trace_provenance，reviewer specialist 用）

`get_chain` 给的是**无向子图**（上下游都走，给人看），适合"链路查看"。而 reviewer specialist 检查产物真实性时需要的是另一件东西：**一条有序的上游链 + 链断没断的判定**——"这个 artifact 能追溯到 ResearchGoal 吗？"这个问题不能让 reviewer 自己拿子图拼、自己推断断点，要接口直接给结论。`trace_provenance` 就是干这个的。

与 `get_chain` 的关键区别：

| | `get_chain`（链路查看） | `trace_provenance`（真实性溯源） |
|---|---|---|
| 产出 | 无序子图 `{nodes[], edges[]}` | 有序线性链 `{chain[], broken, truncated, reason}` |
| 方向 | 上下游双向 | **固定 upstream**（从起点往源头走，不暴露 direction） |
| 判定 | 无 | `broken`/`truncated`/`reason` 三个真实性信号 |
| 消费者 | 前端渲染给人看 | reviewer specialist 据此派生 `decision` |

`trace_provenance` 复用 `get_chain` 的 `_CHAIN_HOPS` 逐跳扩展引擎，但只取 `direction=="in"`（upstream）的条目，逐跳记录到达的节点 + `via_edge` 跳序，并判定：

- 走到 `target_label`（默认 ResearchGoal）→ `broken:false`，末跳标 `is_terminal`（链完整，产物可追溯）
- 某跳找不到上游边（链断）→ `broken:true`，`reason` 指向链尾节点（断点定位）
- 走到 `max_hops`（默认 8）仍未到终点 → `truncated:true` + `broken:false`（链没断只是没走完，区别于断链）
- 起点不存在 → HTTP 404（产物完全无记忆，比 broken 更严重）
- 图不可达 → `broken:true` + `reason:"memory_graph_unreachable"`，HTTP 200（降级不崩，与所有 read 端点一致）

reviewer 据返回的 `broken` 派生 `decision`：`broken:false` → `ACCEPT_AND_PROCEED`；`broken:true` 或 `truncated:true` → `REVISE_AND_RETRY`。**接口只输出 `broken`，不输出 verdict/decision**——后者是 reviewer agent 内部的事，保持"只要接口、不要 specialist 决策逻辑"的边界。

## 3. 新增 API 接口

科学记忆新增了三类 HTTP 接口：**sidecar 原生路由**（Python，回环 `:17674`，Bearer 鉴权）、**Node API 反向代理路由**（浏览器入口 `:4310`，`/api/memory/*`）、**LLM 工具回调**（Node 内部，非 HTTP 面向浏览器）。

### 3.1 sidecar 路由（`services/memory-graph/.../server.py`，Bearer 保护）

**写 / 镜像（observe + persist）**

| 方法 + 路径 | 作用 |
|-------------|------|
| `POST /observe/execution` | 镜像一次代码执行 → ToolCall + Code；仅 `declare_artifact` 后重放的已声明版本携带 Artifact + produces；并重建 next 链 |
| `POST /observe/mcp-search` | 镜像一次文献检索 → ToolCall + Papers + produces |
| `POST /observe/subagent` | 镜像 subagent 生命周期 → 一个 scope `Task`（`task_type='subagent'`）；其子执行/检索通过 `contains` + `next` 挂到 scope 下 |
| `POST /observe/session-first-message` | 写 Session + ResearchGoal + has_goal |
| `POST /observe/session-plan` | 用 plan.scope 修正 ResearchGoal |
| `POST /persist/evidence` | CREATE Evidence + extracts→Paper（Paper 不存在 → 422 `source_paper_not_found`） |
| `POST /persist/claim` | CREATE Claim + supports（Evidence/Artifact→Claim）+ 可选 produces + 可选 stated_in；返回 `chip_map`。无支撑目标 → 422 `no_cites_target`（在降级分支前触发，图挂了也报） |
| `POST /persist/stated_in` | MERGE stated_in（Claim→报告 Artifact）；Artifact 可能尚未镜像，轮询等待最多 10×0.3s |
| `POST /internal/neo4j-password` | 推送 Neo4j 密码 + ensure_schema |

**读 / 查询**

| 方法 + 路径 | 作用 |
|-------------|------|
| `GET /health` | 状态：`needs-password`/`degraded`/`healthy`（无鉴权）。`disabled` 是 API 侧概念（toggle 关），不是 sidecar 状态——sidecar 始终在跑，只报图可达性 |
| `GET /subgraph?session_id=` | 全节点 + 全"有意义的"边（白名单：produces/next/extracts/supports/stated_in/supersedes/input/contains；前端绘制时过滤掉 `supersedes`，版本谱系不入链路视图） |
| `POST /query/match` | 跨会话子串搜索（按命中数+字段优先排序）；`mode=all_terms` term-AND（前端搜索框用，输入论文标题只回该论文），`mode=any_term` OR（默认，agent `query_graph` 工具用，宽松召回避免零结果）；`session_id=null` 跨会话 |
| `POST /query/by-node-type` | 按 label 过滤节点 |
| `POST /query/by-edge-type` | 按边类型过滤，返回边 + 去重端点 |
| `POST /query/chain` | 链路遍历（`node_id` + `kind` + 可选 `session_id`/`version`）：`kind` 是按钮 key，查 `_BUTTON_CHAIN_HOPS`（见 §2.4）；未找到 → 404 |
| `POST /query/chain-exists` | 批量检查某节点的按钮 `kind` 是否有链 → `{<kind>: bool}`；前端据此在用户点击前置灰空链按钮 |
| `POST /query/scope-expansion` | 把一个 subagent scope `Task` 展开成其子 ToolCall + 真实 produces/contains/next 边（"点开 scope"的载荷）；非 scope id → 404 |
| `POST /query/group-expansion` | 把折叠的聚合节点（多个同 kind 的 Artifact/Paper 合并成一个）展开成其成员产物 |
| `POST /trace/provenance` | 产物真实性溯源（`node_id` + 可选 `target_label`/`max_hops`/`session_id`）；固定 upstream，返回有序链 + `broken`/`truncated`/`reason`；起点不存在 → 404 |
| `GET /query/artifact-provenance` | 经图聚合某个 Artifact 版本的 derived-from 依赖（四个 provenance 字段留在旧 SessionStore 端点） |

**清理**

| 方法 + 路径 | 作用 |
|-------------|------|
| `POST /cleanup/session` | 把该会话的 Artifact 软标记为会话级（保留节点，调整留存策略） |
| `POST /cleanup/project` | 物理删除某 project 的全部图节点（project 拆除） |

### 3.2 Node API 反向代理路由（`services/api/src/http/`，浏览器入口）

浏览器只读，全部反向代理到 sidecar；功能关闭（client=null）返回空结果 + `reason:"memory_graph_disabled"`，sidecar 不可达返回 `reason:"memory_graph_unreachable"`：

| 方法 + 路径 | 客户端方法（`apps/web/src/api/`） |
|-------------|--------------------------------------|
| `GET /api/memory/subgraph?session_id=` | `getMemorySubgraph` |
| `POST /api/memory/query/match` | `queryMemoryMatch` |
| `POST /api/memory/query/by-node-type` | `byMemoryNodeType` |
| `POST /api/memory/query/by-edge-type` | `byMemoryEdgeType` |
| `POST /api/memory/query/chain` | `getMemoryChain` |
| `POST /api/memory/query/chain-exists` | `chainExists`（点亮/置灰各 label 按钮） |
| `POST /api/memory/query/scope-expansion` | `getScopeExpansion` |
| `POST /api/memory/query/group-expansion` | `getGroupExpansion` |
| `POST /api/memory/trace/provenance` | `traceProvenance`（reviewer 真实性溯源；返回 `broken`/`truncated`/`reason`） |
| `GET /api/memory/query/artifact-provenance` | `getMemoryArtifactProvenance` |
| `GET /health`（含 `memoryGraph` 字段） | `getMemoryHealth` |

> declare/persist 类**不在浏览器客户端上**：`declareEvidence`/`declareClaim`/`linkClaimsToReport` 是 Node 内 LLM 工具回调（见 4.3），经 `MemoryGraphClient` 直接打 sidecar `/persist/*`。

### 3.3 LLM 工具（`packages/workspace/src/workspace.ts`，功能开启时注册）

| 工具名 | 输入 | 作用 |
|--------|------|------|
| `query_graph` | `{query}` | 本会话图节点子串搜索；最多调一次，仅最终报告前解析要 cite 的节点 id |
| `declare_evidence` | `{content, source_paper_link, locator, evidence_type, confidence, strength}` | 建 Evidence + `extracts`（Paper→Evidence），返回 `evidence_id` |
| `declare_claim` | `{content, claim_type, confidence, locator, cites_node_ids[], cites_evidence_aliases{}, cites_artifact_aliases{}, cites_artifact_versions{}, artifact_id?, artifact_version?, task_id?}` | 建 Claim + `supports`（Evidence/Artifact→Claim）+ 可选 produces/stated_in，返回 `chip_map`（alias→{kind,id,label}） |
| `trace_provenance` | `{node_id, target_label?, max_hops?}` | 溯源产物真实性：返回有序上游链 + `broken`/`truncated`/`reason`。reviewer specialist 据此派生 `decision`，无需自己拼链 |

这些工具在 `RunTimeline` 里以 `GRAPH_TOOL_NAMES = {query_graph, declare_evidence, declare_claim}` 归类展示。系统提示同时约束：declare/query 步骤**静默**，绝不向用户叙述。

> **`trace_provenance` 的可见性不同于其它三个**：`query_graph`/`declare_*` 在科学记忆功能开启时对所有 workspace 注册；`trace_provenance` 仅在 **reviewer specialist 激活时**（`reviewerSpecialistAvailable(enabled, message)` gating，用户消息含 "reviewer specialist" + 开关开）才注册，主 agent 平时看不到。且其 description 含 RESTRICTED USE 强约束（仅真实性审查时调、禁探索），双重保险防误用——因为 reviewer specialist 当前是"主 agent + gated 工具"模式（非独立 subagent），激活后主 agent 仍可见该工具。

## 4. 新增存储

科学记忆自身的数据在 Neo4j，但为支持 chip 渲染与跨刷新存活，Node 侧的既有存储模型扩展了字段：

### 4.1 Node 侧文件存储扩展

| 位置 | 新增内容 |
|------|----------|
| `.sciencediscovery-data/scientific-artifacts/`（catalog） | `ScientificArtifactVersion.references?: ComposerReference[]` —— 报告版本的 chip 别名→图节点映射，让 chip 跨刷新存活（`store/catalog.ts`） |
| Project 产物目录 | `ScientificArtifact` 保存稳定 `artifact_id`、`projectId`、`origin` 与创建 Session 快照；`ScientificArtifactVersion` 保存 CAS 引用和源路径 |
| 报告版本 | `declare_artifact` 落盘时 drain `chipMapBuffer`→`references` + `claimIds`→`stated_in` 边 |
| `ComposerReferenceKind` | 扩展为 `artifact | session | skill | paper | evidence | claim`，承载 chip 的 kind |

### 4.2 环境变量

sidecar 与 Node 客户端的连接、鉴权、日志变量：

| 变量 | 默认 | 作用 |
|------|------|------|
| `SCIENCE_AGENT_MEMORY_GRAPH_HOST` / `_PORT` | `127.0.0.1` / `17674` | sidecar 绑定地址与端口（服务进程使用） |
| `SCIENCE_AGENT_MEMORY_GRAPH_URL` | `http://127.0.0.1:17674` | Node API 客户端访问 sidecar 的端点（尾斜杠会被裁掉） |
| `SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN` | `sciencediscovery-memory-graph-local` | sidecar Bearer token；Node 与 sidecar 双向校验 |
| `SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL` | `INFO` | sidecar 与 Node 两侧的日志级别（同源传递） |

> ScienceMemory 的启停、Neo4j 连接地址、用户与密码都在 **System Settings → ScienceMemory** 里管理（单一 toggle，无需改 `.env`、无需重启 stack）。

启动：`scripts/start-stack.sh` 无条件用 `.sciencediscovery-data/envs/memory-graph/bin/python -m sciencediscovery_memory_graph.server` 拉起 sidecar（环境随栈启动无条件 provision），并 `wait_healthy` 等 `http://127.0.0.1:17674/health`。toggle 关时 sidecar 空跑，sink 写入与读路径 short-circuit 返回 `memory_graph_disabled`。
