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

## 追加修复（E2E 复跑发现）

- **轮询链陈旧读修复（KnowledgeEnginePage）**：`refreshKbData` 现在返回 `{failed, jobs}`（本轮取到的任务列表），loop 用返回值判定是否有 pending/running，不再同步读 `jobsRef`——`await` 后 React 尚未刷新渲染，`jobsRef.current` 会拿到旧的空列表导致链提前停（表现：播种后面板冻结、文档列表不更新）。
- **KB 切换即时清空（KnowledgeEnginePage）**：切换 KB 时立即清空 graph/documents/jobs/growStatus/roots/detail 五个状态片——此前旧 KB 的数据会残留到下一次刷新，既误导用户也让 journey 的文档 ✓ 等待吃到旧库的假阳性。
- **J-KE1 步骤 1 断言放宽**：图谱区断言改为 `ke-graph-empty | ke-graph-canvas | ke-roots` 三选一——数据目录有遗留 KB 时首开会自动选中带社区的库，显示社区总览属合法状态。
- **画布确定性测试钩子**：`window.__keGraphCy`（DA `__subjectGraph*` 先例），J-KE2 的节点点击改为 `page.evaluate` 里 `cy.nodes().first().emit("tap")`，盲点画布中心不可靠。
- **jobs 排空预算 60s→180s**（三个 journey 统一）：10 篇串行摄取+抽取在共享机器上超过 60s。
- **journey 必须在 WSL 里跑**：旅程注册的抽取 stub 监听 127.0.0.1:<动态端口>，Windows 侧跑 Playwright 时 WSL 栈够不到它（NAT 模式 localhost 不互通），ke_extract 全部 ECONNREFUSED→dead。WSL 侧跑（~/sciencediscovery/test + .e2e 依赖 + chromium-1228 已就绪）则闭环。
- **隔离栈数据目录需每次重置**：遗留 KB 会污染首开状态（自动选中带实体的旧库）；本次用 `mv data6 data6.bak` 重置后两轮 journey 全绿（J-KE1 1.3m / J-KE2 1.6m）。

## 验收状态

- apps/web tsc ✅ / architecture:check ✅（228 文件）
- J-KE1 + J-KE2 在隔离 fixture 栈（4390）全绿，零 console error；journey 报告含逐步截图（中文界面）。
- 视觉抽查截图：roots 社区气泡、下钻、详情面板、图例、增长面板均为中文。
