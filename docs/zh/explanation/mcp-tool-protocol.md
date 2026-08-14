# MCP 后端设计

## 1. 设计目标

ScienceDiscovery 使用一套 MCP 数据访问链路。科研查询、下载候选、权限、缓存、限流、重试、CAS 和审计不得绕过 Node 控制面。

```text
Agent
  → mcp__<source>__<tool>
  → Node McpGovernanceBroker
  → DeerFlow MCP Gateway
  → Python MCP Server
  → McpResult
```

旧 `invoke_connector`、`ConnectorBroker`、`science-sources` 以及 direct transport 不再属于运行时架构。

## 2. 职责边界

Python MCP 负责：

- 供应商参数和科学标识符校验；
- 构造上游请求并解析供应商响应；
- 生成 `McpRecord`、`McpCitation` 和 `ArtifactCandidate`；
- 将供应商错误转换成可分类异常。

Node 负责：

- Session Source 启用状态和工具权限；
- MCP 输入 Schema 和返回信封校验；
- Source、Tool、Record、Citation、ArtifactCandidate 身份一致性；
- 网络域名、响应大小、下载路径和 checksum；
- TTL 缓存、请求频率、最大并发和重试；
- CAS、Invocation 和 Artifact 审计。

Node 不重复实现供应商领域解析，但将 Python MCP 视为外部信任边界。

## 3. 核心结果

```ts
interface McpToolResult {
  records: McpRecord[];
  artifacts?: ArtifactCandidate[];
  warnings: string[];
  data?: JsonValue;
  attribution: string;
  license: string;
  retrievedAt: string;
  sourceId: string;
  sourceVersion?: string;
  toolId: string;
  untrusted: true;
}
```

MCP 只产生 Record、Citation、ArtifactCandidate、Warning 和结构化数据。Claim、EvidenceItem 和 EvidenceBrief 属于 Agent 阅读和论证阶段，不由查询 MCP 直接生成。

## 4. Source Manifest

首期保留：

- Source ID、显示信息、版本和类型；
- MCP Server ID；
- Tool 名称、输入 Schema、描述和路由；
- 许可证、署名、数据分类和允许域名；
- 最大响应大小、请求频率和最大并发；
- TTL 缓存和重试策略。

不提供：

- direct transport；
- credential cache scope；
- stale-if-error；
- 通用版本策略；
- remote Artifact destination；
- adapter cache/version hooks；
- artifact-export；
- MCP 请求 DAG 或 `dependsOn`；
- 没有实际去重实现的公开 idempotency key；
- 任意 server metadata 容器。

## 5. Agent 工具

### 5.1 MCP 查询工具

```text
mcp__<sourceId>__<toolId>
```

工具返回标准 MCP 结果，并由 Node 增加 `invocationId`。返回 ArtifactCandidate 不会自动下载。

### 5.2 Artifact 下载

```ts
artifact_download({
  mcpInvocationId: string,
  candidateId: string,
  destinationPath?: string
})
```

执行顺序：

1. 从成功的 MCP Invocation CAS 结果读取候选；
2. 校验候选身份、域名、许可证和目标路径；
3. 创建 ArtifactPlan；
4. 等待用户权限；
5. 创建并运行 DownloadJob；
6. 支持断点、重试、大小限制和 checksum；
7. 下载进入终态后才向 Agent 返回结果。

下载结果至少包括：

```ts
interface ArtifactDownloadResult {
  candidateId: string;
  planId: string;
  jobId?: string;
  finalPath?: string;
  actualChecksum?: string;
  bytesDownloaded: number;
  sourceId: string;
  sourceRecordId: string;
  status: "completed" | "failed" | "cancelled" | "denied";
  error?: McpError;
}
```

### 5.3 PDF 抽取

```ts
paper_extract_pdf({
  artifactJobId: string
})
```

只接受已经完成的 PDF paper 下载。工具先创建独立的 ExtractionJob，再调用 Paper Worker，返回
ExtractionJob ID、PaperAcquisition ID、文本路径、Manifest 路径、页数和警告。

下载完成不会自动抽取，抽取失败也不会改变原 PDF 下载的 completed 状态。

## 6. Agent Loop

同一个模型回合中的工具调用必须彼此独立，可以并行执行。Agent 主流程等待本轮全部工具结束，再把所有 Tool Result 交给模型。

```text
模型回合 1
  → artifact_download(A)
  → artifact_download(B)
  → 等待 A、B

模型回合 2
  → paper_extract_pdf(A.jobId)
  → paper_extract_pdf(B.jobId)
  → 等待两个抽取

模型回合 3
  → 根据抽取结果继续推理
```

