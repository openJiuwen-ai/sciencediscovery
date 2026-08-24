# 配置、端口、配额与存储参考

本文集中列出本地模式和 Docker 的环境变量、默认端口、工作区相关配额及存储布局。实际部署步骤见[部署指南](../how-to/deployment.md)。

## 环境变量（本地模式）

```bash
cp .env.example .env
set -a && source .env && set +a
./scripts/run-local.sh
```

| 变量 | 默认值 | 用途 |
|---|---|---|
| `SCIENCE_AGENT_HOST` | `127.0.0.1` | HTTP 绑定地址；监听其他网卡必须显式配置 |
| `SCIENCE_AGENT_PORT` | `4310` | HTTP 端口 |
| `SCIENCE_AGENT_AUTH_TOKEN` | 首次启动生成 | 浏览器/API bearer token；不设置时使用 `<数据目录>/secrets/auth-token` 中保存的值 |
| `SCIENCE_DISCOVERY_DATA_DIR` | 均为 `.sciencediscovery-data`：仓库启动器相对仓库根目录解析，单文件 launcher 相对当前工作目录解析 | 项目、会话、工作区、密钥、服务环境。原 `SCIENCE_AGENT_DATA_DIR` 保留为带日志的兼容回退。 |
| `SCIENCE_AGENT_LOG_LEVEL` | `INFO` | 运行日志级别阈值（`DEBUG` / `INFO` / `WARNING` / `ERROR`） |
| `SCIENCE_AGENT_LOG_DIR` | `<数据目录>/logs` | 可选日志目录覆盖；通常保持默认以随数据目录持久化 |
| `SCIENCE_AGENT_LOG_MAX_BYTES` | `10485760` | 单个类别日志滚动前的最大字节数 |
| `SCIENCE_AGENT_LOG_BACKUP_COUNT` | `5` | 每个类别保留的滚动历史文件数 |
| `SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS` | `240000` | 初始 Agent 无响应上限：无流式输出或进度（`0` = 无限） |
| `SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS` | `0` | 初始 Agent 单轮总时长上限（`0` = 无限） |
| `SCIENCE_AGENT_RUNNER_HOST` | `127.0.0.1` | Runner 监听地址 |
| `SCIENCE_AGENT_RUNNER_PORT` | `4311` | Runner 监听端口 |
| `SCIENCE_AGENT_RUNNER_URL` | `http://127.0.0.1:4311` | Runner 端点（API 客户端） |
| `SCIENCE_AGENT_RUNNER_TOKEN` | `sciencediscovery-runner-local` | API→runner token |
| `SCIENCE_AGENT_BWRAP_PATH` | `bwrap`（通过 `PATH` 解析） | bubblewrap 可执行文件；Runner 启动时校验所需沙箱参数 |
| `SCIENCE_AGENT_NPU_BROKER` | `0` | 是否启用宿主 Ascend NPU Broker。默认关闭；只有 `1` / `true` / `yes` 会让 Agent 看到 `run_npu_job` |
| `SCIENCE_AGENT_NPU_WORKLOAD_CONFIG` | 空 | NPU workload 白名单 JSON；留空时使用 `services/runner/workloads/npu-workloads.default.json` |
| `SCIENCE_AGENT_NPU_PYTHON` | `python3` | 仅供自定义白名单中显式使用 `${python}` 的兼容 workload；仓内默认 NPU workload 使用 Agent 选定的 scientific environment revision，不读取此值 |
| `SCIENCE_AGENT_NPU_SMOKE_SCRIPT` | 空 | 可选管理员自定义 Ascend smoke probe；留空时使用仓内 `services/runner/workloads/npu-smoke-test.py` |
| `SCIENCE_AGENT_NPU_PROTENIX_SCRIPT` | 空 | Protenix 抗体 pipeline 的宿主 manager 入口；通常指向已部署 skill 的 `scripts/antibody_pipeline_manager.py`。该 manager 由 ScienceDiscovery scientific environment revision 解析出的 Python 启动 |
| `SCIENCE_AGENT_NPM_REGISTRY` | 空（官方 registry） | 构建步骤的 npm 镜像，仅作用于 `start-stack.sh` 内的 `pnpm install --registry`，不改用户/全局 npm 配置；如华为云 `https://mirrors.huaweicloud.com/repository/npm/` |
| `SCIENCE_AGENT_PYPI_INDEX` | 空（PyPI 官方） | 构建步骤的 PyPI 镜像，仅作用于 `start-stack.sh` 内 `uv sync` 的 `UV_DEFAULT_INDEX`，不改用户/全局 uv 配置；如华为云 `https://mirrors.huaweicloud.com/repository/pypi/simple`。注意：`uv.lock` 记录 index 来源，设置镜像后 uv 会按镜像重新 resolve（版本仍受 `pyproject.toml` 约束但可能偏离 lock），脚本会自动备份并恢复 lockfile，工作区不会被改动 |
| `SCIENCE_AGENT_MEMORY_GRAPH_HOST` | `127.0.0.1` | memory-graph 监听地址（服务进程使用） |
| `SCIENCE_AGENT_MEMORY_GRAPH_PORT` | `17674` | memory-graph 监听端口（服务进程使用） |
| `SCIENCE_AGENT_MEMORY_GRAPH_URL` | `http://127.0.0.1:17674` | memory-graph 端点（API 客户端） |
| `SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN` | `sciencediscovery-memory-graph-local` | API→memory-graph token |
| `SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL` | `INFO` | memory-graph 日志级别 |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `0` | 初始单次沙箱执行墙钟上限（`0` = 无限） |
| `SCIENCE_AGENT_MAX_WORKSPACE_BYTES` | `10737418240`（10 GiB） | Runner 工作区总量上限（`0` = 无限）；亦播种系统设置 |
| `SCIENCE_AGENT_MAX_OUTPUT_BYTES` | `1073741824`（1 GiB） | 单次执行 stdout+stderr 保留上限（超限截断；`0` = 不截断） |
| `SCIENCE_AGENT_WORKSPACE_MAX_BYTES` | `10737418240`（10 GiB） | API 上传累计工作区上限（`0` = 无限） |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_FILE_BYTES` | `1073741824`（1 GiB） | API 上传单文件上限（与 runner 无关；`0` = 无限） |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES` | `10737418240`（10 GiB） | 单个 multipart 请求体上限（`0` = 无限） |
| `SCIENCE_AGENT_PERMISSION_WAIT_TIMEOUT_MS` | `0` | 初始权限决策等待上限（`0` = 无限） |
| `SCIENTIFIC_ENVS` | `1` | 暴露托管 Python/R 与持久内核；完成 setup 前 runner 也可安全启动 |
| `SCIENCE_AGENT_PROVISIONER_PATH` | — | 可选管理员提供的 provisioner 覆盖；正常 setup 安装应用自有固定二进制 |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | — | 可选预置缓存；设置后 provision 离线运行，不再拉取允许渠道。pip `indexUrl` 与 conda channel 仍执行安全校验，但安装时不访问这些网络源（见 [sandbox-execution.md](../explanation/sandbox-execution.md) §6 受控软件源） |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | 逗号分隔的包渠道白名单；内置镜像预设（TUNA/USTC）对应的频道 URL 始终被 Runner 接受，自定义频道仍须显式列入 |
| `SCIENCE_AGENT_KERNEL_IDLE_MS` | `0` | 初始持久内核空闲超时（`0` = 无限） |
| `SCIENCE_AGENT_WEB_DIR` | `apps/web/dist` | 静态 UI 资源 |
| `SCIENCE_AGENT_PAPER_PYTHON_PATH` | `<data dir>/envs/paper/bin/python` | PDF worker Python |
| `SCIENCE_AGENT_PAPER_WORKER_PATH` | `services/paper/paper_worker.py` | PDF worker 入口 |

