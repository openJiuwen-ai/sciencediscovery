# 外部数据源限流机制

本文档描述外部数据源出站请求的统一限流底座：资源键抽象、排队与超时语义、错误码、默认参数，以及 LLM API 的挂接边界。

## 1. 背景与目标

论文/文献/数据库类公共 API（arXiv、NCBI eutils、UniProt 等）对客户端有 QPS 或并发限制。突发并发加上模型侧盲目重试会打穿上游配额，产生成串的 `429 Too Many Requests`，并以无结构错误回流给模型与用户。

限流底座在 Node 治理面（`services/api`）为每个上游资源提供可独立启用的最小请求间隔、最大并发、FIFO 等待队列深度、排队超时，以及取消释槽、429 冷却与排队时长审计。目标是把「盲目重试 + 裸 429」替换为「按源配置的有序排队 + 结构化可读错误」。

## 2. 与 MCP 源的关系与调用流程

### 2.1 关系边界

限流在 Node 控制面统一实现，不在各 Python MCP 源内部：

- `McpGovernanceBroker`（`services/api/src/mcp/broker.ts`）是所有 MCP 工具调用的唯一治理入口，串起权限、缓存、限流、Gateway 调用与 CAS 审计。
- `ResourceRateLimiter`（`services/api/src/rate-limit/resource-rate-limiter.ts`）是底座，按资源键做并发上限、最小间隔、FIFO 排队、排队超时与 429 冷却。单机、进程内内存态，不做跨机器分布式配额，进程重启即清零。
- Python MCP server 只负责单次查询、provider 参数/响应校验、瞬时错误重试（`retryPolicy`）和标准结果组装，不做跨请求的排队或并发控制。

各源通过 manifest 的 `governance` 字段向底座提供参数（schema 见 `packages/schema/src/mcp-source.ts`；内建源构造见 `packages/mcp-sources/src/public-biomed.ts` 的 `manifest()`）：

| 字段 | 作用 |
|---|---|
| `rateLimitGroup` | 资源键。内建源默认取 `hosts[0]`（如 arXiv 为 `export.arxiv.org`）；**同 `rateLimitGroup` 的多个源共享同一配额**，例如共享 `eutils.ncbi.nlm.nih.gov` 的 PubMed/ClinVar/GEO 共占 NCBI 的并发与 pacing。 |
| `maxConcurrentRequests` | 最大在途请求数。 |
| `minIntervalMs` | 最小请求间隔；未提供时 broker 在 `rateLimitPerSecond` 存在时推导 `ceil(1000 / rps)`。 |
| `rateLimitPerSecond` | 每秒放行上限，用于推导 `minIntervalMs`。 |
| `maxQueueDepth` / `queueTimeoutMs` | 等待队列深度与排队超时。 |

资源键是任意字符串。MCP 源之外预留命名空间：`llm:<provider-host>`（LLM，见第 6 节）、`web:<provider>`（Web Search/Fetch 尚未接入，见第 7 节）。

### 2.2 端到端调用链

```text
Agent 工具 mcp__<source>__<tool>
  → createMcpWorkspaceTools.execute            services/api/src/mcp/workspace-tools.ts
  → McpGovernanceBroker.invoke                 services/api/src/mcp/broker.ts
      会话可写检查 → 启用过滤 → 输入校验 → 权限 authorize
      → 结果缓存：命中则直接返回规范化结果（不再 acquire、不再出站）
      → ResourceRateLimiter.acquire(rateLimitGroup, …)   services/api/src/rate-limit/resource-rate-limiter.ts
          队列满   → RATE_LIMIT_QUEUE_FULL
          排队超时 → RATE_LIMIT_QUEUE_TIMEOUT
      → McpNodeClient.invoke → MCP server → 上游 provider
          Gateway 内按 retryPolicy 对 429/5xx/transport 做有限重试（尊重 Retry-After）
          attempt 出现 rate-limited → ResourceRateLimiter.reportUpstreamRateLimit(rateLimitGroup, retryAfterMs)
      → lease.release()   finally 释放并发槽并 pump 队尾
```

工具名由 `createMcpWorkspaceTools` 包装为 `mcp__<sourceId>__<toolId>`，`execute` 统一走 `McpGovernanceBroker.invoke`；只有会话启用且 catalog 判定可用的工具才会被注入（注入链路详见 [science-connectors.md](science-connectors.md) 第 3 节）。

### 2.3 代码锚点

| 模块 | 路径 | 职责 |
|---|---|---|
| 限流底座 | `services/api/src/rate-limit/resource-rate-limiter.ts` | `acquire` / `release` / `reportUpstreamRateLimit`：进程内并发、间隔、队列、冷却 |
| 治理挂接 | `services/api/src/mcp/broker.ts` | `McpGovernanceBroker.invoke`：权限 → 缓存 → acquire → Gateway → 429 反馈 → release |
| 治理参数 | `packages/mcp-sources/src/public-biomed.ts` | `manifest()` 构造 `governance`（`rateLimitGroup`、并发、间隔/QPS、队列等） |
| 工具注入 | `services/api/src/mcp/workspace-tools.ts` | `createMcpWorkspaceTools` 把 MCP 工具包成 `mcp__<source>__<tool>`，`execute` 调 `broker.invoke` |

