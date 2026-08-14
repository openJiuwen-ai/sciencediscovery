# Subagent 编排与治理

本文说明 ScienceDiscovery 当前的 lead agent + subagent 编排模型，以及本仓库复用 DeerFlow 能力时保留和没有保留的边界。重点不是“如何从零实现 subagent”，而是解释主 Agent 如何拆解、委托、回收结果，并在长上下文、多工具、多子任务场景下避免失控。

## 1. 总体模型

ScienceDiscovery 采用 **Node 侧编排 + Gateway 独立 `/run`** 的模型：

```text
主 Agent /run
        │
        │ 模型调用 task 工具
        ▼
services/api 工具回调
        │
        │ 创建子 AgentRun
        ▼
子 Agent /run
        │
        │ final_messages + 结果摘要
        ▼
task 工具结果回流主 Agent
```

这和 DeerFlow 的默认实现不同。DeerFlow 更偏向在同一个 LangGraph graph 内嵌套子 graph，并通过 `Command(update={messages:[ToolMessage]})` 把子任务结果回灌到同一份 state。ScienceDiscovery 没有把 Gateway 做成持久 stateful runtime；Gateway 仍是一轮请求的无状态 sidecar，会把权威会话历史、权限、工作区、工具实现和审计都留在 Node API。

这个选择带来两个约束：

- 子 Agent 是独立 AgentRun，不支持再次调用 `task` 嵌套子 Agent。
- 跨 AgentRun 的历史交接依赖 Gateway 返回的 `final_messages` 和 Node 保存的运行状态。

好处是现有权限、Runner sandbox、工具回调、文件溯源和 UI 时间线不需要迁移到 Python Gateway。

## 2. Lead prompt 编排

主 Agent 可使用 `task` 工具时，workspace system prompt 会注入 `<subagent_system>` 段。该段把主 Agent 明确塑造成编排者：

- `DECOMPOSE`：把复杂请求拆成互相独立的子任务。
- `DELEGATE`：用同一轮多个 `task` 调用并行委托。
- `SYNTHESIZE`：等待子任务回流后综合结论。

默认硬性运行限制与提示词保持一致：

| 限制 | 默认值 | 执行位置 |
|------|--------|----------|
| 单个模型响应最多 `task` 调用数 | 10 | prompt + API 硬限制 |
| 单个用户请求最多启动子 Agent 数 | 50 | prompt + API 硬限制 |

提示词只鼓励把“有两个或更多独立分支”的非平凡任务交给子 Agent。单文件读取、单个命令、小编辑、直接计算、必须先向用户澄清的请求，仍应由主 Agent 直接处理。

## 3. 子 Agent 运行合约

主 Agent 的首次用户输入会固定为 `runContract`，并注入 Gateway system prompt 的 `<run_contract>` 段。子 Agent 运行时，delegated prompt、Brief 和 handoff 信息也会作为该子运行的 `runContract` 注入。

`runContract` 是请求或任务合约，不是普通历史消息：

- 不进入 Gateway `messages`。
- 不会被运行时摘要当作旧对话压缩掉。
- 用来固定目标、边界、约束和交付要求。

这保证了长上下文或多批次子任务中，原始用户约束和子任务委托范围不会只依赖可压缩历史保存。

## 4. 结果回流契约

`task` 工具返回的不是一段自由文本，而是带状态字段的结构化结果。主 Agent 可以据此判断是否继续派单、补救或综合：

| 字段 | 作用 |
|------|------|
| `subagent_status` | 子 Agent 最终状态，例如 completed、failed、timed_out |
| `subagent_stop_reason` / `stopReason` | 停止原因，例如完成、超时、轮数上限、取消 |
| `subagent_token_usage` | 子 Agent 模型 token 使用量 |
| `subagent_model_name` | 子 Agent 使用的模型 |
| `subagent_result_brief` | 供主 Agent 综合的短摘要 |
| `subagent_result_sha256` | 摘要内容 hash，便于诊断和审计 |
| `resultValidation` | Brief 结构化输出校验结果 |
| `structuredResult` / `rawStructuredResult` | 通过校验的结构化输出或原始待诊断输出 |

当 Brief 带 `outputJsonSchema` 时，服务端会校验子 Agent 最后一个非空 assistant 输出。校验失败会标记为失败结果，不会把未通过校验的内容当成正常结构化结果交给主 Agent。

## 5. 工具循环保护

ScienceDiscovery 在 Node 工具回调层检测“同一工具 + 相同参数”的重复调用。由于 Gateway 的代理工具都会回调 Node，这个保护同时覆盖主 Agent 和子 Agent。

