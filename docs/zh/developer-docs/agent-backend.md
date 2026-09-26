# Agent 后端：Native executor

**Status: Current native executor implementation**

本文只描述 `services/api/src/native-agent/` 的 **native executor**。它不是唯一生产路径：本地源码默认 native，而 Docker / 发行包默认 JiuwenSwarm。Executor 选择和共同控制面见[整体运行时架构](architecture.md)。

JiuwenSwarm 路径的协议适配以：

- `services/api/src/agent-run/jiuwenswarm-agent.ts`
- `services/api/src/agent-run/jiuwenswarm-model-gateway.ts`
- `services/adapter/`
- `services/adapter/README.md`

为准。

## 1. Executor seam

所有主/子 Agent run 最终进入：

```text
createAgentRun(profile, bindings, input)
```

定义在：

```text
services/api/src/agent-run/create-agent-run.ts
```

`defaultAgentFactory()` 根据部署配置选择：

```text
native       → createNativeAgent
jiuwenswarm  → createJiuwenSwarmAgentFactory
```

因此修改 `createAgentRun` 时要保持 executor-neutral；native 专属行为应留在 `native-agent/`。

## 2. Native executor 代码入口

当前 `services/api/src/native-agent/` 主要包含：

| 文件 | 作用 |
| --- | --- |
| `index.ts` | `NativeAgent`、主循环、tool dispatch、超时、context/model 调用 |
| `versioning.ts` | run/versioning snapshot 与 authority 记录 |
| `native-agent.test.ts` | native loop 核心单测 |
| `context-assembly.integration.test.ts` | context assembly 与 native loop 集成 |
| `versioning.test.ts` | versioning 行为 |

模型、工具、context 等能力大量来自 packages，而不是全部实现在该目录：

- `@sciencediscovery/model`
- `@sciencediscovery/context`
- `@sciencediscovery/tools`
- `@sciencediscovery/workspace`
- plugin runtime contributions

## 3. Native run 数据流

```text
API run orchestration
       │
       ▼
createAgentRun(...)
       │ native factory
       ▼
NativeAgent.execute(prompt)
       │
       ├─ assemble context
       ├─ stream model turn
       ├─ emit text/thinking/usage events
       ├─ parse tool calls
       ├─ execute tool handlers
       ├─ append tool results
       └─ repeat until no tool calls / abort / timeout
       │
       ▼
finalMessages
```

Tool handler 的真实基础设施仍由 API bindings 注入，因此 native executor 不直接拥有 Project/Session storage、permission persistence 或 Runner lifecycle。

## 4. Context 与 system prompt

Native executor 在构造/运行期间组合：

- Workspace system prompt；
- run contract；
- context contributors；
- Skill / durable context；
- deferred tool metadata；
- MCP routing hints；
- Agent history。

动态 context 机制本身由 `packages/context` 提供，见[动态上下文组装](context-assembly.md)。

修改 prompt/context 时，需要同时检查：

- `packages/context`；
- `packages/workspace`；
- capability plugin 的 contributor；
- native integration tests；
- JiuwenSwarm model/tool proxy 是否需要保持等价语义。

## 5. Model transport

Native executor 通过 ScienceDiscovery model package/client 直接调用用户配置的模型 endpoint，并把流式 delta 转成 Agent events。

需要保持的产品语义包括：

- provider / protocol variant；
- thinking / reasoning 控制；
- proxy policy；
- usage accounting；
- provider-specific assistant history；
- abort / timeout。

JiuwenSwarm 不直接绕过这些产品语义：其模型请求经 ScienceDiscovery 的 per-run model gateway/proxy 路径重新进入产品模型层。

## 6. Tool dispatch

Native executor 接收模型 tool call 后调用 ScienceDiscovery tool table。

核心约束：

- 一个 assistant turn 中可并发执行允许并发的 tool；
- 结果按调用顺序进入 history；
- 参数解析错误返回结构化 tool error，而不是崩掉整个 run；
- tool handler 异常转换为结构化失败结果；
- deferred tool 未暴露时要求先经过 discovery；
- 重复 tool call 有循环保护；
- abort signal 要贯通模型和工具执行。

Tool policy、permission、Runner、MCP、Artifact/provenance 等不是 native loop 自己的持久化职责。

## 7. 超时与外部等待

Native executor 区分：

- run 总时长；
- 无进展 idle timeout；
- 主动 cancel；
- permission / subagent 等外部等待。

`beginExternalWait()` 用于暂停 run deadline，使等待人工审批或子 Agent 时不被错误计入主 Agent 的 active time。

超时错误 wording 与子 Agent failure classification 存在契约关系，修改前应先查相关测试。

## 8. History 与版本记录

Native executor 保存模型 assistant message 和 tool result，最终返回 `finalMessages` 给控制面。

Versioning 记录的目标不是复制 Session store，而是冻结本次 Agent trajectory 中对结果有影响的 authority，例如：

- plan；
- resources；
- tool policy；
- budget；
- 外部版本引用。

相关代码：

- `native-agent/versioning.ts`
- `agent-run/versioning-authorities.ts`
- Prompt Manifest / provenance 相关代码

## 9. Native 与 JiuwenSwarm 必须保持的共同语义

如果修改的是产品行为，而非 native-only optimization，应检查 JiuwenSwarm 路径是否仍一致：

| 语义 | Native | JiuwenSwarm |
| --- | --- | --- |
| Project/Session authority | API | API |
| Tool implementations | ScienceDiscovery bindings | adapter MCP bridge → 同一 bindings |
| Permission | ScienceDiscovery | ScienceDiscovery tool bridge |
| Artifact/provenance | ScienceDiscovery | ScienceDiscovery tool bridge |
| Model provider semantics | product model client | adapter/API model gateway |
| Run events | native AgentEvent mapping | adapter frame mapping |
| Cancel/timeout | native executor | JiuwenSwarm agent adapter |

不要只修改 `native-agent/index.ts` 就假设发行版行为已经改变。

## 10. 测试入口

优先运行：

```bash
pnpm --filter @sciencediscovery/api test
```

关键测试包括：

- `native-agent/native-agent.test.ts`
- `native-agent/context-assembly.integration.test.ts`
- `native-agent/versioning.test.ts`
- `agent-run/create-agent-run.test.ts`
- `agent-run/jiuwenswarm-agent.test.ts`
- `agent-run/jiuwenswarm-model-gateway.test.ts`

若变更用户可观察行为，还需要相应 E2E / journey。

## 11. 已退役架构

以下内容不属于当前实现，不应在新代码中恢复：

- Python gateway 承载主 Agent loop；
- deer-flow 作为当前 Agent runtime；
- Node API 通过旧 `POST /run` 把一轮完整对话交给 gateway；
- gateway 通过旧 `/internal/tool-exec` 作为统一工具回调；
- 所有生产部署固定使用 native loop。

历史兼容命名可能仍存在于字段或环境目录中，但不代表旧服务边界仍成立。

## 相关文档

- [整体运行时架构](architecture.md)
- [控制面](control-plane.md)
- [动态上下文组装](context-assembly.md)
- [组件与插件机制](plugins.md)
- `services/adapter/README.md`
