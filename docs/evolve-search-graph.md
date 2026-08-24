# 搜索过程落图 —— 一次搜索 = 一个 SubTask 节点 + 它绑定的那张图

`/evolve`（别名 `/era` · `/openevolve`）跑一次搜索，产出一个最优 artifact。**整次搜索在
Neo4j 科学记忆图谱里是一个 `SubTask` 节点，这个节点绑定一张图**——ERA 下它是搜索树，
OpenEvolve 下它是岛屿档案的谱系与网格占位。

> **前置**：[`/evolve` 设计](evolve-command.md) 已定的部分本文不重复——命令入口与向导（§1–2）、
> 目标模型与三段划分（§3）、引擎绑定（§6–7）、起跑前校验（§8）、沙箱（§9）、治理（§11）、
> 预算与看板（§12–13）。本文只写**图这一层**：图模型、写路径、洪水控制、读路径、渲染。
>
> **已定的两条前提**：① `/era` 与 `/openevolve` 是同一个向导、同一套 run 子系统的别名入口，
> 算法（`algorithm: "era" | "openevolve"`）是目标模型里的一个字段；② 图是**投影不是真源**
> ——科学记忆[默认关闭且必须静默降级](zh/explanation/science-memory.md)，所以
> `data/evolution/runs/<runId>/events.ndjson` 是权威，Neo4j 是可查询副本。

---

## 1. 一套图模型装两种算法

两种算法的**过程形状不同**，但可持久化的东西是同一套：

| | ERA | OpenEvolve |
|---|---|---|
| 结构 | 一棵树，节点全体可选（flat PUCT） | 3 个岛 × 每岛一张 MAP-Elites 网格 |
| 一次扩展的父 | 1 个（被 `argmax(puct)` 选中的节点） | 1 个 parent + prompt 里还有 best 与 inspiration |
| 谁在变 | 节点的 `visits`（选择时预留） | 网格的**占位**（插入换位、环形迁移） |
| 失败候选 | **入树**，记 `valid:false` | 入 history，不进网格 |
| 「最优」 | 分数最高的节点 | archive 里 `combined_score` 最高的 program |

统一的办法：**候选是节点，血缘是边，算法特有的位置信息是属性或（网格）一个有界的第三类节点。**

### 1.1 三个 label

| label | 代表 | 唯一键 | 算法 |
|---|---|---|---|
| `SearchRun` | 一次搜索（run 级身份与聚合量） | `search_id`（= runId） | 两者 |
| `SearchNode` | 一个候选（**含失败的**） | 复合 `(search_id, node_index)` | 两者 |
| `SearchCell` | MAP-Elites 一个格子 | 复合 `(search_id, island, complexity_bin, diversity_bin)` | 仅 openevolve |

**`node_index` 是统一主键，不是 ERA 私有的。** ERA 的节点索引本来就是插入序（上游 `futs.Node.index`，
保真度要求钉住它）；OpenEvolve 的候选身份是字符串 `program_id`，但 `archive.history` 的追加序
同样是一个插入序。所以两者都写 `node_index`，OpenEvolve 额外把 `program_id` 留成属性
（跨引 ledger 与 CAS 用）。这样 `(search_id, node_index)` 一个约束覆盖两种算法，
而 ERA 的上游索引语义没被改。

**`SearchRun` 必须独立于 `SubTask`**，不能把这些属性塞进 `SubTask.extra`：

1. **续跑是决定性的一条。** `--resume` 是新的一轮、新 turn，产生**第二个** SubTask，
   但它继续的是**同一次搜索**。属性挂 SubTask 上，续跑就得在"分裂身份"和"覆盖另一个 SubTask
   的属性"之间选一个错的。有了 `SearchRun`，两个 SubTask 各拉一条 `searches` 指向同一个 run。
2. `SubTask` 参与**每一次**链路遍历（`_CHAIN_HOPS` 里 Paper/Code/Artifact 都会走到它），
   run 级聚合量挂上去等于给所有链路视图加噪。
3. `SearchRun` 是那个"可折叠的把手"——会话图谱面板上一次 `/evolve` 只多两个节点（§4）。

