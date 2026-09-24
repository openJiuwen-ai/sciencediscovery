# 动态上下文组装

ScienceDiscovery 完全在 Node 进程内组装模型上下文。`packages/runtime-core` 只依赖稳定的
`ContextAssembler` 端口；提示词策略、动态 contributor、预算、历史窗口和校验则由
`packages/context` 实现。

上下文组装不需要 Python 进程或外部 Agent 框架。

## 组装模式

在启动服务前设置 `SCIENCE_AGENT_CONTEXT_MODE`：

```bash
# 生产默认值：将 Node 组装的动态上下文发送给模型。
SCIENCE_AGENT_CONTEXT_MODE=dynamic

# 调试比较：构建并 trace 动态候选，但向模型发送 legacy 输入。
SCIENCE_AGENT_CONTEXT_MODE=shadow

# 调试回归：跳过动态组装，复现旧路径。
SCIENCE_AGENT_CONTEXT_MODE=legacy
```

未设置 `SCIENCE_AGENT_CONTEXT_MODE` 时，运行时选择 `dynamic`。`legacy` 和 `shadow` 是调试和
回归比较路径，不是常规生产模式。`shadow` 会执行全部动态阶段并记录候选结果，但 Agent 的实际行为
仍使用 legacy `ModelInput`。

## Node 组装管线

每个模型轮次遵循同一顺序：

```text
规范历史
  -> 兼容的消息数量压缩
  -> ContextContributorRegistry.collectDetailed
  -> applyContextBudget
  -> DeterministicSystemPromptRenderer
  -> token 压力计算
  -> HistoryCompactor（先处理旧工具正文，再处理旧的已结束步骤）
  -> 仅在模型可见历史变更时重新收集
  -> DefaultContextMessageComposer
  -> AtomicHistoryWindowPolicy
  -> ContextValidator
  -> ModelInput
```

压缩后的 Node transcript 仍是规范历史。Contributor 消息和 attachment 只属于本次调用，绝不回写到
Session 历史。

| 组件 | 职责 |
| --- | --- |
| `ContextContributorRegistry` | 作用域过滤、并发收集、稳定排序、校验，以及必需/可选失败策略 |
| `DurableContextStore` | 在工具结果边界捕获运行范围内的结构化 Goal、Plan、Skill、Delegation、Artifact、Review 和 Memory 状态 |
| `ContextBudgetPolicy` | 保护段落准入，以及确定性的 section/data/message 截断 |
| `HistoryCompactor` | 面向模型的压力处理：删除旧工具正文，再总结旧的已结束 LLM 步骤，同时保留近期 token 尾部 |
| `SystemPromptRenderer` | 确定性的 section 排序和提示词渲染 |
| `ContextMessageComposer` | 调用局部的 contributor 消息和带 trust 标签的 attachment envelope |
| `HistoryWindowPolicy` | 选择近期轮次/消息/token，且不拆分工具调用和结果配对 |
| `TokenEstimator` | 可替换的 token 估算；默认值是保守、与提供方无关的估算 |
| `ContextValidator` | 检查受保护的 authority、受治理的工具集和工具结果完整性 |
| `ContextTraceWriter` | 显式开启的、每轮私有的组装和最终输入导出 |

## Contributor 模型

每个 `AgentRun` 在第一轮前冻结 Contributor 注册表。Contributor 的作用域为 `main`、`subagent` 或
`reviewer`，可以提供：

- 结构化 System Prompt section；
- 有界、调用局部的用户上下文消息；
- 可信或不可信的数据 attachment；
- 诊断信息。

当前内置 contributor 覆盖身份、治理、RunContract、当前工具/MCP 能力、Skill 发现，以及结构化的
Plan、Skill、Delegation、Artifact、Review 和 Memory 运行时状态。Identity、Governance 和
RunContract section 受保护，不能被静默截断。

Skill 正文仍使用渐进式披露。稳定的 System Prompt 只含已选择的 Skill 目录。完整正文只通过规范的
`read_skill` 结果进入一次上下文，动态组装不会将它复制进 System Prompt。持久的 Skill reference
记录冻结 revision。若压缩移除了原始结果，运行时数据通道会将指令标为不可用，让 Agent 再次调用
`read_skill`。延迟 MCP 工具直到 ToolRegistry promotion 前仍不存在，并会在下一轮模型调用中出现。

## 持久状态和 authority

成功的工具结果在 ToolRegistry 结果边界更新运行范围的结构化通道。并发工具可以按任何顺序结束，但
状态序列遵循模型声明的顺序。由规范 gateway history 创建的 run 会在压缩前，从结构化的 assistant
工具调用及其匹配工具结果填充 store。

