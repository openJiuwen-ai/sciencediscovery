# 控制面：services/api

Node 控制 API 是系统的核心进程：所有浏览器请求、Agent 运行编排、工具执行、权限、评审与存储都经过它。本文描述其内部结构与主要机制；HTTP 端点以 `services/api/src/http/index.ts` 中的路由注册为准。

## 1. 源码结构

| 文件 / 目录 | 作用 |
|---|---|
| `server.ts` | 兼容入口 barrel（re-export `http/`），进程启动点 |
| `http/` | HTTP 壳：路由装配、鉴权、请求体、响应、静态资源 |
| `runs/` | 运行生命周期、SSE 运行流、会话运行编排与并发串行化、workspace 事件过滤 |
| `store.ts` / `store/` | `SessionStore` 门面 + SQLite 目录库；实体职责由 catalog/permissions/secrets/settings/subagents/run-streams 域模块承担 |
| `native-agent/` | **Node 原生 agent loop**：`index.ts`（循环状态机）、`model-client.ts`（流式模型传输）、`deferred-tools.ts`、`compaction.ts`；见 [agent-backend.md](agent-backend.md) |
| `agent-run/` | 运行编排：`create-agent-run.ts`（主/子 Agent）、`permission-runtime.ts`（权限状态机）、`workspace-bindings.ts`（工具与 runner 绑定）、`orchestrators.ts` |
| `mcp/` | MCP 治理与传输：`broker.ts`（调用治理）、`node-client.ts`（**进程内 MCP 客户端**）、`extensions-config.ts`、`source-catalog.ts`、`artifact-manager.ts`（下载/抽取任务）、`rate-limiter.ts`、`result-cache.ts` |
| `runner-client.ts` | Runner HTTP 客户端（Bearer + HMAC 签名） |
| `provenance.ts` / `prompt-manifest.ts` / `reviewer-specialist/` | 溯源与 Artifact Reviewer，见 [review-provenance.md](review-provenance.md) |
| `papers.ts` / `skills.ts` / `remote-compute.ts` / `environment.ts` | 论文、技能、实验性远程作业卡片和科学环境的领域逻辑；远程作业不是当前支持主线 |
| `memory-graph.ts` | 实验性 memory-graph 侧车客户端 |

## 2. HTTP 面

按前缀分组（代表性端点，非穷举）：

| 前缀 | 内容 |
|---|---|
| `GET /health`、`/api/health` | 聚合健康：runner、memory-graph 状态 |
| `/api/projects…` | 项目 CRUD、设置覆盖、删除影响预览 |
| `/api/sessions…` | 会话 CRUD、归档/恢复、设置、删除影响预览 |
| `POST /api/sessions/:id/messages` | **SSE**：发起一次运行并流式返回 `RunStreamEvent` |
| `GET /api/sessions/:id/runs/:runId/stream` | **SSE**：订阅已存在运行的事件 |
| `GET /api/sessions/:id/runs/:runId/streams/:streamId/events` | 读取已持久化子流（`main`/`tool-<id>`/`subagent-<id>`）事件，支持 `after` 游标增量回放 |
| `POST /api/sessions/:id/runs/:runId/cancel` | 取消运行（abort 贯通到原生 loop 与 runner） |
| `/api/sessions/:id/{plans,subagents,remote-jobs,papers,evidence-items}` | 计划、子 Agent、远程作业、论文、证据 |
| `/api/sessions/:id/mcp/…` | MCP 调用记录、artifact plan/job/extraction-job |
| `/api/mcp/sources…` | MCP Source 目录与状态 |
| `/api/{models,specialists,skills,remote-hosts,environments}` | 全局资源管理 |
| `/api/settings`、`/api/timeout-settings`、`/api/quota-settings`、`/api/sandbox-network-settings`、`/api/runtime-status` | 全局设置、超时、配额、沙箱网络访问、运行状态页 |

SSE 传输为 fetch 流（`data: <json>\n\n` 帧），前端消费方式见[Web 前端参考](../reference/web-frontend.md)。

