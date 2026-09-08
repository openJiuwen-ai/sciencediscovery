# REST API 参考

本页记录当前 Web UI 使用的关键 HTTP 接口，内容来自 `services/api/src/http/index.ts` 与 `packages/schema/src/` 的类型。接口当前没有版本前缀或独立稳定性承诺；仓库内路由和共享 schema 是事实源。面向外部集成时，应固定所使用的 ScienceDiscovery 提交或 Release，并在升级时重新核对。

## 地址、认证与通用响应

- 本地模式默认基址与绑定地址：`http://127.0.0.1:4310`。
- Docker 默认发布地址：`http://127.0.0.1:4310`。
- `GET /health` 与 `GET /api/health` 无需认证。
- MCP OAuth 浏览器回调 `GET /api/mcp/oauth/callback` 不使用本地 bearer token，而是校验待处理的一次性 OAuth state，并通过 PKCE 交换授权码。
- 其他 `/api/*` 请求必须携带 `Authorization: Bearer <SCIENCE_AGENT_AUTH_TOKEN>`。没有默认 token：该变量未设置时，服务端在首次启动生成并打印一个随机 token，并保存在 `<数据目录>/secrets/auth-token`。
- JSON 客户端应发送 `Content-Type: application/json`；服务端对通用 JSON body 设置 1,500,000 bytes 上限。工作区上传使用 multipart 及独立配额。
- JSON 错误至少包含 `{"error":"..."}`；部分业务错误还可包含 `code` 或 `details`。

通用状态码来自当前路由与错误映射：

| 状态码 | 当前语义 |
|---|---|
| `200` | 查询、更新、删除或取消成功 |
| `201` | Project、Session、Run、代理记录或上传等资源创建成功 |
| `400` | 已识别的输入错误、无效 JSON 或非法查询参数 |
| `401` | 缺少或错误的 bearer token |
| `404` | 路由或目标资源不存在 |
| `409` | 资源冲突、只读 Session，或资源仍被引用/正在运行 |
| `413` | JSON/multipart body、单文件或工作区超出对应配额 |
| `415` | 不支持的媒体类型 |
| `500` | 未分类的服务端错误；响应不会返回内部异常细节 |

## 健康检查

```bash
curl -fsS http://127.0.0.1:4310/health
```

成功响应为 `200`，字段包括：

```json
{
  "memoryGraph": "disabled",
  "milestone": "M4",
  "runner": { "status": "ok" },
  "service": "sciencediscovery-api",
  "status": "ok",
  "workspace": {
    "maxFileBytes": 1073741824,
    "maxRequestBytes": 10737418240,
    "maxWorkspaceBytes": 10737418240
  }
}
```

