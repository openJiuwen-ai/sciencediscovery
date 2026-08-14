# Explanation 导航

这些文档解释系统为何这样设计及组件如何协作。查询具体参数、路由和文件位置时，请转到 [Reference](../README.md#reference参考)。

- [整体运行时架构](architecture.md) — 常驻进程、模块边界和跨进程时序。
- [控制面](control-plane.md) — `services/api` 的职责、存储与运行生命周期。
- [Agent 后端](agent-backend.md) — Gateway 契约和内部引擎边界。
- [沙箱执行](sandbox-execution.md) — bubblewrap/seccomp、科学环境和持久内核机制。
- [Ascend NPU 宿主 Broker](ascend-npu-runner.md) — 昇腾设备不能稳定直通 bwrap 时的宿主白名单作业方案。
- [外部数据源限流](rate-limiting.md) — MCP 限流底座、队列、429 冷却和覆盖边界。
- [科研连接器](science-connectors.md) — 科研 MCP 的治理链、审计和引用。
- [MCP 工具与协议设计](mcp-tool-protocol.md) — Source Manifest、工具协议、Agent Loop、权限、审计与控制面接口。
- [网络代理机制](network-proxy.md) — 代理策略解析、出站接入与安全边界。
- [评审与溯源](review-provenance.md) — 完整性检查、语义评审、claims/evidence 和 Prompt Manifest。
- [科学记忆](science-memory.md) — 任务链、引用链、模块边界和存储。
- [技能渐进式披露](skill-progressive-disclosure.md) — 技能发现与 DeerFlow catalog 复用。
- [子 Agent 编排](subagent-orchestration.md) — 主/子 Agent 契约、guardrails 和取舍。
- [内容寻址存储](cas.md) — CAS 地址、工作区变更检测、写入方与生命周期。