**候选代码只存 `code_hash`，不建 `Code` 节点。** 遵循这个仓库自己的分层——"图 = 目录，
CAS/store = 仓库"。N 个候选建 N 个 `Code` 节点会直接淹掉 `get_subgraph`（§4）。
只有**被采纳存为产物的那一个**走既有 `declare_artifact` 路径物化成 `Code` + `Artifact`。

### 1.2 属性：算法专属的部分要**平铺**，不能塞 JSON

```
SearchRun   共有  search_id · session_id · algorithm · goal_statement · status ·
                  started_at/finished_at · candidates · valid_count ·
                  baseline_score · best_node_index · best_gate_score ·
                  best_test_score · tokens · cost_cents · last_seq
            era   c_puct · max_depth · root_visits
            oe    islands · feature_bins · exploitation_ratio ·
                  migration_interval · archive_size · migrations

SearchNode  共有  search_id · node_index · session_id · valid · score（可空）·
                  reward · rollout_score · gate_score · accepted · merge_reason ·
                  error · change_summary · code_hash · code_chars · iteration ·
                  worker · created_at/evaluated_at
            era   parent_index · depth · visits · selected_puct ·
                  selected_rank_score · selection_count
            oe    program_id · parent_id · island · combined_score ·
                  birth_complexity_bin · birth_diversity_bin · in_archive
            评分卡 scorecard_hash · crit_<id>（每条判据的分，平铺）·
                  rejected_by（触发的否决项 id）—— 见 evolve-scorecard.md §9

SearchCell  共有  search_id · island · complexity_bin · diversity_bin ·
                  occupant_node_index · occupant_score · updated_at
```

**Neo4j 属性只能是标量与数组，没有嵌套 map。** [`/evolve` §4](evolve-command.md) 的事件模型里
`meta: EraMeta | OpenEvolveMeta` 是个对象，到持久化边界必须**平铺**。不要退化成
`meta_json` 字符串——那样 `WHERE n.island = 2`、`ORDER BY n.visits` 全都没了，
而"按岛看、按访问数看"正是这张图存在的理由。平铺的代价是属性名带算法前缀语义，可接受。

### 1.3 六条边

| 边 | 方向 | 含义 | 算法 |
|---|---|---|---|
| `searches` | `SubTask` → `SearchRun` | **就是"绑定"**：一条边把一次任务和一张图接起来 | 两者 |
| `root` | `SearchRun` → `SearchNode` | 起点（baseline 那个候选） | 两者 |
| `expands` | `SearchNode` → `SearchNode` | 父 → 子，血缘本体 | 两者 |
| `inspires` | `SearchNode` → `SearchNode` | prompt 里出现过的 best / inspiration → 子 | 仅 oe |
| `elected` | `SearchRun` → `SearchNode` | 当前最优；易主时重指（先删旧边再 MERGE） | 两者 |
| `occupies` | `SearchNode` → `SearchCell` | 占据网格格子；边上带 `current`/`via`/`since_iteration`/`evicted_at` | 仅 oe |

**`expands` 在两种算法下是同一件事**（谁从谁变异而来），所以血缘视图只有一个渲染器。
ERA 是一棵真树（单父、连通）；OpenEvolve 是一片森林（每岛各自生长，`root` 只有 baseline 一个，
但迁移会让分支跨岛）——同一个 dagre 分层布局都能画。

**`inspires` 值得单独存**：OpenEvolve 的 `select_parent()` 返回的是
`(iteration, island, parent, best, inspiration)` 五元组——**prompt 里有三个程序**
（`examples/openevolve/openevolve_program_evolution.py:337`），其中 inspiration 是
"archive 里与 parent 代码距离最远的那个"。"模型当时看见了什么"是这个算法唯一能解释
一次跳变的东西，只留 parent 会把它丢掉。它不进链路遍历（§4），所以不额外污染既有视图。

### 1.4 网格占位是**关系**，不是属性

这一条容易做错。`island_cells[island][cell] = program_id` 有两个性质：

1. **一个程序可以同时占多个岛的格子**——`_migrate_locked()` 把每岛最好的 elite **拷贝**到
   顺时针邻岛的格子里（`:318`），不是移动。
