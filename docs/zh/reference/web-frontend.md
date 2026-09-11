# 前端：apps/web

React 浏览器 UI，构建后由控制 API 作为静态资源托管；开发时可独立热重载。刻意保持轻依赖：无路由库、无状态管理库。

## 1. 技术栈

- React 19 + Vite（`@vitejs/plugin-react`）；纯 CSS（`styles.css`），无预处理器
- Markdown：`react-markdown` + `remark-gfm` / `remark-math` / `rehype-katex`
- 分子查看器：Molstar（`molecular.ts` 初始化）
- 路由与状态：手写——顶层视图由 [App.tsx](../../../apps/web/src/App.tsx) 中的 state（如 `activeSessionId`）切换，状态全部在 React hooks 中

## 2. 源码布局

| 文件 | 作用 |
|---|---|
| `App.tsx` | 根组件与状态壳：全局状态、会话/项目管理、运行流监听、顶层装配；纯逻辑委托给 `timeline/`、`composer/`、`session/`、`run-stream/` 特性模块 |
| `api.ts` / `api/` | `api.ts` 为兼容公共入口 barrel；`ApiClient` 与各域客户端（artifacts/auth/projects/runs/sessions/settings/skills/web）在 `api/` |
| `timeline/RunTimeline.tsx` | 事件流 reducer + 时间线渲染（thinking / tool / assistant 条目）；旧路径 `RunTimeline.tsx` 留兼容再导出 |
| `ProcessRecord.tsx` / `styles/process-records.css` | 活动卡片与终态可展开记录的展示、工作区一级分区、对齐与悬停样式；不改变执行状态 |
| `SkillReviewRecords.tsx` | 根据精确 draftId 查询待审状态，区分待审入口与已处理记录 |
| `session/ConversationArtifactList.tsx` | 本轮产物入口，保留固定版本与当前文件的语义区别 |
| `session/run-activity.ts` | 活动卡片（plan / subagent / remote job / permission / 产物预览）按 run 归组与锚点计算；卡片展开态纯函数（`setActivityCardExpanded`，区分「未记录」与 `false`） |
| `Permissions.tsx` | 权限卡片与授权管理 |
| `Orchestration.tsx` | 子 Agent 卡片、specialist、计划展示 |
| `RemoteCompute.tsx` / `ScientificArtifacts.tsx` / `RuntimeControls.tsx` / `EnvironmentManager.tsx` / `SkillManager.tsx` / `MemoryGraphView.tsx` | 各系统配置与领域面板 |
| `UsagePage.tsx` | 用量看板：模型/日期筛选、Token 与费用总览、按日堆积柱状图、随筛选收敛的明细下钻与 CSV/JSON 导出；长日期范围可横向拖动/滚动，默认显示最新日期，向左查看更早记录 |
| `ManagementControls.tsx` / `WorkbenchNavigation.tsx` | 生命周期对话框、全局搜索与 composer 引用（@artifact、#session、/skill） |
| `Markdown.tsx` / `Toasts.tsx` / `icons.tsx` | 渲染基础设施 |

## 3. 与服务端通信

- `ApiClient.request()` 统一注入 `authorization: Bearer <token>`；token 存 localStorage 键 `sciencediscovery-token`（另有工作区面板布局键）。
- 运行流：`streamMessage()` POST `/api/sessions/:id/runs`，以 `accept: text/event-stream` 用 fetch `body.getReader()` 手工解析 `data: <json>\n\n` 帧（非 EventSource，便于带 Authorization 头与 abort）。

## 4. 事件到 UI 的映射

`RunStreamEvent` 由 `timeline/RunTimeline.tsx` 归约到时间线，面板类事件由 `App.tsx` 装配并委托特性模块分发：

| 事件 | UI |
|---|---|
| `agent.phase` / `assistant.thinking.delta` / `assistant.delta` | 时间线 thinking / 正文条目 |
| `tool.started` / `tool.completed` | 工具条目状态与摘要 |
| `tool.output` | 工具输出按子流 `streams/:streamId/events` 增量追加，详情按需展开 |
| `permission.required` | 权限卡片（动作类型：code/connector/artifact_download/directory/host/remote_job） |
| `plan.updated` | 右侧 Workspace 的 Tasks 区按 Agent 展示当前 Plan；空快照会移除该 Agent 的当前卡片，但事件仍保留在持久化事件流中 |
| `subagent.updated` | 在首次委派的位置逐个更新子任务，不因同时运行而强制合组；结束后每个子任务保留一条可展开记录，独立会话入口仍可访问 |
| `remote_job.proposed` | 按 run 归位的远程作业记录；待批状态保留审批卡片，终态可展开；展示历史记录不代表恢复远程执行能力 |
| `artifact_review.completed` | Reviewer Specialist 卡片与 Artifact 审核结果 |
| `run.completed` / `run.failed` / `run.cancelled` | 时间线收尾、工作区文件刷新、错误横幅/Toast |