下载和依赖它的抽取不得出现在同一个模型回合。首期不引入工具 DAG。

工具失败作为结构化 Tool Result 返回 Agent：

```json
{
  "ok": false,
  "error": {
    "code": "UPSTREAM_UNAVAILABLE",
    "message": "bounded message",
    "retryable": true,
    "attempts": 3,
    "retryAfterMs": 1000
  }
}
```

单个工具失败不得取消同轮其他独立工具。

## 7. 权限与审计

Session 只有两种审批策略：

```ts
type ApprovalMode = "always_allow" | "ask_for_dangerous";
```

`ask_for_dangerous` 是默认值。危险动作创建相互独立的 `PermissionRequest`，用户可以选择：

- `allow_once`：仅允许当前动作，不创建 Grant；
- `allow_matching`：创建匹配 action 与标准化 resource class 的 Session 级
  `PermissionGrant`，原子地放行当前 Session 中已经等待审批的全部同类动作；之后到达的同类动作也直接命中该 Grant；
- `deny`：只拒绝当前动作。

`always_allow` 直接允许危险动作，但不创建通配或一次性 Grant。允许、拒绝以及命中已有 Grant 的动作
都追加一条 `PermissionAuthorization`。Authorization 是单次、不可复用的审计事实；Grant 才是
可复用、可撤销的能力。

```text
危险动作
  ├─ always_allow    → Authorization(source=always_allow) → 执行
  ├─ 命中 Grant      → Authorization(source=existing_grant) → 执行
  └─ PermissionRequest
       ├─ allow_once     → Authorization(source=user_once) → 执行
       ├─ allow_matching → Grant + 每个匹配 pending 动作各自的 Authorization → 并行恢复执行
       └─ deny           → Authorization(source=user_deny) → 终止本动作
```

Authorization 使用独立 SQLite 表追加写入，ArtifactPlan、ArtifactJob 和 McpInvocation 使用
`permissionAuthorizationId` 关联本次动作的授权依据。旧 `permissionGrantId` 仅作历史数据读取兼容。

人工审批会暂停对应主 Agent 或子 Agent 的 Gateway deadline。一个请求的决定不会改变其他请求；
SSE 断开或 execution 结束时，其残留 pending 请求进入 `cancelled`。运行中切换到 `always_allow`
会旋转 Permission Epoch，并分别允许和唤醒当前 Session 的所有 pending 请求。

Plan 与权限完全解耦：`propose_plan` 只生成 `recorded` 计划，不存在计划批准门禁或计划
Approve/Reject API。

## 8. 生命周期

```text
ArtifactPlan:
awaiting_approval → approved | expired

DownloadJob:
queued → running | retrying → verifying → completed | failed | cancelled

ExtractionJob:
queued → running → completed | failed | cancelled

PaperAcquisition:
仅在 paper_extract_pdf 成功后创建
```

Job 表示执行状态，已完成下载的文件保持不可变。PDF 抽取是新的工具调用和派生结果，不是 DownloadJob 的 post-processing 字段。

## 9. 数据源

首期统一注册 12 个 Source：

- 文献：PubMed、arXiv、Europe PMC、bioRxiv、medRxiv；
- 数据库：UniProt、PDB、Ensembl、Reactome、ClinVar、ChEMBL、GEO。

所有来源均通过 MCP Catalog 发现和兼容性检查。缺失或 Schema 不兼容的工具将使 Source 进入 degraded 状态，并且不会暴露给 Agent。

## 10. 控制面接口

Source Catalog：

```text
GET  /api/mcp/sources
POST /api/mcp/sources/reload
GET  /api/mcp/sources/:sourceId
GET  /api/mcp/sources/:sourceId/status
GET  /api/mcp/sources/:sourceId/tools
```

调用审计：

```text
GET /api/sessions/:sessionId/mcp/invocations
GET /api/sessions/:sessionId/mcp/invocations/:invocationId
```

下载候选、计划和任务：

```text
GET  /api/sessions/:sessionId/mcp/artifact-candidates
GET  /api/sessions/:sessionId/mcp/artifact-plans
POST /api/sessions/:sessionId/mcp/artifact-plans
GET  /api/sessions/:sessionId/mcp/artifact-plans/:planId
POST /api/sessions/:sessionId/mcp/artifact-plans/:planId/approve
GET  /api/sessions/:sessionId/mcp/artifact-jobs
GET  /api/sessions/:sessionId/mcp/artifact-jobs/:jobId
POST /api/sessions/:sessionId/mcp/artifact-jobs/:jobId/cancel
POST /api/sessions/:sessionId/mcp/artifact-jobs/:jobId/retry
```