2. **格子坐标本身是时变的**——`_feature_cell_locked()` 的 diversity 维度是拿候选代码与
   **当前全部有效程序**求平均距离算出来的（`:272`），同一份代码在不同时刻可能落进不同格子。

所以"占位"不能写成 `SearchNode.bin_key` 一个属性。做法：`SearchCell` 节点 +
`occupies` 边，边上 `current: true/false` + `via: "insert" | "migration"`。
换位时把旧边 `current=false, evicted_at=…`，新边 `current=true`。

规模有界：格子数 ≤ `islands × feature_bins²` = 3 × 4 × 4 = **48**，占位边 ≤ 换位次数 + 迁移次数。
`SearchNode.birth_*_bin` 仍保留（出生时的格子快照，回答"它当初落哪"），
但**当前占位一律读边**，不读属性。

### 1.5 与既有链路的接缝：不能断链

最优程序存为产物后，既有链路**一个字不用改**就是完整的：

```
Artifact ←produces← SubTask(tree_search) ←next← ResearchGoal
```

`trace_provenance` 因此直接给出 `broken: false`（reviewer specialist 依赖这个）。两条硬要求：

1. **SubTask 的 `task_id` 必须以 `subtask:` 开头**，否则它进不了时序链——
   `_link_subtasks_by_finish_time` 用前缀筛选自动镜像的 SubTask（`persistence.py:485`）。
   定为 **`subtask:evolve:<runId>`**（不带算法名：算法在 `SearchRun.algorithm` 上，
   id 里编码算法会让续跑换算法这种非法状态"看起来合法"）。
   `task_type` 统一 `"program_evolution"`，算法从绑定的 `SearchRun` 读。
2. 产物侧留反向指针：`Artifact.search_id` + `Artifact.search_node_index`，
   并建 `SearchNode -[:produces]-> Artifact`。从产物能问"哪个候选生的"，
   从候选能问"它成了哪个产物"，而主链不依赖这条边。

---

## 2. 写路径

### 2.1 谁写图

**侧车不直连 Neo4j。** 这个仓库的不变量是"Node API 是图谱的唯一客户端"
（[science-memory](zh/explanation/science-memory.md) §1），破了它就多一个需要鉴权、
需要降级、需要日志的图客户端。

```
services/evolve (Python 侧车，era / openevolve 同一进程同一事件流)
      │ NDJSON（既有接缝，/evolve §5）
      ▼
services/api ─┬─► SSE ──────────────► 浏览器（实时看板）
              ├─► events.ndjson ────► 权威真源（回放 / 续跑 / backfill）
              └─► MemoryGraphSink.observeSearchProgress()
                        │ fire-and-forget，void 返回，绝不抛回 run
                        ▼
                  图侧车 POST /observe/search-progress ──Cypher──► Neo4j
```

`MemoryGraphSink` 现有方法（`services/api/src/memory-graph.ts:861` 起）全是
`void this.client.…catch(...)` 形态，新方法照抄。

### 2.2 事件 → 图写入

统一事件模型（`/evolve` §4），算法专属字段在 `meta` 里，落库时平铺（§1.2）：

| 事件 | 图写入 | 算法 |
|---|---|---|
| `search_started` | MERGE `SubTask{task_id:"subtask:evolve:<runId>", task_type:"program_evolution", status:"running"}` + MERGE `SearchRun{algorithm}` + `searches` 边 | 两者 |
| `seeded` | MERGE `SearchNode`(node_index 0) + `root` 边；oe 另建 baseline 的 `occupies` | 两者 |
| `selected` | era：被选节点 SET `selected_puct`/`selected_rank_score`/`selection_count`，**沿祖先链 SET 绝对 visits**（祖先列表由侧车给，不在图里走路径）<br>oe：记下 parent/best/inspiration，等 `expanded` 落地后建 `inspires` | 两者 |
| `expanded` | MERGE `SearchNode` + 从 parent 建 `expands`（**失败也建**）；oe 补 `inspires` ×2 | 两者 |
| `evaluated` | 汇总进 `rollout_score`/`gate_score`；**逐分片明细只进 NDJSON**（否则 N×shards 个节点） | 两者 |
| `inserted` | MERGE `SearchCell` + 换位（旧边 `current=false`，新边 `current=true, via:"insert"`）；SET `in_archive` | 仅 oe |
| `migrated` | 目标岛格子换位，新边 `via:"migration"`；`SearchRun.migrations` 累计 | 仅 oe |
| `merged` | SET `accepted`/`merge_reason`；最优易主则重指 `elected` | 两者 |
| `search_finished` | SET `SearchRun` 全部聚合量；SubTask `status`/`finished_at`；重建 `next` 时序链 | 两者 |
| `artifact_saved` | 既有 `declare_artifact` 路径 → `SubTask -produces-> Artifact` + §1.5 反向指针 | 两者 |

