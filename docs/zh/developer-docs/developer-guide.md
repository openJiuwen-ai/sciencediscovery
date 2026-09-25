# 深度开发指南

本文面向需要修改 ScienceDiscovery 代码的开发者和 Code Agent。目标不是介绍产品功能，而是帮助你在最短时间内建立**当前实现的代码地图**，避免被历史设计文档或兼容目录误导。

## 1. 推荐阅读顺序

第一次进入仓库时，建议按这个顺序：

1. [整体运行时架构](architecture.md)
   - 先理解 native / JiuwenSwarm 两种 executor、adapter、API、Runner 和 sidecar 的关系。

2. [仓库布局](repository-layout.md)
   - 再理解 capability package、service composition 和代码入口。

3. [控制面](control-plane.md)
   - 理解 Project / Session / Run、权限、存储和产品级生命周期。

4. [Agent 后端](agent-backend.md)
   - 只在需要修改 native executor 或 executor seam 时深入。

5. [组件与插件机制](plugins.md)
   - 新增跨产品能力前先确认 ownership 和扩展入口。

6. 目标领域文档
   - execution → [sandbox-execution.md](sandbox-execution.md)
   - MCP → [mcp-tool-protocol.md](mcp-tool-protocol.md)
   - context → [context-assembly.md](context-assembly.md)
   - subagent → [subagent-orchestration.md](subagent-orchestration.md)
   - provenance/review → [review-provenance.md](review-provenance.md)
   - memory → [science-memory.md](science-memory.md)
   - evolution → [evolve-standalone.md](evolve-standalone.md)

## 2. 先记住五条当前架构事实

### 2.1 API 是业务权威控制面

`services/api` 持有：

- Project / Session / Run 生命周期；
- 权限；
- tool binding；
- Artifact / provenance；
- 模型和资源配置；
- executor 选择；
- 产品级持久化。

即使使用 JiuwenSwarm executor，这些权威状态也不迁移到 adapter 或 JiuwenSwarm。

### 2.2 Agent executor 可替换

当前有两条 executor：

- **native**：`services/api/src/native-agent/`
- **JiuwenSwarm**：`services/api/src/agent-run/jiuwenswarm-agent.ts` + `services/adapter/`

`services/api/src/agent-run/create-agent-run.ts` 是公共 seam。

本地源码默认 native；Docker/发行包默认 JiuwenSwarm。

### 2.3 Runner 只负责执行

`services/runner` 负责隔离执行、科学环境和可选 Host NPU Broker。

不要把业务判断、Agent policy、Artifact 语义或产品存储放到 Runner。

### 2.4 packages 拥有 capability

通用/领域能力优先放在 `packages/`。Service 的职责是：

- 进程入口；
- 协议适配；
- dependency injection；
- 生命周期；
- composition。

`scripts/check-architecture.mjs` 会强制部分边界。

### 2.5 Web 不是业务权威

`apps/web` 消费 API 状态并呈现 UI。不要通过前端本地状态定义后端业务事实。

## 3. 修改代码时先回答这些问题

在写代码前，先定位：

1. **用户入口是什么？**
   - HTTP route、Tool、Plugin、UI action、CLI、sidecar protocol？

2. **谁拥有这个 capability？**
   - 已经有 package，还是确实需要新 package？

3. **composition seam 在哪里？**
   - API binding、plugin port、executor factory、Runner client、sidecar client？

4. **两个 executor 都受影响吗？**
   - Native 和 JiuwenSwarm 是否要保持同一工具/权限/Artifact 语义？

5. **权威状态存在哪里？**
   - SQLite、文件审计、CAS、sidecar，还是纯派生状态？

6. **测试应该放哪里？**
   - package unit test、service contract test、adapter live test、用户旅程 E2E？

## 4. 快速代码导航

| 要改什么 | 先看哪里 |
| --- | --- |
| HTTP/API 行为 | `services/api/src/http/index.ts` |
| Run 生命周期 | `services/api/src/agent-run/orchestrators.ts` |
| executor 选择 | `services/api/src/agent-run/create-agent-run.ts` |
| native Agent loop | `services/api/src/native-agent/` |
| JiuwenSwarm 适配 | `services/adapter/` + `jiuwenswarm-agent.ts` |
| Tool 合同 | `packages/tools` |
| Workspace 工具/prompt | `packages/workspace` |
| Context | `packages/context` |
| Plugin | `packages/plugin-sdk` + owning capability plugin |
| 权限治理 | `packages/governance` |
| 本地/远端执行 | `packages/executor` + `services/runner` |
| Skill | `packages/skill`, `packages/specialist`, `services/api/src/skill-library-catalog.ts` |
| Artifact / 下载 | `packages/artifact-manager`, `packages/artifact-json`, API artifacts composition |
| Memory | `packages/memory` + `services/memory-graph` |
| Evolve | `packages/evolve` + `services/evolve` + API evolution routes |

## 5. 必跑检查

架构或 capability 变更至少先跑：

```bash
pnpm architecture:check
pnpm typecheck
```

再运行目标 package/service 的测试。

用户可观察行为发生变化时，应补或运行对应用户旅程；不要只以“单元测试通过”作为完成标准。

全仓默认检查与文档检查入口：

```bash
pnpm check
pnpm docs:check
```

`docs:check` 会执行 Markdown lint 和仓内文档链接检查。

## 6. 如何判断文档是否还能信

Developer Docs 中的优先级：

1. 标记为当前实现的架构/模块文档；
2. 当前代码和测试；
3. service 自带 README（例如 adapter README）；
4. 历史设计记录。

如果文档描述和代码冲突，先验证代码，再更新文档。

本轮已经移除明确的 MVP/M1/M2 阶段性交付文档，避免 Code Agent 把旧阶段目标当成当前实现。

## 7. 不要做的事情

- 不要根据目录名猜 ownership。
- 不要在 `services/api` 复制已经迁到 package 的 capability。
- 不要把 `services/gateway` 当成当前 Agent HTTP gateway。
- 不要假设生产环境永远使用 native Agent loop。
- 不要只修 native executor 而忽略 JiuwenSwarm adapter 语义。
- 不要扩大 executor → runner 的遗留依赖豁免。
- 不要绕过 `pnpm architecture:check` 引入新的反向依赖。

## 相关文档

- [整体运行时架构](architecture.md)
- [仓库布局](repository-layout.md)
- [控制面](control-plane.md)
- [组件与插件机制](plugins.md)
