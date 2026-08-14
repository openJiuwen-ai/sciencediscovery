# REST API 参考

本页记录当前 Web UI 使用的关键 HTTP 接口，内容来自 `services/api/src/http/index.ts` 与 `packages/schema/src/` 的类型。接口当前没有版本前缀或独立稳定性承诺；仓库内路由和共享 schema 是事实源。面向外部集成时，应固定所使用的 ScienceDiscovery 提交或 Release，并在升级时重新核对。

## 地址、认证与通用响应

- 默认基址与绑定地址：`http://127.0.0.1:4310`。
- `GET /health` 与 `GET /api/health` 无需认证。
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
  "service": "science-agent-api",
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

## 代理配置

以下接口均需 bearer 认证。配置步骤与凭据注意事项见[配置企业网络代理](../how-to/configure-network-proxy.md)。

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
