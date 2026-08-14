# 科研 MCP 与外部数据源

## 1. 唯一运行路径

科研检索、记录查询和文件候选解析统一走 MCP：

```text
Agent MCP tool
  → Node MCP Governance Broker
  → Python Agent Gateway 的 MCP client
  → Python MCP server
  → CAS、缓存、权限、审计
  → 规范化 McpToolResult
```

旧 `invoke_connector`、`ConnectorBroker`、`ScienceSource` 和 Node 直连 provider 的路径已经移除。
完整接口与生命周期见 [MCP 工具与协议设计](mcp-tool-protocol.md)。

## 2. 职责边界

- Python MCP 负责实际查询、provider 参数/响应校验、瞬时错误重试和标准结果组装。
- Node 负责统一注册、会话授权、来源身份与 URL 白名单复核、并发/速率限制（限流底座与 MCP 调用流程见 [rate-limiting.md](rate-limiting.md) 第 2 节）、缓存、CAS 和审计。
- Agent 只接收规范化结果；MCP 返回的外部内容始终视为不可信数据。
- PDF worker 只处理已完成下载的本地 PDF，不负责联网检索。

实现位置：

| 路径 | 作用 |
|---|---|
| `packages/mcp-sources` | Source/Tool manifest、输入与信任边界校验 |
| `services/gateway/src/science_agent_gateway/*_mcp.py` | Python MCP 工具和 provider 访问 |
| `services/api/src/mcp` | Broker、Catalog、CAS 审计、缓存和 Artifact 下载 |
| `packages/agent-runtime` | MCP 工具暴露、`artifact_download`、`paper_extract_pdf` |
| `services/paper` | 有界 PDF 抽取 |

## 3. 工具注入与模型可见性

Agent 并不能直接看到全部 MCP 工具。从 connector 定义到进入模型请求,链路上有三层过滤,
最后一层是"延迟可见"(deferred):模型初始只看到工具名字清单,完整 schema 需要发现并晋升后才暴露。

### 3.1 注入链路(Node 侧)

| 步骤 | 实现模块 | 行为 |
|---|---|---|
| 1. 注册 | `packages/mcp-sources/src/registry.ts`、`builtins.ts` | 每个 connector 是一个 `McpSourceAdapter`,manifest 声明工具的 `inputSchema`、`mcpToolName`、权限模板、缓存策略和 prompt 片段,统一注册进 `McpSourceRegistry` |
| 2. 可用性过滤 | `services/api/src/mcp/source-catalog.ts` | `McpSourceCatalog` 从 Python gateway 拉取真实 server/tool 目录,按 `mcpToolName` 匹配远端工具并用 `inputSchemasCompatible` 做 schema 兼容检查;匹配失败的进 `missingTools`,不会暴露给 Agent |
| 3. 会话启用过滤与包装 | `services/api/src/mcp/workspace-tools.ts` | `createMcpWorkspaceTools` 只保留会话 `enabledConnectorIds` 中启用且 catalog 判定可用的工具,包装为 `mcp__<sourceId>__<toolId>`;description 拼接工具描述、`promptFragment` 与来源 summary/citationPolicy/caveats;execute 统一走 `McpGovernanceBroker.invoke`(权限门、输入校验、缓存、限流、CAS 审计,见 `services/api/src/mcp/broker.ts`) |
| 4. 标记 deferred | `packages/agent-runtime/src/workspace.ts` | `createWorkspaceTools` 把每个 MCP 工具包成 `AgentTool` 时统一打 `deferred: true` 并携带 `routing`(keywords/mode/priority);内置工作区工具不打此标记 |
| 5. 发送工具 spec | `services/api/src/gateway-agent.ts` | 把全部工具 spec(name/description/schema/deferred/routing)POST 给 Python Gateway;工具执行时 Gateway 的 proxy tool 经 HTTP 回调 Node 的 `/internal/tool-exec`,真正执行仍在 Node 侧治理链路中完成 |

