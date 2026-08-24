# `/evolve` 前端设计

`/evolve`（别名 `/era` · `/openevolve`）在界面上是**四个屏 + 一张常驻卡**。本文把
[`/evolve` §13 的看板判据](evolve-command.md)与[落图文档 §5 的渲染雏形](evolve-search-graph.md)
做实到组件、状态、数据流、实时更新策略与降级态。

> **判据一句话**（沿用 `/evolve` §13）：**不看日志就能判断这次为什么没变好。**
> 下面每个决定都回到这条上；做不到这条的块删掉也不亏。

---

## 1. 信息架构：四个屏 + 一张卡

```
会话页
 ├─ 输入框  /evolve <目标>  ──拦截──▶ ① EvolveWizard      全屏 modal，四步
 │                                        │ 开始
 │                                        ▼
 │                                    ② EvolveDashboard   全屏 modal，跑起来后
 │                                        │ 结束
 │                                        ▼
 │                                    ③ EvolveResult      看板的最后一屏（不是新窗口）
 │
 ├─ 工作区面板 ─▶ ⑤ EvolveRunCard      常驻把手：进度 / 重新打开 / 历史 run
 │
 └─ 记忆图谱 ──▶ ④ SearchGraphView     回看：只读，无 live（进 MemoryGraphExplorer）
```

**为什么必须有那张卡（⑤）**：`/evolve` 是前端拦截、**不创建 chat run** 的（`/evolve` §2），
所以会话时间线里没有任何痕迹——面板一关，一次跑了半小时的搜索就找不回来了。
卡是唯一的持久入口，位置与形态照 `MemoryGraphView`（工作区面板 `<aside className="workspace-panel">`
里的 section 卡，`App.tsx:3979` 那一带）。

**为什么 ③ 不是新窗口**：产物屏要和看板并排看——「最优程序长什么样」和「它在曲线上是哪个点」
是同一个判断。做成第二个 modal 就断了这个联系。

---

## 2. 组件落点

| 文件 | 职责 | 复用什么 |
|---|---|---|
| `apps/web/src/evolve/EvolveWizard.tsx` | 四步向导 + 起跑前校验 | `InlineErrorAlert` · 现有 settings editor 的表单样式 |
| `apps/web/src/evolve/EvolveDashboard.tsx` | 看板外壳（四块布局、Stop、重连态） | `memory-explorer-backdrop/-panel/-header/-body` 那套全屏 modal 结构 |
| `apps/web/src/evolve/ScoreChart.tsx` | 三条分数线 | plotly **懒加载器**（`csv-artifact/charts/PlotlyChart.tsx` 的 `loadPlotly()` 模式），不引新依赖 |
| `apps/web/src/evolve/SearchGraphCanvas.tsx` | 树 / 血缘森林 | cytoscape 宿主约定 + `NODE_COLORS` 写法（见 §5） |
| `apps/web/src/evolve/IslandGridPanel.tsx` | MAP-Elites 网格（仅 oe） | 纯 CSS grid，**不用 cytoscape** |
| `apps/web/src/evolve/CandidateStream.tsx` | 候选流水（每次扩展一行，可展开） | `timeline/RunTimeline.tsx` 的条目展开形态 |
| `apps/web/src/evolve/BudgetBar.tsx` | 成本条 | `UsagePage` 的数字格式化（`usageFormat.ts`） |
| `apps/web/src/evolve/CandidateDetail.tsx` | 候选详情 + 与父的代码 diff | `DetailModal`（eyebrow/title/controls/body）· 现有 artifact diff 视图 |
| `apps/web/src/evolve/EvolveResult.tsx` | 三个分数 + 获胜程序 + 存为产物 | `GovernedDownloadCards` 的治理提示形态 |
| `apps/web/src/evolve/EvolveRunCard.tsx` | 工作区常驻卡 | `MemoryGraphView`（含「功能关就不留痕迹」的规矩） |
| `apps/web/src/evolve/model.ts` | 事件 → 视图状态的 reducer；两个数据源的 adapter | `timeline/model.ts` 与 `run-stream/model.ts` 的 reducer 写法 |
| `apps/web/src/MemoryGraphExplorer.tsx` | 加 `SearchRun` 节点的「打开搜索图」入口 | 既有 `memory-chain-bar` 双按钮形态 |
| `apps/web/src/MemoryGraphCanvas.tsx` | `NODE_COLORS`/`EDGE_COLORS`/`graphNodeName` 补三 label 六边 | —— |
| `apps/web/src/styles/evolve.css` | 全部新样式 | 只用 `tokens.css` 的变量；进 `styles.css` 的 `@import` 序（排在 `memory-graph.css` 后） |

