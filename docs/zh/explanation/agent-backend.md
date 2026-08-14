# Agent 后端与 Gateway 适配边界

## 1. 结论先说

- **唯一的 agent 循环引擎**是本仓库的 `services/gateway`（Python 侧车），不是 deer-flow 官方完整服务栈。
- deer-flow 以 **git submodule**（`third_party/deer-flow`）形式 vendored；gateway 通过 uv path 依赖 **`deerflow-harness`**（`third_party/deer-flow/backend/packages/harness`）引入包名 `deerflow`。
- 所有 `deerflow.*` import、动态 provider 路径和供应商配置类型只允许出现在 Gateway 内部 `_engine/` adapter。Gateway 主流程和 Node API 只消费产品通用接口。
- Agent 组装使用 **LangChain 公共 API** `langchain.agents.create_agent`，参数由本产品的 Node API 提供；供应商 middleware、状态类型和模型补丁由 `_engine/` 转换成通用运行时组件。
- **未使用** deer-flow 的前端、其完整 runtime/配置中心、沙箱、上传系统等。一般工具执行、权限、溯源和治理仍在 Node；MCP 与 Web Provider 的实际协议调用由 Gateway 复用 DeerFlow。

## 2. 端到端一轮对话

```text
用户在 Web 发送消息
        │
        ▼
services/api 创建会话、组装 GatewayAgent
        │  buildWorkspaceSystemPrompt + createWorkspaceTools
        │  POST {gateway}/run  (JSON body，见 §4.1)
        ▼
services/gateway
        │  ReasoningChatOpenAI(← PatchedChatOpenAI) + proxy StructuredTools
        │  langchain.agents.create_agent(...)
        │  agent.stream(...) → NDJSON 事件流
        │
        ├─ 模型 API 调用 ──▶ 用户配置的 OpenAI 兼容 endpoint
        │
        └─ 工具调用 ──POST──▶ services/api /internal/tool-exec
                              │  toolCallbackRegistry[token]
                              │  真实 createWorkspaceTools 处理器
                              │  （runner / 连接器 / 权限 / 溯源…）
                              ▼
                           返回 content 文本给 gateway，继续 loop
        │
        ▼
gateway 发送 type=end（含 final_messages）
        │
        ▼
GatewayAgent 将 final_messages 写回历史，翻译事件为 UI AgentEvent（SSE）
```

**状态归属**：会话消息、工具实现、权限 epoch、工作区文件的权威都在 **Node**。Gateway 进程内不持久化会话；`thread_id` 仅用于日志/追踪（当前实现传入 session id）。

**配置归属**：Node 保存产品级 Provider、凭据、代理和 timeout 设置，只发送
`operation`、`provider`、`arguments`、`options`、`timeoutMs` 等通用字段。
Gateway `_engine/` 负责 provider 到实现路径的映射、供应商配置构造和校验，
且不读取磁盘 `config.yaml`。

## 3. 本产品侧组件

### 3.1 `GatewayAgent`（`services/api/src/gateway-agent.ts`）

职责：

1. 用 `packages/agent-runtime` 的 `buildWorkspaceSystemPrompt` 与 `createWorkspaceTools` 得到本轮提示与工具表。
2. 为每次 run 生成随机 `callback_token`，注册到 `toolCallbackRegistry`。
3. `POST ${gatewayUrl}/run`，body 携带：历史、system_prompt、tools 规格、model、callback。
4. 解析响应 **NDJSON**，映射为 `AgentEvent`（文本增量、thinking、tool start/end 等）。
5. 在 `end` 时采用 `final_messages` 作为下一轮历史；最后注销 callback token。

超时：用户设置中的 **Agent 无响应** 默认 240s（内部字段 `gatewayIdleTimeoutMs`），**Agent 单轮**默认无限（内部字段 `gatewayTurnTimeoutMs`，`0` = 无限）；两者均可在系统配置 → Timeouts 中调整。Agent 无响应在本轮长时间没有流式输出或进度时停止，Agent 单轮限制模型、工具与流式输出组成的完整一轮总时长。主 Agent 等待子 Agent 或外部工具时会暂停自身的 Gateway 计时，让子 Agent 的 `timeout` / `max_turns` 限制独立生效。子 Agent 默认 `max_turns=300`、`timeout_seconds=7200`；`task` 工具可手动传入 `max_turns`（最高 1000）和 `timeout_seconds`（最高 14400）。

