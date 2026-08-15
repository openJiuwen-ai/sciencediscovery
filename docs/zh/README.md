# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## Tutorial（教程）

- [快速开始](tutorial/01-quick-start.md) — 安装、启动、配置模型并完成第一次 Agent 任务。

## How-to（操作指南）

- [部署](how-to/deployment.md) — 使用预先提供的二进制部署 ScienceDiscovery 的操作步骤。
- [配置网络代理](how-to/configure-network-proxy.md) — 在设置页添加代理并为 LLM、Web 和 MCP 选择策略。
- [文献调研案例指南](how-to/literature-research-case-guide.md) — 以一项跨数据库文献调研任务为例，演示从启动服务、配置系统到下发任务、审批与查看结果的全流程。

## Reference（参考）

- [配置、端口与存储](reference/configuration.md) — 环境变量、默认端口、上传/工作区/输出配额和数据布局。
- [REST API](reference/rest-api.md) — 当前 UI 使用的内部 HTTP 接口、认证、请求/响应与错误语义。
- [运行时行为](reference/runtime-behavior.md) — 模型、设置继承、技能、权限、超时和执行限制。
- [内置工具](reference/builtin-tools.md) — 模型可见工具的参数、边界和暴露条件。
- [Web 工具](reference/web-tools.md) — Web Search/Fetch provider、配置、权限、缓存与审计。
- [仓库布局](reference/repository-layout.md) — 目录、模块、默认端口和数据落点。
- [PDF worker](reference/paper-worker.md) — PDF 抽取协议、管线和限制。
- [Web 前端](reference/web-frontend.md) — 前端技术栈、事件映射、开发与测试入口。

## Explanation（解释）

见 [Explanation 导航](explanation/README.md)，其中包括整体架构、控制面、Agent 后端、沙箱、Ascend NPU 宿主 Broker、限流、连接器、MCP 工具协议、代理、溯源、科学记忆、技能披露、子 Agent 编排和内容寻址存储。

## 其他资料

- [贡献指南](../../CONTRIBUTING.md)
- [License](../../LICENSE)
