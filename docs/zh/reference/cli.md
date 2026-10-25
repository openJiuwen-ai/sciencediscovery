# CLI 参考

本文记录 ScienceDiscovery 单文件启动器与本地源码模式的命令行行为。部署步骤见[部署指南](../getting-started/deployment.md)。

## 命令

```text
ScienceDiscovery serve [选项]        启动 Web UI、API、沙箱 runner 与默认的 JiuwenSwarm/adapter
ScienceDiscovery run [输入] [选项]    作为命令行客户端连接一个已运行的 serve，执行 Agent 任务
ScienceDiscovery evolve <动作> ...    列出、查看、跟踪或停止 evolve 搜索
ScienceDiscovery idea <动作> ...      列出、查看、跟踪、暂停、继续或停止 Idea Tree 研究
ScienceDiscovery extract --to <目录>  只解包内嵌运行时，不启动
ScienceDiscovery version             打印版本及内置 Node / CPython / micromamba 版本
ScienceDiscovery help                显示帮助
```

本地源码模式没有 `ScienceDiscovery` 单文件。对应的 CLI 客户端入口是：

```bash
node services/launcher/dist/main.js run ...
```

`evolve` 与 `idea` 使用同一个入口。

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

通过管道或脚本运行时默认使用 JSONL 输出。非交互环境无法回答权限卡片，因此必须传入 `--auto-approve`（或 `--approval always_allow`），否则任务会拒绝启动。自动批准作用于本次运行所在会话的工具操作；沙箱失效后直接在主机上执行仍须明确同意，因此请求这类执行的非交互运行会停下等待。

如果只想把答案写入文件，请显式选择 text 输出：

```bash
./ScienceDiscovery run --auto-approve --output text "用一段话解释 p 值能说明什么、不能说明什么" > answer.md
```

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

## `evolve` 与 `idea`

evolve 搜索（`/evolve-design`）和 Idea Tree 研究（`/idea-tree`）在发起它们的那一轮对话结束后，还会在服务端继续运行数分钟到数小时。这两个命令用于在终端里列出、查看、跟踪和控制它们。它们调用的是 Web 卡片使用的同一组 HTTP 路由，因此从 CLI 停止与在 evolve 面板上点 **停止**、在 Idea Tree 卡片上点 **结束研究** 效果相同。与 `run` 一样，它们连接一个已运行的 `serve`，从同一个 `--data-dir` 读取令牌，并接受 `--token`、`--host`、`--port` 与 `--output <jsonl|text>`。

```text
ScienceDiscovery evolve list [--session <id>]
ScienceDiscovery evolve get <run-id> [--candidate <hash>]
ScienceDiscovery evolve watch <run-id> [--after <sequence>]
ScienceDiscovery evolve stop <run-id>

ScienceDiscovery idea list --session <id>
ScienceDiscovery idea get <research-id> --session <id>
ScienceDiscovery idea watch <research-id> --session <id>
ScienceDiscovery idea pause|continue|stop <research-id> --session <id>
```

| 动作 | `evolve` | `idea` |
| --- | --- | --- |
| `list` | 所有搜索，最新的在前；`--session` 只看一个会话，与路由的 `sessionId` 过滤一致 | `--session` 指定会话中的研究 |
| `get` | 状态、候选数、token、费用与最佳节点；带 `--candidate <hash>` 时改为输出该候选的源码 | 状态、阶段、轮次、token，以及每个候选和它的得分 |
| `watch` | 持续输出搜索事件，直到搜索结束 | 持续输出研究进度，直到研究不再运行 |
| `stop` | 停止搜索 | 结束研究；已结束的研究不能再继续 |
| `pause` / `continue` | 不提供：evolve 搜索不能暂停 | 在当前步骤完成后暂停 / 继续已暂停或被中断的研究 |

每个命令只提供对应卡片已有的操作：evolve 没有暂停；Idea Tree 研究按会话寻址，因为它的路由就是按会话的。run id 可用 `evolve list` 查到，research id 可用 `idea list` 查到。

### 输出

约定与 `run` 相同：

- 在终端中输出 text：表格和可读的行写 stdout；连接提示和 `watch` 的最终状态写 stderr。
- 在管道或重定向中输出 JSONL：每行一个对象，内容与路由返回的完全一致——run 记录、事件记录（`{"sequence", "createdAt", "event"}`）、研究视图（`{"research", "graph"}`）。`watch` 会额外输出 `{"type":"reconnect"}` 行，并以一行 `{"type":"result"}` 结尾；失败是一行 `{"type":"error"}`。除此之外不输出任何内容，因此可以直接接 `jq`。

```bash
# 仍在运行的搜索
./ScienceDiscovery evolve list | jq -r 'select(.status == "running") | .id'

# 保存搜索事件，并按结束方式分支
./ScienceDiscovery evolve watch "$RUN" > events.jsonl && echo "search succeeded"

# 保存最佳候选的源码
best=$(./ScienceDiscovery evolve get "$RUN" | jq .bestNodeIndex)
hash=$(jq -r "select(.event.type == \"expanded\" and .event.nodeIndex == $best) | .event.codeHash" events.jsonl)
./ScienceDiscovery evolve get "$RUN" --candidate "$hash" --output text > best.py
```

### `watch`

`watch` 先回放已经发生的内容，再实时跟踪，引擎不再运行时返回；对已经结束的运行会立即返回。连接中断时（例如网络波动或 `serve` 重启），它会以逐渐加长的间隔重连约三分钟，并从中断处继续：evolve 从最后打印的事件序号之后继续，不丢也不重复；Idea Tree 的每次更新都携带完整的当前状态，所以重连后显示当前状态，并跳过已经显示过的更新。如果要在新进程里接着跟踪 evolve，把保存下来的最后一个 `sequence` 传给 `--after`。

Ctrl-C 只停止跟踪，不停止引擎。要停止引擎请用 `stop`。

退出码沿用 `run` 的约定（0 完成、1 失败、130 取消）：

| 退出码 | `evolve` 结束状态 | `idea` 结束状态 |
| --- | --- | --- |
| 0 | `succeeded` | `completed` |
| 130 | `stopped` | `ended` 或 `paused` |
| 1 | `failed` 或 `budget_exhausted` | `interrupted` |

找不到运行、令牌被拒绝或连接无法恢复时，`watch` 也以 1 退出；按 Ctrl-C 时以 130 退出。

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