运行合约：主 Agent 的首次用户输入会作为 `runContract` 注入 Gateway `system_prompt` 的 `<run_contract>` 段；子 Agent 的 delegated prompt / Brief / handoff 信息也会作为子运行的 `runContract` 注入同一段。`runContract` 不进入 `messages`，因此不会被 Gateway 运行时摘要化当成普通历史压缩掉。Node 不再在发送 Gateway 前对 `input.history` 做预摘要；跨 AgentRun 的历史以 Gateway 返回的 `final_messages` 为准直接转交。

### 3.2 工具回调用路由

`POST /internal/tool-exec`（仅应由本机 gateway 调用）：

- Header：`Authorization: Bearer <callback_token>`
- Body：`{ name, args, toolCallId }`
- 响应：`{ content, is_error }`

token 只在某一轮 `execute()` 进行期间存在于内存 Map，避免跨会话串扰。

### 3.3 Gateway 包结构

```text
services/gateway/src/science_agent_gateway/
  _engine/           # 唯一供应商 adapter：agent/model/MCP/Web 接缝
  server.py            # FastAPI：/health、/run；create_agent + stream
  model.py             # 通用 reasoning model 工厂
  tools.py             # 按 Node 下发的 spec 构建 StructuredTool 代理
  callback.py          # httpx 阻塞 POST 回 Node
  mcp_api.py           # 科研 MCP 工具的 HTTP 接入与鉴权
  public_biomed_mcp.py # 公共生物医学数据源 MCP 工具
  uniprot_mcp.py       # UniProt MCP 工具
```

依赖声明见 `services/gateway/pyproject.toml`：`deerflow-harness` → editable path 到 submodule harness。

## 4. Gateway 接口清单

### 4.1 Node → Gateway：`POST /run`

**请求 JSON（`RunRequest`）**

| 字段 | 含义 |
|------|------|
| `thread_id` | 会话/线程标识（API 传 session id） |
| `messages` | OpenAI 形态消息列表；含历史 + 本轮 user |
| `system_prompt` | Node 拼好的工作区系统提示（技能、plan 等） |
| `tools[]` | `{ name, description, input_schema }`，与会话真实工具集一致 |
| `skills[]` | 本次运行已冻结的技能 metadata（id、description、version、revision、hash、resources）；用于 Gateway native `describe_skill`，不包含完整 `SKILL.md` |
| `model` | `{ base_url, api_key, model, max_tokens?, temperature? }` |
| `callback_url` | 工具回调 URL，默认 `http://…/internal/tool-exec` |
| `callback_token` | 本轮 Bearer token |
| `summarization` | Gateway 运行时摘要配置；启用时由 adapter 提供摘要与 durable-context 能力 |

**响应**：`Content-Type: application/x-ndjson`，每行一个 JSON 对象。

| `type` | `data` 要点 | 含义 |
|--------|-------------|------|
| `messages-tuple` | `type: "ai"`, `content` | 文本增量 |
| `messages-tuple` | `type: "ai"`, `thinking` | 推理/reasoning 增量（如 DeepSeek `reasoning_content`） |
| `messages-tuple` | `type: "ai"`, `tool_calls` | 工具调用（完整 name/args/id） |
| `messages-tuple` | `type: "tool"`, `content`, `tool_call_id`, `name` | 工具结果 |
| `end` | `final_messages`, `usage` | 正常结束；历史快照供 Node 回放 |
| `error` | `message` | 失败 |

### 4.2 Gateway → Node：`POST /internal/tool-exec`

见 §3.2。Gateway 内由 `callback.invoke_node_tool` 使用 **httpx 同步 POST**（跑在 worker 线程上，匹配 LangGraph 同步 tool 调度）。

