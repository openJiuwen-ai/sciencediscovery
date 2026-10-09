# 基本概念：ScienceDiscovery 如何完成一次科研任务

在开始使用 ScienceDiscovery 前，先理解几个基本概念。后续的核心能力章节会介绍 ScienceDiscovery 在普通 Agent 基础上增加的科研能力。

## 一次任务如何运行

ScienceDiscovery 的基本流程可以理解为：

```text
研究问题
   ↓
Research Agent
   ↓
理解目标、规划步骤、选择能力
   ↓
调用工具、执行代码、协作角色
   ↓
生成科研产物 Artifact
   ↓
检查、复用和继续研究
```

Agent 不只是生成文字，而是在目标驱动下完成一系列行动：理解问题、选择方法、调用工具、执行分析，并交付结果。

## Agent Loop

一次典型 Agent 运行包括：

1. 理解用户目标和当前上下文；
2. 判断下一步需要的信息或操作；
3. 调用工具、执行代码或请求其他角色协助；
4. 根据执行结果调整下一步；
5. 最终生成回答和研究产物。

实际执行过程可以通过任务时间线查看。

## Agent 可以使用哪些能力

ScienceDiscovery 中有三类容易混淆的扩展概念：

| 概念 | 作用 | 简单理解 |
| --- | --- | --- |
| MCP | 提供外部工具和数据接口 | Agent 的工具 |
| Skill | 提供可复用的方法和流程 | Agent 的方法 |
| Specialist | 提供特定职责和角色分工 | Agent 的角色 |

例如：

- MCP 可以让 Agent 查询论文数据库；
- Skill 可以指导 Agent 如何完成文献综述；
- Specialist 可以定义一个负责文献研究的专业角色。

## Workspace、Artifact 与研究交付

Agent 在执行过程中会产生文件，但文件有不同状态。

```text
Workspace
  ├── 上传数据
  ├── 临时代码
  ├── 中间结果
  ↓
Artifact
  ├── 报告
  ├── 代码
  ├── 数据表
  └── 图像
```

可以简单理解为：

> Workspace 是工作台，Artifact 是正式交付物。

不是所有文件都需要成为 Artifact。值得查看、下载、复用或继续研究的结果，才应该作为产物交付。

## 执行环境

Agent 需要一个地方执行实际工作。

ScienceDiscovery 提供科研执行环境，让 Agent 可以：

- 运行 Python、R 和 Shell；
- 处理数据；
- 保存脚本和结果；
- 在受控环境中完成计算。

执行环境决定“在哪里做”，Artifact 决定“留下什么结果”。

## 从基础概念到科研能力

理解这些基础概念后，可以继续阅读 Core：

- [核心能力](../core/README.md)：ScienceDiscovery 为什么适合科研场景。
- [领域指南](../domains/literature-research.md)：通过真实任务理解完整流程。