| 次数 | 行为 |
|------|------|
| 第 10 次 | 返回 `REPEATED_TOOL_CALL` 警告，提示模型复用已有结果或改变策略 |
| 第 20 次 | 返回 `TOOL_LOOP_DETECTED` 硬停错误 |

这层保护不依赖模型遵守提示词，是防止重复读文件、重复查同一检索、重复执行同一命令导致 token 和时间失控的兜底。

## 6. 历史摘要与 handoff

Gateway 运行时接入 DeerFlow 的 `DeerFlowSummarizationMiddleware` 和 `DurableContextMiddleware`。一轮运行内部可以把旧消息摘要为 `summary_text`，在后续模型调用中继续注入。

运行结束时，Gateway 会把 `summary_text` 转为隐藏的 summary checkpoint，并随 `final_messages` 返回 Node。Node 不再在发送 Gateway 前预压缩 `input.history`，避免 Node 和 Gateway 双层摘要叠加导致用户约束或 delegated prompt 被二次稀释。

历史 handoff 的原则是：

- 单次 Gateway 运行内部由 Gateway middleware 做上下文瘦身。
- 跨 AgentRun 历史以 Gateway 返回的 `final_messages` 为准。
- 不可丢失的请求边界放在 `runContract`，不放在可压缩历史里。

## 7. 子 Agent 工作区

子 Agent 有自己的私有 workspace，路径形如：

```text
subagents/<subagentId>/
```

Runner 会把父 Session workspace 以只读方式挂载给子 Agent。即使 `inputPaths` 未显式指定，子 Agent 也能读取父 workspace 文件；写入只能落到自己的私有 workspace。

当 `inputPaths` 显式指定，或 delegated prompt / Brief 明确提到父 workspace 路径时，API 会复制输入快照：

- `inputs/<原路径>`：审计用输入快照。
- `<原路径>`：镜像路径，方便子 Agent 按 prompt 中的相对路径读取。

文件数量、单文件大小和总大小仍受限制。超限文件会进入 `skippedInputPaths`，不会直接中断子 Agent 初始化。

## 8. 与 DeerFlow 的取舍

ScienceDiscovery 当前复用了 DeerFlow 影响主观效果和稳定性的关键能力，但没有完整迁移其同 graph subagent runtime。

| 能力 | 当前状态 | 说明 |
|------|----------|------|
| `task` 工具 | 已有 | 由 Node 真实执行子 AgentRun |
| `<subagent_system>` 编排提示 | 已有 | 明确要求主 Agent 拆解、并行委托、综合 |
| 并发/总量限制 | 已有 | API 层硬限制 10/50 |
| 结构化结果回流 | 已有 | 状态、停止原因、usage、Brief 校验结果回流 |
| 重复工具调用检测 | 已有 | Node 回调层警告和硬停 |
| 运行时摘要 | 已有 | Gateway middleware + summary checkpoint handoff |
| 父 workspace 只读挂载 | 已有 | 子 Agent 可读父 workspace，只能写私有目录 |
| 同 graph 嵌套 subagent | 未接入 | Gateway 仍保持无状态 sidecar |
| 子 Agent 再嵌套 | 禁用 | API 明确拒绝 nested subagents |
| per-run token 硬预算 | 未接入 | 当前只做 usage 回流和运行超时/轮数限制 |

完整复刻 DeerFlow 的同 graph 嵌套路线会带来共享 state、共享 checkpointer 和再嵌套能力，但也会把 Gateway 从无状态 sidecar 推向 stateful runtime。当前实现选择渐进补强路线：保留 Node 作为系统事实来源，先补齐最影响效果的 prompt、限流、结果契约、摘要和循环保护。

## 9. 相关入口

- [agent-backend.md](agent-backend.md) — Node/Gateway 请求结构、运行历史和 DeerFlow 复用边界
- [builtin-tools.md](../reference/builtin-tools.md) — `task`、`describe_skill` 等模型可见工具
- [skill-progressive-disclosure.md](skill-progressive-disclosure.md) — skill 渐进式披露与 frozen snapshot
- `packages/agent-runtime/src/runtime.ts` — `<subagent_system>` 与 prompt 版本
- `packages/agent-runtime/src/workspace.ts` — `task` 工具与结果契约
- `services/api/src/runs/index.ts` — 子 Agent 限流、handoff、Brief 校验、嵌套禁用
- `services/api/src/gateway-agent.ts` — run contract、工具循环检测、Gateway 请求体
- `services/gateway/src/science_agent_gateway/server.py` — summarization checkpoint 和 Gateway stream
- `services/runner/src/executor.ts` — 父 workspace 只读挂载与私有 workspace 写入