### 3.2 模型可见性(Python gateway 侧)

| 机制 | 实现模块 | 行为 |
|---|---|---|
| 延迟目录组装 | `services/gateway/src/science_agent_gateway/server.py`(`_drive_stream`)、`tools.py`(`build_proxy_tools`) | 只要存在 deferred 工具,就通过 deer-flow 的 `assemble_deferred_tools` 启用延迟机制,追加 `tool_search` 工具,并在 system prompt 注入只含工具名的 `<available-deferred-tools>` 清单 |
| schema 隐藏与调用拦截 | `third_party/deer-flow/.../middlewares/deferred_tool_filter_middleware.py` | `DeferredToolFilterMiddleware` 在每次 model 调用前把未晋升的 deferred 工具从 `bind_tools` 中滤掉,模型请求里没有这些工具定义;直接调用未晋升工具会被拦截并返回"先调 `tool_search`"的错误 ToolMessage |
| 晋升状态 | deer-flow `ThreadState.promoted` | 晋升记录绑定 catalog hash;catalog 变化(工具改名、schema 漂移)时旧晋升自动失效 |
| 关键词自动晋升 | deer-flow `McpRoutingMiddleware`(由 `server.py` 的 `build_mcp_routing_middleware` 装配) | 用户消息命中工具 `routing.keywords`(`mode: "prefer"`)时,在 model 调用前自动晋升最多 top 3 个,省去一次 `tool_search` 往返 |

因此模型的视野是:内置工作区工具全量可见;MCP 工具初始只见名字,schema 经 `tool_search`
晋升或路由自动晋升后按需暴露。而哪些 MCP 工具能进入名字清单,又先经过会话启用开关(步骤 3)
和 gateway catalog 可用性(步骤 2)两道过滤。

## 4. 首期数据源

- 文献：PubMed、arXiv、Europe PMC、bioRxiv、medRxiv。
- 科学数据库：UniProt、PDB、Ensembl、Reactome、ClinVar、ChEMBL、GEO。

Source Catalog 只暴露 MCP server 中实际存在且 schema 兼容的工具。缺失或不兼容的工具使来源进入
`degraded`，不会作为可调用工具交给 Agent。

## 5. 下载与 PDF 抽取

检索和文件传输是不同动作：

1. MCP 查询或 prepare 工具返回 `ArtifactCandidate`，不下载文件。
2. Agent 下一步调用 `artifact_download`；主循环等待下载进入终态。
3. 下载成功后，Agent 在新的模型回合调用 `paper_extract_pdf`。
4. 抽取任务完成后，Agent 根据文本路径、manifest 和警告继续推理。

同一模型回合中的多个独立工具并行执行，主循环等待全部结束。下载及其依赖的抽取不能放在同一回合；
首期不提供工具 DAG 或 `dependsOn` 接口。

## 6. 审计与引用

每次 MCP 调用保存请求、原始响应和规范化响应的 CAS 引用，并记录 source、tool、尝试次数、缓存命中、
权限授权、许可证和错误。记录与候选文件必须保持 source/identifier/citation 身份一致，URL 必须使用
HTTPS 且命中来源 manifest 的 host 白名单。

数据库记录、论文摘要和已抽取全文具有不同 `contentScope`；只有 `paper_extract_pdf` 成功后才能声称读取
了全文。Claim/Evidence 评审只消费受治理的 MCP 调用或可追溯执行结果。

## 7. UI 状态

本轮以后端为主，只提供基础 Artifact 下载候选、任务状态、取消/重试视图，并显示 MCP Invocation
审计数量。旧 Connector 搜索/导入入口已移除，避免调用已删除接口或绕过治理链路。Source、Tool、
Invocation、ExtractionJob 和权限管理的完整 UI 尚未实现。

危险动作默认逐次审批；Allow same type 创建 Session 级 Grant，并立即放行当前审批队列中的同类动作，Always allow
按动作追加 Authorization 而不创建通配 Grant。并发卡片彼此独立。