**一个 reducer，两个数据源。** `model.ts` 暴露
`reduceEvolveRun(state, event): EvolveRunView`，实时走 SSE、回看走
`GET /api/evolve/runs/:id/search-graph`（store 源）或 `/api/memory/search-graph/:id`（图源）
折叠出的同一批事件。**三个入口渲染出的画面必须逐像素一致**——不一致就说明有一个源在偷偷补信息。

---

## 3. 向导：四步，校验分两处挡

| 步 | 内容 | 本地能挡的 | 要问后端的 |
|---|---|---|---|
| ① 目标与算法 | 那句话（原样保留）· 算法选择器（era / openevolve） | 目标非空 | —— |
| ② 目标物与数据 | baseline 程序（上传 / 从工作区选 / Agent 起草）· 数据集 | 文件类型、大小 | CAS 落盘 |
| ③ 指标与划分 | 指标名 + 方向 + 映射 · 三段分片数 | **指标映射单调性** · `gateShards ≥ 4` | —— |
| ④ 预算与预检 | 扩展次数 · worker · 评测并发 · 超时 · 上限；**baseline 试跑** | `expansions % workers == 0` | 沙箱后端可用 · `max_tokens` 下限（era ≥ 16k / oe ≥ 32k）· thinking 必须 disabled |

两条呈现规则：

1. **本地能判的错就地报**（字段下方 `InlineErrorAlert`，「开始」保持禁用），
   要问后端的六条在第 ④ 步点「预检」时**一次性**全打回来——一条一条弹是最烦人的形态。
2. **baseline 试跑不可跳过**，且它的分数就是曲线的起点：出分之前「开始搜索」不点亮。
   文案要写明为什么：*一次程序执行，比一次搜索便宜三个数量级；指标选错、划分切错，
   不试跑就要等一整轮昂贵搜索才暴露。*

**算法切换的字段处理**：共有字段（目标、数据、指标、划分、预算）保留，
算法专属字段（era 的 `c_puct`；oe 的 `islands`/`feature_bins`/`exploitation_ratio`/
`migration_interval`/`archive_size`）重置为该算法默认值，并在切换处提示
「token 下限从 16k 变为 32k」这类会影响能不能起跑的差异。**续跑不出现算法选择器**（不可改）。

**`workers` 放进高级设置，`eval-concurrency` 放主面板**，并在 `workers` 旁直说
「提高它几乎不会更快」——瓶颈在接受门的重新执行（实测 96% 墙钟），可并行的只有模型调用。

---

## 4. 看板：四块

```
┌──────────────────────────────────────────┬────────────────────┐
│ ① 主图 ScoreChart                        │ ③ 候选流水          │
│    rollout / 留出门(加粗) / 测试(末点)     │    每次扩展一行      │
├──────────────────────────────────────────┤    选中→摘要→分数    │
│ ② 搜索结构                                │    →采纳/拒绝+原因   │
│    era: SearchGraphCanvas(树)             │    点一行 → 详情     │
│    oe : SearchGraphCanvas(森林) +         │                    │
│         IslandGridPanel(网格)             │                    │
├──────────────────────────────────────────┴────────────────────┤
│ ④ 成本条 BudgetBar  token/费用/墙钟 vs 上限 | 门耗时 · worker 饥饿 │
└───────────────────────────────────────────────────────────────┘
```

| 块 | 形态要点 | 为什么必须有 |
|---|---|---|
| **① 主图** | 三条线，**留出门那条加粗**；测试分数只有最后一个点（全程只测一次）；失败扩展在 x 轴上是一个空心点，不是断线 | 留出门是搜索的排名依据，测试是**唯一能对外说的数字**；三个数字必须分开显示 |
| **② 搜索结构** | era 画树；oe 画血缘森林 + 网格并排 | 异步会让 era 的树根重、让 oe 的岛代数不均——**深度/代数必须与分数并列**，不能塞脚注 |
| **③ 候选流水** | 一行 = 一次扩展；行内四段（选中了谁 · 变异摘要 · 分数 · 采纳/拒绝原因）；可展开看 error 全文 | 「模型返回空 → 记成失败节点」必须在这里看得出来，否则与「程序真的跑不起来」无法区分 |
| **④ 成本条** | 三根进度条 + **接受门耗时与 worker 饥饿时间单列** | 让用户看见时间花在门上，而不是怀疑系统卡了 |

