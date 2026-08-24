# Agent 后端：Node 原生 agent loop

## 1. 结论先说

- **agent 循环运行在 Node 控制面进程内**（`services/api`），不再有「Node 把一轮对话转交给 Python 侧车」这一跳。
- 循环、模型流式传输、工具调度、延迟工具发现、历史压缩全部是本仓库自己的 TypeScript 实现，**不使用 LangChain / LangGraph，也不依赖 deer-flow 跑 loop**。
- 模型调用由 Node 直接发出（`undici`），支持 **OpenAI 兼容** 与 **Anthropic Messages** 两种方言。
- MCP 由 Node 用官方 TypeScript SDK **在进程内**连接（stdio / SSE / streamable-HTTP），不再经 gateway HTTP。
- 工具实现仍在 Node 控制面：`packages/workspace` 构建工作区工具，`packages/tools` 负责注册与调度策略，API 注入治理、溯源、执行和数据源适配器。原生 loop 直接 `await` 这些处理器，因此不再需要 `POST /internal/tool-exec` 回调。
- **Python 侧车已不再是服务**：web provider 也已原生化到 Node，gateway 的 HTTP 服务随之删除；`services/gateway` 现在只是随包 Python MCP server（biomed、UniProt）的宿主包与解释器环境。详见 §8。

历史架构（Python gateway 跑 LangChain `create_agent`、Node `POST /run`、gateway 回调 `/internal/tool-exec`）已退役，见 §9。

## 2. 端到端一轮对话

```text
浏览器 ──SSE/REST──▶ services/api
                          │
                          │ runs/index.ts 组装 AgentProfile + WorkspaceAgentOptions
                          ▼
                    createAgentRun(profile, bindings, input)     ← agent-run/create-agent-run.ts
                          │  默认工厂 createNativeAgent
                          ▼
                    NativeAgent.execute(prompt)                  ← native-agent/index.ts
                          │
      ┌───────────────────┴────────────────────────────────────────────┐
      │  for turn in 0..MAX_MODEL_TURNS:                               │
      │    1. maybeCompact(history)          ← native-agent/compaction │
      │    2. streamModelTurn(...)           ← native-agent/model-client│
      │         └─出站 HTTPS─▶ 用户配置的模型 endpoint                  │
      │         └─onTextDelta / onThinkingDelta ─▶ AgentEvent ─▶ SSE   │
      │    3. 无 tool_calls → 跳出循环                                  │
      │    4. 并发执行本轮全部 tool_calls                               │
      │         └─▶ AgentTool.execute(...)   ← workspace + tools      │
      │              └─▶ 权限门 / Runner:4311 / MCP / 连接器 / 溯源      │
      │    5. tool 结果按调用顺序 append 回 history，回到第 1 步         │
      └────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                    finalMessages（OpenAI wire 格式，剔除 system）
                          │
                          ▼
                    API 落盘历史；事件已实时经 SSE 推给浏览器
```

**状态归属**：会话消息、工具实现、权限 epoch、工作区文件的权威全部在 Node。**没有第二个进程持有对话状态**——这一点相比旧架构是简化，而不是变更。

**历史格式**：全程使用 OpenAI wire 格式（`role` / `content` / `tool_calls` / `tool_call_id`）。assistant 消息**逐字保存**，包括模型返回的未知字段（如 Gemini 的 `thought_signature`）。这就是为什么原生 loop 不需要旧架构里的模型补丁层：下一次请求原样回放即可。

## 3. `agent-run/create-agent-run.ts` — 一轮 run 的起点

**职责**：把控制面的 `AgentProfile` + `AgentRunInput` 翻译成一个 `NativeAgent`，并提供 run 级生命周期句柄。它本身不含循环逻辑。

| 项 | 内容 |
|---|---|
| 入口 | `createAgentRun(profile, bindings, input): AgentRunHandle` |
| 默认工厂 | `bindings.createAgent ?? createNativeAgent`——测试可注入替身，生产恒为原生 loop |
| 返回 | `{ abort(), beginExternalWait(), execute() }` |