### 2.4 Broker 逻辑要点

- `acquire` 包住整次 Gateway invoke（含 invoke 内的 `retryPolicy` 重试）：lease 在 `gateway.invoke` 之前获取、在 `finally` 中 `release`，因此同一资源在一次调用内的多次 attempt 共占同一个并发槽。
- 队列满映射为 `RATE_LIMIT_QUEUE_FULL`、排队超时映射为 `RATE_LIMIT_QUEUE_TIMEOUT`，两者均 `retryable`，并写入失败 `McpInvocation`（排队超时附带 `queueWaitMs`）。错误码全貌见第 4 节。
- 四个底座维度均为 optional；`undefined` 或省略表示不启用该维度，broker 保留 governance 的缺失状态、不回填隐式默认（语义见第 3 节，内建源显式取值见第 5 节）。现有源之所以带 `8` / `20s` 队列参数，是 manifest 显式引用 `DEFAULT_MCP_RATE_LIMIT_QUEUE`（`maxQueueDepth: 8`、`queueTimeoutMs: 20_000`），而非底座硬编码。
- 结果缓存命中时直接返回规范化结果，**不 acquire、不调用 Gateway**，因此缓存重放不占用出站配额。

### 2.5 Gateway 重试与 Node 限流的分工

两层不重复，互补：

- **Gateway 层（Python，`retryPolicy`）**：在一次 invoke 内部对瞬时错误（`transport-error` / `rate-limited` / `server-error`）做有限重试，尊重 `Retry-After`，逐次 attempt 记入 `response.attempts[]`。它处理「这一次调用撞墙了，退一下再试」。
- **Node 限流层（`ResourceRateLimiter`）**：跨多次 invoke 的并发上限、最小间隔、FIFO 排队与排队超时，以及撞墙后的冷却。它处理「这次 invoke 整体排队、控并发、控节奏，撞墙后让后续调用也等」。

衔接点：Gateway 重试的 `attempts` 中出现 `rate-limited` 时，broker 调用 `reportUpstreamRateLimit(rateLimitGroup, retryAfterMs)`，把上游指示的冷却写回底座，使队列中等待的后续调用推迟到冷却结束再放行，而不是放行后立刻再撞同一个 429。

### 2.6 不经此链的出站

以下出站不经 `McpGovernanceBroker.invoke`，不受本底座约束（与第 7 节「覆盖面与已知缺口」一致）：

- Artifact 真正下载由 `artifact-manager` 负责（`workspace-tools.ts` 的 `artifactDownload` → `ArtifactManager`），只消费 MCP 调用产出的 `ArtifactCandidate`，本身不再过 `broker.invoke`。
- web search/fetch、沙箱 skill 脚本内的直接出站请求（后续按 `web:<provider>` 接入）。
- 结果缓存命中跳过出站（见 2.4）。

## 3. 语义

每个资源键的一次 `acquire` 按以下规则放行：

四个底座维度均为 optional；`undefined` 或省略表示不启用该维度，而不是采用隐式默认：

| 参数 | `undefined` / 省略 | 显式配置 |
|---|---|---|
| `minIntervalMs` | 无 pacing；broker 仅在 manifest 显式配置 `rateLimitPerSecond` 时推导 `ceil(1000/rps)` | ≥ 0；0 也表示无间隔；与 rps 同时配置时本字段优先 |
| `maxConcurrent`（manifest 为 `maxConcurrentRequests`） | 不限制同时在途请求数 | 正整数 ≥ 1 |
| `maxQueueDepth` | 无限队列；调用方接受对应的内存增长风险 | 整数 ≥ 0；0 表示不允许排队 |
| `queueTimeoutMs` | 排队不超时，只能由放行或 Abort/取消结束等待 | > 0；到期返回结构化排队超时错误 |
| `signal` | 不提供主动取消 | 提供 AbortSignal；排队中取消即出队，执行中取消由调用方释放槽位 |

数值校验只针对已提供的字段。Broker 保留 governance 的缺失状态，不会把缺失字段回填为并发 1、队列 8 或排队 20 秒。

超时分层：

- **排队超时**（本底座）：等不到执行槽位。
- **执行超时**（Gateway `timeoutMs` deadline）：拿到槽位后上游过慢。两者叠加的最坏等待仍显著小于 gateway idle 超时（240s），外层不会先断。

429 冷却：Gateway 重试明细中出现 `rate-limited` attempt 时，broker 调用 `reportUpstreamRateLimit(key, retryAfterMs)`，该资源键的后续放行推迟到冷却结束。无 `Retry-After` 时至少冷却 1 秒；若最近一次 acquire 或等待队列存在更长 pacing，则取更长值。即使该键没有 pacing 配置，冷却仍安全生效。

