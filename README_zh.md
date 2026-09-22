<div align="center">

# ScienceDiscovery

**专为科研打造的一站式 AI 科研工作台。**

文献阅读、假设提出、代码编写、实验试错、参数调优 —— 在同一个环境里完成，每一步都留痕。

[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/badge/Release-0.2.0-1f6feb?style=flat-square)](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/0.2.0)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS-6e7781?style=flat-square)](#环境要求)
[![Docs](https://img.shields.io/badge/Docs-EN%20%7C%20ZH-6e7781?style=flat-square)](docs/README.md)

[下载](#安装) · [快速开始](docs/zh/tutorial/01-quick-start.md) · [文档](docs/README.md) · [贡献指南](CONTRIBUTING.md) · [English](README.md)

<img src="docs/images/task_zh.gif" width="920" alt="ScienceDiscovery 工作区：项目与会话导航、输入框，以及产物、审阅与溯源面板" />

</div>

## 简介

ScienceDiscovery 是一个本地运行的科研工作台：智能体阅读文献、在沙箱中编写并运行代码，并记录每一项结果的来源。全部过程在你自己的机器上执行，处理你自己的文件，使用你自己的模型密钥。

## 安装

从 [release 0.2.0](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/0.2.0) 下载与宿主架构匹配的构建：

```bash
curl -LO https://github.com/openJiuwen-ai/sciencediscovery/releases/download/0.2.0/ScienceDiscovery-0.2.0-linux-x86_64
chmod +x ScienceDiscovery-0.2.0-linux-x86_64
./ScienceDiscovery-0.2.0-linux-x86_64 serve
```

打开 `serve` 输出的 **`Open to sign in`** 链接，浏览器将自动保存本地服务访问令牌，无需手动复制。该令牌不同于模型 API Key；此链接可访问本机工作区，请勿外传。Web 界面位于 <http://127.0.0.1:4310>，终端窗口仅运行服务进程。

arm64 请使用 [`ScienceDiscovery-0.2.0-linux-aarch64`](https://github.com/openJiuwen-ai/sciencediscovery/releases/download/0.2.0/ScienceDiscovery-0.2.0-linux-aarch64)。宿主唯一依赖是 Bubblewrap。本地源码模式（Linux 与 macOS）和 Docker 参见[部署指南](docs/zh/how-to/deployment.md)；智能体后端 [JiuwenSwarm](docs/zh/how-to/run-with-jiuwenswarm.md) 也是在本地源码模式下运行。

## 配置模型

ScienceDiscovery 不内置模型，需接入你自己的 API。打开左侧栏底部的**系统配置**，完成两处配置：

1. **模型注册表** —— 选择预置服务商或手动填写**基础 URL**，填入 **API Key**，然后添加需要使用的模型。
2. **全局默认值** —— 将上一步添加的模型设为**任务模型**。

各字段的含义，以及可改用环境变量配置的项，参见[配置参考](docs/zh/reference/configuration.md)。

## 第一个任务

新建 Project 与 Session，将 CSV 或 PDF 拖入工作区，并描述分析目标。首次执行代码前会出现权限卡片，批准后即可在时间线中查看工具调用与产物。完整步骤参见[快速开始](docs/zh/tutorial/01-quick-start.md)。

## 核心能力

| 能力 | 说明 | 参考 |
|---|---|---|
| **文献与数据接入** | 内置连接器直达文献库与数据库；PDF 被解析为可引用的证据 | [文献调研案例](docs/zh/how-to/literature-research-case-guide.md) · [自定义 MCP](docs/zh/how-to/configure-custom-mcp.md) |
| **沙箱内代码执行** | 智能体在 fail-closed 沙箱中编写、调试并运行 Python、R 与 Shell | [沙箱执行](docs/zh/explanation/sandbox-execution.md) |
| **复杂任务拆解** | 任务规划与多智能体协同将任务分发给子智能体和跨领域 Skill 库 | [子智能体编排](docs/zh/explanation/subagent-orchestration.md) · [Skill](docs/zh/explanation/skill-progressive-disclosure.md) |
| **全链路溯源** | 代码、环境、日志与引用证据按产物记录；开启记忆图谱后整条链路可点击追溯 | [审阅与溯源](docs/zh/explanation/review-provenance.md) · [ScienceMemory](docs/zh/how-to/science-memory-setup.md) |

## 命令行

已启动的 `serve` 同样可以从终端驱动：

```bash
./ScienceDiscovery run "总结这些结果" > answer.md
cat prompt.txt | ./ScienceDiscovery run --stdin --auto-approve | jq .
```

`run` 连接与浏览器相同的控制面，并从数据目录读取访问令牌，因此只要与 `serve` 共用 `--data-dir` 即无需额外配置。在终端中直接运行时，答案输出到 stdout、进度输出到 stderr；在管道中则输出 JSONL，且非交互运行必须显式传入 `--auto-approve`，因为此时无法响应权限询问。完整选项参见 `./ScienceDiscovery run --help`。

## 环境要求

| 路径 | 宿主要求 |
|---|---|
| **预打包二进制** | Linux x86_64/aarch64、Bubblewrap |
| **本地源码模式** | Linux x86_64/aarch64 或 macOS x64/arm64；Node.js 22.19+、pnpm 11.1.2、Python 3、uv 0.9+、Git；Linux 用 Bubblewrap，macOS 用系统内置 Seatbelt |
| **Docker** | Linux x86_64/aarch64、Docker Engine 24+、Compose v2、可用的无特权用户命名空间 |

托管科学环境基于固定版本的 micromamba 运行，无需在系统中安装 Python、R 或 conda。

## 架构概览

浏览器 UI 连接的是一个适配器，由它把智能体循环放到 [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) 上运行：适配器占据对外端口，把 Node 控制 API 反向代理在它身后，JiuwenSwarm 负责模型循环并通过回调进入 API 执行每一次工具调用；工作区工具、沙箱执行、科研连接器、PDF 抽取、权限、溯源与审阅校验仍由 Node 控制面统一管控。安装步骤、环境变量与完整拓扑图见[在 JiuwenSwarm 上运行智能体](docs/zh/how-to/run-with-jiuwenswarm.md)。

> [!WARNING]
> ScienceDiscovery 不是多用户生产服务。适配器与 API 默认只监听回环；访问使用一个 bearer token，且不终止 TLS。监听其他网卡必须是可信、受保护网络中的显式部署选择。Python、R 和 shell 命令在 fail-closed 的平台沙箱中运行（Linux 使用 Bubblewrap，macOS 源码模式使用 Seatbelt）；控制 API、适配器、JiuwenSwarm、PDF worker 以及发往已配置模型/数据提供方的请求在沙箱外作为受信任控制面操作执行。

## 文档

| 分类 | 文档 |
|---|---|
| **教程** | [快速开始](docs/zh/tutorial/01-quick-start.md) |
| **How-to** | [部署](docs/zh/how-to/deployment.md) · [在 JiuwenSwarm 上运行](docs/zh/how-to/run-with-jiuwenswarm.md) · [自定义 MCP](docs/zh/how-to/configure-custom-mcp.md) · [网络代理](docs/zh/how-to/configure-network-proxy.md) · [ScienceMemory](docs/zh/how-to/science-memory-setup.md) |
| **参考** | [配置](docs/zh/reference/configuration.md) · [REST API](docs/zh/reference/rest-api.md) · [内置工具](docs/zh/reference/builtin-tools.md) · [运行时行为](docs/zh/reference/runtime-behavior.md) |
| **解释** | [整体架构](docs/zh/explanation/architecture.md) 及[完整索引](docs/zh/explanation/README.md) |

完整中英文导航参见 [docs/README.md](docs/README.md)；开发环境与测试命令参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[Apache License 2.0](LICENSE)。

本产品仅作为流程编排工具，不包含 AI 模型能力；用户在连接 AI 模型用于特定业务场景时，需自行承担欧盟 AI 法案等相关合规义务。