### 2.3 三条不能省的规则

1. **发绝对状态，不发增量。** 两种算法各有一个非幂等量：ERA 的 `visits`、OpenEvolve 的
   **格子占位**。`SET n.visits = n.visits + 1` 在重连重放下会多计，而 MERGE 救不了它。
   侧车本来就持有权威状态（`EraTree._backpropagate_locked` 之后的访问向量、
   `OpenEvolveArchive.island_cells` 的当前映射），所以每批事件带上**被触碰对象的绝对状态**：
   `SET n.visits = $visits`、`SET cell.occupant_node_index = $idx`。
   幂等由构造保证，顺带买到 §2.5 的 backfill。
2. **`-inf` 不许上线。** 失败候选上游记 `-inf`，而 `json.dumps` 把它写成裸 token
   `-Infinity`——**不是合法 JSON**，严格解析器（含 JS `JSON.parse`）直接拒绝；
   Neo4j 属性也不接受非有限浮点。上游端口已经处理了：`_finite()` 返回 `None`，
   失败靠 `valid: false` 表达（`examples/era/era_empirical_software.py:159`，注释写得很清楚）。
   **照它做**：线上和图上都是 `score: null` + `valid: false`。
3. **按扩展批量 + `seq` 水位。** 一次扩展会连着来 4–6 条事件，一条一次 HTTP 是几百次往返。
   侧车给每条事件一个单调 `seq`，Node 侧按扩展合并（或 250ms / 50 条 flush）成一次
   `POST /observe/search-progress {search_id, events[]}`，侧车一个事务里 UNWIND 落库，
   并把 `SearchRun.last_seq` 抬到批次末尾；`seq <= last_seq` 的整批丢弃。

### 2.4 时序链的一个细节

现有镜像都是**执行完之后**才写 SubTask，而这里的 SubTask 要在开跑时就出现（看板要看见它在跑）。
`_link_subtasks_by_finish_time` 按 `ORDER BY st.finished_at` 排序，Neo4j 升序把 null 排在最后
——所以运行中的 SubTask 落在链尾，**这正是它该在的位置**（它是最新一步）。完成时再 rebuild
一次定序即可，**不需要改那个函数**。同时跑两个演进时链尾相对顺序不确定，可接受
（都是 `temporal_chain` 推断边，前端本来就弱化显示）。

### 2.5 降级矩阵

| 情况 | run | UI | 补偿 |
|---|---|---|---|
| Science Memory toggle 关 | 正常跑完 | 从 store 源读（§5），功能无缺 | 无 |
| 图侧车不可达 | 正常跑完 | 同上 | run 结束时重放 backfill |
| 跑到一半 Neo4j 挂 | 正常跑完 | 实时视图照常（store 源） | 结束时从 `events.ndjson` 全量重放；写是幂等的（§2.3 第 1 条），直接重放，不需要对账 |
| 图写比搜索慢 | 不受影响（fire-and-forget） | 图视图落后几秒 | 无 |

**"结束时重放一遍"是这套设计的兜底**，也是坚持"绝对状态 + MERGE + seq 水位"的第二个回报：
任何时刻的图状态都可以由事件流的前缀重建，重复重放不改变结果。

---

## 3. 洪水控制（不做会砸坏现有面板）