关键映射：

| 来源 | 传给 NativeAgent |
|---|---|
| `input.history` | `structuredClone` 后作为 `gatewayHistory`（字段名沿用，语义是「上一个 AgentRun 交接过来的权威 transcript」） |
| `profile.budget.runTimeoutMs` | `runTimeoutMs` |
| `bindings.runIdleTimeoutMs` | `runIdleTimeoutMs` |
| `input.runContract` | `runContract`（注入 system prompt 的 `<run_contract>` 段，不进 `messages`，因此不会被压缩掉） |
| `profile.toolPolicy` | `{ allowed, disallowed }` 工具白/黑名单 |
| `profile.resources.connectorIds` | `enabledConnectorIds` |
| `profile.gatewayThreadId` | `sessionId`（仅用于日志/追踪） |

**失败行为**：`execute()` 只允许调用一次，重复调用抛 `AgentRun <id> has already been executed`。`bindings.abortSignal` 触发时转成 `agent.abort()`；`finally` 中一定会解绑监听器和事件订阅。

## 4. `native-agent/index.ts` — 循环状态机

这是整个后端的核心，`NativeAgent` 类。

### 4.1 构造期（一次性）

1. `buildTools(options)` → 调 `createWorkspaceTools`，得到本轮完整工具表；重名直接抛 `Duplicate workspace tool name`。
2. `buildDeferredToolState(...)` → 挑出 `deferred` 工具建目录（§6）。
3. `buildWorkspaceSystemPrompt(...)` → 基础系统提示（技能、科学环境、审批模式、specialist、subagent 等）。
4. 拼出最终 system prompt：

   ```text
   基础工作区提示
   <run_contract>…</run_contract>        （有 runContract 时）
   <available-deferred-tools>…</…>       （有 deferred 工具时）
   <mcp_routing_hints>…</…>              （有 prefer 路由提示时）
   ```

5. 归一化历史：`normalizeHistoryMessage` 会把历史里的**旧环境工具名**（`normalizeLegacyEnvironmentToolName`）在 `message.name`、`tool_calls[].name`、`tool_calls[].function.name` 三处都改写，避免老会话回放时出现模型看不懂的工具名。
6. 解析模型 endpoint 与 `ModelClientPolicy`（§5.1）。

### 4.2 `execute(text)` 主循环

```text
history.push({role:"user", content:text})
autoPromoteFromRouting(...)                  ← 按关键词预提升 deferred 工具
armTurnDeadline(); markProgress()            ← 装两个计时器

for turn in 0 .. MAX_MODEL_TURNS(128):
    aborted? → 抛错
    maybeCompact()                           ← 超过阈值就压缩历史
    emit turn_start
    modelTurn = streamModelTurn(...)         ← 流式一轮；每个 chunk 调 markProgress
    history.push(modelTurn.assistantMessage) ← 逐字保存
    if modelTurn.toolCalls 为空 → break
    对每个 call emit tool_execution_start
    outcomes = await Promise.all(calls.map(executeToolCall))   ← 并发
    对每个结果 emit tool_execution_end，并 history.push({role:"tool", ...})
emit model_usage（+ usage）
return { finalMessages: history 中剔除 system 的深拷贝 }
```

要点：

- **`MAX_MODEL_TURNS = 128`** 只是防跑飞的硬保险；正常边界是时间预算。
- 同一个 assistant turn 里的多个 tool call **并发执行**，但结果**按调用顺序**追加回历史，保证可复现。
- `finalMessages` 过滤掉 `role === "system"`，交给显式的 RequestExecution 交接。

### 4.3 超时：两个独立计时器

| 计时器 | 选项 | 默认 | 含义 |
|---|---|---|---|
| 单轮总时长 | `runTimeoutMs` | `DEFAULT_AGENT_TURN_TIMEOUT_MS = 0`（无限） | 一次完整 run 的硬截止 |
| 无进展 | `runIdleTimeoutMs` | `DEFAULT_AGENT_IDLE_TIMEOUT_MS = 240_000` | 距上一次「有进展」的最长间隔 |