## 3. 存储

- **SQLite**（`node:sqlite`，`.sciencediscovery-data/catalog.sqlite`）：项目、会话、运行、消息、artifact 与版本、权限（请求/授权/epoch）、计划、子 Agent、specialists、模型配置、`permission_authorizations` 审计表等目录实体。
- **文件**（`.sciencediscovery-data/` 下按会话分文件）：execution-runs、prompt-manifests、claims、evidence-items/links、mcp-invocations、artifact-derivations、model-usage 等审计记录，以及 CAS blob（`.sciencediscovery-data/cas/sha256/…`）。
- 完整落点见[配置参考](../reference/configuration.md#存储布局)。

## 4. 运行生命周期

状态机：`queued → running ⇄ blocked →（completed | failed | cancelled | interrupted）`。`blocked` 表示等待权限决策；`interrupted` 是进程崩溃后启动恢复（`recoverSessionRuns`）标记的历史运行。

一次主运行（`agent-run/create-agent-run.ts`）：

1. **准备**：校验会话与模型、解析 composer 引用、同步科学环境、构建工作区系统提示。
2. **执行**：创建 `RequestExecutionContext`（executionId、权限运行时、abort signal），由 `createNativeAgent` 在本进程内跑 agent loop。
3. **记录**：写 Prompt Manifest 与执行、Artifact 溯源记录；显式触发的 Reviewer Specialist 通过独立 checkpoint 审核 Artifact，不阻塞主 Agent。
4. **收尾**：发 `run.completed`/`run.failed`/`run.cancelled`，清理挂起的权限请求。

子 Agent（`task` 工具）在私有工作区中运行受限工具集，交接文件有大小上限，结束时按 Brief 的 `outputJsonSchema` 校验结构化输出（契约见 [subagent-orchestration.md](subagent-orchestration.md#41-subagent-brief-v1-契约)）。

## 5. 权限系统

- **动作类型**：`code`、`connector`、`artifact_download`、`directory`、`host`、`remote_job`。
- **授权范围**：`once`（单次，用后作废）/ `session` / `project` / `global`。
- **流程**（`store.requestPermission` → `decidePermissionRequest`）：先查未撤销的常驻授权与 once 授权；未命中则产生 pending 的 `PermissionRequest`，经 SSE 发 `permission.required` 卡片，运行转 `blocked` 并暂停超时计时（`beginExternalWait`）；用户选择 allow_once / allow_matching / deny，决策落 `PermissionAuthorization` 审计行。
- **Epoch**：审批模式变化或环境重置时 `rotatePermissionEpoch`，持久内核随 epoch 失效重建；每条 ExecutionRun 记录当时的 `permissionEpochId`。

## 6. 工具执行与 Runner 通道

- 工具由原生 loop **在本进程内直接调用**（`AgentTool.execute`），不再有跨进程回调，也不再有 per-run callback token。权限门、溯源和限流仍在工具处理器内生效。
- Runner 调用（`runner-client.ts`）：`/execute`、`/execute-shell` 附加 HMAC-SHA256 签名头（token + 时间戳 + body 哈希）；另有 kernels、environments、setup 等管理端点，见 [sandbox-execution.md](sandbox-execution.md)。

## 7. 由本进程直接发出的模型调用

- **Agent 主循环**（`native-agent/model-client.ts`）直接向用户配置的模型 endpoint 发流式请求，支持 OpenAI 兼容与 Anthropic Messages 两种方言。
- **论文视觉分析**（`papers.ts`）直接 `fetch` OpenAI 兼容端点；细节见 [PDF worker 参考](../reference/paper-worker.md)。

## 相关文档

- [architecture.md](architecture.md) — 全局架构与进程模型
- [agent-backend.md](agent-backend.md) — gateway 协议与 Agent 循环
- [sandbox-execution.md](sandbox-execution.md) — Runner 沙箱与科学环境
- [review-provenance.md](review-provenance.md) — Artifact Reviewer、执行溯源与 CAS
