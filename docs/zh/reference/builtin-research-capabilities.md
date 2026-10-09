# 预置科研能力参考

本文集中记录当前版本随产品提供的科研连接器、Skill 和 Specialist。它们会随版本演进；概念和使用方式见[核心能力](../README.md#核心能力)。

## 预置科研连接器

| 研究需求 | 预置来源 | 典型用途 |
| --- | --- | --- |
| 论文与预印本 | PubMed、Europe PMC、arXiv、bioRxiv、medRxiv | 检索研究、保留标识与来源链接 |
| 蛋白功能与结构 | UniProt、PDB | 查询注释、结构条目与结构文件 |
| 基因与变异 | Ensembl、ClinVar | 查询基因、转录本、变异和相关注释 |
| 通路与实验数据 | Reactome、GEO | 检索通路信息和公共表达研究 |
| 化合物与活性 | ChEMBL | 查询化合物、靶点与活性记录 |

在配置可用时，LLM Wiki 连接器还可以提供知识页面检索与读取。

预置接入不代表外部服务始终在线、所有内容都可免费下载，或返回记录等于已阅读全文。实际工具范围与连接状态以当前 Session 为准。

## 预置 Skill

| 工作方向 | Skill | 用途 |
| --- | --- | --- |
| 研究组织与证据简报 | `science-research-team`、`life-science-evidence-brief` | 组织文献与数据研究，形成可追溯摘要 |
| 检索、阅读与成文 | `literature-searcher`、`evidence-extractor`、`report-writer` | 从来源发现到证据提取和报告综合 |
| 计算与结果评价 | `code-engineer`、`result-evaluator` | 编写可复现分析并检查结果 |
| 引用与计算核查 | `citation-reviewer`、`computation-reviewer` | 检查引用支撑和数值一致性 |
| 材料方案探索 | `creative-material-design`、`assessment-screening`、`insight-aggregator` | 生成候选、分视角评价并汇总反馈 |
| 自主研究与产物改进 | `idea-tree-team`、`evolve-design` | 准备 Idea Tree 输入、设计和发起产物演进 |
| 结构与抗体工作流 | `structure-pocket-inspection`、`antibody-design` | 检查结构并组织抗体设计流程 |
| 方法沉淀 | `skill-creator` | 起草可审核的 Skill 包 |

Skill 是否安装或可用，不等于模型本次一定读取或执行。应以执行记录和最终产物为准。

## 预置 Specialist

| Specialist | 适合承担的工作 | 主要交付 |
| --- | --- | --- |
| `literature-searcher` | 检索学术来源、去重、记录覆盖缺口 | 来源清单与检索说明 |
| `evidence-extractor` | 提取发现、方法、统计量和局限 | 带来源定位的结构化证据 |
| `code-engineer` | 编写、执行和调试 Python/R 分析 | 脚本、结果和复现说明 |
| `result-evaluator` | 检查分析准确性、完整性和稳健性 | 修订建议和评价 |
| `report-writer` | 综合已有研究摘要和来源关系 | 最终报告 |
| `creative-material-design` | 提出材料候选方案 | 候选材料设计 |
| `assessment-screener` | 按指定视角评价材料候选 | 分维度评价和验证建议 |
| `insight-aggregator` | 比较多个评估结果 | 共识、分歧与改进洞察 |

预置角色名称不代表专业资格，也不意味着多个角色提供独立科学验证。

## 扩展入口

- [接入自定义 MCP](../advanced-setup/configure-custom-mcp.md)
- [导入与管理 Skill](../advanced-setup/configure-skills.md)
- [创建与使用自定义 Specialist](../advanced-setup/configure-specialists.md)
