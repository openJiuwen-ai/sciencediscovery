# ScienceDiscovery

 ScienceDiscovery是专为科学研究打造的一站式AI科研工作台。依托该平台，科研人员能够一站式高效完成“文献阅读、假设提出、代码编写、实验试错、参数调优”这一极为繁琐的科研探索流程。

[English](README.md) | 中文

> [!WARNING]
> ScienceDiscovery 不是多用户生产服务。API、runner 与 gateway 默认只监听回环；API 使用一个 bearer token 且不终止 TLS。监听其他网卡必须是可信、受保护网络中的显式部署选择。Python、R 和 shell 命令在 fail-closed 的 bubblewrap 沙箱中运行；控制 API、gateway、PDF worker 以及发往已配置模型/数据提供方的请求在沙箱外作为受信任控制面操作执行。

## 项目定位

 ScienceDiscovery是专为科学研究打造的一站式AI科研工作台。依托该平台，科研人员能够一站式高效完成“文献阅读、假设提出、代码编写、实验试错、参数调优”这一极为繁琐的科研探索流程。

## 特性

- **海量资源一键配置与高效接入**：通过平台内置的科研数据库 Connector，实现文献库与数据库的一键快速配置，快速获取海量前沿文献与核心试验数据；
- **安全沙箱环境下的自主代码探索**：支持智能体在安全隔离的沙箱环境中自主编写、调试并运行 Python、R或Shell代码，为复杂科学数据处理提供稳定环境；
- **复杂科研任务的自动拆解与动态执行**：凭借强大的任务规划与多智能体协同能力，系统可自动拆解复杂科研任务，动态编排并调用300+跨领域 Skills ；
- **科研流程全链路可溯源**：平台将完整展现全流程工作流，并提供包含代码、环境和日志在内的全链路产物溯源，确保科研全流程的高可信度。

## 相关文档

- [文档导航](docs/README.md) — 完整的中英文 Tutorial / How-to / Reference / Explanation 入口。
- [贡献指南](CONTRIBUTING.md) — 本分支的文档与贡献说明。

## 环境要求

ScienceDiscovery 以预打包二进制分发，这是唯一的用户路径：拿到与宿主架构匹配的可执行文件，安装 bubblewrap，然后 `./ScienceDiscovery serve`。

| 路径 | 宿主要求 |
|---|---|
| 预打包二进制 | Linux x86_64/aarch64、bubblewrap |

托管科学环境使用应用固定版本的 micromamba，不要求系统安装 Python、R 或 conda。部署还要求 Linux 以及部署指南中说明的用户命名空间能力。

## 安装

准备与宿主架构匹配的 ScienceDiscovery 可执行文件，安装与运行步骤见[部署指南](docs/zh/how-to/deployment.md)。

## 快速开始

在 `ScienceDiscovery` 可执行文件所在目录启动服务：

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

另开终端执行 `curl -fsS http://127.0.0.1:4310/health`。随后打开 <http://127.0.0.1:4310>，使用服务端启动时打印的访问 token 登录，并在 **系统配置 → Global defaults** 配置任务模型。第一次任务见[快速开始教程](docs/zh/tutorial/01-quick-start.md)；完整部署见[部署指南](docs/zh/how-to/deployment.md)。

## 许可证

[Apache License 2.0](LICENSE)。

本产品仅作为流程编排工具，不包含 AI 模型能力；用户在连接 AI 模型用于特定业务场景时，需自行承担欧盟 AI 法案等相关合规义务。