| 通道 | 生产工具 | 动态投射 |
| --- | --- | --- |
| Goal/constraints | 不可变的 RunContract | 受保护的 RunContract section；store 保留结构化快照 |
| Plan | `update_plan` 的完整快照替换 | 受保护的 `plan_state` system section |
| Skill activation | `read_skill` | 隐藏且有界的 `active_skills` reference/reminder；绝不含第二份 Skill 正文 |
| Delegation | `task` | 隐藏且有界的 `delegations` data message |
| Artifact | 下载、抽取和 `declare_artifact` | 隐藏且有界的 `artifacts` data message |
| Review | `review_checkpoint`、`trace_provenance` | 隐藏且有界的 `reviews` data message |
| Memory | `query_graph`、`declare_evidence`、`declare_claim` | 隐藏且有界的 `memory` data message |

System section 只包含运行时 authority 和稳定的能力策略。工具/模型派生的观察使用标记
`authority="data_only"` 的隐藏用户消息；它们的值是数据，不能替代 system、governance、permission
或 RunContract 指令。这些投射只属于本次调用，绝不改变规范 Session 历史。

Contributor 消息只能使用 `user` 角色。Contributor 不能伪造 assistant 工具调用或工具结果。
Attachment 被包装为隐藏、调用局部的消息，带有明确的 `source` 和 `trust` 属性。

### 注册包 Contributor

能力包公开 `ContextContributorFactory`，而不导入或修改 `NativeAgent`：

```ts
import type { ContextContributorFactory } from "@sciencediscovery/context";
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";

export const memoryContextFactory: ContextContributorFactory<AgentHistoryMessage> = {
  id: "memory.context",
  create({ scope }) {
    return {
      id: "memory.snapshot",
      scopes: [scope],
      async contribute(request) {
        return {
          attachments: [{
            id: "memory.snapshot",
            source: "memory",
            trust: "trusted_data",
            content: await loadBoundedMemorySnapshot(request.contextId),
          }],
        };
      },
    };
  },
};
```

factory ID、Contributor ID、section ID 和 attachment ID 必须唯一。运行范围的 Registry 在组合后冻结，
所以包不能变更活跃 run，也不能绕过作用域、预算、ToolRegistry 或 authority 检查。

## 预算和历史窗口

全部配置值均为正整数：