PDF 抽取任务：

```text
GET /api/sessions/:sessionId/mcp/artifact-extraction-jobs
GET /api/sessions/:sessionId/mcp/artifact-extraction-jobs/:jobId
```

权限：

```text
GET    /api/permission-requests?sessionId=:sessionId
POST   /api/permission-requests/:requestId/decision
GET    /api/permission-grants
DELETE /api/permission-grants/:grantId
GET    /api/sessions/:sessionId/permission-authorizations
PATCH  /api/sessions/:sessionId
```

Permission decision 使用 `allow_once | allow_matching | deny`。Session PATCH 的
`approvalMode` 使用 `ask_for_dangerous | always_allow`。加载 catalog 时，短期使用过的
`approvalMode: never_ask` 会迁移为 `always_allow`。

Agent 使用 `artifact_download` 和 `paper_extract_pdf` 工具创建并等待任务。HTTP 接口主要供审计、
人工授权和 UI 查询使用，不提供绕过 Agent 工具语义的“一步下载并抽取”接口。

## 11. 测试要求

每个 Source 必须具有工具注册/Schema 契约和至少一个正常或空结果 Fixture；Fixture 校验 Source、
Record、Citation 身份及 URL。能产生 ArtifactCandidate 的 Source 还必须覆盖候选身份与域名。

以下行为由所有 Source 共用的 Gateway/Broker 参数化测试覆盖，不为每个 provider 重复复制：

- 非法输入、缺失或变化字段；
- limit/空结果边界，以及 provider 支持时的分页；
- 429、Retry-After、5xx 和超时；
- 响应大小、重试次数和结构化错误。

Node 集成测试必须验证：

- 缓存、权限、最大并发和重试；
- Python 返回伪造身份或非法 URL 时被拒绝；
- Artifact 路径穿越、重定向和 checksum 防护；
- MCP 查询不自动下载；
- 下载不自动抽取；
- 多下载并行后进入下一模型回合；
- PDF 抽取只接受 completed PDF；
- 失败作为 Tool Result 回传且不终止其他工具。
- `always_allow` 高频调用不会增加 PermissionGrant 数量，并逐次留下 Authorization；
- 并发 Permission 决策相互独立，并精确绑定各自的 Permission Epoch；
- `allow_once` 不产生 Grant；`allow_matching` 仅产生 Session 级 Grant，并批量解决当前审批队列中的同类请求；
- 人工等待暂停主 Agent 和子 Agent deadline；
- execution 结束或断连后不存在 pending 孤儿请求；
- 运行中切换 `always_allow` 会分别恢复所有 pending 动作。

真实供应商 Smoke Test 单独运行，不进入默认离线单元测试。

## 12. 当前实现范围

本次实现包括：

- 统一 MCP Source Registry 与 Catalog，移除旧 ConnectorBroker、`science-sources` 和 Node 直连 provider；
- 12 个公开文献/数据库 Source，以及实际 MCP Server 工具发现和 Schema 兼容性检查；
- Node 权限、限流、缓存、重试、CAS、审计与返回信封复核；
- 显式 Artifact 下载、独立 PDF 抽取、持久化任务状态和结构化失败回传；
- 同模型回合的独立工具并行、全部完成后再继续 Agent Loop；
- Semantic Reviewer 只消费受治理的 MCP Evidence；
- 默认危险操作逐次审批、同类操作 Session Grant、Never Ask 全自动策略；
- 独立 PermissionAuthorization 审计、Permission Epoch 绑定和断连清理；
- Plan 记录与危险动作审批解耦。

以下内容不在本次范围内：

- 私有镜像、机构凭证和商业数据库；
- 批量导出、专利库和参考文献管理器同步；
- 完整 MCP Source 与 Invocation 管理 UI。

因此数据库与文献库能力的本次交付是公开数据源和治理链路的首期实现，不代表已经覆盖所有后续数据源需求。

## 13. UI

本次仅提供基础 Artifact 下载候选、任务状态、取消/重试视图，并在信任面板显示 MCP Invocation 数量。
检索和下载由 Agent 工具驱动；旧 Connector 搜索/导入入口已移除，避免绕过治理链路。Source、Tool、
Invocation 和 ExtractionJob 的完整 UI 尚未实现。当前权限卡片提供
Allow once、Allow same type 和 Deny，Session 提供 Always allow 开关。