「有进展」= `markProgress()` 被调用，触发点是：模型流每收到一个 chunk、一轮模型结束、每条 tool 结果落历史。

**外部等待暂停**：`beginExternalWait()` 返回一个释放函数，支持嵌套计数。第一次进入时 `pauseRunDeadline()` 停掉两个计时器并把已耗时从 `remainingRunMs` 里扣掉；计数归零时 `resumeRunDeadline()` 重新装表。主 Agent 等待子 Agent 或人工审批时用它，让子 Agent 自己的 `timeout_seconds` / `max_turns` 独立生效。

**错误措辞是契约**：超时抛出的消息**必须**含 `timeout` 字样——`classifySubagentFailure` 用 `/timeout/i` 匹配，以保留子智能体对外的 `timed_out` 状态。两条消息分别是 `Agent run stalled: no gateway progress for N ms` 与 `Agent run timeout: gateway turn exceeded N ms`。

**取消**：`abort()` 置 `abortRequested` 并 abort `AbortController`；信号透传给模型请求和工具 `execute`。`raiseForAbort` 区分三种情况——超时（转成 timeout 错误）、主动取消（`Agent run cancelled`）、其他真实错误（原样抛出）。

### 4.4 工具调度与失败形状

`executeToolCall` 的判定顺序：

1. **参数解析失败** → 返回 `INVALID_TOOL_ARGUMENTS`，`retryable: true`，不调用任何处理器。
2. **`tool_search`** → 走延迟工具目录检索（§6），不进权限门。
3. **命中仍隐藏的 deferred 工具** → 返回 `blockedDeferredToolResult`，提示先调 `tool_search`。
4. 其余 → `executeTool(name, args, id)`。

`executeTool` 里还有**循环检测**：以 `sha256(name + 稳定序列化后的 args)` 为键计数。

| 重复次数 | 行为 |
|---|---|
| ≥ `LOOP_DETECTION_WARN_COUNT`（10） | 返回 `REPEATED_TOOL_CALL` 警告，`isError: false`，提示换思路，仍可继续 |
| ≥ `LOOP_DETECTION_HARD_COUNT`（20） | 返回 `TOOL_LOOP_DETECTED`，`retryable: false`，**不再执行**该调用 |

工具抛异常时统一转成结构化 JSON 结果（不是让循环崩掉）：

```json
{ "ok": false, "error": { "code": "...", "message": "(截断到 1000 字符)", "attempts": N, "retryable": bool, "retryAfterMs": ms } }
```

`code` / `attempts` / `retryable` / `retryAfterMs` 优先取自错误对象上的 `invocation` 字段（MCP 治理路径会带），否则回落到 `TOOL_EXECUTION_FAILED` / `1` / `false`。未知工具名返回 `Unknown tool: <name>`。

**远程内容净化**（`native-agent/sanitize.ts`）：工具成功返回后、结果进入历史和 UI 之前，`web_search` / `web_fetch` / `image_search` / `web_capture` 四个工具的文本会经 `neutralizeUntrustedTags` 中和——框架权威标签被 HTML 转义（`<system-reminder>` → `&lt;system-reminder&gt;`），`--- BEGIN/END USER INPUT ---` 被替换为惰性形 `[BEGIN/END USER INPUT]`。本地工具（shell、文件读取）输出**不做任何处理**，以免改坏真实代码和日志。

封禁标签表包含本产品实际注入的全部权威块（`available-deferred-tools`、`available_skills`、`durable_context_data`、`mcp_routing_hints`、`run_contract`、`skill_system`、`subagent_system`、`system-reminder` / `system_reminder`）以及通用注入模式。`sanitize.test.ts` 的**防漂移测试**会扫描提示词源文件，任何新出现的标签必须要么进封禁表、要么在测试的 `NON_AUTHORITY_TAGS` 中显式说明理由，否则测试失败——这条约束的存在是因为新增 `<run_contract>` 时曾漏掉同步。

### 4.5 事件如何变成 SSE

