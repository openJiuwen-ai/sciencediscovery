# 开发者文档

这些文档描述架构、模块边界、协议和当前有效的特性设计。面向用户的行为和精确配置见[文档总览](../README.md)。

## 开始阅读

- [深度开发指南](developer-guide.md) — 面向代码贡献者和 Code Agent 的仓库理解入口。
- [整体运行时架构](architecture.md) — 常驻进程、模块边界和跨进程时序。
- [仓库布局](repository-layout.md) — 目录、模块、默认端口和数据位置。

## Runtime 与 Agent

- [控制面](control-plane.md) — `services/api` 的职责、存储与运行生命周期。
- [Agent 后端](agent-backend.md) — Node 原生 agent loop 的模块结构、模型传输、延迟工具与历史压缩。
- [Runtime Core 边界](runtime-core.md) — 与领域无关的运行时职责和已注册端口。
- [动态上下文组装](context-assembly.md) — 上下文模式、contributor、预算、trace 和校验。
- [Session 轨迹与模型上下文](session-trajectory.md) — 真实时间多 Agent 导航、固定状态与上下文来源、只读导出。
- [子 Agent 编排](subagent-orchestration.md) — 主/子 Agent 契约、guardrails 和取舍。

## 扩展与科研能力

- [组件与插件机制](plugins.md) — 能力归属、单向依赖、公开插件入口。
- [科研连接器](science-connectors.md) — 科研 MCP 的治理链、审计和引用。
- [MCP 工具与协议设计](mcp-tool-protocol.md) — Source Manifest、工具协议、Agent Loop、权限、审计与控制面接口。
- [科学记忆](science-memory.md) — 任务链、引用链、模块边界和存储。
- [评审与溯源](review-provenance.md) — 完整性检查、claims/evidence 和 Prompt Manifest。
- [技能渐进式披露](skill-progressive-disclosure.md) — 技能目录检索与冻结快照读取。
- [Skill 自演进设计](skill-self-evolution.md) — 从任务经验提取候选 Skill、评估、门禁和发布到 Skill 库的闭环。

## 执行环境与部署

- [沙箱执行](sandbox-execution.md) — bubblewrap/seccomp、科学环境和持久内核机制。
- [Project/Session Runner 继承](runner-inheritance.md) — Project 提供默认值，Session 可独立选机。
- [Ascend NPU 宿主 Broker](ascend-npu-runner.md) — 昇腾设备宿主白名单作业方案。
- [网络代理机制](network-proxy.md) — 代理策略解析和安全边界。
- [内容寻址存储](cas.md) — CAS 地址、工作区变更检测和生命周期。
- [PDF worker](paper-worker.md) — PDF 抽取协议、管线和限制。
- [Web 前端](web-frontend.md) — 前端技术栈、事件映射、开发与测试入口。

## 历史设计记录

以下文档保留用于理解演进过程，不作为当前实现依据：

- 技能库管理初步设计
- 技能库管理 MVP/M1/M2 落地记录
- 已废弃迁移方案
