# 外部数据源限流机制

本文档描述外部数据源出站请求的统一限流底座：资源键抽象、排队与超时语义、错误码、默认参数，以及 LLM API 的挂接边界。

## 1. 背景与目标

论文/文献/数据库类公共 API（arXiv、NCBI eutils、UniProt 等）对客户端有 QPS 或并发限制。突发并发加上模型侧盲目重试会打穿上游配额，产生成串的 `429 Too Many Requests`，并以无结构错误回流给模型与用户。

限流底座在 Node 治理面（`services/api`）为每个上游资源提供可独立启用的最小请求间隔、最大并发、FIFO 等待队列深度、排队超时，以及取消释槽、429 冷却与排队时长审计。目标是把「盲目重试 + 裸 429」替换为「按源配置的有序排队 + 结构化可读错误」。

## 2. 与 MCP 源的关系与调用流程

### 2.1 关系边界

限流在 Node 控制面统一实现，不在各 Python MCP 源内部：

- `McpGovernanceBroker`（`packages/data-source/src/broker.ts`）是所有 MCP 工具调用的唯一治理入口，串起权限、缓存、限流、Gateway 调用与 CAS 审计。
- `ResourceRateLimiter`（`packages/data-source/src/resource-rate-limiter.ts`）是底座，按资源键做并发上限、最小间隔、FIFO 排队、排队超时与 429 冷却。单机、进程内内存态，不做跨机器分布式配额，进程重启即清零。
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
  → createMcpWorkspaceTools.execute            packages/artifact-manager/src/mcp-workspace-tools.ts
  → McpGovernanceBroker.invoke                 packages/data-source/src/broker.ts
      会话可写检查 → 启用过滤 → 输入校验 → 权限 authorize
      → 结果缓存：命中则直接返回规范化结果（不再 acquire、不再出站）
      → ResourceRateLimiter.acquire(rateLimitGroup, …)   packages/data-source/src/resource-rate-limiter.ts
          队列满   → RATE_LIMIT_QUEUE_FULL
          排队超时 → RATE_LIMIT_QUEUE_TIMEOUT
      → McpNodeClient.invoke → MCP server → 上游 provider
          broker 每次只允许一个上游 attempt，后续调用重新经过准入与健康检查
          attempt 出现 rate-limited → ResourceRateLimiter.reportUpstreamRateLimit(rateLimitGroup, retryAfterMs)
      → lease.release()   finally 释放并发槽并 pump 队尾
