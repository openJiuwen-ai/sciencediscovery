# CLI 参考

本文记录 ScienceDiscovery 单文件启动器与本地源码模式的命令行行为。部署步骤见[部署指南](../getting-started/deployment.md)。

## 命令

```text
ScienceDiscovery serve [选项]        启动 Web UI、控制 API 与沙箱 runner
ScienceDiscovery run [输入] [选项]    作为命令行客户端连接一个已运行的 serve，执行 Agent 任务
ScienceDiscovery extract --to <目录>  只解包内嵌运行时，不启动
ScienceDiscovery version             打印版本及内置 Node / CPython / micromamba 版本
ScienceDiscovery help                显示帮助
```

本地源码模式没有 `ScienceDiscovery` 单文件。对应的 CLI 客户端入口是：

```bash
node services/launcher/dist/main.js run ...
```

## `serve`

常用选项：

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `--data-dir <路径>` | `./.sciencediscovery-data` | 运行时数据目录 |
| `--host <地址>` | `127.0.0.1` | Web UI / API 绑定地址 |
| `--port <端口>` | `4310` | Web UI / API 端口 |
| `--runner-port <端口>` | `4311` | Runner 端口，仅回环 |
| `--env-file <路径>` | — | 启动前读取 `KEY=VALUE`；已存在的环境变量优先 |
| `--bwrap <路径>` | PATH 中的 `bwrap` | Bubblewrap 可执行文件 |
| `--skip-sandbox-check` | 关 | 缺少 Bubblewrap 时仍启动 UI；沙箱执行不可用 |
| `--no-scientific-envs` | 关 | 不初始化托管科学环境 |
| `--jiuwenswarm` | 开 | 使用 JiuwenSwarm；该行为当前已是默认值 |
| `--no-jiuwenswarm` | 关 | 使用原生 Agent loop；等价于 `SCIENCE_AGENT_EXECUTOR=native` |

完整环境变量、端口与存储布局见[配置参考](configuration.md)。

API 与 Runner 默认只监听回环。确需对外暴露 API 时，应先更换 `SCIENCE_AGENT_AUTH_TOKEN`，并只在受保护网络中显式设置 `--host 0.0.0.0`。

## `run`

`run` 是已运行 `serve` 的命令行前端。它适合直接从终端执行任务，或把任务接入脚本和管道。

先启动服务：

```bash
./ScienceDiscovery serve
```

再在另一个终端运行：

```bash
./ScienceDiscovery run "分析当前工作区里的 CSV，并生成报告"
```

默认连接 `http://127.0.0.1:4310`，并从与 `serve` 相同的 `--data-dir` 中读取认证令牌。只要两者使用同一个数据目录，通常无需显式传 token。

Agent 生成的文件位于：

```text
<data-dir>/projects/<project-id>/sessions/<session-id>/workspace/
```

它们不写入当前 shell 工作目录。

### 交互模式

直接在终端运行时默认使用 text 模式：

- 最终答案写 stdout；
- 进度写 stderr；
- 权限请求以交互选择呈现。

### 非交互模式

通过管道或脚本运行时默认使用 JSONL 输出。非交互环境无法回答权限卡片，因此必须显式使用相应的自动批准选项，否则任务会拒绝启动。

精确选项以当前版本的：

```bash
./ScienceDiscovery run --help
```

为准。

### 本地源码模式

本地源码模式通过：

```bash
node services/launcher/dist/main.js run ...
```

连接由 `start-stack.sh` 启动的服务，地址与数据目录规则与单文件模式相同。

### Docker

容器内不需要运行 `run`。若希望从宿主 CLI 连接 Docker 中的服务，可让客户端指向相同发布端口，并使用 Docker bind mount 对应的数据目录或显式 token。

## `extract`

```bash
./ScienceDiscovery extract --to <目录>
```

只解包单文件中内嵌的运行时，不启动任何服务。该命令主要用于调试、检查发行包或提前准备运行环境。

## `version`

```bash
./ScienceDiscovery version
```

用于查看 ScienceDiscovery 构建版本以及随包运行时版本。构建标识的生成规则见[二进制打包与发行](../developer-docs/binary-packaging.md)。
