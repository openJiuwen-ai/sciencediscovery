# Runtime Core 边界

`@sciencediscovery/runtime-core` 是稳定、与领域无关的执行内核。它拥有 Agent Loop 状态机，
只负责所有 Agent 执行共有的不变量：

- 组装上下文、调用模型、执行请求的工具，然后重复；
- 并发执行同一模型轮次请求的工具调用，并按原调用顺序提交结果；
- 维护规范历史，以及 assistant/tool-call 配对；
- 观察取消，表示独立的外部等待，强制执行调用方提供的模型轮次上限，并发出一个终态结果。

运行时依赖四个端口，没有产品包依赖。`RuntimeBuilder` 是它的类型化注册入口，会拒绝不完整的
组合，并在运行开始前冻结端口注册表：

- `ContextAssembler` 生成权威历史和不透明的模型输入；
- `ModelClient` 执行一个归一化的模型轮次；
- `ToolDispatcher` 应用工具策略并返回一条规范历史消息；
- `RunEventSink` 将中性的生命周期事件投射到日志、SSE 或指标。

`services/api/src/bootstrap/runtime.ts` 是组合根。它的原生 Agent 适配器将端口连接到提示词构建、
历史压缩、模型传输、工具注册表、权限门禁、溯源钩子和 SSE 事件。这些策略刻意保留在 Runtime
Core 外。子 Agent 通过既有的 `task` 工具派发，因此内核不定义独立的 Agent 派发路径。

依赖方向为：

```text
apps -> services/api -> 能力适配器 -> packages/runtime-core
```

能力代码可以实现 Runtime Core 端口。Runtime Core 绝不能导入 HTTP/SSE、提供方客户端、工具、MCP、
权限、Artifact、溯源、Specialist 或其他 ScienceDiscovery 领域包。

当前能力归属：

- `packages/context`：历史压缩、有作用域的 `ContextContributor` 契约、稳定的
  `DefaultContextAssembler` 和可选的 `DynamicContextAssembler`。在 `shadow`/`dynamic` 模式中，
  Node 负责 contributor 准入、确定性的提示词渲染、调用局部的消息组合、运行范围的持久工具状态投射、
  模型感知的原子历史窗口选择和最终校验。规范历史和受治理的工具集合仍是权威。
  默认 `dynamic` 模式发送 Node 原生组装的模型输入，`legacy` 和 `shadow` 仍是显式的调试或回归路径；
- `packages/model`：`ProviderModelClient`、与提供方无关的模型类型、归一化流式传输、代理、超时和重试策略；
- `packages/tools`：冻结的工具注册表、延迟发现、远程内容净化、错误归一化和循环策略；
- `packages/workspace`：工作区路径和工作区工具实现；
- `packages/orchestration`：`AgentRun` 配置、生命周期契约和子 Agent 配置；
- `packages/governance`：权限 epoch、匹配/授权策略和独立的权限决策队列；
- `packages/provenance`：溯源记录、评审策略、引用/计算评审、由 Agent 发起的评审检查点和评审日志；
- `packages/artifact-manager`：Artifact 分类/注册、受治理的下载状态和面向 Artifact 的 MCP 工具绑定；
- `packages/data-source`：MCP/Web broker、提供方客户端、缓存、出站代理解析、来源目录和 Web 工具绑定；
- `packages/executor`：科学/远程执行客户端和可复现实验环境元数据；
- `packages/memory`：Memory Graph 客户端、观测 sink 和运行日志 adapter；
- `packages/specialist`：内置 Specialist 定义和子 Agent 生命周期转换。

`services/api/src/bootstrap/platform.ts` 为这些包选择具体的存储、MCP、网络、模型、评审和执行
适配器。HTTP 服务消费这个已组合的服务集合并转换 HTTP/SSE 请求，不拥有领域构造。`SessionStore`、
MCP Node 进程客户端、HTTP/SSE 转换，以及小型的 Reviewer-to-AgentRun 桥接仍是服务适配器。
能力包依赖窄端口，而不是 `SessionStore` 或其他服务实现。

动态上下文模式、Contributor 边界、预算和完整输入跟踪导出见[动态上下文组装](context-assembly.md)。

评审行为始终是显式的：注册 Artifact 不会自动派发评审。主 Agent 调用 `review_checkpoint`，结果通过
普通 Tool Result/SSE 路径返回。Runtime Core 和 Artifact manager 都不含 Review outbox 或隐式的 Review
协调器。

此前私有的 `packages/agent-runtime` 聚合包已在仓库中的所有导入迁移到各自能力包后移除；不保留兼容
服务定位器或重复运行时。

权限、溯源、Artifact、数据源和 Specialist 仍是领域服务/适配器，只能通过已注册工具或事件进入
执行。它们不得向 Runtime Core 添加控制分支。

`pnpm architecture:check` 强制执行这一方向：包不能导入 `services`/`apps`，生产服务不能使用兼容
门面，Runtime Core 不能使用非相对导入，已经移入包的领域源码不能在 `services/api` 下重新创建。
