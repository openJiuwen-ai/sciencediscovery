# MCP 后端设计

[English](../../en/explanation/mcp-tool-protocol.md) | [配置指南](../how-to/configure-custom-mcp.md) | [REST API](../reference/rest-api.md)

## 1. 设计目标

ScienceDiscovery 使用一套 MCP 数据访问链路。科研查询、下载候选、权限、缓存、限流、重试、CAS 和审计不得绕过 Node 控制面。

```text
Agent
  → mcp__<source>__<tool>
  → Node McpGovernanceBroker
  → Node 进程内 MCP 客户端(mcp/node-client.ts)
  → MCP Server(stdio / SSE / streamable-HTTP)
  → McpResult
```

旧 `invoke_connector`、`ConnectorBroker`、`science-sources` 以及 direct transport 不再属于运行时架构。

## 2. 职责边界

内置科研数据源的 Python MCP 负责：

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

Node 不重复实现供应商领域解析，并将所有 MCP Server 视为外部信任边界。自定义服务器不限于 Python，也不要求实现科研结果信封；Node 的 `customMcpAdapter` 负责把通用 MCP 工具结果适配到现有治理链路，详见第 5 节。

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

上述接口是 Node 内部标准化结果，不是要求任意自定义服务器直接返回的协议格式。通用自定义适配器将 MCP 的 `content` 和可选 `structuredContent` 放入 `data`，返回空 `records` 和 `warnings`，并标记 `untrusted: true`；不会自动把文本或链接解释为科研证据或下载候选。

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

## 5. 自定义 MCP

### 5.1 组件与调用边界

自定义接入复用现有 Registry、Catalog、Broker 和 Node MCP 客户端，不新增绕过治理的 Agent 工具执行器。

| 组件 | 职责 |
|---|---|
| `McpServerSettings.tsx` / `McpAuthorization.tsx` | 配置编辑、导入、启停、连接状态及授权交互 |
| `McpInspector.tsx` | 在指定 Session 下手动调用工具，展示原始和标准化结果 |
| `http/custom-mcp.ts` | 管理、测试、Inspector 和 OAuth HTTP 入口 |
| `mcp/custom-servers.ts` | 配置校验、加密持久化、变更串行化及动态 Source 注册 |
| `mcp/custom-adapter.ts` | 工具身份、输入 Schema、通用结果适配及治理策略 |
| `mcp/oauth.ts` | OAuth 发现、授权、凭据保存、刷新与失效处理 |
| `mcp/node-client.ts` | STDIO / HTTP / SSE 连接、工具发现与协议调用 |

前端文件位于 `apps/web/src/`，HTTP 和 MCP 后端文件位于 `services/api/src/`；共享配置与返回类型位于 `packages/schema/src/custom-mcp.ts`。

```text
保存配置 -> CustomMcpServers -> 加密文件 + Registry -> Catalog 工具发现

测试连接 -> 独立 McpNodeClient -> 连接 / tools/list / Schema 检查

Agent -> Session 有效连接器选择 -> mcp__<sourceId>__<toolId> --+
                                                          +-> McpGovernanceBroker
Inspector -> 指定 Session + 显式选择单台服务器 ------------+    -> McpNodeClient
                                                               -> MCP Server
                                                               -> CAS / Invocation / 标准化结果
```

连接测试不调用业务工具，不能证明所有工具参数、权限和运行结果都正常；但 STDIO 测试会实际启动配置的程序。Inspector 是真实工具调用，不使用 LLM 生成参数，也不是模拟预览。

### 5.2 配置与生命周期

- 每台服务器有稳定的 `custom-<12 位十六进制>` ID，同时用作 Source ID；显示名称不作为身份。名称不区分大小写去重，最多保存 50 台。
- `stdio` 使用 `command`、`args`、可选 `cwd` 和 `env`；`http` / `sse` 使用 MCP `url`、`headers` 和认证配置。普通网页 URL 或模型 API URL 不能代替 MCP 端点。
- 工具超时默认 60 秒，必须是 1-600 秒整数，不能关闭。当前不提供独立的初始化、工具调用和重连超时配置项。
- 新建表单默认停用；JSON 导入接受 `mcpServers` 对象，先校验整个批次，再一次保存，导入项强制停用。导入不执行工具，也不自动授予 Agent 使用权。
- 保存配置会使旧检查结果失效，并刷新 Catalog；工具发现或输入 Schema 不兼容时，不把对应工具暴露给 Agent。测试使用独立客户端，可探测停用服务器，结束后关闭探测连接，不改变启用状态。
- 服务端加载持久化配置后注册动态 Source ID，使 Store 能识别已有连接器选择；工具列表和检查状态由运行时发现恢复，不作为永久配置保存。
- 删除会移除配置、注册项、检查状态、本地 OAuth 凭据及配置中的连接器引用，再刷新 Catalog；不会卸载 STDIO 程序或删除远端数据。

