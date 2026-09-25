# 控制面：services/api

`services/api` 是 ScienceDiscovery 的**业务权威控制面**。它负责 Project / Session / Run 生命周期、有效配置解析、权限、工具绑定、Artifact / provenance、产品级存储，以及选择当前 Agent executor。

它不等于“native Agent loop”。Native 和 JiuwenSwarm 都通过控制面的同一 Run seam 接入。

## 1. 进程入口与 composition root

| 路径 | 责任 |
| --- | --- |
| `src/server.ts` | Node 进程入口，启动/关闭 HTTP server |
| `src/http/index.ts` | HTTP composition root：路由、平台服务装配、静态 Web、运行入口 |
| `src/store.ts`, `src/store/` | Project / Session / Run / settings / secrets 等权威目录状态 |
| `src/runs/` | Session Run 状态、SSE 流、事件持久化与恢复 |
| `src/agent-run/` | executor seam、主/子 Agent 编排、workspace bindings、run deadlines |
| `src/native-agent/` | native executor，仅是两个 executor 之一 |
| `src/plugins/` | capability plugin 的宿主装配和控制入口 |
| `src/evolution/` | evolve sidecar 的控制面路由与模型代理 |
| `src/reviewer-specialist/` | Reviewer 的 API 级编排和外部 evidence gateway |
| `src/artifacts/`, `src/subagents/`, `src/permissions/` | 产品级领域编排；底层 capability 仍优先由 packages 拥有 |

精确路由以 `src/http/index.ts` 和被它调用的 route handler 为准。

## 2. Executor seam

共同入口：

```text
runMainRequestExecution / runSubagentTask
             │
             ▼
createAgentRun(profile, bindings, input)
             │
      defaultAgentFactory()
        ┌────┴──────────────┐
        ▼                   ▼
createNativeAgent   createJiuwenSwarmAgentFactory
```

`create-agent-run.ts` 根据 `jiuwenSwarmConfigFromEnv()` 选择 executor。

- 本地源码默认 native；
- 本地 `--jiuwenswarm` 使用 JiuwenSwarm；
- Docker / 发行包默认 JiuwenSwarm；
- 测试也可以通过 `bindings.createAgent` 注入替身。

`createAgentRun` 本身不应拥有 executor-specific loop policy。它负责把 `AgentProfile`、Workspace bindings、tool policy、budget、context contributors、versioning authority 和 abort 生命周期映射成统一 `AgentRunHandle`。

## 3. Run 的权威生命周期

产品状态机：

```text
queued → running ⇄ blocked → completed | failed | cancelled | interrupted
```

典型主运行：

1. HTTP 层校验 Session / model / request。
2. 解析 Project/Session 生效设置与资源。
3. 创建 RequestExecutionContext：execution id、权限 runtime、abort signal、versioning authorities。
4. 构造 Workspace / plugin / tool bindings。
5. 调用 `createAgentRun()`。
6. executor 发出 AgentEvent / tool call。
7. Tool 仍通过 ScienceDiscovery binding 执行，因此权限、Runner、MCP、Artifact 和 provenance 由产品控制面保持一致。
8. Run events 持久化并经 SSE 暴露给 UI。
9. 终态落盘并清理待处理权限/资源。

`blocked` 用于等待外部批准；`interrupted` 用于进程恢复时标记未正常结束的历史运行。

## 4. JiuwenSwarm 模式下控制面没有消失

JiuwenSwarm 模式常见误解是“adapter 成了新的后端”。实际不是：

- adapter 是 public front door 和协议适配层；
- API 仍持有 Project / Session / Run / permission / Artifact 权威状态；
- API 构造本次 run 的工具表和 runtime bindings；
- `createJiuwenSwarmAgentFactory` 把 run 发给 adapter；
- adapter 把工具暴露成 per-run MCP server；
- JiuwenSwarm tool call 经 adapter 回到 API loopback bridge；
- 模型调用经 adapter 的 per-run proxy / API model gateway 保留 ScienceDiscovery provider 行为；
- adapter frame 被映射回 ScienceDiscovery Run events。

因此新增产品行为时，优先判断它属于：
- executor-independent control plane；
- native executor；
- JiuwenSwarm adapter；
- 或 capability package。

不要在 adapter 中复制 Session/Artifact/permission 存储。

## 5. HTTP 与事件

HTTP 面主要包括：

- Project / Session CRUD 和 settings；
- Session message → Run；
- Run SSE 订阅、历史事件回放、cancel；
- models / specialists / skills / skill libraries / environments；
- MCP source、Connector、Artifact jobs；
- permissions / quotas / timeout / sandbox network；
- Reviewer / evidence / paper；
- evolution / Idea Tree / memory 等能力入口。

Run 事件是 UI 和自动化观察执行过程的稳定产品接口之一。修改事件 shape 时必须同步：

- schema；
- API producer；
- adapter mapper（如 JiuwenSwarm 路径涉及）；
- Web consumer；
- tests / E2E。

## 6. Tool 与 capability 组合

API 不应成为所有 capability 的实现仓库。

当前方向：

```text
packages/* capability
       │ public contracts / plugins / ports
       ▼
services/api composition
       │
       ├─ native executor
       └─ JiuwenSwarm bridge
```

典型 owning packages：

- `tools`：Tool 合同；
- `workspace`：Workspace tools / prompt；
- `governance`：权限治理；
- `executor`：Runner client / 远端 provision；
- `skill` / `specialist`；
- `mcp` / `mcp-sources`；
- `data-source`；
- `artifact-manager` / `artifact-json`；
- `provenance`；
- `memory`；
- `evolve` / `idea-tree`。

`scripts/check-architecture.mjs` 明确禁止多类已迁移 service-domain 源文件重新出现。

## 7. Runner 通道

Runner 是独立执行边界。API / executor 通过 `packages/executor` 的 Runner client 使用：

- shell / language execution；
- managed scientific environments；
- execution status/log/cancel；
- remote Runner / SSH provision；
- NPU workload（启用时）。

执行请求有认证和签名要求。具体协议和沙箱见 [sandbox-execution.md](sandbox-execution.md)。

## 8. 存储

权威状态不是单一数据库：

- SQLite catalog：Project、Session、Run、messages、settings、model、permission 等目录实体；
- Workspace：用户输入和执行文件；
- CAS/versioning：内容与版本；
- append-only / 文件审计：run events、execution runs、Prompt Manifest、model usage、connector/MCP/provenance 等；
- sidecar：Memory graph 等派生/专用存储。

完整数据布局见[配置参考](../reference/configuration.md#存储布局)。

## 9. 修改控制面时的检查

至少确认：

- 是否把 capability policy 错放回 API？
- 是否同时兼容 native / JiuwenSwarm executor？
- Run event 和 Artifact 语义是否保持一致？
- 是否改变权限外部等待 / timeout 行为？
- 是否影响恢复、取消或并发串行化？
- 是否新增 package dependency edge？
- 是否需要 adapter contract test 或 E2E？

先运行：

```bash
pnpm architecture:check
pnpm --filter @sciencediscovery/api test
```

## 相关文档

- [整体运行时架构](architecture.md)
- [Native Agent 后端](agent-backend.md)
- [仓库布局](repository-layout.md)
- [组件与插件机制](plugins.md)
- [沙箱执行](sandbox-execution.md)