### 4.3 运维接口

| 接口 | 方向 | 说明 |
|------|------|------|
| `GET {gateway}/health` | 探活 | `{"status":"ok"}` |
| `GET {api}/health` 或 `/api/health` | 探活 | 控制面健康检查 |

Gateway 监听：`SCIENCE_AGENT_GATEWAY_HOST`（默认 `127.0.0.1`）、`SCIENCE_AGENT_GATEWAY_PORT`（默认 `4312`）。
API 侧配置：`SCIENCE_AGENT_GATEWAY_URL`、`SCIENCE_AGENT_TOOL_CALLBACK_URL`。

### 4.4 Gateway 内部 adapter 与 LangChain 接缝

| 符号 | 来源 | 用途 |
|------|------|------|
| `_engine.agent` | Gateway 私有 adapter | 输出通用 middleware、state schema、工具与 prompt sections，并提供技能 metadata 搜索 |
| `_engine.model` | Gateway 私有 adapter | 创建支持 `reasoning_content` 流式 delta 的通用 chat model |
| `_engine.mcp` | Gateway 私有 adapter | MCP server 定义、工具缓存与 metadata 的通用封装 |
| `_engine.web` | Gateway 私有 adapter | Provider 映射、供应商配置与隔离调用 |
| `create_agent` | `langchain.agents` | 组装 agent（与 deer-flow 客户端同类接缝） |
| `StructuredTool` | `langchain_core.tools` | 代理工具 |
| `convert_to_messages` / `convert_to_openai_messages` | `langchain_core.messages` | 消息格式转换；产出 `final_messages` |
| `agent.stream(..., stream_mode=["messages","values"])` | LangGraph/LangChain agent | 驱动一轮流式执行 |

**明确未接入的 deer-flow 面（示例）**：deer-flow 自带 sandbox、社区工具市场、官方 TUI/Web、其 MCP/subagent 默认栈、上传与 workspace 实现、技能文件读取路径等。若未来扩展，注释中预留可通过 `create_agent(..., middleware=...)` 增加 middleware，但仍应保持工具回调到 Node 的治理边界。

### 4.5 与「模型」相关的其他调用（不经 gateway）

**论文页面视觉分析**（`papers.ts` 中 vision 路径）仍由 **控制 API 进程** 直接 `fetch` OpenAI 兼容 `chat/completions`，**不**经过 deer-flow / gateway。

Agent 主对话与工具循环的模型调用发生在 **gateway 进程**。

## 5. Gateway 内部：一轮 `/run` 算法概要

1. 解析 `RunRequest`，构造 `CallbackTarget(url, token)`。
2. `_build_model` → `ReasoningChatOpenAI(**model_spec)`。
3. `build_proxy_tools(tools, target)`：每个 spec 一个 `StructuredTool`，`func` 闭包调用 `invoke_node_tool`。
4. `create_agent(model=..., tools=..., system_prompt=...)`。
5. `convert_to_messages(req.messages)` 作为输入。
6. 在 **后台线程** 中 `agent.stream`，经 asyncio.Queue 写出 NDJSON：
   - `values` 快照：发现新的完整 `tool_calls` 则 emit；
   - `messages` 块：emit AI 文本 / thinking / ToolMessage 结果；
   - 结束时 `final_messages = convert_to_openai_messages(state.messages)`。
7. 客户端断开时 set stop 事件，在事件边界停止 worker。

## 6. 工作区工具如何进入循环

工具 **实现** 在 Node（`packages/agent-runtime` 的 `createWorkspaceTools` + API 侧注入的 execute/MCP/plan 等）。

`web_search` / `web_fetch` 是特例：模型仍只调用 Node proxy，Node 的
`WebBroker` 完成权限、凭证、缓存、CAS 和审计后，调用 Gateway
`/internal/web/invoke`；Gateway adapter 将通用 options 转换为请求级内部配置
并执行所选 Provider。API key 不写环境变量，也不进入模型上下文。