连接状态 `untested / ready / error / disabled` 与 OAuth 状态分别维护。`ready` 表示连接发现检查通过，不表示每个业务工具都经过调用验证。

### 5.3 秘密值与持久化

配置写入数据目录的 `custom-mcp-servers.enc`，OAuth 凭据写入 `mcp-oauth.enc`，复用 `model-secrets.key` 加密。写入采用队列、临时文件和重命名，文件创建权限为 `0600`。这是静态存储保护，不是对后端宿主机管理员的秘密隔离。

列表接口保留 env/header 的键名，但把值返回为 `null`；已保存的 OAuth Client Secret 同样不回填明文，访问令牌和刷新令牌不返回前端。env/header 的更新契约如下：

| 提交内容 | 保存语义 |
|---|---|
| 已存在的同名 key，值为 `null` | 保留该 key 的旧值 |
| 字符串，包括 `""` | 用该字符串替换旧值；空串是明确清空 |
| 更新后的映射不包含旧 key | 删除该 key |
| 新 key 的值为 `null` | 拒绝；不存在可保留的同名旧值 |

前端用仅存在于编辑草稿中的 `originalKey` 识别已保存的行。只改 key 时保持 `value: null`，不转成空串；若 key 已变且没有重填非空值，则显示行内错误并阻止保存。仅改键名、未编辑值时，恢复原名可继续保留旧值。后端没有“按新名字迁移旧秘密”的隐式逻辑，交换两个已保存键名也不能绕过重填要求。

以 `$` 开头的 env/header 值在后端解析为环境变量引用，不在浏览器解析。STDIO 程序运行在 API 后端所在主机或容器，不自动进入 Session 沙箱；应仅配置可信程序，并由部署方控制其系统权限与依赖。

### 5.4 工具适配、选择与审计

工具发现后，适配器把原始工具名转换成规范化名称加哈希的本地工具 ID，保留原名用于协议调用；生成的 Agent 工具名控制在提供方的 64 字符限制内。输入 Schema 使用 Ajv 校验，显式 draft-07 使用兼容校验器，其余使用 Ajv2020。

通用工具可能产生副作用，因此设置 `idempotent: false`、关闭缓存、工具执行仅尝试一次（不自动重试），不启用关键词自动路由。当前 Source 治理默认最大并发 1、队列深度 8、排队超时 20 秒、响应大小上限 5,000,000 字节；这些是客户端治理参数，不是对外部程序行为的沙箱保证。OAuth 刷新后对认证失败请求的再次发送属于认证处理，不等于开启工具失败自动重试策略。

限额按自定义服务器 ID 分组，在同一后端 Broker 实例内由不同 Session 共享，并非每个 Session 各有一套额度。超限处理如下：

| 条件 | 处理方式 |
|---|---|
| 已有 1 个调用执行中 | 后续调用进入等待队列，获得空闲名额后再执行；最多允许 8 个等待项，不含正在执行的调用 |
| 已有 8 个等待项，新调用也需要排队 | 立即拒绝新调用，返回 `RATE_LIMIT_QUEUE_FULL`，不会发送到 MCP 服务器 |
| 入队后 20 秒仍未取得执行名额 | 移出队列并返回 `RATE_LIMIT_QUEUE_TIMEOUT`，不会发送到 MCP 服务器 |
| 响应大小超过 5,000,000 字节 | 本次调用失败，返回 `RESPONSE_TOO_LARGE`；不截断后作为成功结果返回 |

上述失败均写入 Invocation 审计。队列满和排队超时标记 `retryable: true`，表示可以稍后发起新的调用，并不代表本次调用会自动重新排队；响应超限标记 `retryable: false`。排队超时与开始工具调用后的执行超时是不同限制。

响应大小是在 SDK 已返回结果后，对 `content` 与 `structuredContent` 组成的 JSON 计算 UTF-8 字节数进行检查，不是接收过程中对网络流量或内存的硬限制。此时远端工具可能已经执行完成，响应被拒绝不意味着远端副作用被撤销。

Agent 可用性同时取决于服务器全局启用、工具发现结果和 Session 的有效连接器配置；Session 可能继承 Project / 全局设置。配置允许使用不代表 Agent 每轮必定调用。调用经 Broker 执行输入检查、权限策略和审计。

