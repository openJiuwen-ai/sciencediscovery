# 在 JiuwenSwarm 上运行智能体

ScienceDiscovery 的智能体循环跑在 [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) 上。本文说明如何安装它并以它启动整套栈；这是本项目文档化、构建与测试所依据的后端。（栈里还留有更早的内置循环，本文不涉及，需要对比或回退时见 [JiuwenSwarm 迁移：现状与交接](../reference/jiuwenswarm-migration-status.md)。）

不变的部分：网页界面、会话、消息、运行事件、产物与溯源。变化的部分：模型循环、对话上下文（由 JiuwenSwarm 保存并压缩）、系统提示词（JiuwenSwarm 自己的，加上 ScienceDiscovery 的），以及默认情况下的**工具**：模型拿到的是 JiuwenSwarm 自己的工具（bash、文件读写编辑、grep、网页抓取、子代理、todo、记忆、技能、定时任务），再加上 JiuwenSwarm 没有对应物的 ScienceDiscovery 工具（在 Runner 上执行的 `run_shell`、产物、证据与论断、论文、idea tree、evolve、`task`）。

**工具、沙箱与审批：** JiuwenSwarm 直接在主机上操作的工具（`bash`、`read_file`、`write_file`、`edit_file`、`glob`、`list_files`、`grep`、`read_pdf`）对模型隐藏：命令、脚本和写文件走 ScienceDiscovery 的 `run_shell`，在它的沙箱或 Runner 里执行，保留溯源；读文件用它的文件工具。模型若仍调用被隐藏的工具，调用会被拒绝，什么也不执行。JiuwenSwarm 其余的工具（网页搜索与抓取、todo、记忆、技能、子代理、定时任务）保留。ScienceDiscovery 的工具通过一个 MCP 服务 `sci` 提供给 JiuwenSwarm，名字固定（如 `mcp_sci_run_shell`）。**审批用 JiuwenSwarm 的**：它的权限引擎已开启，每次工具调用前由它判断。我们的每个工具在第一次出现时设定级别：会执行命令、访问主机或 Runner、下载的工具，以及自定义 MCP 连接器工具为*询问*，其余为*允许*。询问显示为 ScienceDiscovery 的审批卡片（会话的审批模式和已有授权仍然生效），答复回传给 JiuwenSwarm（本次 / 本会话 / 总是 / 拒绝）。之后 ScienceDiscovery 自己的审批层放行这次调用，并以来源 `jiuwenswarm` 记录。设 `SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` 则模型只用 ScienceDiscovery 的工具。

**语言：** JiuwenSwarm 的语言跟随界面语言（设置里的 English / 中文）：它自己的提示词、规则和工具，以及它要求模型使用的回答语言。这是所有会话共用的一个设置（JiuwenSwarm 配置里的 `preferred_language`）；切换后，会话在下一次运行时生效。

```text
浏览器 ─▶ 适配器（公共端口）─▶ API（端口 + 100）
              │                     │
              └─▶ JiuwenSwarm ◀─────┘   工具在 API 里执行，经每次运行一个的桥回调
                       │
                       └─▶ 模型，经 API 里的回环网关（前端能配置的协议都可以）
```

哪些已实现、哪些没有：[JiuwenSwarm 迁移：现状与交接](../reference/jiuwenswarm-migration-status.md)。

## 以 JiuwenSwarm 启动整套栈

```bash
scripts/jiuwenswarm.sh setup                            # 一次性：克隆固定版本、安装、创建实例
./scripts/start-stack.sh --mode local --jiuwenswarm     # 如果 JiuwenSwarm 没在运行会先启动它，再启动整套栈
```

