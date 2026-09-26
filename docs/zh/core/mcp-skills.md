# 科研 MCP 与 Skill：接通科研资源，复用研究方法

科研任务需要具体依据：一个蛋白的注释、一篇论文的实验条件、一份结构文件中的原子位置。只靠模型已有知识，很难保证这些信息及时、准确且可以回查。同时，同样的数据若缺少合适的分析步骤，也容易得到不可复现的结论。

ScienceDiscovery 一方面通过 MCP 接入科研数据与工具，另一方面通过 Skill 提供可复用的方法。前者帮助 Agent 取得实际记录，后者指导它如何检索、整理、计算和交付，让每次研究不必从空白开始。

可以用一句话区分三类扩展：**MCP 是工具，Skill 是方法，Specialist 是角色。** MCP 回答“Agent 能调用什么”，Skill 回答“这类工作应该怎么做”，Specialist 则把职责、Skill 和可用工具组织成一个可以被主 Agent 调用的专业角色。

## 产品已经提供哪些能力

ScienceDiscovery 预置了常见科研连接器和可组合的 Skill。例如，文献研究可以使用 PubMed、Europe PMC、arXiv 等来源，结构研究可以使用 UniProt、PDB；对应的 Skill 可以负责检索、证据提取、计算、报告撰写和结果核查。

这些预置项是帮助用户快速开始的默认能力，不是 Core 概念本身。完整且可能随版本变化的清单见[预置科研能力参考](../reference/builtin-research-capabilities.md)。

预置接入不代表外部服务永远在线、所有内容都能免费下载，或返回记录等于已读全文。安装了 Skill 也不等于模型本次已经读取或执行它；实际使用情况应以当前 Session 的工具范围、执行记录和产物为准。

![科研连接器](../../images/connector.png)

## 让实验室自己的资源加入工作流

你可以接入自建数据库、已有 MCP 服务或专用计算接口，也可以把常用 SOP、分析脚本和交付规范整理成 Skill。工具与方法独立扩展：更换数据接口不必重写全部流程，改进方法也不要求新增服务。

这些入口面向用户开放。自定义 MCP 支持本地 STDIO 和远程 HTTP/SSE 服务；技能支持本地文件、目录、ZIP 与 Git 导入，也支持由 Agent 起草后人工确认。凭据在设置中管理，不应写入公开的技能说明。

具体接入步骤放在进阶指南中：

- [接入自定义 MCP](../advanced-setup/configure-custom-mcp.md)：添加服务、认证、测试连接和选择工具。
- [导入与管理 Skill](../advanced-setup/configure-skills.md)：准备技能包、导入、确认生效并验证。
- [创建 Specialist](../advanced-setup/configure-specialists.md)：把资源与职责组织成自己的研究角色。
