# 概念：ScienceDiscovery 如何完成科研任务

在使用 ScienceDiscovery 之前，需要理解几个基础概念。核心能力章节会进一步介绍构建在通用 Agent 系统之上的科研专用能力。

## 任务如何运行

一个 ScienceDiscovery 任务可以抽象为：

```text
科研问题
      ↓
科研 Agent
      ↓
理解目标、规划步骤、选择能力
      ↓
调用工具、执行代码、协作角色
      ↓
生成科研 Artifact
      ↓
审查、复用并继续研究
```

Agent 不只是生成文本。它通过理解问题、选择方法、执行操作并交付结果来完成目标。

## Agent 循环

一次典型的 Agent 运行包括：

1. 理解目标和当前上下文；
2. 判断下一步需要的信息或操作；
3. 调用工具、执行代码或请求其他角色协助；
4. 根据执行结果调整方案；
5. 输出答案和科研 Artifact。

执行时间线展示了任务实际发生的过程。

## Agent 可以使用哪些能力？

以下三个扩展概念容易混淆：

| 概念 | 作用 | 简单理解 |
| --- | --- | --- |
| MCP | 提供外部工具和数据接口 | Agent 工具 |
| Skill | 提供可复用的方法和工作流 | Agent 方法 |
| Specialist | 提供专门职责和角色 | Agent 角色 |

例如：

- MCP 可以让 Agent 查询文献数据库；
- Skill 可以指导文献调研流程；
- Specialist 可以定义专门的科研角色。

## Workspace、Artifact 与科研交付

科研过程中产生的文件具有不同用途。

```text
Workspace
  ├── 上传数据
  ├── 临时代码
  ├── 中间结果
  ↓
Artifact
  ├── 报告
  ├── 代码
  ├── 表格
  └── 图片
```

一个简单理解：

> Workspace 是工作台；Artifact 是最终交付物。

并非所有文件都需要成为 Artifact。值得查看、下载、复用或继续研究的结果，应作为 Artifact 交付。

## 执行环境

Agent 需要一个执行真实工作的环境。

ScienceDiscovery 提供科研执行环境，使 Agent 可以：

- 运行 Python、R 和 Shell；
- 分析数据；
- 保存脚本和结果；
- 在受控环境中执行计算。

执行环境决定工作在哪里发生；Artifact 决定最终留下什么结果。

## 从基础概念到科研能力

理解这些基础概念后，可以继续阅读：

- [核心能力](../core/README.md)：了解 ScienceDiscovery 如何面向科研工作流设计。
- [领域指南](../domains/literature-research.md)：通过真实任务了解完整工作流程。