Gateway 只收到 **规格**（名称、描述、JSON Schema）。因此：

- 会话禁用某 MCP Source → Node 不暴露对应的 `mcp__<source>__<tool>` → 模型看不到/不能调；
- 启用科学环境 → 出现 `run_r`、`environment_list` 等；
- 权限拒绝时，Node 工具 handler 失败并以 tool error 文本返回 gateway，模型可继续或解释。

典型工具名（随会话配置增减；完整清单、参数与暴露条件见 [builtin-tools.md](../reference/builtin-tools.md)）：

- 基础：`list_files`、`read_file`、`run_python`、`run_shell`
- Web：`web_search`、`web_fetch`
- 科研 MCP：`mcp__<source>__<tool>`（按需发现）
- 文件：`artifact_download`、`paper_extract_pdf`
- 科学环境：`run_r`、`environment_list`
- 技能：`describe_skill`、`read_skill`、`read_skill_resource`
- 编排：`propose_plan`、`task`、`query_graph`（Science Memory 启用时）

技能是一个有意保留的小例外：Node 除工具规格外，还会给 Gateway 下发本次运行的 `skills[]` metadata，使 Gateway 可以挂载 native `describe_skill`；目录检索实现封装在 `_engine/`。完整 `SKILL.md` 不随 `skills[]` 下发，模型选中后仍通过 Node proxy `read_skill` 读取 frozen snapshot。详见 [skill-progressive-disclosure.md](skill-progressive-disclosure.md)。

### 6.1 Subagent Brief v1 契约

`task` 工具可携带 `brief`，用于给子智能体传递结构化治理输入。服务端负责最终规范化和版本所有权：

| 字段 | 约束 |
|------|------|
| `goal` | 必填，1-2000 字符 |
| `constraints[]` | 必填，1-20 项，每项 1-1000 字符 |
| `outputRequirements[]` | 必填，1-20 项，每项 1-1000 字符 |
| `collaborationRules[]` | 必填，1-12 项，每项 1-1000 字符 |
| `outputJsonSchema` | 可选，JSON Schema draft 2020-12；序列化后最多 20000 字节，深度最多 64 |
| `version` | 服务端所有；创建时为 `1`，PATCH 每次递增，客户端传入值会被忽略 |

`outputJsonSchema` 在创建和 PATCH 时会先编译，非法 schema、未知关键字或超限 schema 返回 400。子智能体结束时只校验最后一个非空 assistant step，且该 step 必须是单个 JSON object；校验失败时子智能体状态为 `failed`，保留 `resultValidation` 和 `rawStructuredResult` 供诊断，不把未通过校验的值写入 `structuredResult`。

`PATCH /api/sessions/:sessionId/subagents/:subagentId/brief` 状态矩阵：

| 子智能体状态 | PATCH 行为 |
|--------------|------------|
| `completed` / `failed` | 可更新，返回递增后的 Brief 版本 |
| `running` | 409 |
| `cancelled` / `timed_out` | 409 |
| 未找到 | 404 |
| Brief 或 schema 非法 | 400 |

## 7. 验证入口

仓库根目录：

```bash
./test/gateway/run_m0_smoke.sh   # mock 模型：组装 + 回调 + 流式
./test/gateway/run_real_smoke.sh # 真实模型 + stub 回调
./test/api/run_m1_smoke.sh       # 假 gateway + 真 Node 工具路径（封闭）
./test/api/run_real_smoke.sh     # 真 gateway + 真模型 + 真 list_files
```

## 8. 相关文档

- [architecture.md](architecture.md) — 全局模块图
- [science-connectors.md](science-connectors.md) — 科研 MCP、治理与文件生命周期
- [subagent-orchestration.md](subagent-orchestration.md) — 主 Agent / 子 Agent 编排、结果契约与 DeerFlow 取舍
- [skill-progressive-disclosure.md](skill-progressive-disclosure.md) — 技能渐进式披露与 DeerFlow catalog 复用
- [services/gateway/README.md](../../../services/gateway/README.md) — gateway 英文说明