| 环境变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS` | `300000` | Contributor System Prompt 总字符数 |
| `SCIENCE_AGENT_CONTEXT_SECTION_MAX_CHARS` | `100000` | 一个非保护 section 的最大字符数 |
| `SCIENCE_AGENT_CONTEXT_DATA_BUDGET_CHARS` | `500000` | attachment 总字符数 |
| `SCIENCE_AGENT_CONTEXT_ATTACHMENT_MAX_CHARS` | `200000` | 一个 attachment 的最大字符数 |
| `SCIENCE_AGENT_CONTEXT_CONTRIBUTED_MESSAGE_BUDGET_CHARS` | `100000` | contributed message 中字符串内容的总字符数 |
| `SCIENCE_AGENT_CONTEXT_MAX_CONTRIBUTED_MESSAGES` | `50` | contributed message 的最大数量 |
| `SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS` | 已解析模型上下文；回退为 `131072` | 模型上下文容量的可选覆盖值，包含预留输出 |
| `SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS` | 模型策略 `maxTokens`，默认 `16384` | 为下一次模型响应保留的容量 |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_PRESSURE_PERCENT` | `80` | 在有效模型输入上限达到该百分比时开始历史压力处理 |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_RETAIN_PERCENT` | `16` | 总结时原样保留的近期规范历史后缀，必须低于压力百分比 |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_TOOL_PREVIEW_BYTES` | `2048` | 压缩已存工具结果时保留的 head/tail 总字节数 |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_SUMMARY_RETRIES` | `1` | 总结未能缩短源片段后的额外尝试次数 |
| `SCIENCE_AGENT_CONTEXT_WINDOW_MESSAGES` | 未设置 | 调用消息上限；会保留任务锚点、最新原子步骤、检查点和未结束工具调用 |
| `SCIENCE_AGENT_CONTEXT_WINDOW_ROUNDS` | 未设置 | 近期用户轮次上限，优先于消息上限 |
| `SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS` | 未设置 | 近似的完整输入上限，包含 Prompt、工具和历史 |

受保护的 section 优先准入。若仅它们就超过 Prompt 预算，组装会失败，而不是削弱 authority。其他
section 按 slot 和顺序准入，并产生明确的截断或丢弃诊断。

有效输入上限是 `SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS`（设置时）与
`MODEL_MAX_TOKENS - OUTPUT_RESERVE_TOKENS` 中的较小值。System Prompt、Tool schema、
contributed data 和 history 都消耗同一上限。

达到压力阈值时，确定性投射会把旧的已存工具结果正文替换为小型 head/tail 预览以及它们结构化的
`read_tool_output` reference。没有可检索 reference 的结果不会被盲目删除，而是仍可由 summarizer
获取。压力仍在时，模型将最旧的已结束 LLM 步骤总结到常驻 checkpoint，并按 token 成本保留近期后缀。
这个边界可能落在一个很长的用户请求中：以前保护整个最新用户轮次的策略会让自主科学运行无限增长。
已存结果仍可通过一个有界接口恢复：先按字面 `query` 搜索，再查普通行范围，最后才对压缩 JSON 或
其他过宽单行使用 Unicode 字符范围。模型选择 query 或 range，运行时不会代替它自动搜索。

assistant 工具调用和紧随其后的工具结果保持为一个原子单元。未结束调用永不移除或总结，最新 LLM 步骤
始终保留调用/结果结构，大结果正文可能变成 head/tail + ref。最终窗口保留任务锚点、checkpoint、最新
步骤和未结束调用；若连它们也无法放入，组装会在 Provider 调用前清晰失败。

总结请求接收完整、且已受限的源 transcript，而不是再经过一层 16,000 字符/600 字符工具截断。它必须
输出一个科学 checkpoint，分别说明已完成工作、证据、决定、失败或放弃的方向、明确待满足条件、可选方向
和一个下一步。轻量结构校验器会规范化缺失或重复 section，并报告无效结构或未知的已存输出 reference；
它不判断证据是否充分，也不强制任务收敛。比源片段更大的 checkpoint 会被拒绝，并在配置范围内重试；
若失败则保留确定性裁剪，不会用更大的总结替换历史。

即使 Provider 仍以 context-window overflow 拒绝请求，adapter 也会归一化该错误。Runtime Core 会让
Assembler 执行一次强制压力处理，并恰好重试同一 LLM 轮次一次。第二次 overflow 会直接暴露，不能造成
无限重试循环。

内置的 `ConservativeTokenEstimator` 有意高估中英文混合科研文本。Model Provider 可以通过
`TokenEstimator` 接口注入精确 tokenizer，而无需改变 Assembler。

## Context trace

详细导出默认关闭：

```bash
SCIENCE_AGENT_CONTEXT_TRACE=1
# 可选；默认是 <data-dir>/context-traces
SCIENCE_AGENT_CONTEXT_TRACE_DIR=/secure/local/context-traces
```

每个模型轮次写入一个私有 JSON 文件。强制恢复写在原尝试旁边，而不是覆盖它：

```text
<trace-dir>/<context-id>/turn-0001.json
<trace-dir>/<context-id>/turn-0001-recovery-1.json
```

Trace schema v5 包含：

- mode、Agent scope、选定路径和解析后的预算；
- 每个 Contributor 的原始输出、耗时、状态和错误；
- 预算准入前已经校验的收集结果；
- 准入后的 section、attachment、message 和诊断；
- 活跃 Plan 存在时的 `planProgress`：它的 Agent/工具调用身份、声明调用在压缩后是否仍可见，以及后续
  模型步骤和已完成非 Plan 工具结果的数量；
- `renderedContext` 中的渲染 Prompt、section ID、调用历史、工具、窗口统计和窗口诊断；
- 压缩原因、前后估算 token、已压缩工具输出 reference、总结源/checkpoint 成本、尝试/拒绝次数、已总结
  消息数量，以及恢复原因/尝试；
- 传给 `ProviderModelClient` 的精确 `llmInput`。

在 `shadow` 中，`renderedContext` 是动态候选，而实际为模型选择的仍是 legacy `llmInput`。

Plan progress 仅用于观察。它不会将 Plan 标为过时、安排自动更新、阻止其他工具，或阻止模型完成。
当压缩移除声明 `update_plan` 调用时，trace 记录 `anchorFound: false`，并省略 age counter，而不是从墙钟时间
或无关轮次猜测。

Trace 文件使用 `0600` 模式，但包含用户消息、工具输入/结果、Skill metadata、检索内容和完整 prompt。
应把它们视为敏感的本地调试数据，绝不能自动上传。

## 自动验证和示例

集成测试运行真实的进程内路径，只以确定性的 recorder 替换外部 LLM transport：

```bash
pnpm --filter @sciencediscovery/api build
pnpm --filter @sciencediscovery/api test
```

它覆盖全部三种模式、main/Subagent/Reviewer scope、动态包注册、Skill 加载、延迟 MCP promotion、面向模型的
预算、trace phase、`ProviderModelClient` 收到的精确输入，以及超过压缩阈值后仍保留 Plan 和 Skill reference
而不重复 Skill 正文的历史。

使用以下命令导出三个可复现示例：

```bash
SCIENCE_AGENT_CONTEXT_EXAMPLE_DIR=.tmp/context-examples \
  node --test services/api/dist/native-agent/context-assembly.integration.test.js
```

见[上下文组装示例](context-assembly-examples.md)。

## 交付边界

当前运行范围的 Artifact、Review、Memory 和 Delegation 投射由普通受治理工具结果提供；它们不会绕过所属
领域包，也不会直接查询其 store。未来更丰富的 retrieval Contributor 属于它们各自的包，并通过
`ContextContributorFactory` 注册。`packages/context` 拥有通用的状态、注册、收集、准入、渲染、窗口、
校验和观测契约。

单一、带版本的全包式 Context Config，以及对工具 description/parameter schema 作 deep equality 检查，
仍是可能的规范化工作，不是当前实现的要求。
