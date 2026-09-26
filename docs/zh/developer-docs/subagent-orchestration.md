# Subagent 编排与治理

本文说明 ScienceDiscovery 当前的 lead agent + subagent 编排模型。重点不是“如何从零实现 subagent”，而是解释主 Agent 如何拆解、委托、回收结果，并在长上下文、多工具、多子任务场景下避免失控。

## 1. 总体模型

ScienceDiscovery 默认由平台的 `task` 工具分发子任务，每个子任务创建独立的 AgentRun。
执行器与分发方式是两个不同的选择：使用 JiuwenSwarm 执行器时，主 Agent 和平台分发的子 Agent
都由 Swarm 执行；使用内置执行器时，则运行 Node 原生 loop。

```text
主 Agent（Swarm 执行）
        │ task
        ▼
平台创建、治理子 AgentRun
        │
        ▼
子 Agent（Swarm 执行）
        │ finalMessages + 结果摘要
        ▼
平台 task 工具将结果交回主 Agent
```

`SCIENCE_AGENT_EXECUTOR=jiuwenswarm` 时，子任务链路配置如下（修改后重启服务）：

| 环境变量 `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` | 行为 |
| --- | --- |
| 未设置、空值或 `task` | 默认：平台分发，Swarm 执行；保留平台权限、沙箱、产物交接与审计 |
| `jiuwenswarm` | Swarm 原生 `subagent_spawn` / `subagent_wait`；不经过平台 `task` 生命周期 |

未知值会在启动时被拒绝。直接启动 API 与启动脚本使用相同默认值。
Swarm 原生模式仍需开放其原生工具（`SCIENCE_AGENT_JIUWENSWARM_TOOLS` 不设为 `ours`）。
原生子 Agent 使用 Swarm 自身的工具与生命周期，不保证平台 task 链路的工作区、审批与溯源一致性。
这个开关不会把执行器切回 Node 原生 loop。

主 Agent 与子 Agent 之间**不共享一份可变 state**：每个 AgentRun 拥有自己的历史、自己的工具表、自己的时间预算，交接点是显式的 `finalMessages` 与结构化的 `task` 结果。权威会话历史、权限、工作区、工具实现和审计始终由 Node 控制面持有。

这个选择带来两个约束：

- 子 Agent 是独立 AgentRun，不支持再次调用 `task` 嵌套子 Agent。
- 跨 AgentRun 的历史交接依赖上一轮返回的 `finalMessages` 和 Node 保存的运行状态。

好处是权限、Runner sandbox、工具处理器、文件溯源和 UI 时间线对主/子 Agent 完全一致，不存在两套实现。

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

主 Agent 的首次用户输入会固定为 `runContract`，并注入系统提示的 `<run_contract>` 段。子 Agent 运行时，delegated prompt、Brief 和 handoff 信息也会作为该子运行的 `runContract` 注入。

`runContract` 是请求或任务合约，不是普通历史消息：

- 不进入发给模型的 `messages`。
- 不会被 Node 原生 loop 的历史压缩当作旧对话压缩掉。
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

### 4.1 Subagent Brief v1 契约

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

## 5. 工具循环保护

ScienceDiscovery 在 Node 原生 loop 的工具调度层检测“同一工具 + 相同参数”的重复调用。由于主 Agent 和子 Agent 走的是同一套 `executeTool` 路径，这个保护对两者同时生效。

| 次数 | 行为 |
|------|------|
| 第 10 次 | 返回 `REPEATED_TOOL_CALL` 警告，提示模型复用已有结果或改变策略 |
| 第 20 次 | 返回 `TOOL_LOOP_DETECTED` 硬停错误 |

这层保护不依赖模型遵守提示词，是防止重复读文件、重复查同一检索、重复执行同一命令导致 token 和时间失控的兜底。

## 6. 历史摘要与 handoff

历史压缩由 Node 原生 loop 自己完成（`services/api/src/native-agent/compaction.ts`）。一次 AgentRun 内部，历史超过阈值时旧消息会被摘要成一条隐藏的 summary checkpoint，并在后续模型调用中继续注入；下一次压缩会把上一份摘要合并进来，因此摘要是滚动更新而不是层层叠加。细节见 [agent-backend.md](agent-backend.md) §7。

历史 handoff 的原则是：

- 单次 AgentRun 内部由 loop 自己做上下文瘦身，只有一层摘要，不存在双层叠加。
- 跨 AgentRun 历史以上一轮返回的 `finalMessages` 为准，Node 不再做额外预压缩。
- 不可丢失的请求边界放在 `runContract`，不放在可压缩历史里。

## 7. 子 Agent 工作区