**Stop 的语义要写在按钮旁**：中止当前扩展、保留 ledger 断点，可 `--resume` 续跑
（不是"作废这次搜索"）。

**窄屏**（`responsive.css` 现有断点 1180 / 900 / 600）：
< 1180px 候选流水移到主图下方；< 900px 搜索结构默认折叠成一行摘要（节点数 · 深度 · 最优），
点开占满屏——canvas 在小屏上挤成一团没有信息量。

---

## 5. 搜索图渲染：三条约束（这一节是从现有代码读出来的）

### 5.1 不要用 `MemoryGraphCanvas` 的 dagre 布局做 live 视图

现有画布有两条为**静态图**设计的性质，直接拿来做实时树会同时坏在两头：

1. `hierarchyLayout` 是**全图** dagre（`MemoryGraphCanvas.tsx:99` 起）。每来一个新节点重跑一次，
   整张图会重排——用户正在看的那个节点会跳走。
2. 重建是**内容签名**驱动的：`signature` 只包含 `id:label:status` 与边
   （`:162`）。这是为了「未变化的图不重跑布局，否则每次轮询都重置 pan/zoom/选中」——
   但它的副作用是 **`visits`/`score`/`elected` 变了根本不会重绘**。

所以新写 `SearchGraphCanvas`，两件事分开：

| 变化 | 处理 |
|---|---|
| **新节点 / 新边** | `cy.add()` 增量添加，坐标**自己算**，`layout: { name: "preset" }`：era `x = depth`，`y = 同深度插入序`；oe 按 `island` 分带，带内同法。确定性、无重排、O(1) |
| **属性变化**（visits / score / rank / elected / accepted） | `cy.$id(id).data({...})` 打补丁 + 样式映射函数读 data，**永不触发布局** |

选中态、pan、zoom 在整个过程中不动——这是现有画布注释里已经踩过的坑，别再踩一次。

### 5.2 颜色写在 TS 里，不是 CSS 变量

`NODE_COLORS` 那份表有一条注释解释得很清楚：**Cytoscape 画在 canvas 上，解析不了 `var(--x)`**。
所以新 label 的颜色也进 TS 表。视觉编码：

| 通道 | era | openevolve |
|---|---|---|
| 节点大小 | `visits` | `in_archive`（在档案里的更大） |
| 填充色 | **rank**（不是原始分值：ERA 的利用项本身就是排名，量纲无关） | 岛（分类色） |
| 虚线边框 | `valid: false` | 同 |
| 金色描边 | `elected` | 同 |
| 灰色细边 | —— | `inspires`（与 `expands` 视觉分级） |
| 标签 | `#index · d深度 · 分数` | `#index · i岛 · 分数` |

**失败节点必须画出来**：ERA 里失败扩展也入树（丢掉会改后续每轮的排名分母），
而它在界面上不出现的话，「模型返回空」和「程序跑挂了」就没法区分——回到 §4 的判据。

### 5.3 规模上限与折叠

节点数超过阈值（建议 200）时默认只画 **elected 的祖先链 + 按 rank 前 K**，其余按父节点折叠成
计数徽标（`+37`），点开展开一层；顶部显示 `truncated` 提示（照 explorer 现有的
`memory-truncated` 徽标）。**不要静默截断**——截断了不说等于告诉用户"就这些"。

### 5.4 交互

点节点 → 右栏详情；双击 → 以它为根聚焦子树（面包屑可回到全图）；
hover → tooltip（rank · visits · score · 采纳与否）;
键盘：`←→` 在兄弟间移动，`↑↓` 父/子——**canvas 对读屏器不可达**，所以：

### 5.5 canvas 必须有等价的表格视图

