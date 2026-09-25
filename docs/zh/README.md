# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## 快速开始

- [快速开始](getting-started/quick-start.md) — 按 Linux 或 macOS 的最短路径启动服务、配置模型，并完成第一次可检查的 Agent 任务。
- [部署](getting-started/deployment.md) — 选择预编译单文件、本地源码模式或 Docker，包含长期运行与首次启动排障。

## 核心能力

从把代码跑起来，到探索方向、改进产物与核查依据，这六项能力组成了可检查、可迭代的科研工作方式。

- [科研沙箱](core/execution-workspaces.md) — 在隔离空间编写、调试和运行代码，让分析可以复核。
- [Idea Tree 自主研究](core/idea-tree.md) — 提出候选、设计方案、分别评估，让反馈引导下一轮探索。
- [科研产物的 RSI](core/evolve.md) — 通过变体搜索与留出评价，逐步改进可评价的产物。
- [记忆图谱与 Reviewer](core/science-memory-reviewer.md) — 连接任务、证据与结论，发现值得复核的问题。
- [专业 Specialist](core/specialists.md) — 将职责、技能和工具整理成可复用的研究角色。
- [科研 MCP 与 Skill](core/mcp-skills.md) — 将真实科研接口与可复用的工作方法组合起来。

## 领域指南

- [演进出一个更优解](domains/evolve-a-solution.md) — 完整跑一次程序演进搜索，并判断改进是不是真的。
- [运行一次演进搜索](domains/run-an-evolution-search.md) — 定搜索规模、选择打分模式、看过程，并读留出结果。
- [在 Ascend NPU 上设计抗体](domains/antibody-design.md) — 使用 RFdiffusion、ProteinMPNN 和 Protenix 完成一次可追溯的抗体设计与筛选。
- [分析脓毒症分型评分的相关性与聚类](domains/analyze-sepsis-endotypes.md) — 使用 BiomniBench 真实数据，从上传 CSV 到分析、交付和质量评价。
- [调研鸟类迁徙如何定位与导航](domains/literature-research.md) — 以 DRB-59 为例，配置检索资源、综合文献证据并检查报告。

## 进阶设置

- [创建与使用自定义 Specialist](advanced-setup/configure-specialists.md) — 配置专业职责、资源并验证任务。
- [导入与管理科研 Skill](advanced-setup/configure-skills.md) — 本地/Git 导入、运行端启用与草稿审核。

- [配置自定义 MCP](advanced-setup/configure-custom-mcp.md) — 本地/远程连接、秘密值编辑、OAuth、Inspector 与会话工具选择。
- [配置网络代理](advanced-setup/configure-network-proxy.md) — 在设置页添加代理并为 LLM、Web 和 MCP 选择策略。
- [安装 Neo4j 与配置科学记忆](advanced-setup/science-memory-setup.md) — 安装外部 Neo4j、在系统设置里开启科学记忆，并在前端图谱里查看链路。

## Reference（参考）

- [执行与工作区](reference/execution-workspaces.md) — 执行状态、文件交接、环境版本与停止行为。

- [CLI](reference/cli.md) — `serve`、`run`、`extract`、`version` 的命令与行为。
- [配置、端口与存储](reference/configuration.md) — 环境变量、默认端口、上传/工作区/输出配额和数据布局。
- [REST API](reference/rest-api.md) — 当前 UI 使用的内部 HTTP 接口、认证、请求/响应与错误语义。
- [运行时行为](reference/runtime-behavior.md) — 模型、设置继承、技能、权限、超时和执行限制。
- [内置工具](reference/builtin-tools.md) — 模型可见工具的参数、边界和暴露条件。
- [Web 工具](reference/web-tools.md) — Web Search/Fetch provider、配置、权限、缓存与审计。

## 开发者文档

- [Idea Tree 实现](developer-docs/idea-tree.md) — 研究循环、状态持久化、预算与恢复边界。

见[开发者文档导航](developer-docs/README.md)，其中包括架构、模块边界、协议和当前有效的特性设计。

## 其他资料

- [贡献指南](../../CONTRIBUTING.md)
- [License](../../LICENSE)