Ascend NPU Broker 面向需要访问宿主 Ascend 设备的部署，且需要管理员明确开启。没有 Ascend NPU、未安装 CANN/MindSpore，或不希望 Agent 调用宿主 NPU 时，请保持 `SCIENCE_AGENT_NPU_BROKER=0`；此时工具表不会包含 `run_npu_job`。本地模式启用后仍使用正常启动入口。启用 Broker 前，应先创建并验证至少一个可导入所需 CANN/MindSpore 栈的 ScienceDiscovery 托管 Python scientific environment revision。内置 NPU workload（包括 `npu.smoke_test`）都要求 `environment_revision_id`；Agent 未显式传入时，API 使用当前 Session revision。`SCIENCE_AGENT_NPU_WORKLOAD_CONFIG` 留空时使用仓内默认白名单，当前包含 `npu.smoke_test` 与 `antibody.protenix.v1`；如需新增模型，提供自定义 JSON 白名单并固定 entrypoint，而不是让 Agent 传任意命令。`SCIENCE_AGENT_NPU_PYTHON` 仅保留给显式使用 `${python}` 的自定义白名单；仓内默认白名单使用 `${managedPython}`，不会读取它。修改白名单 JSON 等价于修改可执行代码入口，应作为部署变更审查；模型权重、数据库、HMMER、CANN、MindScience checkout 等站点资产不进入仓库，通常通过上面的环境变量或 workload 配置引用。