`runner` 的完整字段由 Runner 健康响应决定；Runner 不可用时 API 返回 `status: "degraded"` 和 `runner.status: "unavailable"`，HTTP 状态仍为 `200`。`workspace.maxFileBytes` 与 `maxRequestBytes` 是上传入口配额，`maxWorkspaceBytes` 是 Runner 工作区配额；输出限制不在此响应中，层级见[配置参考](configuration.md#配额层级)。

## Project 与 Session

以下是创建和浏览主流程所需的接口：

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/projects` | 无 | `200`，`Project[]` |
| `POST /api/projects` | `CreateProjectRequest` | `201`，Project 字段位于根，同时含 `project` 与自动创建的 `firstSession` |
| `PATCH /api/projects/:projectId` | `{"name":"新名称"}` | `200`，更新后的 `Project` |
| `GET /api/projects/:projectId/sessions?state=active|archived|all` | 无 | `200`，`Session[]`；`state` 默认 `active` |
| `POST /api/projects/:projectId/sessions` | `CreateSessionRequest` | `201`，创建后的 `Session` |
| `GET /api/sessions/:sessionId/files` | 无 | `200`，工作区文件数组 |
| `POST /api/sessions/:sessionId/workspace/upload?conflict=reject|overwrite|rename` | multipart `file` 字段 | `201`，`WorkspaceUploadResult` |

最小 Project 请求：

```bash
curl -X POST http://127.0.0.1:4310/api/projects \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Research plan"}'
```

`CreateProjectRequest` 的字段是 `name: string` 与可选 `settingsOverrides`。`CreateSessionRequest` 可包含 `title`、`modelId`、`settingsOverrides`、`approvalMode`、`reviewMode`、`reviewCriteria` 和 `specialistId`；可选字段的精确类型见 `packages/schema/src/session.ts`。

删除 Project 或 Session 不是无请求体的 DELETE：客户端应先查询对应的 `.../deletion-impact`，再把服务端给出的 `targetId` 作为 `confirmationId` 提交。若目标含活跃运行或确认值不匹配，删除会失败。

## Run 与事件

| 方法与路径 | 请求/查询 | 成功响应 |
|---|---|---|
| `GET /api/sessions/:sessionId/runs` | 无 | `200`，`SessionRun[]` |
| `POST /api/sessions/:sessionId/runs` | `SendMessageRequest` | `201`，排队后的 `SessionRun` |
| `GET /api/sessions/:sessionId/runs/:runId` | 无 | `200`，`SessionRun` |
| `GET /api/sessions/:sessionId/runs/:runId/events?after=0` | `Accept: application/json` 或 `text/event-stream` | `200`，事件数组或 SSE；`after` 必须是非负数 |
| `POST /api/sessions/:sessionId/runs/:runId/cancel` | 无 | `200`，取消结果 |
| `GET /api/sessions/:sessionId/artifacts` | 无 | `200`，Session Artifact 数组 |

最小 Run 请求只要求 `content`：

```json
{
  "content": "概括当前研究目标，并给出下一步分析计划"
}
```

`SendMessageRequest` 还可包含 `annotationIds`、`references` 和 `webForceRefresh`。`SessionRun.status` 当前可能为 `queued`、`running`、`blocked`、`completed`、`failed`、`cancelled` 或 `interrupted`。

## 自定义 MCP 服务器与 Inspector

界面操作见[配置自定义 MCP](../how-to/configure-custom-mcp.md)。路由位于 `services/api/src/http/custom-mcp.ts`，请求和响应类型位于 `packages/schema/src/custom-mcp.ts`。下表接口均需本地 API bearer token。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/mcp/servers` | 无 | `200`，`CustomMcpServerDetails[]` |
| `POST /api/mcp/servers` | 服务器配置 | `201`，`CustomMcpServerDetails` |
| `PUT /api/mcp/servers/:id` | 完整更新配置，不是局部 PATCH | `200`，`CustomMcpServerDetails` |
| `DELETE /api/mcp/servers/:id` | 无 | `200`，`{"deleted":true}`；清理配置引用和本地 OAuth 凭据 |
| `POST /api/mcp/servers/import` | `{"mcpServers":{"名称":{...}}}` | `201`，导入的 `CustomMcpServerDetails[]`；整批校验，导入项默认停用 |
| `POST /api/mcp/servers/:id/test` | 无 | `200`，包含发现的 `tools` 和可选 `error` 的详情；可探测停用服务器，不自动启用 |
| `POST /api/mcp/servers/:id/inspect` | `{"sessionId":"...","toolName":"...","input":{...}}` | `200`，`McpInspectorResult`，含 `ok`、`invocationId`、`durationMs`，以及可选 `raw`、`result`、`error` |
| `POST /api/mcp/servers/:id/oauth/start` | `{"redirectUrl":"http://127.0.0.1:4310/api/mcp/oauth/callback"}` | `200`，`{authorizationUrl, expiresAt}`；回调必须与浏览器访问的应用同源 |
| `POST /api/mcp/servers/:id/oauth/cancel` | 无 | `200`，`{"ok":true}`；取消本地待处理授权流程 |
| `POST /api/mcp/servers/:id/oauth/clear` | 无 | `200`，`{"ok":true}`；清除本地凭据并重新探测服务器 |

服务器 ID 为 `custom-` 加 12 位十六进制字符。最多保存 50 台自定义服务器，名称不区分大小写且不能重复。最小停用 HTTP 配置示例：

```json
{
  "name": "Research tools",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "enabled": false,
  "timeoutSeconds": 60,
  "authMode": "headers",
  "headers": {}
}
```

`transport` 为 `stdio`、`http` 或 `sse`。STDIO 使用 `command`、`args`、`cwd`、`env`，HTTP/SSE 使用 `url`、`headers`。`timeoutSeconds` 默认 60，必须为 1-600 的整数。OAuth 模式接受 `oauth: {clientId, clientSecret, scope, clientMetadataUrl}`，不能同时配置手动 Authorization 请求头。示例 URL 是占位地址，不可直接用于连接。

响应中的 `env`、`headers` 只返回键名和值为 `null` 的映射，不返回秘密值。更新时，`null` **只保留同名 key 的旧值**；字符串（包括 `""`）替换旧值，省略映射中的 key 表示删除。因此重命名必须明确提供新值，对原本不存在的 key 传 `null` 会失败。界面对已保存键名的重命名要求重新填写值，未填时阻止保存。OAuth 的 `clientSecret: null` 同样保留已保存的值；详情不会返回 access/refresh token。

连接失败可能通过 HTTP `200` 测试结果内的 `error` 返回。进入治理链路后的 Inspector 失败返回 `ok: false`；无效输入或调用记录建立前的错误可能返回 `400`，服务器不存在返回 `404`。不能只根据 HTTP 成功判断工具成功。Inspector 要求服务器已启用、Session 存在且工具已被发现；手动调用会记录审计，但不会替该 Session 的 Agent 启用连接器。

### OAuth 浏览器回调

| 方法与路径 | 查询参数 | 响应 |
|---|---|---|
| `GET /api/mcp/oauth/callback` | 待处理的 `state` 与 `code`，或服务商 `error` | HTML 完成页：成功 `200`，state 无效/过期、拒绝授权或交换失败为 `400` |

这是上述本地 bearer 认证的例外，不是通用免认证配置接口。OAuth state 一次性使用，10 分钟过期；回调必须来自通过认证的 start 接口发起的流程。清除本地授权不等于撤销服务商端授权。远程 OAuth 端点要求 HTTPS，本机回环 HTTP 可用于开发。

## 代理配置

以下接口均需 bearer 认证。配置步骤与凭据注意事项见[配置网络代理](../how-to/configure-network-proxy.md)。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/proxy/settings` | 无 | `200`，`{defaultPolicy, servers}`；认证设置响应会包含可用的完整代理 URL |
| `PUT /api/proxy/settings` | `{"defaultPolicy":"none"}` 或 `proxy:<id>` | `200`，更新后的设置 |
| `POST /api/proxy/servers` | `{name, kind, url?}` | `201`，创建后的代理记录 |
| `PUT /api/proxy/servers/:id` | `{name?, kind?, url?}` | `200`，更新后的代理记录 |
| `DELETE /api/proxy/servers/:id` | 无 | `200`，`{"deleted":"<id>"}`；仍被引用时为 `409` |
| `GET /api/mcp/proxy-policies` | 无 | `200`，`{"policies":{...}}` |
| `PUT /api/mcp/proxy-policies` | `{"policies":{"server-id":"inherit|none|proxy:<id>"}}` | `200`，规范化后的策略 map |

`kind` 只能是 `custom_url`、`environment` 或 `system`；`custom_url` 创建时必须提供 `url`。示例：

```bash
curl -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN}" \
  http://127.0.0.1:4310/api/proxy/settings

curl -X POST http://127.0.0.1:4310/api/proxy/servers \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Corporate proxy","kind":"custom_url","url":"http://proxy.company.example:8080"}'
```

不要把真实代理凭据写入文档、脚本或 shell history。认证设置接口会按当前产品设计返回完整 URL，因此应按凭据管理界面保护 bearer token 和浏览器会话。