每个子 Agent 在每个 Runner 上有独立的 Workspace 身份。本地子 Agent 的物理目录与主 Workspace 并列，不位于主 Workspace 内；审计和文件引用仍使用逻辑前缀：

```text
subagents/<subagentId>/
```

新子 Agent 不再默认挂载父 Workspace。子 Agent 只能使用已显式复制到自己 Workspace 的输入，不能通过父目录读取主 Agent 文件。Runner 的可选只读挂载能力仍保留，但子 Agent 启动不会传入父 Workspace。

当 `inputPaths` 显式指定，或 delegated prompt / Brief 明确提到父 workspace 路径时，API 会复制输入快照：

- `inputs/<原路径>`：审计用输入快照。
- `<原路径>`：镜像路径，方便子 Agent 按 prompt 中的相对路径读取。

文件数量、单文件大小和总大小仍受限制。超限文件会进入 `skippedInputPaths`，不会直接中断子 Agent 初始化。

## 8. 能力边界

| 能力 | 当前状态 | 说明 |
|------|----------|------|
| `task` 工具 | 已有 | 由 Node 真实执行子 AgentRun |
| `<subagent_system>` 编排提示 | 已有 | 明确要求主 Agent 拆解、并行委托、综合 |
| 并发/总量限制 | 已有 | API 层硬限制 10/50 |
| 结构化结果回流 | 已有 | 状态、停止原因、usage、Brief 校验结果回流 |
| 重复工具调用检测 | 已有 | 原生 loop 工具调度层警告和硬停 |
| 运行时摘要 | 已有 | 原生 loop 内的 summary checkpoint + `finalMessages` handoff |
| 独立子 Workspace | 已有 | 物理根与主 Workspace 分离；输入经显式复制交接，不默认挂载父目录 |
| 主/子共享一份可变 state | 未接入 | 每个 AgentRun 独立历史，交接点是显式 `finalMessages` |
| 子 Agent 再嵌套 | 禁用 | API 明确拒绝 nested subagents |
| per-run token 硬预算 | 未接入 | 当前只做 usage 回流和运行超时/轮数限制 |

共享 state 与再嵌套会带来更强的编排表达力，但也要求引入共享 checkpointer 和跨 run 的可变状态。当前实现选择保留「Node 是唯一事实来源、每个 run 独立」的边界，先补齐最影响效果的 prompt、限流、结果契约、摘要和循环保护。

## 9. 相关入口

- [agent-backend.md](agent-backend.md) — Node 原生 loop 的模块结构、历史压缩与工具调度
- [builtin-tools.md](../reference/builtin-tools.md) — `task`、`read_skill` 等模型可见工具
- [skill-progressive-disclosure.md](skill-progressive-disclosure.md) — skill 渐进式披露与 frozen snapshot
- `packages/workspace/src/prompt.ts` — `<subagent_system>` 与 prompt 版本
- `packages/workspace/src/workspace.ts` — `task` 工具入口
- `packages/orchestration/src/subagents.ts`、`run-profile.ts` — 子 Agent 配置与运行契约
- `services/api/src/runs/index.ts` — 子 Agent 限流、handoff、Brief 校验、嵌套禁用
- `services/api/src/native-agent/index.ts` — run contract 注入、工具循环检测、超时与取消
- `services/api/src/native-agent/compaction.ts` — summary checkpoint 与历史压缩
- `services/api/src/subagents/index.ts`、`workspace-copy.ts` — 独立 Workspace 输入交接和文件复制
- `services/runner/src/executor.ts` — 执行 Workspace 的沙箱边界

## 10. 按 Agent 隔离审计快照

无论执行器是 native loop 还是 JiuwenSwarm，任务目录均由 native task 分发层管理。采集快照时显式传入会话 ID、当前请求的执行 ID，以及子任务 ID（如有）。子 Agent 只采集自身任务记录、执行溯源、通知收件箱、定时器、shell 执行和文件传输，不采集兄弟任务目录。主 Agent 采集任务目录及自身执行状态；权限、artifact 和环境记录仍属于会话共享资源。

任务目录条目通过不可变的 `SubagentAuthority` 引用关联完整记录，不再内嵌轨迹。引用保留采集时的完整任务记录及继续执行所需的上下文引用。未变化的目录对象复用引用，任务或 Brief 更新后生成新版本。UI 和 native task API 仍从目录读取完整记录。历史快照继续可读，无需迁移持久化目录。

本次隔离的是快照内容，不改变模型提示词或授权策略。State Pool 闭包校验仍检查引用对象，包括继续执行的历史。历史闭包遍历和其他共享资源快照的重复保存属于后续性能优化，不能仅凭此改动认定真实 E2E 超时已经修复。
