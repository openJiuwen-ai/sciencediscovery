# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## 快速开始

- [快速开始](getting-started/quick-start.md) — 按 Linux 或 macOS 的最短路径启动服务、配置模型，并完成第一次可检查的 Agent 任务。
- [基本概念](getting-started/concepts.md) — 了解 Agent Loop、Tool、Skill、Specialist、Workspace 和 Artifact 等基础概念。
- [部署](getting-started/deployment.md) — 选择预编译单文件、本地源码模式或 Docker，包含长期运行与首次启动排障。

## 核心能力

- [核心能力总览](core/README.md) — ScienceDiscovery 在通用 Agent 基础上增加的科研能力地图。

## 领域指南

- [使用PUCT优化一个文本压缩算法](domains/evolve-a-solution.md) — 完整跑一次程序演进搜索，并判断改进是不是真的。
- [在 Ascend NPU 上设计抗体](domains/antibody-design.md) — 使用 RFdiffusion、ProteinMPNN 和 Protenix 完成一次可追溯的抗体设计与筛选。
- [分析脓毒症分型评分的相关性与聚类](domains/analyze-sepsis-endotypes.md) — 使用 BiomniBench 真实数据，从上传 CSV 到分析、交付和质量评价。
- [调研鸟类迁徙如何定位与导航](domains/literature-research.md) — 以 DRB-59 为例，配置检索资源、综合文献证据并检查报告。

## 进阶设置

- [创建与使用自定义 Specialist](advanced-setup/configure-specialists.md)
- [导入与管理科研 Skill](advanced-setup/configure-skills.md)
- [配置自定义 MCP](advanced-setup/configure-custom-mcp.md)

## Reference（参考）

- [CLI](reference/cli.md) — `serve`、`run`、`extract`、`version` 的命令与行为。
- [执行与工作区](reference/execution-workspaces.md)
- [预置科研能力](reference/builtin-research-capabilities.md)
- [配置、端口与存储](reference/configuration.md)
- [REST API](reference/rest-api.md)
- [运行时行为](reference/runtime-behavior.md)

## 开发者文档

见[开发者文档导航](developer-docs/README.md)，其中包括架构、模块边界、协议和当前有效的特性设计。

## 其他资料

- [贡献指南](../../CONTRIBUTING.md)
- [License](../../LICENSE)
