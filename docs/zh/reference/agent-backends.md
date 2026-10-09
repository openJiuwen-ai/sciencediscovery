# Agent 后端

ScienceDiscovery 的本地源码、Docker 和发行包启动器**默认使用 JiuwenSwarm**。需要旧版 Node 原生循环时，使用 `--no-jiuwenswarm`（或 `SCIENCE_AGENT_EXECUTOR=native`）。源码模式第一次启动前先运行 `scripts/jiuwenswarm.sh setup`；Docker 镜像和发行包自带运行环境。若绕过启动器直接启动 API，未设置 `SCIENCE_AGENT_EXECUTOR` 时仍会选择 native。

| 启动方式 | Agent executor | 对外 `:4310` | API |
| --- | --- | --- | --- |
| `./scripts/start-stack.sh --mode local` | JiuwenSwarm | adapter | `:4410` |
| `./scripts/start-stack.sh --mode docker` | JiuwenSwarm | adapter | `:4410` |
| `./scripts/start-stack.sh --mode local --no-jiuwenswarm` | native | API | `:4310` |

adapter 把运行请求转给 JiuwenSwarm，其余 HTTP 路由代理到 API。Project、Session、权限、工作区工具、Runner 执行、Artifact、溯源和运行事件仍由 API 管理。JiuwenSwarm 保存自己的模型对话与上下文；在 API 可见历史里编辑或回退消息，不会重写它的对话。模型调用经 adapter 和 API 模型网关转发。JiuwenSwarm 模式下可用带访问令牌的 `GET /agent/info` 检查对外入口。

## JiuwenSwarm 行为与开关

以下设置只在 `SCIENCE_AGENT_EXECUTOR=jiuwenswarm` 时生效，修改后需重启。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `SCIENCE_AGENT_JIUWENSWARM_PROMPT` | `prepend` | 产品提示词放在 JiuwenSwarm 提示词之前；`replace` 仅使用产品提示词及显式运行规则。 |
| `SCIENCE_AGENT_JIUWENSWARM_TOOLS` | `jiuwenswarm` | JiuwenSwarm 的网页、记忆、技能等可用工具与产品工具一起提供；`ours` 改用产品工具集。Swarm 直接操作宿主机的 `bash`、文件读写、`glob`、`grep`、`read_pdf` 会被拦截；命令请使用产品的 `run_shell` 等工作区工具。 |
| `SCIENCE_AGENT_JIUWENSWARM_PLANNING` | `todo` | 启用规划时由 JiuwenSwarm todo 工具维护计划；`update_plan` 改用产品工具。 |
| `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` | `task` | 平台 `task` 派发独立子运行，子运行也由 JiuwenSwarm 执行，并保留产品沙箱、权限、交接和审计；`jiuwenswarm` 改用原生 `subagent_spawn`/`subagent_wait`。 |
| `SCIENCE_AGENT_JIUWENSWARM_SKILLS` | `jiuwenswarm` | 默认提示词和工具模式下，把选中的技能安装给 `skill_tool`；`ours` 使用产品技能加载方式。JiuwenSwarm 加载失败时可回退到 `read_skill` 和 `read_skill_resource`。 |

使用默认 JiuwenSwarm 工具时，模型工具表里的产品 `web_search`/`web_fetch` 换成 JiuwenSwarm 的 `free_search` 或 `paid_search`、`fetch_webpage`；没有对应替代的产品工具继续可用。Swarm 原生子代理不具备平台 `task` 的工作区、产品工具、审批、交接、溯源及任务卡片，需要这些能力时应保持默认的 `task`。

部分实现文档**仅适用于 native executor**，包括[原生 Agent 后端](../developer-docs/agent-backend.md)中的上下文压缩、重复工具调用阈值和原生延迟工具可见性；不能直接套用于 JiuwenSwarm。另见[运行时架构](../developer-docs/architecture.md)、[子代理编排](../developer-docs/subagent-orchestration.md)及[历史迁移记录](jiuwenswarm-migration-status.md)。