## 4. 错误语义（对模型与用户可读）

| 场景 | `McpError.code` | retryable | 说明 |
|---|---|---|---|
| 等待队列已满 | `RATE_LIMIT_QUEUE_FULL` | true | 建议减少并行调用、稍后重试 |
| 排队超时 | `RATE_LIMIT_QUEUE_TIMEOUT` | true | 附实际排队时长（审计 `queueWaitMs`） |
| 上游 429（重试耗尽） | `RATE_LIMITED` | true | 尽量携带真实 `retryAfterMs` |
| 执行超时 | `TIMEOUT` | true | 既有语义不变 |
| 用户取消 | `CANCELLED` | false | 排队/执行中取消都会释放资源 |

Retry-After 传播：Python MCP server 的 HTTP 封装不再使用裸 `raise_for_status()`（它会丢弃响应头），而是抛出形如 `HTTP 429 Too Many Requests from export.arxiv.org (retry-after: 5)` 的可解析错误；Gateway 错误分类器锚定 `retry-after` token 取值，重试与冷却都能拿到上游指示。

## 5. 配置面与内建源显式参数

per-source 配置在 source manifest 的 `governance` 字段（`packages/schema/src/mcp-source.ts`）：

| 参数 | 内建源显式值 | arXiv 显式值 | 依据 |
|---|---|---|---|
| `minIntervalMs` | 由 `rateLimitPerSecond` 推导 | 3000 | arXiv API 使用条款：约每 3 秒 1 请求 |
| `rateLimitPerSecond` | NCBI 3 / 其他 5 | 5（存在但被 minIntervalMs 覆盖） | NCBI 无 key 上限 3/s |
| `maxConcurrentRequests` | 2 | 1 | arXiv 条款：单连接 |
| `maxQueueDepth` | 8（manifest 显式引用 `DEFAULT_MCP_RATE_LIMIT_QUEUE`） | 8 | 一轮并行工具调用典型 ≤ 6 |
| `queueTimeoutMs` | 20000（manifest 显式引用同一推荐值） | 20000 | 突发 6 个 arXiv 请求可在窗口内消化 |
| `retryPolicy.initialDelayMs` | 500 | 3000 | 重试间隔不低于源 pacing |

这些值不是 broker 的隐式默认。当前 public-biomed 与 UniProt manifest 显式选择它们，因此现有源行为保持不变；自定义或未来 source 可省略任一治理字段，以关闭对应限制维度。

审计：每次 `McpInvocation` 记录 `queueWaitMs`（排队时长）；429/重试明细在 `attempts[]`；均可经 `GET /api/sessions/:sessionId/mcp/invocations` 查询。不记录 query 全文之外的新增敏感信息。

## 6. LLM API 边界（当前结论：预留，不排队）

LLM 出站与数据源出站不在同一进程：

- 主 Agent 循环的模型请求由 Python Gateway 发出（`services/gateway/src/science_agent_gateway/server.py` 的 `_build_model` 是唯一构造点），HTTP 由 openai/anthropic SDK 负责，SDK 自带 429 指数退避与 `Retry-After` 尊重。
- Node 侧另有少量辅助模型调用（会话命名、语义评审、论文视觉），与底座同进程，后续可按 `llm:<host>` 键直接接入。

当前不把 LLM 请求纳入排队：provider 配额语义是 TPM/RPM（token 维度），请求级排队收益有限且直接推高首 token 延迟。本期提供最小配置面（经 Gateway 环境变量，默认与 SDK 一致）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | 600（SDK 默认） | 单次模型请求超时 |
| `SCIENCE_AGENT_LLM_MAX_RETRIES` | 2（SDK 默认） | SDK 内置 429/5xx 重试次数 |

后续如需真正的 LLM 限流：Gateway 内按 `base_url` host 建 asyncio 信号量 + 最小间隔即可覆盖主循环（无需跨进程共享）；跨会话全局并发上限属于 Node run 调度层的独立议题。

## 7. 覆盖面与已知缺口

- 已接入：全部经 `McpGovernanceBroker` 的 MCP 源（arXiv、PubMed、Europe PMC、bioRxiv/medRxiv、PDB、Ensembl、Reactome、ClinVar、ChEMBL、GEO、UniProt）。
- 未接入（后续）：web search/fetch broker、artifact 字节下载、沙箱 skill 脚本内的直接出站请求。

## 8. 测试

- `services/api/src/rate-limit/resource-rate-limiter.test.ts`：并发上限、间隔 pacing、FIFO、队列满、排队超时、取消出队、释放幂等、冷却，以及四个维度省略时的无限语义。
- `services/api/src/mcp/broker.test.ts`：governance 缺失状态透传、队列错误映射、`queueWaitMs` 审计、429 反馈冷却。
- `packages/mcp-sources/src/public-biomed.test.ts`：arXiv 治理参数对齐条款、全部内建源显式队列与 pacing 保护。
- `services/gateway/tests/test_mcp_api.py`、`test_public_biomed_mcp.py`：Retry-After 传播与解析。
