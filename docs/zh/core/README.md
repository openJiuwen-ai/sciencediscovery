# ScienceDiscovery 核心能力

Core 不负责解释 Agent 的基础概念，而是回答一个问题：

> 在通用 Agent 能力之上，ScienceDiscovery 为科研任务增加了哪些特殊能力？

如果你第一次接触 Agent，建议先阅读[基本概念](../getting-started/concepts.md)，了解 Agent Loop、Tool、Skill、Specialist、Workspace 和 Artifact。

ScienceDiscovery 的核心差异化能力可以分成三个方向：

## 1. 探索与优化：让研究过程可以搜索和迭代

### [Idea Tree 自主研究](idea-tree.md)

面对开放问题时，ScienceDiscovery 不只生成一个答案，而是可以展开多个候选方向、设计方案并根据反馈继续探索。

### [科研产物的 RSI](evolve.md)

针对已有可评价产物，通过候选生成、评价和选择进行多轮改进。

Idea Tree 关注：

> 下一步应该探索什么？

RSI 关注：

> 当前方案如何变得更好？

---

## 2. 可信科研：让结果可以追溯和检查

### [记忆图谱与 Reviewer](science-memory-reviewer.md)

科研结果不仅需要生成，还需要回答：

- 这个结论来自哪里？
- 哪些证据支持它？
- 哪些地方需要进一步检查？

ScienceMemory 记录研究过程中的关系，Reviewer 帮助发现产物中的问题。

---

## 3. 支撑科研 Agent 的基础能力

理解 Agent 基础概念后，以下能力帮助 ScienceDiscovery 将研究过程真正执行起来：

### [科研执行环境与工作区](execution-workspaces.md)

提供代码运行、文件管理和实验环境，使研究过程可以实际执行。

### [科研 MCP 与 Skill](mcp-skills.md)

MCP 连接外部工具和数据，Skill 提供可复用研究方法。

### [专业 Specialist](specialists.md)

将职责、方法和工具组合成可复用的研究角色。

这些能力回答的是：

> Agent 如何完成科研任务。

而 Idea Tree、RSI、ScienceMemory 和 Reviewer 回答的是：

> 为什么 ScienceDiscovery 更适合科研场景。

## 从哪里开始

- 想理解完整科研流程：[领域指南](../domains/literature-research.md)
- 想扩展能力：[进阶设置](../advanced-setup/)
- 想了解实现：[开发者文档](../developer-docs/)