`NativeAgent` 只向订阅者 emit `AgentEvent`（定义在 `packages/orchestration/src/agent.ts`）。`services/api/src/runs/index.ts` 的 observer 负责翻译成前端 SSE：

| AgentEvent | 触发点 | SSE 事件 |
|---|---|---|
| `turn_start` | 每轮模型开始前 | `agent.phase`（`phase: "thinking"`，`turn` 递增） |
| `message_update` / `thinking_delta` | 模型 reasoning 增量 | `assistant.thinking.delta` |
| `message_update` / `text_delta` | 模型正文增量 | `assistant.delta` |
| `tool_execution_start` | 每个 tool call 派发时 | `tool.started`（携带 `ToolTrace`，status `running`） |
| `tool_execution_end` | 每个 tool 结果就绪 | `tool.output` + `tool.completed`（status `completed` / `failed`） |
| `model_usage` | 循环结束 | 不直接下发，记为本轮 usage |
| `usage` | 循环结束且拿到 usage | 子智能体用量汇总 |

## 5. `native-agent/model-client.ts` — 流式模型传输

**职责**：把一轮模型调用做成「两种方言进、一种归一化结果出」。

```ts
streamModelTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks): Promise<ModelTurn>
```

`ModelTurn = { assistantMessage, toolCalls, usage? }`。方言选择由 `isAnthropicEndpoint(baseUrl)` 决定——**判据是 baseUrl 含 `/api/plan`**，即内部 plan endpoint；其余一律走 OpenAI 兼容。

### 5.1 策略与网络

`resolveModelClientPolicy(env)`：