## 5. 展示生命周期

- 每轮 Run 的头像和模型名只显示一次，位于用户输入之后、该轮思考和工具之前。后续正文和过程记录共享文字起点。
- 思考、工具及其他活动执行中保留卡片；终态折叠为灰色无边框单行。失败仍有明确文字，并在文字后紧跟红点。悬停或键盘聚焦平滑变深色，尊重减少动画设置。
- 点击终态记录恢复带框详情，可再次收起；工具输入、输出、错误可分别展开。展示折叠不删除事件、日志、结果或后端审计。显式展开选择不会被新的流式片段反复重置。
- 待审批请求保留决策按钮；请求已允许、拒绝或取消后不再保留权限卡片。只有精确匹配 `toolCallId` 的获准工具在运行或展开时显示“已授权”，不能以另一个工具获准推断本工具已授权。
- 受治理下载仍位于中间对话区，候选、待审批及进行中任务保留操作；终态详情和失败重试可展开。计划的 `awaiting_approval` 不能替代权限请求的真实状态；已取消请求无法再次审批。当前仍有计划状态未随请求取消同步的已知问题，本次未修复该后端状态链路。
- Reviewer、Skill 总结和草稿审核分别按自身状态转换，不以主 Run 结束推断它们已完成。草稿从待审列表消失只能表述“已处理”，不等于“已批准”；状态查询失败不应误报完成。
- 只在最新合格源 Run 下显示 Skill 总结入口。没有可写 Skill 库、会话已归档或没有模型时隐藏尚未发起的入口；已有总结任务和结果继续展示。`project-skills` 是推荐名称，不会因此自动创建库。
- 本轮产物保留原卡片和固定版本入口，不再额外叠放 `Generated result` 聚合卡。未登记文件只能打开当前内容，不冒充不可变历史版本。

## 6. 右侧工作区

一级分区默认展开，二级详情和文件目录默认收起，各自独立切换。一级分区通过本地状态保留用户的展开选择，流式更新不重置，内部详情切换不改变外层状态；切换 Session 后重新默认展开，不跨会话持久化。内部功能继续使用原白色面板，不套用中间区域的终态去框规则。

| 一级分区 | 内容与条件 |
|---|---|
| 文件 | 上传、项目产物及 Session 分组、工作区文件与文件溯源；空产物/文件列表不显示对应入口，上传保留 |
| 任务 | 当前执行计划、Evolve、启用的 Reviewer 控制、执行记录、传输、提醒；无内容时整区隐藏，但活动轮询继续运行，收到新任务后重新显示 |
| 记忆 | 已启用的科学记忆摘要与图谱入口；未启用时连同二级入口隐藏，启用但空数据/不可达时保留相应提示 |

列表标题右侧只显示总条数，0 条列表隐藏；控制入口不伪造条数。工作区文件展开时才在数量左侧显示多选图标，收起后隐藏图标；多选、下载、删除和溯源操作不变。

计划标题过长时截断并提供完整悬停文本，进度单独一行，状态标签不换行。全部步骤完成显示“已完成”；Run 已终止但步骤未全完成显示“已结束”，不能因条目非空就显示“进行中”。空计划快照仍移除该 Agent 的当前计划。

移除右侧独立 Paper reader 面板、Provenance 统计卡和隔离常驻提示，仅改变入口布局，不删除论文解析、审计或隔离能力。文件区计数是总数，不表示未读数；本次没有实现下载后确认再隐藏的交互。

## 7. 开发与测试

- 开发：`pnpm --filter @sciencediscovery/web dev` → Vite `127.0.0.1:5173`，代理 `/api` 与 `/health` 到 `127.0.0.1:4310`。
- 单元测试：`tsx --test tests/*.test.tsx`（Node test runner），覆盖时间线归约、停止流程、composer 状态、多会话流隔离等。
- 展示回归重点：`ProcessLifecycle.test.tsx`、`Permissions.test.tsx`、`Orchestration.test.tsx`；浏览器覆盖 `journey-compact-process.spec.ts`、`journey-delegate-subtask.spec.ts`、`journey-plan-workspace.spec.ts`，检查运行/终态、独立子任务、Skill 生命周期、文件访问、计划状态与窄屏布局。
- 用户视角 E2E：从真实使用步骤验证用户目标和结果，不限于 Web。浏览器旅程的固定 Playwright 用例在根 `test/`，`pnpm ci:e2e` 运行 mocked 浏览器子集；API/CLI/本机栈旅程另按公开产品入口运行。UI 改动仍需浏览器交互与布局验证，不能由 API 断言代替；定义、补用例时机与装配见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#user-perspective-e2e)。

## 相关文档

- [控制面](../explanation/control-plane.md) — SSE 端点与事件来源
- [整体运行时架构](../explanation/architecture.md) — 前端在进程模型中的位置
