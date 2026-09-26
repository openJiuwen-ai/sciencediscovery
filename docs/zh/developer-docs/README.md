# 开发者文档

这些文档面向需要修改 ScienceDiscovery 核心代码的开发者和 Code Agent。目标是描述**当前实现、模块边界和必须保持的架构约束**。用户操作与精确配置见[文档总览](../README.md)。

> 第一次进入仓库请先读[深度开发指南](developer-guide.md)，不要从某个历史功能文档反推当前架构。

## 开始阅读

- [深度开发指南](developer-guide.md) — 阅读顺序、代码导航、当前架构事实和修改检查清单。
- [整体运行时架构](architecture.md) — native / JiuwenSwarm executor、adapter、API、Runner 和 sidecar 拓扑。
- [仓库布局](repository-layout.md) — services/packages ownership、依赖边界和代码入口。
- [控制面](control-plane.md) — `services/api` 的权威状态、Run 生命周期与 executor seam。

## Agent Runtime

- [Native Agent 后端](agent-backend.md) — native executor 的循环、模型、工具、超时和与 JiuwenSwarm 的共同语义。
- [Runtime Core 边界](runtime-core.md) — 最底层领域无关 runtime 合同。
- [动态上下文组装](context-assembly.md) — contributor、预算、trace 和依赖边界。
- [上下文组装示例](context-assembly-examples.md) — 生产组装路径生成的模型输入示例。
- [Session 轨迹与模型上下文](session-trajectory.md) — trajectory、固定 context/state 和只读投影。
- [子 Agent 编排](subagent-orchestration.md) — 主/子 Agent 契约、handoff、guardrails 和失败语义。

## 能力与扩展架构

- [组件与插件机制](plugins.md) — capability ownership、plugin manifest/runtime/web 契约和宿主装配。
- [MCP 工具与协议设计](mcp-tool-protocol.md) — MCP Source、工具协议、权限、审计和控制面接口。
- [科研连接器](science-connectors.md) — 科研数据源治理、引用和审计。
- [外部数据源限流](rate-limiting.md) — data-source admission、429 冷却和与 LLM retry 的边界。
- [Skill Library 当前实现](skill-library-management.md) — 版本、内容地址包、搜索、proposal、publish 和 rollback。
- [技能渐进式披露](skill-progressive-disclosure.md) — Skill catalog、冻结快照和按需读取。
- [Skill 自演进当前实现](skill-self-evolution.md) — proposal → 用户授权 → 新 Library version。
- [评审与溯源](review-provenance.md) — Artifact Reviewer、claims/evidence、Prompt Manifest。
- [科学记忆](science-memory.md) — task/citation graph、存储和模块边界。
- [演进侧车](evolve-standalone.md) — PUCT/OpenEvolve sidecar 合同与控制面耦合。
- [Idea Tree 实现](idea-tree.md) — Idea Tree 运行、持久化和恢复边界。

## 执行、存储与基础设施

- [单文件二进制打包与发行](binary-packaging.md) — 构建标识、发行包组成、双架构打包与首次启动 bootstrap。
- [部署运行机制](deployment-runtime.md) — 本地启动链、远端 Runner 自动部署、Docker 内部边界与多实例。
- [沙箱执行](sandbox-execution.md) — Bubblewrap/Seatbelt、科学环境、网络和 NPU 执行。
- [Project/Session Runner 继承](runner-inheritance.md) — Runner 选择、远端执行和继承语义。
- [Ascend NPU 宿主 Broker](ascend-npu-runner.md) — allowlisted host workload。
- [网络代理机制](network-proxy.md) — 出站代理解析和安全边界。
- [内容寻址存储](cas.md) — CAS、版本对象和 workspace change detection。
- [PDF worker](paper-worker.md) — PDF 抽取 worker 协议和限制。
- [Web 前端](web-frontend.md) — Web host、事件映射和前端开发入口。

## 文档维护规则

Developer Docs 只应保留当前实现或仍有必要的兼容行为说明。

- 阶段性 MVP/M1/M2 交付文档不保留在主文档集；需要追溯时使用 Git 历史。
- “计划”“建议”“未来可做”不能写成当前实现事实。
- 代码发生架构变化时，优先更新 `architecture.md`、`repository-layout.md` 和对应 subsystem 文档。
- 遇到文档冲突，以当前代码、测试、`scripts/start-stack.sh` 和 `scripts/check-architecture.mjs` 为准。
