# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## 快速开始

- [快速开始](getting-started/quick-start.md) — 安装预编译二进制、启动服务、配置模型，并完成第一次
  Agent 任务。
- [部署](getting-started/deployment.md) — 预编译二进制不适合你的主机或工作流时，用其他方式安装与运行：源码构建的单文件二进制、本地源码模式，或 Docker。

## 核心能力

ScienceDiscovery 的核心能力可以从三层理解：

**研究执行**
- [科研 Agent](core/research-agent.md) — 从研究目标出发，调用工具、方法与专业角色，并把结果组织成可检查的研究过程。
- [科研产物](core/artifacts.md) — 将报告、代码、表格和图像登记为可查看、版本化和继续使用的交付物。
- [科研执行环境与工作区](core/execution-workspaces.md) — 在隔离环境中运行 Python、R 与 Shell，并保存研究文件。
- [科研 MCP 与 Skill](core/mcp-skills.md) — MCP 提供工具和数据接口，Skill 提供可复用的研究方法。
- [专业 Specialist](core/specialists.md) — 将职责、Skill 和工具范围组织成可复用的专业角色。

**探索与优化**
- [Idea Tree 自主研究](core/idea-tree.md) — 展开候选方向、设计方案并根据反馈继续探索。
- [科研产物的 RSI](core/evolve.md) — 通过候选搜索与留出评价，逐步改进可评价的产物。

**可信与复核**
- [记忆图谱与 Reviewer](core/science-memory-reviewer.md) — 连接任务、证据与结论，发现值得复核的问题。

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