Inspector 要求存在 Session、服务器已启用且工具已发现。显式手动执行以 `allowedSourceIds: [id]` 仅选择本次服务器，不修改该 Session 的 Agent 连接器选择；仍通过同一 Broker。结果包含成功/失败、耗时、`invocationId`、可用的原始响应和标准化结果，并归属于该 Project / Session 的审计链路。取消等待会传递中断信号，但不保证回滚远端已发生的副作用。

### 5.5 OAuth 生命周期

OAuth 仅用于 HTTP/SSE，复用 MCP SDK 的授权能力。支持预注册 Client ID / Secret，以及服务方支持时的动态注册或客户端元数据 URL；产品不托管元数据文档。Client Secret 非空时要求 Client ID；OAuth 模式拒绝手动 `Authorization` 请求头，其他业务请求头可以保留。

```text
浏览器 -> 已鉴权的 oauth/start -> 后端发现授权服务、生成 state 与 PKCE
       <- authorizationUrl + expiresAt
浏览器 -> 服务商登录 / 同意 -> /api/mcp/oauth/callback
后端   -> 校验并消费 state -> 用授权码与 verifier 换取令牌 -> 加密保存
后续 MCP 请求 -> 检查授权 / 必要时刷新 -> 携带访问令牌调用
```

- 状态为 `required / authorizing / authorized / expired`；等待授权保存在内存，10 分钟过期，重启后需重新发起未完成登录。
- start 要求本地 API 鉴权，回调地址必须匹配浏览器应用 origin 和固定回调路径。callback 不要求浏览器携带本地 API Bearer Token，而以一次性 state、有效期和 PKCE 校验授权事务；state 在交换令牌前消费。
- OAuth URL 要求 HTTPS，仅回环地址允许 HTTP。携带访问令牌的 MCP 请求限定在已配置 origin，且不自动跟随重定向；回调页面不回显授权码、令牌或提供方错误原文。
- 请求前检查令牌有效期，过期临近时刷新；401 可触发刷新后的一次重新发送，403 `insufficient_scope` 要求重新同意授权。相同服务器的并发刷新共用一个任务，避免重复刷新。
- 修改 URL、传输方式、认证模式或 OAuth 配置会清除旧授权。配置签名、授权代次与当前待处理事务检查防止过期异步结果重新保存旧凭据。
- cancel 取消待完成登录，不等同于清除已有凭据；clear 删除本地凭据并使待完成事务失效，不调用服务商的授权撤销接口。

连接测试、Inspector 和 Agent 共用 OAuth 管理器与客户端认证逻辑。是否能连接具体服务商仍取决于注册策略、回调白名单、Scope 和账号权限，不承诺所有 OAuth 服务商零配置兼容。

## 6. Agent 工具

### 6.1 MCP 查询工具

```text
mcp__<sourceId>__<toolId>
```

工具返回标准 MCP 结果，并由 Node 增加 `invocationId`。返回 ArtifactCandidate 不会自动下载。

### 6.2 Artifact 下载

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

### 6.3 PDF 抽取

```ts
paper_extract_pdf({
  artifactJobId: string
})
```

只接受已经完成的 PDF paper 下载。工具先创建独立的 ExtractionJob，再调用 Paper Worker，返回
ExtractionJob ID、PaperAcquisition ID、文本路径、Manifest 路径、页数和警告。

下载完成不会自动抽取，抽取失败也不会改变原 PDF 下载的 completed 状态。

## 7. Agent Loop

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

## 8. 权限与审计

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

人工审批会暂停对应主 Agent 或子 Agent 的运行 deadline(`beginExternalWait`)。一个请求的决定不会改变其他请求；
SSE 断开或 execution 结束时，其残留 pending 请求进入 `cancelled`。运行中切换到 `always_allow`
会旋转 Permission Epoch，并分别允许和唤醒当前 Session 的所有 pending 请求。

Plan 与权限完全解耦：`update_plan` 只在当前 run 内完整替换 Agent 的轻量任务进度快照，
不存在计划批准门禁或 Plan Approve/Reject API；计划状态也不会替代 Governance 对危险工具的授权。

## 9. 生命周期

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

## 10. 数据源

首期统一注册 12 个 Source：

- 文献：PubMed、arXiv、Europe PMC、bioRxiv、medRxiv；
- 数据库：UniProt、PDB、Ensembl、Reactome、ClinVar、ChEMBL、GEO。

所有来源均通过 MCP Catalog 发现和兼容性检查。缺失或 Schema 不兼容的工具将使 Source 进入 degraded 状态，并且不会暴露给 Agent。

## 11. 控制面接口

自定义服务器管理：