`get_subgraph` 是 `MATCH (n) WHERE n.session_id = $sid ... LIMIT 500`
（`query.py:38`，`_NODE_LIMIT = 500` 在 `:35`）。一次搜索几十上百个候选 + 最多 48 个格子，
吃掉相当比例的预算，还会把真实节点挤出窗口——**这是本设计最容易踩的一脚**。

| 位置 | 改法 | 理由 |
|---|---|---|
| `get_subgraph` 节点查询 | 加 `AND NOT n:SearchNode AND NOT n:SearchCell` | 保留 `session_id`（会话删除级联、跨会话检索都要它），只是不进会话总览 |
| `get_subgraph` 边白名单 | **不加** `expands`/`root`/`inspires`/`occupies` | 与前端过滤 `supersedes` 同一个精神：结构性谱系不进链路视图 |
| `_CHAIN_HOPS["SubTask"]` | 加 `("searches", "out", "SearchRun")` | "查看链路"能走到那张图的把手 |
| `_CHAIN_HOPS["SearchRun"]` | `("searches","in","SubTask")` · `("elected","out","SearchNode")` · 再接 SubTask 的 next 链 | 从 run 能走回研究目标 |
| `_CHAIN_HOPS["SearchNode"]` | 只给 `in` 方向：`("expands","in","SearchNode","1..")` · `("root","in","SearchRun")` | 让 `trace_provenance` 从任一候选上溯到 goal；**`expands`/`inspires` 的 `out` 方向绝不进 `full`/`task` 链**，否则一次"查看链路"把几百个节点拉进来 |
| `/query/search-graph` | 新端点，`max_nodes` 硬顶 + `truncated` 标记 | 预算已约束节点数，仍要有顶 |

结果：会话图谱面板每次 `/evolve` **只多两个节点**（`SubTask` + `SearchRun`），
点 `SearchRun` 才展开那张图。这就是"节点绑定一张图"落到界面上的样子。

---

## 4. 读路径

| 层 | 接口 | 说明 |
|---|---|---|
| 图侧车 | `POST /query/search-graph` `{search_id, session_id?, max_nodes?}` | 返回 `{run, nodes[], edges[], cells[], truncated, reason?}`；`run.algorithm` 决定前端画树还是画岛；不存在 → 404；图不可达 → 200 + `reason` |
| 图侧车 | `GET /nodes/SearchRun|SearchNode|SearchCell/{id}` | 复用既有单节点详情，label 白名单 +3 |
| Node 代理 | `GET /api/memory/search-graph/:searchId` | 只读反向代理；功能关 → `reason: "memory_graph_disabled"` |
| Node（store 源） | `GET /api/evolve/runs/:runId/search-graph` | 从 `events.ndjson` 折叠出**同一形状**；图关时照样能看 |

**两个源，一套形状，一个渲染器。** adapter 两边都归一化成
`{run, nodes, edges, cells}`：实时看板走 SSE + store 源，跨会话回顾走图源。

---

## 5. 前端

> 完整的前端设计（四个屏 + 一张卡、reducer、布局策略、状态矩阵、i18n/CSS/a11y、
> 实现顺序 F1–F8）见 [前端设计](evolve-frontend.md)。本节只定与图直接相关的部分。

- **向导**：算法选择器是第一步（`/evolve` §3.1 的第五要素），`/era` · `/openevolve` 预置它。
- **`LineageCanvas`（共用）**：复用 `MemoryGraphCanvas` 的 cytoscape + dagre 分层布局
  （`apps/web/src/MemoryGraphCanvas.tsx:17` 注册 dagre，`:267` 的 `hierarchyLayout`）——
  血缘在两种算法下都是分层有向图，不需要新布局引擎。视觉编码：

  | 通道 | ERA | OpenEvolve |
  |---|---|---|
  | 节点大小 | `visits`（谁被反复选中） | `in_archive`（在档案里的更大） |
  | 填充色 | rank（**不是原始分值**——ERA 的利用项本身就是排名，`/evolve` §6） | 岛（分类色） |
  | 虚线边框 | `valid:false` | 同 |
  | 金色描边 | `elected` | 同 |
  | 灰色细边 | —— | `inspires`（与 `expands` 视觉分级） |

  失败节点必须看得见：否则"模型返回空"和"程序跑不起来"在界面上没法区分。

