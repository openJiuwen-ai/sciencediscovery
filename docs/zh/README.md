# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## 快速开始

- [安装与部署](getting-started/deployment.md) — 按 Windows、macOS 或 Linux 的最短路径安装，包含长期运行与首次启动排障。
- [端到端体验案例](getting-started/quick-start.md) — 从一份样例数据到可追溯的结论：统计分析、外部证据、Reviewer 复核、结果追溯，并把流程沉淀成自己的 Skill。

这一节只有这两篇：先安装，再跟着案例把完整流程走一遍。

## 核心能力

- [核心能力总览](core/README.md) — ScienceDiscovery 在通用 Agent 基础上增加的科研能力地图。

## 领域指南

- [使用PUCT优化一个文本压缩算法](domains/evolve-a-solution.md) — 完整跑一次程序演进搜索，并判断改进是不是真的。
- [在 Ascend NPU 上设计抗体](domains/antibody-design.md) — 使用 RFdiffusion、ProteinMPNN 和 Protenix 完成一次可追溯的抗体设计与筛选。
- [分析脓毒症分型评分的相关性与聚类](domains/analyze-sepsis-endotypes.md) — 使用 BiomniBench 真实数据，从上传 CSV 到分析、交付和质量评价。
- [调研鸟类迁徙如何定位与导航](domains/literature-research.md) — 以 DRB-59 为例，配置检索资源、综合文献证据并检查报告。
- [用 Idea Tree 探索水处理催化剂](domains/idea-tree-catalyst-design.md) — 提出并比较催化剂设计，选择下一步验证方向。
- [用 Agent Team 分析免疫特征](domains/agent-team-data-analysis.md) — 以多角色协作完成相关性分析、聚类、复核和报告。

## 进阶设置

- [创建与使用自定义 Specialist](advanced-setup/configure-specialists.md)
- [导入与管理科研 Skill](advanced-setup/configure-skills.md)
- [配置自定义 MCP](advanced-setup/configure-custom-mcp.md)

## Reference（参考）

- [Agent 后端](reference/agent-backends.md) — JiuwenSwarm 默认行为、native 切换、工具、规划、技能和子代理。
- [CLI](reference/cli.md) — `serve`、`run`、`evolve`、`idea`、`extract`、`version` 的命令与行为。
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