全屏面板 `role="dialog"` + `aria-modal` + 标题（照 explorer 的 `aria-label="Science Memory explorer"`），
并且**搜索结构块提供 `<table>` 切换**（一行一个候选：index / 父 / 深度 / 分数 / visits / 采纳）。
只有 canvas 的话键盘与读屏用户到不了任何一个节点——这条最容易漏，且是硬要求。

---

## 6. 候选详情：diff 是主角

```
┌ eyebrow: 候选 #12 · 父 #4 · 深度 2 ────────────── [存为产物] ┐
│ 分数  gate 0.582 → reward 0.632   |  rank 1/7  visits 3      │
│ era: 被选中时 puct 0.71 (rank 0.83 + explore 0.12)           │
│ 变异摘要  "加入 income × age 交互特征 + 目标截断到 [0,5]"      │
├──────────────────────────────────────────────────────────────┤
│ 与父节点的 diff（两个 code_hash → CAS 正文）                   │
│  失败候选：这里换成 error 全文 + stderr 尾部                    │
└──────────────────────────────────────────────────────────────┘
```

- 正文按 `code_hash` 从 CAS 取（走 `services/api/src/provenance.ts` 那条现成的 hash→正文路径）。
- **获胜程序常常从几百字符长到几千字符**，这个增长要看得见——所以默认展示 diff 而不是全文。
- 「存为产物」只对 `elected` 与用户显式选中的候选开放（L1 治理：产物不自动进工作区，要人点一下）。

---

## 7. 回看：进记忆图谱

**起跑入口有两个，产物那个更常用**：`ArtifactModal` / 产物目录的「演进这个产物」按钮
（预填 target + baseline + 起草评分卡，见 evolve-command.md §3.4），以及输入框敲 `/evolve`。
产物按钮必须先显示解析结果——「将演进生成它的 `train.py`」或「这是上传的产物，没有生成它的代码」
——**在打开向导之前就说清楚**，而不是让用户走到第三步才发现。`figure` 类产物在按钮上就要说明
它没有标量评分方式。

回看入口三处：

| 入口 | 行为 |
|---|---|
| 会话图谱面板里的 `SearchRun` 节点 | 点开 → 节点详情（摘要）+「打开搜索图」按钮 |
| `SubTask` 详情 | 加「查看搜索过程」按钮，照 Artifact 的双按钮形态（`memory-chain-bar`） |
| 产物页 | 「它从哪来」→ 定位到生成它的候选并高亮 |

三处不改就会坏的地方：

1. `NODE_COLORS` / `EDGE_COLORS` 补 3 label + 6 边——**不补就是黑点 + 灰线**。
2. `graphNodeName` 的 `pick` 规则补分支：`SearchRun` → `algorithm`，
   `SearchNode` → `#<node_index>`，`SearchCell` → `i<island> (c,d)`。不补就显示裸 id。
3. explorer 的过滤 chips 是按 label / edge 列的，新增项自动出现，**但 `SearchNode` 默认不进会话子图**
   （落图文档 §3 的洪水控制），所以 chips 里不会有它——这是对的，不要"修"。

回看视图是**只读**：无 live、无 Stop、无「存为产物」（那是看板的事）。

---

## 8. 状态矩阵

| 场景 | 看板 | 卡片 | 回看入口 |
|---|---|---|---|
| 没跑过 | —— | **不显示** | —— |
| 跑中 | 实时四块 | 进度环 + 当前扩展数 / 预算 | 灰（run 未结束） |
| SSE 断线 | 顶部「重连中」条，**数据保留**，从 store 源补齐（不清空） | 「已断开」 | 灰 |
| 正常结束 | 产物屏 | ✓ + 最优测试分数 | 亮 |
| 预算触顶停机 | 产物屏 + 顶部黄条说明触的是哪条闸 | ⚠ + 「可续跑」 | 亮 |
| 用户 Stop | 同上，标「已中止，可续跑」 | 同上 | 亮 |
| 失败（沙箱不可用 / 侧车挂） | 错误屏 + 可复制的诊断 | ✗ + 原因一行 | 亮（已写入的部分） |
| Science Memory 关 | **照常**（store 源） | 照常 | **不出现**（照 `MemoryGraphView` 的规矩：默认关的功能不留 UI 痕迹） |
| 图不可达 | 照常 | 照常 | 显示 degraded 文案（复用 `MemoryGraphView` 现有那段） |
| 归档会话 | 只读；Stop / 存产物禁用 | 只读 | 亮 |

