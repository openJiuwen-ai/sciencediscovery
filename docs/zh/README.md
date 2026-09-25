# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## 快速开始

- [快速开始](getting-started/quick-start.md) — 安装预编译二进制、启动服务、配置模型，并完成第一次
  Agent 任务。
- [部署](getting-started/deployment.md) — 预编译二进制不适合你的主机或工作流时，用其他方式安装与运行：源码构建的单文件二进制、本地源码模式，或 Docker。

## 核心能力

- [程序演进](core/evolve.md) — 理解搜索、打分模式、引擎、数据切分和结果可信度。
- [Shell、环境与 Workspace](core/execution-workspaces.md) — 理解执行、文件、环境、完成与停止行为。
- [Idea Tree](core/idea-tree.md) — 理解自主研究引擎的使用方式、状态和边界。

## 领域指南

- [演进出一个更优解](domains/evolve-a-solution.md) — 完整跑一次程序演进搜索，并判断改进是不是真的。
- [运行一次演进搜索](domains/run-an-evolution-search.md) — 定搜索规模、选择打分模式、看过程，并读留出结果。
- [在 Ascend NPU 上设计抗体](domains/antibody-design.md) — 使用 RFdiffusion、ProteinMPNN 和 Protenix 完成一次可追溯的抗体设计与筛选。
- [分析脓毒症分型评分的相关性与聚类](domains/analyze-sepsis-endotypes.md) — 使用 BiomniBench 真实数据，从上传 CSV 到分析、交付和质量评价。
- [文献调研](domains/literature-research.md) — 以跨数据库文献调研为例，演示从启动服务、配置系统到审批与查看结果的全流程。

## 进阶设置

- [配置自定义 MCP](advanced-setup/configure-custom-mcp.md) — 本地/远程连接、秘密值编辑、OAuth、Inspector 与会话工具选择。
- [配置网络代理](advanced-setup/configure-network-proxy.md) — 在设置页添加代理并为 LLM、Web 和 MCP 选择策略。
- [安装 Neo4j 与配置科学记忆](advanced-setup/science-memory-setup.md) — 安装外部 Neo4j、在系统设置里开启科学记忆，并在前端图谱里查看链路。

## Reference（参考）

- [配置、端口与存储](reference/configuration.md) — 环境变量、默认端口、上传/工作区/输出配额和数据布局。
- [REST API](reference/rest-api.md) — 当前 UI 使用的内部 HTTP 接口、认证、请求/响应与错误语义。
- [运行时行为](reference/runtime-behavior.md) — 模型、设置继承、技能、权限、超时和执行限制。
- [内置工具](reference/builtin-tools.md) — 模型可见工具的参数、边界和暴露条件。
- [Web 工具](reference/web-tools.md) — Web Search/Fetch provider、配置、权限、缓存与审计。

## 开发者文档

见[开发者文档导航](developer-docs/README.md)，其中包括架构、模块边界、协议和当前有效的特性设计。

## 其他资料

- [贡献指南](../../CONTRIBUTING.md)
- [License](../../LICENSE)