```

工具名由 `createMcpWorkspaceTools` 包装为 `mcp__<sourceId>__<toolId>`，`execute` 统一走 `McpGovernanceBroker.invoke`；只有会话启用且 catalog 判定可用的工具才会被注入（注入链路详见 [science-connectors.md](science-connectors.md) 第 3 节）。

### 2.3 代码锚点

| 模块 | 路径 | 职责 |
|---|---|---|
| 限流底座 | `packages/data-source/src/resource-rate-limiter.ts` | `acquire` / `release` / `reportUpstreamRateLimit`：进程内并发、间隔、队列、冷却 |
| 治理挂接 | `packages/data-source/src/broker.ts` | `McpGovernanceBroker.invoke`：权限 → 缓存 → acquire → Gateway → 429 反馈 → release |
| 治理参数 | `packages/mcp-sources/src/public-biomed.ts` | `manifest()` 构造 `governance`（`rateLimitGroup`、并发、间隔/QPS、队列等） |
| 工具注入 | `packages/artifact-manager/src/mcp-workspace-tools.ts` | `createMcpWorkspaceTools` 把 MCP 工具包成 `mcp__<source>__<tool>`，`execute` 调 `broker.invoke` |

### 2.4 Broker 逻辑要点

- `acquire` 包住一次 MCP attempt，并在 `finally` 释放；broker 把传给 Node MCP client 的 `maxAttempts` 固定为 1，防止持有同一个 slot 时的内部重试绕过请求间隔。
- 队列满和排队超时分别映射 `RATE_LIMIT_QUEUE_FULL`、`RATE_LIMIT_QUEUE_TIMEOUT`，审计记录实际排队时间。省略队列参数时 broker 使用 `DEFAULT_MCP_RATE_LIMIT_QUEUE` 的 8 深度、20 秒上限，排队时间还不超过工具超时；省略并发或间隔仍保持原语义。
- 缓存命中不出站。权限、启用和输入检查仍在准入前执行。

### 2.5 同进程共享健康与恢复

多个 broker 和科研 agent 默认复用同一个进程内 limiter/SourceHealth；独立 worker 不共享，不新增存储。429 以真实上游限流组和有效鉴权摘要划分；406 再按来源/工具隔离端点。鉴权摘要包含 server URL、headers、env、OAuth 和工具参数中的凭据，不把原值写入日志。

429 尊重 Retry-After；缺失时从 1 秒指数退避至最多 30 秒。冷却发生后，受影响的排队者立即退出，后续调用直接得到 `retryAt`/`retryAfterMs`，不各自 sleep 重试。冷却后仍须经过原有并发和请求间隔控制。

406 使用 provider 自有 JSON envelope 分类。参数/查询错误与无法归因的拒绝只反馈本次请求；只有明确通用边缘拒绝且没有请求错误信号的情况才计入来源健康。同一分钟内连续三个不同请求遭到端点拒绝，才在来源/工具范围内抑制；同一输入反复失败不会累加到阈值。406 冷却从 30 秒指数增长，最多 120 秒。

冷却结束只允许一个探测；其余调用快速返回。探测成功恢复，失败重新抑制，取消释放探测权和 slot。其他来源保持可用；只建议已启用、同类且实际有可用工具的来源，保留引用与证据要求。没有可用替代时诚实说明受阻，不假称已切换或已取得原来源内容。

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

上表描述通用 ResourceRateLimiter。数值校验只针对已提供字段；MCP broker 保留并发和间隔的省略语义，但对缺失队列参数使用 8/20s 有界默认，且排队不超过工具超时。

超时分层：

- **排队超时**（本底座）：等不到执行槽位。
- **执行超时**（Node client `timeoutMs` deadline）：拿到槽位后上游过慢。排队与执行各自有界。

429 的共享冷却与有限探测见第 2.5 节；底座仍通过 `reportUpstreamRateLimit` 保留原有间隔及冷却约束。

## 4. 错误语义（对模型与用户可读）

| 场景 | `McpError.code` | retryable | 说明 |
|---|---|---|---|
| 等待队列已满 | `RATE_LIMIT_QUEUE_FULL` | true | 建议减少并行调用、稍后重试 |
| 排队超时 | `RATE_LIMIT_QUEUE_TIMEOUT` | true | 附实际排队时长（审计 `queueWaitMs`） |
| 上游 429 | `RATE_LIMITED` | false | 携带共享 `retryAt`/`retryAfterMs`，禁止独立重试 |
| 共享冷却或探测进行中 | `SOURCE_COOLDOWN` | false | 短说明与结构化恢复、替代来源指引 |
| 执行超时 | `TIMEOUT` | true | 既有语义不变 |
| 用户取消 | `CANCELLED` | false | 排队/执行中取消都会释放资源 |

Retry-After 传播：随包 Python MCP server 通过 JSON envelope 传递脱敏 origin、状态码、失败范围和毫秒重试时间，兼容数字及 HTTP-date。Node 提取结构化字段；状态转换日志与调用审计保留状态码、排队时间、决策和关联 ID，不保留完整 URL、响应正文或凭据。用户错误只是一句短说明，详细时间与证据要求放在工具详情中。

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

内建源仍显式选择这些参数。自定义或未来来源可以省略并发及间隔，但 broker 总会对排队施加有界保护。

审计：每次 `McpInvocation` 记录 `queueWaitMs`（排队时长）；429/重试明细在 `attempts[]`；均可经 `GET /api/sessions/:sessionId/mcp/invocations` 查询。不记录 query 全文之外的新增敏感信息。

## 6. LLM API 边界（独立于数据源 admission）

LLM 请求不经过本文的数据源队列。当前模型 transport 位于 `packages/model`，使用 Node/undici 实现请求和 pre-stream 重试。

Native executor 直接使用产品 model layer；JiuwenSwarm executor 的模型请求通过 adapter 的 per-run LLM proxy 回到 ScienceDiscovery model gateway，因此仍复用产品 provider、proxy、retry 和 usage 语义。

当前 `packages/model/src/client.ts` 支持：

- 请求 header timeout；
- connect / 429 / 5xx 的 bounded pre-stream retry；
- 解析数字形式的 `Retry-After`；
- 未提供 Retry-After 时做指数 backoff；
- stream 开始之后的错误直接交给调用方，不再透明重试。

相关配置：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | 600 | 请求 header timeout |
| `SCIENCE_AGENT_LLM_MAX_RETRIES` | 2 | pre-stream connect/429/5xx 最大重试次数 |

LLM provider 的 TPM/RPM admission 目前没有接入 `ResourceRateLimiter`。若新增全局模型限流，应放在 model/control-plane 语义中，而不是恢复旧 Python Gateway 限流路径。

## 7. 覆盖面与已知缺口

- 已接入：全部经 `McpGovernanceBroker` 的 MCP 源（arXiv、PubMed、Europe PMC、bioRxiv/medRxiv、PDB、Ensembl、Reactome、ClinVar、ChEMBL、GEO、UniProt）。
- 未接入（后续）：web search/fetch broker、artifact 字节下载、沙箱 skill 脚本内的直接出站请求。

## 8. 测试

- `packages/data-source/src/resource-rate-limiter.test.ts`：并发上限、间隔 pacing、FIFO、队列满、排队超时、取消出队、释放幂等、冷却，以及四个维度省略时的无限语义。
- `packages/data-source/src/broker.test.ts`：governance 缺失状态透传、队列错误映射、`queueWaitMs` 审计、429 反馈冷却。
- `packages/mcp-sources/src/public-biomed.test.ts`：arXiv 治理参数对齐条款、全部内建源显式队列与 pacing 保护。
- `services/gateway/tests/test_public_biomed_mcp.py`：生物医学 MCP 侧的响应与错误处理。