等价的环境变量写法：`SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`。浏览器旅程：`CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked`（JiuwenSwarm 需已在运行）。公共端口：适配器占 4310，API 在其后的 4410。以上是源码模式的启动方式。单文件二进制包和 Docker 镜像都已经内置了 JiuwenSwarm 和适配器，且都默认跑在它上面：`./ScienceDiscovery serve` 或 `docker compose up -d` 都无需任何参数（用 `--no-jiuwenswarm` 改回原生循环，Docker 里通过容器命令传入；见[部署 → 在 JiuwenSwarm 上运行智能体](../getting-started/deployment.md#在-jiuwenswarm-上运行智能体)）。

两种后端用的是同一份数据目录（会话、项目、模型、设置、界面上的消息），但**模型的对话上下文是 JiuwenSwarm 自己的**：它自己保存并压缩上下文，全新实例一开始是空的。所以在栈里更早的内置循环上跑过的会话，界面上能看到之前的轮次，但那些轮次不会成为 JiuwenSwarm 的对话上下文；如果在意，请新开一个会话。反过来没有问题：内置循环可以读取 JiuwenSwarm 那些运行的记录。

**确认当前跑的是哪个后端：**

```bash
curl -s -H "Authorization: Bearer $SCIENCE_AGENT_AUTH_TOKEN" http://127.0.0.1:4310/agent/info
# {"adapter":true,"executor":"jiuwenswarm","jiuwenswarm":{"gatewayUrl":"ws://...","managementUrl":"ws://...","reachable":true},"toolTimeoutSeconds":3600}
```

跑内置循环、或者没有带适配器启动的栈，没有 `/agent/info`。JiuwenSwarm 栈的日志里，每次对话都会出现适配器的 `POST /agent/runs`、`POST /llm/…` 和 `POST /mcp/…`。

## 前置条件

三条路径带有 JiuwenSwarm。

**单文件二进制包**：`./ScienceDiscovery serve` ——JiuwenSwarm 和适配器已经内置在可执行文件里（见[部署 → 二进制里有什么](../getting-started/deployment.md#二进制里有什么)），且这是默认后端，无需任何参数（用 `--no-jiuwenswarm` 改回原生循环）。除了照常需要的 [bubblewrap](../getting-started/deployment.md#宿主依赖bubblewrap) 外，唯一的宿主要求是解包后的磁盘空间，这会额外占用约 1.5 GB。运行时不会克隆或安装任何东西，所以这条路径不需要访问 `gitcode.com` 或 PyPI 源。

**Docker**：`docker compose build` 用同样的方式（直接从 PyPI 安装，不克隆）把它们打进镜像。和二进制包一样，这也是镜像的默认后端；给容器命令加上 `--no-jiuwenswarm`（或设 `SCIENCE_AGENT_EXECUTOR=native`）才会改回原生循环（见[部署 → 在 JiuwenSwarm 上运行智能体](../getting-started/deployment.md#在-jiuwenswarm-上运行智能体)）。除了 Docker 本身的要求外没有额外的宿主要求。首次启动仍会创建实例，落在挂载的数据目录下，因此能挺过容器重建；构建镜像时这部分会额外占用约 1.6 GB。

**源码模式**（见[部署](../getting-started/deployment.md#本地模式宿主进程)）：

- 主机上有 `git` 和 `uv`。JiuwenSwarm 装在它自己的目录和虚拟环境里，不会装进 ScienceDiscovery 的环境。
- 能访问 `gitcode.com`（克隆固定版本）和 PyPI 源。网络慢或在中国大陆时，把 `SCIENCE_AGENT_PYPI_INDEX` 设为镜像；下载超时再设 `UV_HTTP_TIMEOUT`（脚本默认 300 秒）。
- JiuwenSwarm 的安装大约占 1.5 GB 磁盘。

任意路径都支持前端能配置的模型：OpenAI chat completions、OpenAI Responses、Anthropic Messages，以及它们的供应商变体。模型照常在 ScienceDiscovery 里配置，JiuwenSwarm 自己不需要配模型。

## 安装与启动

```bash
scripts/jiuwenswarm.sh setup     # 一次性：克隆固定版本（workswarm0.2.6）、安装、创建实例
./scripts/start-stack.sh --mode local --jiuwenswarm    # 如果 JiuwenSwarm 没在运行会先启动它，再启动整套栈
```

`setup` 是幂等的，并会写入 ScienceDiscovery 依赖的一项 JiuwenSwarm 设置：实例 `config/config.yaml` 里的 `progressive_tool_enabled: false`。JiuwenSwarm 默认是 `true`，那样一次运行的工具会藏在一个搜索步骤后面，模型就看不到 ScienceDiscovery 定义的那些工具名。JiuwenSwarm 没装时，`--jiuwenswarm` 会带提示直接拒绝启动。

想自己管理 JiuwenSwarm：`scripts/jiuwenswarm.sh start | stop | status | env`。JiuwenSwarm 会在 `~/.jiuwenswarm-instances/<name>` 下创建实例工作区（它没有办法改位置）。实例名是 `sciencediscovery`，有自己的端口，不会和同一台机器上默认的 JiuwenSwarm 冲突。想用脚本不管理的 JiuwenSwarm，自己设 `JIUWENSWARM_GATEWAY_URL` 和 `JIUWENSWARM_MGMT_URL`。

## 配置

全部是栈上的环境变量（写在 `.env` 里，或在 `start-stack.sh` 之前导出）。用 JiuwenSwarm 只需要第一组。

| 变量 | 默认值 | 含义 |
|---|---|---|
| **选择** | | |
| `--jiuwenswarm`（参数） | 关 | 设置下面两个变量，并在需要时启动 JiuwenSwarm |
| `SCIENCE_AGENT_ADAPTER` | 未设置 | `1` 让适配器占公共端口，挡在 API 前面 |
| `SCIENCE_AGENT_EXECUTOR` | 未设置 | `jiuwenswarm` 让智能体跑在 JiuwenSwarm 上（需要适配器） |
| **JiuwenSwarm 实例** | | |
| `JIUWENSWARM_ROOT` | `.sciencediscovery-data/jiuwenswarm` | 安装目录 |
| `JIUWENSWARM_INSTANCE` | `sciencediscovery` | 实例名 |
| `JIUWENSWARM_TAG` | `workswarm0.2.6` | 安装的版本，只验证过 0.2.6 |
| `JIUWENSWARM_GIT_URL` | `https://gitcode.com/openJiuwen/jiuwenswarm.git` | 克隆来源 |
| `JIUWENSWARM_GATEWAY_URL` | 从实例读取 | 网关的对话路由，例如 `ws://127.0.0.1:20001/tui` |
| `JIUWENSWARM_MGMT_URL` | 从实例读取 | 用于 `mcp.*`、`models.*` 的 web 通道，例如 `ws://127.0.0.1:20000/ws` |
| `JIUWENSWARM_CONTEXT_WINDOW_TOKENS` | 未设置（JiuwenSwarm 的 200000） | JiuwenSwarm 压缩对话所依据的窗口；实例启动时写进它的配置 |
| `SCIENCE_AGENT_PYPI_INDEX`、`UV_HTTP_TIMEOUT` | 未设置、`300` | 安装时的 PyPI 镜像和下载超时 |
| **端口与地址** | | |
| `SCIENCE_AGENT_PORT` | `4310` | 公共端口（适配器的） |
| `SCIENCE_AGENT_LEGACY_PORT` / `SCIENCE_AGENT_LEGACY_URL` | 端口 + 100 | 适配器后面的 API 监听在哪 |
| `SCIENCE_AGENT_ADAPTER_URL` | `http://127.0.0.1:<端口>` | API 怎样访问适配器 |
| `SCIENCE_AGENT_ADAPTER_PUBLIC_URL` | `http://127.0.0.1:<端口>` | JiuwenSwarm 怎样访问适配器（每次运行的 MCP 和模型路由） |
| `SCIENCE_AGENT_HOST` | `127.0.0.1` | 适配器绑定的网卡 |
| `SCIENCE_AGENT_ADAPTER_TOKEN` | 未设置 | API 访问 `/agent/*` 时带的 Bearer token；适配器监听在回环之外时请设置 |
| **一次运行的行为** | | |
| `SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S` | `3600` | 单次工具调用最长多久（JiuwenSwarm 自己的限制是 30 秒；API 有运行超时时会传运行的超时） |
| `SCIENCE_AGENT_JIUWENSWARM_PLANNING` | `todo` | 谁来维护计划。`todo`：模型用 JiuwenSwarm 自己的 todo 工具，它的清单就是计划。`update_plan`：改用 ScienceDiscovery 自己的工具（模拟浏览器旅程里脚本化的就是它） |
| `SCIENCE_AGENT_JIUWENSWARM_TOOLS` | `jiuwenswarm` | `jiuwenswarm`：JiuwenSwarm 自己的工具，加上它没有的 ScienceDiscovery 工具（重名时用 JiuwenSwarm 的）。`ours`：只用 ScienceDiscovery 的，每次调用都经过它的权限和 Runner（模拟浏览器旅程用的就是这个） |
| `SCIENCE_AGENT_JIUWENSWARM_SKILLS` | `jiuwenswarm` | `jiuwenswarm`：会话启用的技能导入 JiuwenSwarm（`skills.import_local`），按它的机制使用：它的提示词列出技能，模型用 `skill_tool` 加载；不再发送 ScienceDiscovery 的技能目录和 `read_skill`。与 JiuwenSwarm 自带技能重名的（`skill-creator`）以 `sciencediscovery-<id>` 导入。`ours`：用 ScienceDiscovery 的技能目录和 `read_skill`（`PROMPT=replace` 或 `TOOLS=ours` 时也是这样） |
| `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` | `jiuwenswarm` | `jiuwenswarm`：模型用 JiuwenSwarm 自己的 `subagent_spawn`/`subagent_wait` 委派任务，不再提供 ScienceDiscovery 的 `task`。这些子代理跑在 JiuwenSwarm 内部，只有它自带的工具——ScienceDiscovery 的工具、沙箱、工作区交接和溯源都到不了它们。`task`：仍用 ScienceDiscovery 自己的工具（`TOOLS=ours` 时也是这样） |
| `SCIENCE_AGENT_JIUWENSWARM_PROMPT` | `prepend` | `prepend`：先是 ScienceDiscovery 的产品提示词，再是 JiuwenSwarm 的完整提示词，最后是运行契约。`replace`：只有 ScienceDiscovery 的到达模型 |
| `SCIENCE_AGENT_LLM_MAX_TOKENS` | `16384` | 每次模型调用的输出预算（与内置循环共用）；推理模型请调大 |
| `SCIENCE_AGENT_LLM_MAX_RETRIES`、`SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | `2`、`600` | 重试次数（429 等瞬时错误）和单次调用超时（共用） |
| **诊断** | | |
| `SCIENCE_AGENT_ADAPTER_DEBUG` | 未设置 | `1` 打印每次运行的每个工具事件和每个模型请求的最后几条消息（适配器） |
| `SCIENCE_AGENT_JIUWENSWARM_DEBUG` | 未设置 | `1` 记录桥上的每次工具调用（API） |

模型仍照常在界面里逐个设置：供应商、协议与变体、API key、思考模式、网络代理。唯一**不是**逐个模型设置的，是 JiuwenSwarm 压缩对话所依据的窗口大小：JiuwenSwarm 0.2.6 只认一个全局值（默认 200000 token），会忽略模型自己的窗口。请把 `JIUWENSWARM_CONTEXT_WINDOW_TOKENS` 设成你所用模型的窗口（它在达到该值的 80% 时压缩）；模型窗口比默认值小、又没设置时，对话可能在被压缩之前就溢出。

## 使用时会看到什么

- 与内置循环相同的对话、工具卡片、权限提示、计划、子代理和产物；里程碑 0 的旅程在这个后端上通过。
- JiuwenSwarm 把每个智能体（主智能体和每个子代理）的对话保存在自己的会话里，达到 `JIUWENSWARM_CONTEXT_WINDOW_TOKENS` 的 80% 时压缩。JiuwenSwarm 自己的模型调用（压缩时写的摘要、会话标题）用的是它的*默认模型*：适配器把这个条目指向自己（`sd-default`），再把这些调用转给当前正在运行的那次运行的模型。所以这个 JiuwenSwarm 实例是 ScienceDiscovery 专用的，不要和别的工作共用。系统提示词是 JiuwenSwarm 自己的完整版本（身份、任务执行策略、安全原则、工具使用规则、记忆、输入输出规则、子代理规则、运行环境、目录边界、上下文压缩、已安装 Skill），ScienceDiscovery 定义产品的提示词放在它**前面**（科学工作区、我们的工具与治理规则、专家角色），运行契约放在它**后面**。JiuwenSwarm 没有按运行设置自定义提示词的接口，所以由适配器的模型代理负责拼接；运行契约每轮都变，放在最后可让前面部分保持相同前缀，便于供应商缓存。设 `SCIENCE_AGENT_JIUWENSWARM_PROMPT=replace` 则改为用 ScienceDiscovery 的把 JiuwenSwarm 的换掉。技能用 JiuwenSwarm 的：每次运行前，适配器把这次运行冻结的技能包导入 JiuwenSwarm 的技能目录（内容哈希没变的跳过）；用 `skill_tool` 加载一个技能，在 ScienceDiscovery 这边也算加载了它（所以对 skill-creator 调用 `skill_tool` 之后 `create_skill` 可用）。JiuwenSwarm 所有会话共用一套技能，所以用这个后端时不能按项目、会话或专家选择技能：每次运行都导入整个技能目录（最新版本），设置页面上改为显示说明，不再提供选择（已保存的选择保留，切回内置后端时仍然有效）。**设置 › 技能 › JiuwenSwarm 中**列出安装在那里的所有技能，包括 ScienceDiscovery 的和 JiuwenSwarm 自带的（xlsx、docx-pro、pptx-generator 等），每个都有开关（`skills.toggle`），对之后开始的所有会话生效。ScienceDiscovery 每一步的上下文（计划快照、持久状态）**不会**注入，JiuwenSwarm 仍会把它自己的每轮包装和动态上下文（运行时状态）作为用户消息加进去。
- 对话、计划和事件的数据仍保存在 ScienceDiscovery 自己的存储里。
- JiuwenSwarm 的运行没有轨迹和 evidence 记录，图片也不会发给模型。
- 新增一个模型时，JiuwenSwarm 会向它发一条很小的探测请求（检测是否支持图片输入）；网关会拒绝那张图片，所以日志里出现一条 `400` 是预期的。
- 用量按每次模型调用统计，包含推理 token。
- 运行期间与 JiuwenSwarm 的连接断开时，适配器会把这次运行接回来（`chat.resume`）；断开期间发出的内容会丢失。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `start-stack.sh` 提示 JiuwenSwarm 没装或连不上 | 先执行一次 `scripts/jiuwenswarm.sh setup`，再用 `--jiuwenswarm`；或者 `scripts/jiuwenswarm.sh start` 后用 `status` 查看。日志：`.sciencediscovery-data/jiuwenswarm/jiuwenswarm.log` 和 `~/.jiuwenswarm-instances/<name>/agent/.logs/`。 |
| `/agent/info` 里 `"reachable": false` | JiuwenSwarm 没运行，或地址不对。用 `scripts/jiuwenswarm.sh status` 检查；脚本不管理的实例要自己设 `JIUWENSWARM_GATEWAY_URL`/`JIUWENSWARM_MGMT_URL`。 |
| 模型从不调用工具 | 检查实例配置里的 `progressive_tool_enabled: false`；`scripts/jiuwenswarm.sh setup` 会恢复它。 |
| 子代理或长命令在 30 秒后以空错误结束 | 这是 JiuwenSwarm 自己对单次 MCP 调用的限制。适配器按运行提高了它（`SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S`）；如果还看到，说明适配器版本早于此修复。 |
| 运行停在半句思考上，或提示 “cut off at its output limit” | 推理模型把每次调用的输出预算（`max_tokens`，默认 16384）全花在思考上了。在栈上调大 `SCIENCE_AGENT_LLM_MAX_TOKENS` 后重试。内置循环也有同样的上限。 |
| 模型返回 `429` | 供应商在限流。运行会像内置循环一样退避重试，重试用完才以供应商的原话失败。 |
| 只有走这个后端时供应商返回 `403` | 有些网关按 `User-Agent` 过滤。用 `curl` 和同一个 key 直接测试该端点，并反馈响应内容。 |
| 想看一次运行做了什么 | `SCIENCE_AGENT_ADAPTER_DEBUG=1` 和 `SCIENCE_AGENT_JIUWENSWARM_DEBUG=1` 会把它们打印到栈的日志里。 |

设计说明和针对 JiuwenSwarm 0.2.6 实测的协议事实见 [`services/adapter/README.md`](../../../services/adapter/README.md)。
