<div align="center">

# ScienceDiscovery

**专为科研打造的一站式 AI 科研工作台。**

文献阅读、假设提出、代码编写、实验试错、参数调优 —— 在同一个环境里完成，每一步都留痕。

[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/badge/Release-0.2.0-1f6feb?style=flat-square)](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/0.2.0)
[![Platform](https://img.shields.io/badge/Platform-Linux%20binary%20%7C%20macOS%20source-6e7781?style=flat-square)](#环境要求)
[![Docs](https://img.shields.io/badge/Docs-EN%20%7C%20ZH-6e7781?style=flat-square)](https://sciencediscovery.github.io/zh/docs/)

[下载](#安装) · [快速开始](https://sciencediscovery.github.io/zh/docs/getting-started/quick-start.html) · [文档](https://sciencediscovery.github.io/zh/docs/) · [贡献指南](CONTRIBUTING.md) · [English](README.md)

<img src="docs/images/task_zh.gif" width="920" alt="ScienceDiscovery 工作区：项目与会话导航、输入框，以及产物、审阅与溯源面板" />

</div>

## 简介

ScienceDiscovery 是一个基于 [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm)
构建、在本地运行的科研工作台：智能体阅读文献、在沙箱中编写并运行代码，并记录每一项结果的
来源。全部过程在你自己的机器上执行，处理你自己的文件，使用你自己的模型密钥。

## 安装

预打包二进制是完成首次运行的最短路径。请在
[Releases 页面](https://github.com/openJiuwen-ai/sciencediscovery/releases)下载与架构匹配的
`ScienceDiscovery-<version>-linux-x86_64`（x86_64）或
`ScienceDiscovery-<version>-linux-aarch64`（arm64）。
将下载的文件重命名为 `ScienceDiscovery` 后，执行：

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

打开 `serve` 输出的 **`Open to sign in`** 链接，浏览器将自动保存本地服务访问令牌，无需手动复制。该令牌不同于模型 API Key；此链接可访问本机工作区，请勿外传。Web 界面位于 <http://127.0.0.1:4310>，终端窗口仅运行服务进程。

运行预打包二进制时，唯一需要自行安装的依赖是 Bubblewrap。[部署指南](https://sciencediscovery.github.io/zh/docs/getting-started/deployment.html)
说明如何从源码构建便携二进制、以本地源码模式进行开发，以及使用 Docker 完成高级容器运维。
其中的[二进制与本地模式首次启动排障](https://sciencediscovery.github.io/zh/docs/getting-started/deployment.html#二进制与本地模式的首次启动排障)
可处理常见问题。所有部署方式默认使用 JiuwenSwarm 后端；部署指南说明各方式的具体操作。

## 配置模型

ScienceDiscovery 不内置模型，需接入你自己的 API。打开左侧栏底部的**系统设置**，再进入
**模型注册表**。选择预置服务商或手动添加服务商，填写服务商信息和 API Key 后点击**保存并连接**。
该操作会登记服务商的模型并测试第一个模型的连通性；如果这是系统中的第一个模型，它也会自动成为
默认任务模型。已有模型时，请在模型注册表顶部的**全局默认任务模型**中选择。

各字段的含义，以及可改用环境变量配置的项，参见[配置参考](https://sciencediscovery.github.io/zh/docs/reference/configuration.html)。

## 第一个任务

新建 Project 与 Session，将 CSV 或 PDF 拖入工作区，并描述分析目标。首次执行代码前会出现权限卡片，
批准后可在时间线查看工具调用与结果；任务登记为**产物**的生成文件可在工作区的**产物**区查看。
完整步骤参见[快速开始](https://sciencediscovery.github.io/zh/docs/getting-started/quick-start.html)。

## 核心能力

| 能力 | 说明 | 参考 |
|---|---|---|
| **文献与数据接入** | 内置连接器直达文献库与数据库；PDF 被解析为可引用的证据 | [文献调研](https://sciencediscovery.github.io/zh/docs/domains/literature-research.html) · [自定义 MCP](https://sciencediscovery.github.io/zh/docs/advanced-setup/configure-custom-mcp.html) |
| **沙箱内代码执行** | 智能体在 fail-closed 沙箱中编写、调试并运行 Python、R 与 Shell | [沙箱执行](https://sciencediscovery.github.io/zh/docs/developer-docs/sandbox-execution.html) |
| **复杂任务拆解** | 任务规划与多智能体协同将任务分发给子智能体和跨领域 Skill 库 | [子智能体编排](https://sciencediscovery.github.io/zh/docs/developer-docs/subagent-orchestration.html) · [Skill](https://sciencediscovery.github.io/zh/docs/developer-docs/skill-progressive-disclosure.html) |
| **全链路溯源** | 代码、环境、日志与引用证据按产物记录；开启记忆图谱后整条链路可点击追溯 | [审阅与溯源](https://sciencediscovery.github.io/zh/docs/developer-docs/review-provenance.html) · [ScienceMemory](https://sciencediscovery.github.io/zh/docs/advanced-setup/science-memory-setup.html) |

## 命令行

已启动的 `serve` 同样可以从终端驱动：

```bash
./ScienceDiscovery run "总结这些结果" > answer.md
cat prompt.txt | ./ScienceDiscovery run --stdin --auto-approve | jq .
```

`run` 连接与浏览器相同的控制面，并从数据目录读取访问令牌，因此只要与 `serve` 共用 `--data-dir` 即无需额外配置。在终端中直接运行时，答案输出到 stdout、进度输出到 stderr；在管道中则输出 JSONL，且非交互运行必须显式传入 `--auto-approve`，因为此时无法响应权限询问。完整选项参见 `./ScienceDiscovery run --help`。

## 环境要求

| 路径 | 运行环境要求 |
|---|---|
| **预打包二进制** | Linux x86_64/aarch64、Bubblewrap |
| **本地源码模式** | Linux x86_64/aarch64 或 macOS x64/arm64；Node.js 22.19+、pnpm 11.1.2、Python 3、uv 0.9+、Git；Linux 用 Bubblewrap，macOS 用系统内置 Seatbelt |
| **Docker** | Linux x86_64/aarch64、Docker Engine 24+、Compose v2、可用的无特权用户命名空间 |

托管科学环境基于固定版本的 micromamba 运行，无需在系统中安装 Python、R 或 conda。

## 架构概览

ScienceDiscovery 基于 [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) 构建。所有部署
方式中，浏览器 UI 都通过对外适配器访问服务，适配器将 Node 控制 API 反向代理在其后。JiuwenSwarm
负责模型循环，并通过回调进入 API 执行 ScienceDiscovery 工具调用；工作区工具、沙箱执行、科研
连接器、PDF 抽取、权限、溯源与审阅校验仍由 Node 控制面统一管控。[部署指南](https://sciencediscovery.github.io/zh/docs/getting-started/deployment.html)
说明各部署方式的具体拓扑。

> [!WARNING]
> ScienceDiscovery 不是多用户生产服务。适配器与 API 默认只监听回环；访问使用一个 bearer token，且不终止 TLS。监听其他网卡必须是可信、受保护网络中的显式部署选择。Python、R 和 shell 命令在 fail-closed 的平台沙箱中运行（Linux 使用 Bubblewrap，macOS 源码模式使用 Seatbelt）；控制 API、适配器、JiuwenSwarm、PDF worker 以及发往已配置模型/数据提供方的请求在沙箱外作为受信任控制面操作执行。

## 文档

| 分类 | 文档 |
|---|---|
| **快速开始** | [快速开始](https://sciencediscovery.github.io/zh/docs/getting-started/quick-start.html) · [部署](https://sciencediscovery.github.io/zh/docs/getting-started/deployment.html) |
| **进阶设置** | [自定义 MCP](https://sciencediscovery.github.io/zh/docs/advanced-setup/configure-custom-mcp.html) · [网络代理](https://sciencediscovery.github.io/zh/docs/advanced-setup/configure-network-proxy.html) · [ScienceMemory](https://sciencediscovery.github.io/zh/docs/advanced-setup/science-memory-setup.html) |
| **参考** | [配置](https://sciencediscovery.github.io/zh/docs/reference/configuration.html) · [REST API](https://sciencediscovery.github.io/zh/docs/reference/rest-api.html) · [内置工具](https://sciencediscovery.github.io/zh/docs/reference/builtin-tools.html) · [运行时行为](https://sciencediscovery.github.io/zh/docs/reference/runtime-behavior.html) |
| **开发者文档** | [整体架构](https://sciencediscovery.github.io/zh/docs/developer-docs/architecture.html) 及[开发者文档导航](https://sciencediscovery.github.io/zh/docs/developer-docs/) |

完整中文导航参见[文档站](https://sciencediscovery.github.io/zh/docs/)；开发环境与测试命令参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 加入社区

欢迎加入 ScienceDiscovery 微信交流群，与社区交流使用体验。

<img src="docs/images/wechat.jpg" alt="ScienceDiscovery 微信交流群二维码" width="320">

## 许可证

[Apache License 2.0](LICENSE)。

本产品仅作为流程编排工具，不包含 AI 模型能力；用户在连接 AI 模型用于特定业务场景时，需自行承担欧盟 AI 法案等相关合规义务。