浏览器仅将 API token 保存在 local storage。模型凭证只存在于后端存储。

### 配额层级

这些默认值来自 `services/api/src/workspace-upload.ts`、`services/runner/src/executor.ts` 和 `.env.example`，含义不同，不能互相替代：

| 层级 | 默认值 | 作用 |
|---|---|---|
| API 上传单文件 | 1 GiB | 每个 multipart 文件的接收上限；只约束上传入口 |
| API 单次上传请求 | 10 GiB | 一次 multipart 请求体的累计接收上限 |
| API 上传累计工作区 | 10 GiB | 上传新文件前检查会话工作区累计大小 |
| Runner 工作区 | 10 GiB | 执行前后的工作区配额；适用于上传文件和执行生成文件 |
| Runner stdout + stderr | 1 GiB | 一次执行保留的合并输出上限，超出后截断 |
| Runner 单个执行文件 | 不单独限制 | 当前 `MAX_RUNNER_FILE_BYTES=0`；仍受 Runner 工作区总量约束 |

`GET /health` 的 `workspace.maxFileBytes`、`maxRequestBytes`、`maxWorkspaceBytes` 分别报告 API 上传单文件、上传请求和 Runner 工作区上限。它不报告 stdout/stderr 上限。

## Docker 环境变量

Compose 读取仓库根目录 `.env`，并把以下键插值到 `docker-compose.yml`：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID` | `1000` | 容器 uid/gid；必须能写宿主的 `./data` |
| `SCIENCE_AGENT_PUBLISH_HOST` | `127.0.0.1` | UI/API 在宿主上发布到的网卡 |
| `SCIENCE_AGENT_PUBLISH_PORT` | `4310` | 映射到容器 `4310` 的宿主端口 |
| `SCIENCE_AGENT_AUTH_TOKEN` | 首次启动生成 | 浏览器/API bearer token；不设置时使用 `<数据目录>/secrets/auth-token` 中保存的值 |
| `SCIENCE_AGENT_RUNNER_TOKEN` | `sciencediscovery-runner-local` | API→runner token（仅容器回环） |
| `SCIENTIFIC_ENVS` | `1` | 托管 Python/R 环境与持久内核 |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `7200000` | 单次沙箱执行的墙钟上限 |
| `SCIENCE_AGENT_KERNEL_IDLE_MS` | `1800000` | 持久内核空闲超时（最小 1000 ms） |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | 逗号分隔的包渠道白名单 |
| `SCIENCE_AGENT_PROVISIONER_PATH` | — | 可选管理员 micromamba 路径；留空使用镜像内已校验副本 |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | — | 可选预置缓存路径；离线 provision 前需填充内容 |
| `SCIENCE_AGENT_BWRAP_PATH` | `/usr/bin/bwrap` | 镜像内 bubblewrap 可执行文件 |

API 在容器内监听 `0.0.0.0:4310`，runner `4311` 保持在容器回环，对外只发布 API 端口。操作步骤与沙箱放权边界见[Docker 部署](../how-to/deployment.md#docker-部署)。

## 存储布局

应用持久化数据默认都在仓库内（除非覆盖）：

| 位置 | 内容 |
|---|---|
| `.sciencediscovery-data/`（`SCIENCE_DISCOVERY_DATA_DIR`） | 全部运行时状态。请将该目录作为整体备份。 |
| `.sciencediscovery-data/catalog.sqlite` | 目录库：项目、会话、设置、模型配置、权限、specialists（遗留 `catalog.json` 会自动导入） |
| `.sciencediscovery-data/mcp-result-cache.sqlite` | MCP 连接器结果缓存 |
| `.sciencediscovery-data/web-cache.sqlite`、`.sciencediscovery-data/web-audit.sqlite` | Web Search/Fetch 缓存与 `WebInvocation` 审计 |
| `.sciencediscovery-data/model-secrets.key` | 提供方 token 的 AES-256-GCM 密钥（仅属主可读；无密钥则 token 无用） |
| `.sciencediscovery-data/projects/<project-id>/sessions/<session-id>/workspace/` | 每会话工作区：上传/生成文件、`papers/<paper-id>/` 抽取结果 |
| `.sciencediscovery-data/cas/`、`.sciencediscovery-data/execution-runs/`、`.sciencediscovery-data/prompt-manifests/`、`.sciencediscovery-data/reviews/`、`.sciencediscovery-data/messages/` | 内容寻址 blob、执行记录、prompt manifest、聊天、评审 |
| `.sciencediscovery-data/claims/`、`.sciencediscovery-data/evidence-items/`、`.sciencediscovery-data/evidence-links/`、`.sciencediscovery-data/mcp-invocations/`、`.sciencediscovery-data/artifact-derivations/` | claim/证据溯源与 MCP 审计 |
| `.sciencediscovery-data/session-runs/`、`.sciencediscovery-data/run-events/<session>/<run>/main.jsonl`（及 `tool-<id>`/`subagent-<id>` 子流）、`.sciencediscovery-data/model-usage/`、`.sciencediscovery-data/connector-invocations/` | 会话运行记录、运行时间线（无损 append-only JSONL；遗留扁平 `<run>.json` 只读兼容）、模型用量与连接器调用审计 |
| `.sciencediscovery-data/artifact-plans/`、`.sciencediscovery-data/artifact-jobs/`、`.sciencediscovery-data/artifact-extraction-jobs/` | 下载与 PDF 抽取任务状态 |
| `.sciencediscovery-data/scientific-envs/`、`.sciencediscovery-data/runner-runtime/` | 托管 Python/R 环境与 runner 临时状态 |
| `.sciencediscovery-data/skills/` | 本地托管技能包与 revision |
| `.sciencediscovery-data/envs/paper/`、`.sciencediscovery-data/envs/gateway/` | uv 管理的 PDF worker 与 agent gateway Python 环境（可由运行脚本重建；非业务状态） |
| `.sciencediscovery-data/logs/{api,run,gateway,runner,memory-graph}.log` | 分级、按类别和大小滚动的运行日志；memory-graph 文件仅在功能启用时使用 |
| 浏览器 local storage | 仅 API bearer token——模型凭证从不离开后端 |

数据目录是唯一运行时根：通过设置 `SCIENCE_DISCOVERY_DATA_DIR` 可同时迁移状态与服务环境（例如 `SCIENCE_DISCOVERY_DATA_DIR=/srv/science-discovery ./scripts/run-local.sh`）。原 `SCIENCE_AGENT_DATA_DIR` 仍作为兼容回退读取并打印日志；新旧同时设置时 `SCIENCE_DISCOVERY_DATA_DIR` 优先，且会记录该选择。对于仓库启动器，已有默认 `data` 目录会一次性移动到 `.sciencediscovery-data`。对于单文件 launcher，已有默认 `./science-discovery-data` 或更早的 `./science-agent-data` 会按由新到旧的顺序一次性导入 `./.sciencediscovery-data`；目标已存在时绝不覆盖并打印跳过原因。删除当前生效的数据目录会清除所有项目、会话、凭证与审计记录。在 [Docker 部署](../how-to/deployment.md#docker-部署)中，同一目录就是宿主上的 bind mount `./data`，区别只在于 `envs/` 位于镜像内。`services/paper/.venv` 与 `services/gateway/.venv` 仅在独立开发或 smoke 命令中出现；应用本身使用 `.sciencediscovery-data/envs/` 下的环境。

单文件 payload 覆盖变量遵循同一命名和优先级：用 `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR` 指定解包缓存，或用 `SCIENCE_DISCOVERY_PAYLOAD_DIR` 指定已解包 payload；对应的 `SCIENCE_AGENT_*` 名称继续作为带日志的兼容回退。