两条要点：**断线不清空**（清空会让用户以为跑挂了），**图关不降级**（图是投影，不是依赖）。

---

## 9. i18n / CSS / 可达性

- **i18n**：新 key 前缀 `evolve.*` · `searchGraph.*`。`en` 全量补齐（`messages.ts` 的 `en` 是
  MessageKey 的来源），`zhCN` 是 `Partial<Record<MessageKey, string>>`——**中文必须一起补**，
  漏了会静默回落英文。数字与单位走 `usageFormat.ts`，不要新写格式化。
- **CSS**：`styles/evolve.css`，在 `styles.css` 里排在 `memory-graph.css` 之后。
  只用 `tokens.css` 的变量（唯一例外是 §5.2 那份 cytoscape 颜色表）。
- **动效**：`prefers-reduced-motion` 已有 media block；新节点入场动画要放进去（关掉动画时直接出现）。

---

## 10. 测试

| 层 | 用例 |
|---|---|
| 单测（`apps/web/tests/`，照 `NodeField.test.tsx` 的先例） | 坐标计算（depth / 兄弟序 / 岛分带）· 属性变化**不触发** relayout · reducer 对乱序与重复 `seq` 的处理 · 状态矩阵每一行渲染出正确的东西 |
| E2E mocked（`test/`，照 e2e-testing 分组） | 向导四步 → STUB 引擎跑完 → 树长出来 → 点节点看 diff → 存为产物 → **关掉面板后卡片仍在** → 重开看板与关闭前一致 |
| E2E 一致性 | 同一个 run：live 视图 / store 源回看 / 图源回看 三处渲染出的节点数、边数、最优节点一致 |
| a11y | 键盘走完向导四步；搜索结构的表格视图可 Tab 到每个候选 |
| 视觉证据 | 关键屏截图 + trace（e2e skill 要求收集） |

---

## 11. 实现顺序

| # | 任务 | 完成判据 | 依赖 |
|---|---|---|---|
| **F1** | `model.ts` reducer + 两个 adapter + 类型 | 灌一段假事件流得到确定的视图状态；乱序/重复 seq 有测试 | E1/G1 |
| **F2** | `EvolveRunCard` + `/evolve` 拦截（三别名）+ 空壳面板 | 输入 `/evolve` 开面板；关掉后卡片仍在 | E2 |
| **F3** | `EvolveWizard` 四步 + 本地校验 + 预检 | 六条校验各有一个失败呈现；baseline 出分才点亮开始 | E5 |
| **F4** | `SearchGraphCanvas`（era 树）+ 表格视图 | STUB 引擎下树增量长出，pan/zoom/选中不丢；键盘可达 | G3 |
| **F5** | `ScoreChart` + `CandidateStream` + `BudgetBar` | 四块齐；**不看日志能判断这次为什么没变好** | E10 |
| **F6** | `CandidateDetail`（diff）+ `EvolveResult` + 存为产物 | 三个分数分开显示；失败候选显示 error 全文 | E11 |
| **F7** | 回看接入（explorer 三处改动）+ 状态矩阵全分支 | 图关时无痕迹；图不可达时 degraded 文案 | G5 |
| **F8** | `IslandGridPanel` + oe 视觉编码 | 网格能看出迁移与换位 | G8 |

```
F1 ── F2 ── F3 ── F4 ── F5 ── F6 ── F7        ← 里程碑：F5
                          └── F8（跟 G8，不在关键路径）
```

**里程碑在 F5**：那时候四块齐了，判据可以真的拿一次 STUB run 去验——
而 canvas 的布局策略（§5.1）是最贵的返工点，它在 F4 就已经定住。

---

## 12. 待定

1. **看板做成全屏 modal 还是工作区的一个 tab**。建议全屏 modal（照 explorer），
   理由是四块在 400px 宽的工作区面板里放不下。代价是看板打开时看不到会话。
2. **卡片要不要显示历史 run 列表**。建议显示最近 3 个 + 「全部」入口；
   一个项目里跑十几次搜索是常态，只显示最新那个会让前面的都找不回来。
3. **搜索结构块的默认视图**（图 / 表格）。建议图，表格作切换；
   但 a11y 检查可能要求反过来——待评审。
