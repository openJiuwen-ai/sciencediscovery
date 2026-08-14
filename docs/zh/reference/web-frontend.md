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
| `session/run-activity.ts` | 活动卡片（plan / subagent / remote job / permission / 产物预览）按 run 归组与锚点计算；卡片展开态纯函数（`setActivityCardExpanded`，区分「未记录」与 `false`） |
| `Permissions.tsx` | 权限卡片与授权管理 |
| `Orchestration.tsx` | 子 Agent 卡片、specialist、计划展示 |
| `RemoteCompute.tsx` / `ScientificArtifacts.tsx` / `RuntimeControls.tsx` / `EnvironmentManager.tsx` / `SkillManager.tsx` / `MemoryGraphView.tsx` | 各系统配置与领域面板 |
| `ManagementControls.tsx` / `WorkbenchNavigation.tsx` | 生命周期对话框、全局搜索与 composer 引用（@artifact、#session、/skill） |
| `Markdown.tsx` / `Toasts.tsx` / `icons.tsx` | 渲染基础设施 |

## 3. 与服务端通信

- `ApiClient.request()` 统一注入 `authorization: Bearer <token>`；token 存 localStorage 键 `science-agent-token`（另有工作区面板布局键）。
- 运行流：`streamMessage()` POST `/api/sessions/:id/runs`，以 `accept: text/event-stream` 用 fetch `body.getReader()` 手工解析 `data: <json>\n\n` 帧（非 EventSource，便于带 Authorization 头与 abort）。

## 4. 事件到 UI 的映射

`RunStreamEvent` 由 `timeline/RunTimeline.tsx` 归约到时间线，面板类事件由 `App.tsx` 装配并委托特性模块分发：

| 事件 | UI |
|---|---|
| `agent.phase` / `assistant.thinking.delta` / `assistant.delta` | 时间线 thinking / 正文条目 |
| `tool.started` / `tool.completed` | 工具条目状态与摘要 |
| `tool.output` | 工具输出按子流 `streams/:streamId/events` 增量追加，详情按需展开 |
| `permission.required` | 权限卡片（动作类型：code/connector/artifact_download/directory/host/remote_job） |
| `plan.proposed` / `subagent.updated` / `remote_job.proposed` | 按 run 归位的活动卡片：渲染在产生它们的 run 的对话块（回放时间线或消息）之后，默认折叠为一行摘要（名称/状态/步骤数/用量），可展开；展开态由 App 层按卡片 id 维护；待批 remote job 默认展开以便审批、可手动收起 |
| `artifact_review.completed` | Reviewer Specialist 卡片与 Artifact 审核结果 |
| `run.completed` / `run.failed` / `run.cancelled` | 时间线收尾、工作区文件刷新、错误横幅/Toast |

## 5. 开发与测试

- 开发：`pnpm --filter @science-agent/web dev` → Vite `127.0.0.1:5173`，代理 `/api` 与 `/health` 到 `127.0.0.1:4310`。
- 单元测试：`tsx --test tests/*.test.tsx`（Node test runner），覆盖时间线归约、停止流程、composer 状态、多会话流隔离等。
- 浏览器 e2e：Playwright 用例在仓库根 `test/`，环境搭建见 [CONTRIBUTING.md](../../../CONTRIBUTING.md)。

## 相关文档

- [控制面](../explanation/control-plane.md) — SSE 端点与事件来源
- [整体运行时架构](../explanation/architecture.md) — 前端在进程模型中的位置
