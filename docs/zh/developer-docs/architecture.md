# 整体运行时架构

本文只描述**当前代码路径**。历史迁移方案不作为实现依据；遇到冲突时，以 `scripts/start-stack.sh`、`services/api/src/agent-run/create-agent-run.ts`、`services/adapter/`、`services/runner/` 和架构检查脚本为准。

## 1. 两种 Agent executor，共用一个控制面

ScienceDiscovery 的 Project、Session、权限、工具实现、Artifact、溯源和运行事件仍由 Node 控制面 `services/api` 持有。Agent executor 有两条实现：

| Executor | 选择方式 | Agent loop 在哪里 | 公共入口 |
| --- | --- | --- | --- |
| Native | 本地源码模式默认；或 `SCIENCE_AGENT_EXECUTOR=native` | `services/api/src/native-agent/` | API 直接监听 `:4310` |
| JiuwenSwarm | Docker/发行包默认；本地用 `--jiuwenswarm` | JiuwenSwarm；ScienceDiscovery adapter 负责协议适配 | adapter `:4310`，API 退到 `:4410` |

关键点：**切换 executor 不会把业务权威状态迁出 API。** `createAgentRun()` 通过 `defaultAgentFactory()` 在 `createNativeAgent` 和 `createJiuwenSwarmAgentFactory` 之间选择。

## 2. 当前进程拓扑

### 2.1 Native 模式

```text
Browser
   │ REST / SSE :4310
   ▼
services/api
   ├─ Agent run orchestration
   ├─ native-agent loop
   ├─ tools / permissions / provenance / artifacts
   ├─ MCP clients / data sources
   └──────────────▶ services/runner :4311 ──▶ sandbox processes

optional sidecars:
services/memory-graph :17674
services/evolve        :4313
services/paper         on-demand worker
Python MCP servers     on-demand stdio children
```

### 2.2 JiuwenSwarm 模式

```text
Browser
   │ REST / SSE :4310
   ▼
services/adapter
   ├─ migrated /agent/* routes
   ├─ per-run MCP bridge
   ├─ per-run model proxy
   └─ reverse proxy for remaining routes
            │
            ▼
services/api :4410
   ├─ authoritative Project / Session / Run state
   ├─ tool construction, permission, Artifact, provenance
   ├─ createAgentRun()
   └─ JiuwenSwarm agent factory
            │ POST /agent/runs
            ▼
services/adapter
            │ WebSocket
            ▼
JiuwenSwarm gateway
   ├─ model calls ──▶ adapter /llm/<token>/v1 ──▶ API model gateway ──▶ provider
   └─ tool calls  ──▶ adapter /mcp/<token> ──▶ API loopback tool bridge
                                              └─▶ Runner / MCP / workspace / etc.
```

Adapter 的真实协议与已验证行为见 `services/adapter/README.md`。未迁移的 HTTP 路由仍反向代理给 TypeScript API。

## 3. 启动模式矩阵

`scripts/start-stack.sh` 是源码/Docker 栈的事实源：

| 模式 | 默认 executor | Adapter | API 端口 |
| --- | --- | --- | --- |
| `--mode local` | native | 不启动 | 4310 |
| `--mode local --jiuwenswarm` | JiuwenSwarm | 4310 | 4410 |
| `--mode docker` | JiuwenSwarm | 4310 | 4410 |
| `--mode docker --no-jiuwenswarm` | native | 不启动 | 4310 |

发行单文件的默认行为与 Docker 一致：JiuwenSwarm 是默认 executor。

无论 executor 如何选择，Runner 默认只监听回环 `:4311`。

## 4. 服务与 sidecar 职责

| 组件 | 形态 | 当前职责 |
| --- | --- | --- |
| `apps/web` | 静态 Web / dev server | UI、SSE 展示、权限卡片、设置 |
| `services/api` | 常驻 Node | 控制面、运行编排、权威状态、工具/权限/Artifact/溯源 |
| `services/adapter` | JiuwenSwarm 模式常驻 Python | 公共 front door、JiuwenSwarm run bridge、LLM/MCP 适配、旧 API 反代 |
| `services/runner` | 常驻 Node | Bubblewrap/Seatbelt 执行、科学环境、可选 NPU broker |
| `services/memory-graph` | 可选常驻 Python | ScienceMemory 图服务；存储可为本地文件或 Neo4j |
| `services/evolve` | 常驻 sidecar（栈启动时） | 演进搜索；业务事件和持久化权威仍在 API |
| `services/paper` | 按需 Python worker | 有界 PDF 抽取 |
| `services/gateway` | **不是 HTTP 服务** | 随包 Python MCP server 代码与解释器环境 |
| JiuwenSwarm | 外部/随包运行时 | JiuwenSwarm executor 的会话与循环实现 |

