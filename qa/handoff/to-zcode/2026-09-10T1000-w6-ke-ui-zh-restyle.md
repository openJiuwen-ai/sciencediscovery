# W6 KE 界面中文化 + DA 风格重设计 — 交接（journey 选择器已改）

日期：2026-09-10 · 分支 feature/knowledge-engine

## 做了什么

- KE 页四组件（KnowledgeEnginePage/KeGrowPanel/KeRootsView/KeGraphCanvas）+ App.tsx 侧边栏入口全部接入 i18n（`ke.*` 66 键 + `app.knowledgeEngine`，en+zhCN 双语），zh-CN 环境下全中文。
- 布局对齐 DA SubjectEnginePage 模式但用 SD token（--surface/--border/--accent/--radius-m 等）：顶栏=关闭+标题+KB 名+实时计数(ke-header-counts)+面包屑；左栏 340px（知识库/播种卡带篇数下拉 5-25/增长面板/消解/后台任务状态 pill/文档）；主区右上角计数徽章(ke-counts-badge)；底部固定 230px 详情面板（meta 行、证据卡片网格：方向箭头+边类型 pill+参考文献（doc）：quote）。
- 增长面板 DA 化：说明文案、方向输入（留空=KB 名）、预算下拉 10/30/50/100 → budget.maxPapers、进度条(ke-grow-progress-bar)、前沿计数(ke-grow-progress)、四信号行(ke-grow-signals)、已收敛徽章(ke-converged-badge)、日期 toLocaleString(locale)。
- 画布：边宽按 log2(支撑)、cose 防重叠调密、**拖拽位置按 KB 持久化** localStorage `keGraphPos:<kbId>`（合并写入，不丢屏外节点）、右下角类型图例(ke-graph-legend)。保 cytoscape，不引 G6。
- roots 气泡换 DA 十色盘 + 尺寸公式 min(160, 64+72·√(size/max))。

## journey 选择器变更（test/journey-ke-*.spec.ts 已同步改）

zh-CN locale 下原英文文本选择器全部失效，已改为语言无关选择器：

| 原选择器 | 新选择器 |
|---|---|
| `getByRole("button", { name: "Knowledge Engine" })` | `getByTestId("open-knowledge-engine")` |
| `getByLabel("new kb name")` | `getByTestId("ke-new-kb-name")` |
| `getByLabel("seed query")` | `getByTestId("ke-seed-query")` |
| `not.toContainText("no jobs yet")` | `ke-job-status >> [data-status]` 首行可见 |
| `not.toContainText("running")` | `[data-status='pending'],[data-status='running']` count=0 |
| `not.toContainText("failed")` | `[data-status='failed'],[data-status='dead']` count=0 |

任务行现在带 `data-status={pending|running|succeeded|failed|dead}`，建议后续断言一律走属性而非文本。

## testid 兼容承诺（未变）

knowledge-engine-page / ke-transient-issue / ke-kb-* / ke-create-kb / ke-seed / ke-resolve / ke-job-status / ke-documents / ke-breadcrumb(-roots/-all) / ke-graph-empty / ke-community-empty / ke-graph-canvas / ke-roots / ke-community-* / ke-grow-panel / ke-grow-start / ke-grow-progress / ke-grow-signals。
`ke-entity-detail` 语义保持：**仅在选中实体时出现**（空态为 ke-detail-empty）。
新增：open-knowledge-engine / ke-new-kb-name / ke-seed-query / ke-counts-badge / ke-header-counts / ke-converged-badge / ke-grow-progress-bar / ke-graph-legend / ke-detail-empty。

## 行为说明

- 后台任务列表 8→30 行（对齐 DA）；播种篇数选项 5/10/15/20/25（服务端上限 25）。
- 评审 3C/2M/7m 全修（选择器失效×3、任务等待文本失效、位置持久化丢屏外节点、死键、token 硬编码色、括号本地化等）。