- **`IslandGridPanel`（仅 openevolve）**：`islands × bins²` 的 CSS 网格（≤ 48 格，不用画布），
  每格显示当前占位者的 `node_index` + 分数，`via:"migration"` 的格子标迁移箭头。
  数据直接来自 `cells[]`——这就是 §1.4 把占位做成关系换来的东西。
- **候选详情**：与父节点的**代码 diff**（两个 `code_hash` 取 CAS 正文，走
  `services/api/src/provenance.ts` 里 hash→正文那条现成路径）+ 采纳/拒绝原因 +
  算法专属那行（era：被选中时的 `puct`/`rank_score`；oe：岛、出生格子、
  当时的 inspiration 是谁）。获胜程序常常从几百字符长到几千字符，这个增长要看得见。
- **三个入口**：会话图谱面板上的 `SearchRun` 节点；`SubTask` 详情的「查看搜索过程」按钮
  （照 Artifact 的「查看产物链」）；产物页的「它从哪来」。
- **深度/岛代数必须与分数并列**，不能塞进脚注：异步调度会让 ERA 的树根重
  （第一轮在任何兄弟插入前就派发了多个提案，此时 `argmax(puct)` 只能返回根），
  OpenEvolve 则会让岛代数不均，都是真实语义效果，见 `/evolve` §13。

---

## 6. 变更清单

| 文件 | 改什么 |
|---|---|
| `packages/schema/src/memory-graph.ts` | `MemoryGraphNodeLabel` += `SearchRun`/`SearchNode`/`SearchCell`；`MemoryGraphEdgeType` += `searches`/`root`/`expands`/`inspires`/`elected`/`occupies` |
| `packages/schema/src/search-graph.ts`（新） | `SearchRunSummary` · `SearchNodeSummary` · `SearchCellSummary` · `SearchGraphView`；事件判别联合复用 `/evolve` §4 的 `EvolveEvent` |
| `services/memory-graph/.../constraints.py` | `_SCHEMA` 加三条 UNIQUE（`search_id` / `(search_id,node_index)` / `(search_id,island,complexity_bin,diversity_bin)`）+ `search_id`、`session_id` 索引 |
| `services/memory-graph/.../persistence.py` | `upsert_search_progress(search_id, events[])`：一个事务、UNWIND、`last_seq` 水位、算法分派 |
| `services/memory-graph/.../query.py` | `get_search_graph()`；`get_subgraph` 排除两个 label；`_CHAIN_HOPS` 三处（§3） |
| `services/memory-graph/.../server.py` | `POST /observe/search-progress` · `POST /query/search-graph`；label 白名单 +3 |
| `services/api/src/memory-graph.ts` | `MemoryGraphClient.observeSearchProgress` + `MemoryGraphSink.observeSearchProgress`（void 形态）+ 批量缓冲与 flush |
| `services/api/src/http/index.ts` | `GET /api/memory/search-graph/:id` 代理；`GET /api/evolve/runs/:id/search-graph`（store 源） |
| `apps/web/src/App.tsx` | `/evolve` · `/era` · `/openevolve` 三个拦截（`:2853` 模式）→ 同一个 `EvolveWizard`，只预置 `algorithm` |
| `apps/web/src/LineageCanvas.tsx`（新）· `IslandGridPanel.tsx`（新）· `SearchNodePanel.tsx`（新） | §5 |
| `apps/web/src/i18n/messages.ts` | `evolve.*` / `searchGraph.*` 中英双语 |

---

## 7. 测试