`/api/mcp/servers` 提供列表/创建，`/:id` 提供更新/删除，`/import` 提供批量导入；`/:id/test`、`/:id/inspect` 分别用于连接探测和工具执行；`/:id/oauth/start|cancel|clear` 与 `/api/mcp/oauth/callback` 维护授权生命周期。方法、请求体和响应结构以 [REST API](../reference/rest-api.md) 为准，接入设计见第 5 节。

除 OAuth callback 外，自定义服务器管理接口要求本地 API 访问令牌。测试接口可以 HTTP 200 返回包含错误的检查结果，Inspector 也可以 HTTP 200 返回 `ok: false`；前端不能仅凭 HTTP 状态判定工具成功。

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

Agent 与 Inspector 的历史调用均可通过上述 Session Invocation 接口查询。

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

## 12. 测试要求

每个内置科研 Source 必须具有工具注册/Schema 契约和至少一个正常或空结果 Fixture；Fixture 校验 Source、
Record、Citation 身份及 URL。能产生 ArtifactCandidate 的 Source 还必须覆盖候选身份与域名。

以下行为由所有 Source 共用的 Broker/客户端参数化测试覆盖，不为每个 provider 重复复制：

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

自定义接入还需验证：

- 配置导入原子性、脱敏及重启恢复、动态注册与选择；
- 传输发现、Schema 错误、真实 Inspector 调用与审计；
- OAuth 回调重放、过期、取消、刷新及配置变化；
- env 与 header 秘密编辑的未改保留、改名拦截、重填成功、恢复原名和明确清空。

现有自定义 MCP 测试入口：`services/api/src/mcp/custom-servers.test.ts`、`oauth.test.ts`、`node-client.test.ts`，`apps/web/tests/McpSecretFields.test.tsx`，以及 `test/journey-custom-mcp.spec.ts`、`journey-mcp-oauth.spec.ts`、`journey-mcp-secret-edit.spec.ts`。

本地 Fixture 验证协议和产品行为，不替代真实第三方服务的联调验证。真实供应商 Smoke Test 单独运行，不进入默认离线单元测试。

## 13. 当前实现范围

本次实现包括：

- 统一 MCP Source Registry 与 Catalog，移除旧 ConnectorBroker、`science-sources` 和 Node 直连 provider；
- 12 个公开文献/数据库 Source，以及实际 MCP Server 工具发现和 Schema 兼容性检查；
- Node 权限、限流、缓存、重试、CAS、审计与返回信封复核；
- 显式 Artifact 下载、独立 PDF 抽取、持久化任务状态和结构化失败回传；
- 同模型回合的独立工具并行、全部完成后再继续 Agent Loop；
- Semantic Reviewer 只消费受治理的 MCP Evidence；
- 默认危险操作逐次审批、同类操作 Session Grant、Never Ask 全自动策略；
- 独立 PermissionAuthorization 审计、Permission Epoch 绑定和断连清理；
- Plan 记录与危险动作审批解耦；
- 自定义 MCP 的 STDIO、Streamable HTTP 和 SSE 接入、加密配置、动态工具发现、连接测试与 JSON 导入；
- HTTP/SSE OAuth 登录和刷新，以及复用治理链路的工具 Inspector，详见第 5 节。

以下内容不在本次范围内：

- 内置的私有镜像、机构认证和商业数据库专用适配器；自定义 MCP 可以承载服务商提供的接入，但不代表产品附带这些适配器或账号权限；
- 批量导出、专利库和参考文献管理器同步；
- 完整 MCP Source 与 Invocation 管理 UI；
- 完整 resources/prompts 浏览、逐工具启停配置及自定义配置导出。当前 Inspector 聚焦 tools 的单次手动验证，不是官方独立 Inspector 的完整嵌入版。

内置数据库与文献库能力仍以公开数据源为基础；自定义接入扩展的是工具接入机制，不代表已经覆盖所有后续数据源需求。

## 14. UI

内置科研链路提供基础 Artifact 下载候选、任务状态、取消/重试视图，并在信任面板显示 MCP Invocation 数量。
科研检索和下载由 Agent 工具驱动；旧 Connector 搜索/导入入口已移除。系统设置另提供自定义服务器管理、
工具详情和 Inspector，但不是完整的 Source、Invocation 和 ExtractionJob 管理 UI。当前权限卡片提供
Allow once、Allow same type 和 Deny，Session 提供 Always allow 开关。

自定义服务器详情默认收起，展开后可查看工具 Schema、连接信息和授权状态，并进入 Inspector。
启停开关控制整台服务器，超时输入始终必填；秘密值编辑的保留与重填规则见第 5.3 节。
Inspector 展示单次调用的成功/失败、耗时、原始与标准化结果和可复制的审计记录 ID；调用与取消语义见第 5.4 节。