| 环境变量 | 默认 | 校验 |
|---|---|---|
| `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | 600 | 必须为正数，否则启动即抛错 |
| `SCIENCE_AGENT_LLM_MAX_RETRIES` | 2 | 必须为非负整数 |

`maxTokens` 固定 `DEFAULT_MODEL_MAX_TOKENS = 16_384`。

`requestWithRetry` 的重试只覆盖**流开始之前**的失败：连接错误、`429`、`5xx`。一旦流开始出数据，错误直接抛给调用方（不会重放半截输出）。退避为 `min(4000, 500 * 2^attempt)` ms，若响应带 `Retry-After` 则优先采用。`headersTimeout` 取 `requestTimeoutMs`，`bodyTimeout` 设为 `0`——**长流不能因为「响应体慢」被掐断**。

代理：`proxyDispatcher(proxy)` 按 `ResolvedProxy.mode` 分三种——`environment` 用进程默认 dispatcher，`url` 固定一个 `ProxyAgent`，`direct` 固定一个干净 `UndiciAgent`（即忽略环境里的代理变量）。

### 5.2 OpenAI 兼容方言

- `POST {baseUrl}/chat/completions`，`stream: true`，`stream_options: { include_usage: true }`。
- 消息 = `[{role:"system", content: systemPrompt}, ...history]`。
- 工具按 `{ type:"function", function:{ name, description, parameters } }` 下发。
- SSE 解析：`sseData()` 逐行拆 `data:`，跳过 `[DONE]`，**容忍畸形 keepalive 帧**（`JSON.parse` 失败就跳过该行，不中断流）。
- `delta.reasoning_content` → `onThinkingDelta`；`delta.content` → 累加正文并 `onTextDelta`。
- **tool call 分片合并**按 `index` 聚合：`function.name` 取到即用，`function.arguments` 字符串**拼接**。其余未知字段（如 `thought_signature`）逐字合并进分片，最终原样写进 assistant 消息的 `tool_calls`——这是 provider 怪癖能自动回放的原因。
- 缺 `id` 时补 `call_<uuid>`，缺 `type` 时补 `function`；**没有 `function.name` 的分片不进 `toolCalls`**（但仍留在 wire 消息里）。

### 5.3 Anthropic Messages 方言

- `POST {baseUrl}/v1/messages`，头部 `x-api-key` + `anthropic-version: 2023-06-01`。
- `toAnthropicMessages(history)` 把 OpenAI 格式历史翻译过去：`system` 跳过（单独作为顶层 `system` 字段）、`assistant.tool_calls` → `tool_use` 块、`role:"tool"` → **user 角色**的 `tool_result` 块；**相邻同角色消息会被合并**成一条，满足 Anthropic 的交替要求。
- 事件流：`content_block_start`（`tool_use` 建槽）、`content_block_delta`（`text_delta` / `thinking_delta` / `input_json_delta` 累加参数 JSON）、`message_start` 与 `message_delta` 取用量。
- 出参重新组装成**同样的 OpenAI wire 形状**（`tool_calls[].function.arguments` 为字符串，空参补 `{}`），因此上层历史格式始终统一。

### 5.4 用量归一

`normalizeUsage(raw)` 同时认 OpenAI 与 Anthropic 拼写，并做缺项推导：

| 归一字段 | 接受的来源键 |
|---|---|
| `inputTokens` | `input_tokens`、`prompt_tokens` |
| `outputTokens` | `output_tokens`、`completion_tokens` |
| `totalTokens` | `total_tokens`（缺失则由 input+output 推出） |
| `cacheReadTokens` | `cache_read_input_tokens`、`cache_read_tokens`、`cached_tokens`、`prompt_cache_hit_tokens`、`prompt_tokens_details.cached_tokens` |
| `cacheWriteTokens` | `cache_creation_input_tokens`、`cache_write_tokens`、`prompt_cache_miss_tokens` |

三项 token 数任一无法推出时整体返回 `undefined`（宁可不报，也不报错数）。

## 6. `native-agent/deferred-tools.ts` — 延迟工具发现

**问题**：MCP 工具的 JSON Schema 往往很大，全部绑定会挤占上下文。

**做法**：标了 `deferred` 的工具（目前是全部 MCP 工具，见 `packages/workspace/src/workspace.ts`）默认**不绑定给模型**，只在 system prompt 的 `<available-deferred-tools>` 里列名字；模型需要时调用合成工具 `tool_search` 取回完整 schema，取回即「提升」（promote），本轮后续可直接调用。

| 符号 | 作用 |
|---|---|
| `DeferredToolCatalog` | 目录；`hash` 是按名字排序后 schema 的 sha256 前 16 位，用于检测目录漂移 |
| `DeferredToolState` | `{ catalog, promoted: Set<string> }`，run 级状态 |
| `hiddenDeferredNames(state)` | 目录里尚未 promote 的名字；`visibleToolSpecs()` 用它过滤下发工具表 |
| `runToolSearch(state, query)` | 检索 + promote，返回 OpenAI function schema 的 JSON |
| `blockedDeferredToolResult(name)` | 调用未提升工具时的可重试错误文案 |
| `autoPromoteFromRouting(...)` | 依据 operator 路由提示预提升 |

`tool_search` 的三种查询形式：

| 形式 | 语义 | 上限 |
|---|---|---|
| `select:a,b` | 按精确名字取 | **无上限**（显式选择不得静默丢弃） |
| `+slack send` | 名字必须含 `slack`，其余词用于排序 | `MAX_RESULTS = 5` |
| `notebook jupyter` | 当作正则匹配 `name + description`，命中名字得 2 分、仅命中描述得 1 分 | `MAX_RESULTS = 5` |

**失败行为**：模型给出的查询是非法正则时，`compileQueryRegex` / `countMatches` **降级为字面量匹配**而不是抛错。无命中返回 `No tools found matching: <query>`。

**自动提升**：`autoPromoteFromRouting` 在 `execute()` 开头对**本轮用户输入**做小写包含匹配，只考虑 `routing.mode === "prefer"` 且有关键词的工具，按 `priority` 降序（同优先级按名字）取前 `AUTO_PROMOTE_TOP_K = 3` 个提升。

**prompt 区块**：`deferredToolsPromptSection` 输出排序去重后的名字列表；`routingHintsPromptSection` 输出 `<mcp_routing_hints>`，对仍处于 deferred 的工具写「先 `tool_search` 再用」，对已可见的写「直接优先用」。两处都对名字与关键词做 HTML 转义，防止工具名伪造 prompt 结构。

## 7. `native-agent/compaction.ts` — 历史压缩

**触发**：`planCompaction(history)` 在 `history.length >= COMPACTION_TRIGGER_MESSAGES(50)` 时给出计划，保留最后 `COMPACTION_KEEP_MESSAGES(20)` 条。

**切点修正**：保留窗口**不能以 tool 结果开头**——`cutoff` 会向后推进直到不是 `role:"tool"`，保证 assistant 消息和它的 tool 结果总是被一起压缩，不会留下孤儿 tool 结果。

**摘要**：用本轮同一个模型 endpoint 发一次独立请求（system prompt 为 `You are compacting…`，不带工具）。`buildSummaryPrompt` 把待压缩片段渲染成 transcript（assistant 附 `[tool calls: name(args前300字符)]`，tool 结果按 600 字符截断），整体截到 `SUMMARY_INPUT_CHAR_BUDGET = 16_000`，并对内容做 HTML 转义后包进 `<new_messages>`；若存在上一份摘要则再包一个 `<existing_summary>`（预算减半）——**转义是安全要求**，被摘要的内容不得闭合这两个标签来伪造结构。

**checkpoint**：`summaryCheckpointMessage` 生成一条 `role:"user"`、`name:"summary"` 的消息，正文以 `[ScienceDiscovery summary checkpoint]` 开头并包在 `<durable_context_data>` 里，`additional_kwargs` 带 `hide_from_ui: true` 与 `sciencediscovery_summary_checkpoint: true`。渲染预算 `SUMMARY_RENDER_CHAR_BUDGET = 6_000`，超出用 `boundText` 保头保尾（2/3 头 + 尾，中间 `\n...\n`）。

**链式**：下一次压缩通过 `extractCheckpointSummary` 把上一份摘要读回来一起合并，所以摘要是**滚动更新**而不是层层叠加。格式与旧引擎一致，**旧会话历史仍能被识别**。

**失败行为**：摘要请求失败时**跳过本次压缩、继续正常跑**（除非是取消信号，那要往上抛）。摘要为空字符串时也不生成 checkpoint。

## 8. MCP：`mcp/node-client.ts` 与 `mcp/extensions-config.ts`

**职责**：用官方 `@modelcontextprotocol/sdk` 在 Node 进程内直连 MCP server，替掉原先「Node → gateway HTTP → Python MCP 客户端」这一跳，同时**保持治理契约不变**（仍然是 `McpInvokeRequest` / `McpInvokeResponse`）。

### 8.1 配置来源

`extensions-config.ts` 读 `extensions_config.json`：路径取 `SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH`（指定但文件不存在 → 直接抛错），否则回落到 `cwd/extensions_config.json`，都没有则视为空配置。文件内容支持 `${ENV_VAR}` 占位符解析。`signature` = 路径 + mtime + size + 内容的 sha256，**内容一变就整体重建会话**。

### 8.2 传输与会话

| transport | 建立方式 |
|---|---|
| `stdio` | `StdioClientTransport` 派生子进程；`stderr: "ignore"` |
| `sse` | `SSEClientTransport(new URL(url), { requestInit: { headers } })` |
| `http` / `streamable_http` | `StreamableHTTPClientTransport(...)` |

**解释器解析**：stdio 且 `command` 是裸 `python` / `python3` 时，`resolveMcpPython()` 依次尝试 `SCIENCE_AGENT_GATEWAY_PYTHON_PATH`、`$SCIENCE_AGENT_DATA_DIR/envs/gateway/bin/python`、`.sciencediscovery-data/envs/gateway/bin/python`、`services/gateway/.venv/bin/python`，都没有才回落到 `python`。**这是随包 biomed / UniProt MCP server 仍然依赖 gateway venv 的原因**。

**环境投影**：子进程环境从 `getDefaultEnvironment()` 起步，叠加配置里的 `env`（但**代理类变量被剔除**），最后叠加 `proxyEnvOverlay(proxy)` 决定的代理变量——`direct` 不注入任何代理变量，`environment` 复制当前进程的代理变量，`url` 把 `HTTP_PROXY` 等一组固定成该 URL 并保留 `NO_PROXY`。

**会话缓存与失效**：按 serverId 缓存，缓存项记录 `proxySignature`。代理签名变化 → 关掉重连；配置签名变化 → `closeAll()` 全部重建；`invoke` 里发现请求携带的 proxy 与当前不一致时也会自愈式重连。

### 8.3 目录

`catalog()` 遍历 `enabled` 的 server，对每个 server 分页 `listTools()`（跟随 `nextCursor`），按名字排序，为每个工具算 `schemaHash`（inputSchema 的 sha256）并附上 `effectiveRouting(server, toolName)` 得到的 routing 注解。整体 `revision` 是所有 server 结构的 sha256。

**失败隔离**：**单个 server 失败不影响其他 server**——异常被吞掉，该 server 以空工具表出现，并关闭其会话以便下次重连。

**工具名**：Node 侧最终暴露给模型的名字是 `mcp__<sourceId>__<toolId>`（非法字符替换为 `_`），拼装在 `services/api/src/mcp/workspace-tools.ts`。

### 8.4 调用

`invoke(request, signal)` 实现整套重试/超时/限额语义：

- **总截止**：`started + request.execution.timeoutMs`；每次 attempt 先算剩余，剩余 ≤ 0 直接记 `timeout`。
- **单次超时**：`min(剩余时间, server.toolCallTimeoutSeconds * 1000)`。
- **响应上限**：`request.execution.maxResponseBytes`，默认 `5_000_000`；超限抛 `RESPONSE_TOO_LARGE`。
- **错误分类**：`classifyError` 把错误文本映射为 `timeout` / `rate-limited` / `transport-error` / `server-error` / `semantic-error`，并尽力从文本里解析 `retry-after` 秒数。`transport-error` 会**先关闭会话**，让下次 attempt 重连（stdio 子进程死掉的典型场景）。
- **退避**：指数 `initialDelayMs * multiplier^(n-1)`，封顶 `maxDelayMs`，叠加 `jitterRatio` 抖动；`respectRetryAfter` 为真且解析到 retry-after 时优先用它。**若退避会超出总截止则直接放弃**。
- **返回形状**：成功/失败都返回 `McpInvokeResponse`，`attempts[]` 逐次记录状态、耗时、错误码；失败时 `isError: true` 且 content 为截断到 1000 字符的错误文本。未知或未启用的 server 抛带 `statusCode: 404` 的错误。

## 9. 能力 Package 与 loop 的边界

原 `packages/agent-runtime` 聚合包已按职责拆分。`packages/runtime-core` 驱动通用循环，各能力 Package 实现类型化的 Context、Model、Tool Port，且不反向依赖 Service。

| 导出 | 归属 | 与 loop 的关系 |
|---|---|---|
| `buildWorkspaceSystemPrompt(...)` | `packages/context` | 构建由 Context Assembler 使用的工作区/System Prompt 片段 |
| `createWorkspaceTools(root, options)` | `packages/workspace` | 产出 `AgentTool[]`；具体 Port 由 API Composition Root 注入 |
| `AgentTool`、`ToolRegistry` | `packages/tools` | 定义工具执行并负责 deferred 发现、净化和循环策略 |
| `AgentEvent`、`Agent` | `packages/orchestration` | 定义运行生命周期契约；`runs/index.ts` 负责翻成 SSE（§4.5） |
| `AgentHistoryMessage` | `packages/orchestration` | Provider 无关的 Runtime 历史条目 |
| `normalizeLegacyEnvironmentToolName` | `packages/workspace` | 历史回放时的工具改名兼容 |

**边界原则**：loop **不**决定工具语义、不做权限判断、不写溯源；工具层**不**知道自己被哪种循环驱动。这条边界是原生化能做到「换掉引擎但治理不变」的前提。

## 10. `services/gateway` 现在是什么

**不再是一个服务**。它没有 HTTP 端口、没有 FastAPI 应用，也不再被 `start-stack.sh` 拉起。剩下的全部内容是随包的两个 stdio MCP server（biomed、UniProt）及其共用的外部 URL 注册表；Node 用 `resolveMcpPython()` 找到该 venv 的解释器，把它们作为子进程启动（§8.2）。

因此 **gateway venv 仍需 provision，但 gateway 服务不再存在**。`deerflow-harness` 依赖已从 `pyproject.toml` 移除，环境里 `import deerflow` 会直接 `ModuleNotFoundError`；`services/gateway/tests/test_architecture_boundaries.py` 用一条覆盖全包的断言把这条边界钉住。

web provider 的执行改由 `services/api/src/web-providers/native/` 承担：`NativeWebProviderClient` 保持 `WebBroker` 原有的调用契约与响应形状，所以权限、凭据、缓存、CAS、审计、降级策略一行未动，换掉的只是执行体。

## 11. 已退役

以下内容**不再是现行架构**，仅为对照历史记录：

| 已退役 | 曾经的位置 | 现状 |
|---|---|---|
| `GatewayAgent` | `services/api/src/gateway-agent.ts` | 文件已删除 |
| `POST {gateway}/run` 驱动对话 | Node → gateway | 路由与其全部装配代码（`tools.py`、`callback.py`、`model.py`、`_engine` 的 agent/deferred/state/summarize/model_patch/skills/sanitize）已删除 |
| `POST /internal/tool-exec` 回调 | gateway → Node | 原生 loop 直接 `await` 工具处理器；路由、`callback_token` 机制与 `SCIENCE_AGENT_TOOL_CALLBACK_URL` 均已删除 |
| LangChain `create_agent` / LangGraph 驱动循环 | gateway `_engine/` | 循环改由 `native-agent/index.ts` 实现 |
| deer-flow 依赖与 submodule | gateway `pyproject.toml`、`third_party/deer-flow` | 已整体移除：web provider 原生化后不再有 vendor 调用方，依赖、submodule、首启下载与打包 pin 全部删除 |
| 模型补丁层（thought_signature 重放） | gateway `_engine/model_patch.py` | 原生 loop 逐字保存 assistant 消息，回放天然成立 |

## 12. 验证入口

```bash
./test/api/run_m1_smoke.sh        # 封闭：脚本化 SSE 模型端点 + 真实 Node 工具，验证原生 loop 全链路
./test/api/run_real_smoke.sh      # 真实模型 + 真实工具
```

单元测试（`services/api`，`pnpm test` 走 `node --test dist/**`）：

| 文件 | 覆盖 |
|---|---|
| `src/native-agent/native-agent.test.ts` | 循环状态机、超时、取消、循环检测、压缩触发 |
| `src/native-agent/model-client.test.ts` | 两种方言的流式解析、tool call 分片合并、用量归一 |
| `src/mcp/node-client.test.ts` | 传输选择、解释器解析、代理投影、重试与错误分类 |
| `src/agent-run/create-agent-run.test.ts` | 默认工厂与 run 句柄语义 |
| `src/native-agent/sanitize.test.ts` | 标签转义、边界替换、作用域、防漂移 |
| `src/run-failure.test.ts` | 运行失败分类与原始错误保留 |

## 13. 相关文档

- [architecture.md](architecture.md) — 进程与全局模块图
- [control-plane.md](control-plane.md) — 控制面职责与接口
- [mcp-tool-protocol.md](mcp-tool-protocol.md) — MCP 治理契约与结果规范化
- [science-connectors.md](science-connectors.md) — 科研 MCP、治理与文件生命周期
- [subagent-orchestration.md](subagent-orchestration.md) — 主 Agent / 子 Agent 编排与结果契约
- [skill-progressive-disclosure.md](skill-progressive-disclosure.md) — 技能渐进式披露
- [builtin-tools.md](../reference/builtin-tools.md) — 工具清单、参数与暴露条件