不要再把 `services/gateway` 当成 Agent gateway 服务；也不要把 `deer-flow` 当成当前依赖。

## 5. 一次 Run 的共同控制面路径

两种 executor 在 `createAgentRun()` 之前和工具执行之后共享同一控制面：

1. HTTP 层接收 Session message。
2. API 解析生效设置、模型、Skill、Specialist、Connector、Workspace 和权限状态。
3. `runMainRequestExecution` / `runSubagentTask` 构造运行上下文。
4. `createAgentRun(profile, bindings, input)` 选择 executor。
5. executor 产生模型事件和 tool call。
6. Tool 最终回到 ScienceDiscovery 提供的真实处理器，因此权限、Runner、Artifact、MCP、审计语义保持一致。
7. API 持久化 RunStreamEvent、消息、Prompt Manifest、Artifact 与 provenance。

因此修改 executor 时，不应复制 Project/Session/permission/artifact 存储逻辑。

## 6. 包与服务的所有权边界

架构的核心约束不是“目录看起来像什么”，而是 `scripts/check-architecture.mjs` 强制的依赖规则：

- **能力实现归 `packages/` 所有。**
- `services/` 负责进程入口、HTTP/协议适配和组合装配，不应复制 capability policy。
- `apps/web` 只负责浏览器体验，不是权威业务状态。
- `packages/` 不得 import `services/` 或 `apps/`。
- 生产 services 不得依赖旧的 `@sciencediscovery/agent-runtime` compatibility facade。
- `packages/runtime-core` 只能使用相对 import，是最底层运行时合同。
- `packages/context` 只能依赖 `model` 和 `runtime-core`，避免 contributor 扩展形成依赖环。
- executor → runner 是当前唯一显式冻结的遗留 package 耦合；不要扩大这个例外。

`check-architecture.mjs` 还显式禁止一批已经迁移到 package 的旧 `services/api/src/*` 源文件重新出现。新增功能前先运行：

```bash
pnpm architecture:check
```

## 7. 重要 composition seam

深度开发最需要先找到这些入口：

| 目的 | 代码入口 |
| --- | --- |
| API 进程 | `services/api/src/server.ts` → `http/index.ts` |
| Agent Run | `services/api/src/agent-run/create-agent-run.ts` |
| Native executor | `services/api/src/native-agent/` |
| JiuwenSwarm executor | `services/api/src/agent-run/jiuwenswarm-agent.ts` |
| JiuwenSwarm front door | `services/adapter/src/sciencediscovery_adapter/` |
| Tool/runtime capability | `packages/tools`, `packages/workspace`, capability packages |
| Sandbox execution | `services/runner/src/server.ts` + `packages/executor` |
| Plugin contracts | `packages/plugin-sdk` |
| Context contributors | `packages/context` |
| Stack lifecycle | `scripts/start-stack.sh` |
| Architecture enforcement | `scripts/check-architecture.mjs` |

## 8. 修改架构时的检查清单

- 这是 capability policy，还是进程/协议装配？
- 是否已经有 owning package？
- native 与 JiuwenSwarm 两个 executor 是否都需要适配？
- 是否改变公共端口、内部端口或 sidecar 生命周期？
- 是否改变 Run/Tool/Artifact/Permission 的权威状态归属？
- 是否增加 package dependency edge？能否通过 `pnpm architecture:check`？
- 用户可观察行为是否需要 E2E，而不仅是单元测试？

## 相关文档

- [深度开发指南](developer-guide.md)
- [控制面](control-plane.md)
- [Agent 后端](agent-backend.md)
- [组件与插件机制](plugins.md)
- [沙箱执行](sandbox-execution.md)
- [仓库布局](repository-layout.md)
