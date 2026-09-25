# 深度开发指南

本文面向需要修改 ScienceDiscovery 代码的开发者和 Code Agent，提供理解仓库的入口。

## 阅读顺序

如果第一次进入仓库，建议按以下顺序理解：

1. [整体运行时架构](architecture.md)
   - 了解 API、Runner、Web、工具和执行环境的边界。

2. [Agent 后端](agent-backend.md)
   - 了解 Agent loop、模型调用、工具调度和上下文处理。

3. [控制面](control-plane.md)
   - 了解 Session、Project、权限、存储和生命周期。

4. [Runtime Core 边界](runtime-core.md)
   - 了解领域无关的运行时能力。

5. [组件与插件机制](plugins.md)
   - 了解新增能力应该放在哪里。

## 核心设计原则

### API 是 Agent 控制面

当前架构中，Agent loop 位于 `services/api` 内。API 负责：

- 模型调用；
- 工具调度；
- MCP 客户端；
- 权限与溯源；
- Session 生命周期。

Runner 负责隔离执行，不承载 Agent 业务语义。

### services 负责装配，packages 负责能力

新增能力时：

- 通用能力优先进入 `packages/`；
- 服务入口和生命周期管理进入 `services/`；
- UI 展示进入 `apps/web`。

避免在多个层重复实现同一能力。

## 给 Code Agent 的关键信息

修改代码前优先确认：

- 当前模块的 owner；
- 数据流入口；
- 对外接口；
- 相关测试位置。

不要仅根据文件名判断职责，很多历史目录仍然存在兼容代码。

## 历史设计文档

以下文档记录过往阶段设计，不应作为当前实现依据：

- MVP/M1/M2 阶段设计记录；
- 已废弃架构方案；
- 迁移过程记录。

当前行为以架构文档、代码和测试为准。