| # | 探针 | 判据 | 算法 |
|---|---|---|---|
| 1 | **幂等**：同一段事件流重放两次 | 节点/边数、`visits` 向量、格子占位、`elected` 指向、`last_seq` 完全一致 | 两者 |
| 2 | **洪水**：写一次 200 候选的搜索 | `get_subgraph` 节点数只 +2；边白名单不含 `expands`/`occupies` | 两者 |
| 3 | **降级**：跑到一半停掉 Neo4j | run 正常完成；结束 backfill 后图与 `events.ndjson` 折叠结果一致 | 两者 |
| 4 | **不断链**：对最优 artifact 跑 `trace_provenance` | `broken: false`，链上经过 `subtask:evolve:<runId>` 并到达 `ResearchGoal` | 两者 |
| 5 | **`-inf`** | NDJSON 是合法 JSON（`score: null`）；图上 `valid:false`；节点**入了**图（ERA 丢掉它会改后续每一轮的排名分母） | 两者 |
| 6 | **链路不爆**：对 SubTask 点「查看链路」 | 返回节点数与搜索规模无关（只到 `SearchRun` 把手） | 两者 |
| 7 | **续跑** | 两个 SubTask 各一条 `searches` 指向同一个 `SearchRun`；`node_index` 不冲突；算法不可改（试图改 → 拒绝创建 run） | 两者 |
| 8 | **一个程序占两岛** | 迁移后该候选有两条 `current=true` 的 `occupies`，分属不同岛 | oe |
| 9 | **格子有界** | 任意长度的 run 结束后 `SearchCell` 数 ≤ `islands × bins²` | oe |
| 10 | **inspiration 落地** | 每次扩展恰好两条 `inspires`（best + inspiration），且指向的候选在当时的 archive 里 | oe |

外加 `/evolve` §14 那三个保真度测试——**搬 vendor 必须一起搬测试**，否则
"benchmark-faithful" 这个声明就没了。

---

## 8. 实现顺序

图这一层的顺序，与 `/evolve` §15 的 E 序列并行：

| # | 任务 | 完成判据 | 依赖 |
|---|---|---|---|
| **G1** | schema（三 label / 六边 / 类型）+ `constraints.py` 约束 | 编译通过；空库 bootstrap 幂等 | E1 |
| **G2** | `upsert_search_progress` + `POST /observe/search-progress`（先只做 era 分支） | 手工灌事件流形状正确；重放两次不变（探针 1） | G1 |
| **G3** | Node 侧 sink + 批量缓冲，接 **STUB 引擎** | 不调模型、不起沙箱，端到端在图里长出一张假图 | E2/E3 |
| **G4** | `get_search_graph` + 两个读接口 + 洪水控制三处 | 探针 2、6 | G2 |
| **G5** | `LineageCanvas` + 候选详情 + 三个入口 | 假图可看、可点、可 diff | G4 |
| **G6** | 产物落地（`declare_artifact` + §1.5 反向指针）+ 结束 backfill | 探针 3、4、7 | E8 |
| **G7** | openevolve 分派：`SearchCell` + `occupies` + `inspires` + `migrated` | 探针 8、9、10 | E13 |
| **G8** | `IslandGridPanel` | 网格能看出迁移与换位 | G7 |

```
G1 ── G2 ── G3 ── G4 ── G5 ── G6      ← 里程碑：G5
                            └── G7 ── G8   （跟 E13，不在关键路径）
```

**里程碑放在 G5，不是 G6**：STUB 引擎 + 能看的图意味着图模型、洪水控制、渲染这三件
最容易返工的事已经验完了，而这时候一个模型 token 都还没花。

---

## 9. 待定

1. ~~`/era` 与 `/evolve` 的关系~~ **已定**：一套 run 子系统，算法是目标模型里的字段
   （`/evolve` §2）。别名只预置 `algorithm`，续跑不许换算法。
2. **实时视图的数据源**。建议 store 源（图关也能看），图源只服务跨会话回顾。
   代价是 adapter 要写两个方向。若接受"过程只在开图时可见"，可省掉 store 源那个接口。
3. **逐分片评测明细进不进图**。建议不进（只留聚合），明细在 NDJSON 里。
   进图的话每个候选再挂 8 个评测节点，回到 §3 的问题。
4. **占位历史留不留**。建议留（`occupies` 边上 `current=false` 而不是删边）——
   "这个格子之前是谁"是解释 MAP-Elites 的关键，且边数有界。省事的变体是只留 `current` 边、
   历史交给 NDJSON。
5. **最优产物是否自动落工作区**。建议不自动（L1 治理要人点一下，`/evolve` §11），
   但 `Artifact.search_id` 那个反向指针在保存时就要写，否则以后补不回来。
