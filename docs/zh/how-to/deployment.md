# 部署 ScienceDiscovery

根目录 [README_zh.md](../../../README_zh.md) 给出最短启动路径。本文只描述部署操作；环境变量、默认端口、配额和存储布局见[配置参考](../reference/configuration.md)。

## 使用预先提供的二进制

ScienceDiscovery 以预先提供的、与宿主架构匹配的可执行文件分发。本节说明如何安装并运行 `ScienceDiscovery` 可执行文件。该发布版本不提供从源码构建的步骤，请使用已提供的可执行文件。

ScienceDiscovery 不打包 Neo4j。科学记忆需要外部 Neo4j 服务器，未配置时该功能保持关闭，Web 与对话主路径不受影响。

### 启动服务

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

`serve` 依次启动 agent-loop 网关、bubblewrap runner 和带 Web UI 的控制 API，然后打印 UI 地址。默认监听 <http://127.0.0.1:4310>，用 `SCIENCE_AGENT_AUTH_TOKEN` 登录；未设置时，`serve` 会打印首次启动生成的 token。Ctrl-C 会按启动的反序停止全部服务。

另开终端执行健康检查：

```bash
curl -fsS http://127.0.0.1:4310/health
```

首次 `serve` 会把内嵌运行时解包到 `~/.cache/science-agent/payload/<payload-id>`（可用 `XDG_CACHE_HOME` 或 `SCIENCE_AGENT_PAYLOAD_CACHE_DIR` 改位置），之后启动直接复用。目录名带 payload 摘要，因此升级到新版本不会覆盖旧解包结果。

### 首次启动安装的依赖

制品刻意不打包 uv、deer-flow 与 gateway 的第三方 Python 依赖树。首次 `serve` 在解包后会自动把它们装进数据目录（之后的启动直接复用，升级版本时只重建其中失效的部分）：

1. **uv**：从 PyPI 镜像（默认华为云 `https://mirrors.huaweicloud.com/repository/pypi/simple`）下载打包时固定版本与 SHA256 的 uv wheel，校验后解出二进制放到 `<数据目录>/tools/uv/`。
2. **deer-flow**：按本仓 submodule 锁定的精确 commit 获取，依次尝试 GitCode 镜像（`git fetch` 按 commit 浅取，需要宿主有 `git`）、GitHub 仓库、GitHub 归档直链（无 `git` 也可用）；下载结果先校验 commit 或内容摘要，再落到 `<数据目录>/vendor/deer-flow`。全部失败时错误信息会给出人工放置的目标路径、期望 commit 与逐步操作。
3. **gateway Python 环境**：用 uv 在 `<数据目录>/envs/gateway` 基于内置 CPython 建 venv，按打包时从 `services/gateway/uv.lock` 导出的带 SHA256 哈希的精确版本清单安装（`--require-hashes`），版本与锁文件完全一致、下载走配置的镜像。

相关环境变量（可写入 `--env-file`）：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SCIENCE_AGENT_PYPI_INDEX` | 华为云 PyPI 镜像 | Python 依赖使用的 package index |
| `SCIENCE_AGENT_UV_INSTALL_INDEX` | 同 `SCIENCE_AGENT_PYPI_INDEX` | 单独指定 uv wheel 的下载 index |
| `SCIENCE_AGENT_UV_PATH` | — | 直接使用已有的 uv，可跳过下载 |
| `SCIENCE_AGENT_DEERFLOW_GIT_URL` | GitCode 镜像 | deer-flow 首选 git 源（其后仍回退 GitHub） |
| `SCIENCE_AGENT_DEERFLOW_DIR` | `<数据目录>/vendor/deer-flow` | deer-flow 检出位置，也是人工放置的目标路径 |

离线主机可以提前在联网机器上完成一次首启，把整个数据目录拷贝过去；或按失败提示手工放置 deer-flow、用 `SCIENCE_AGENT_UV_PATH` 指向已安装的 uv。

### 宿主依赖：bubblewrap

bubblewrap 是**唯一**需要用户自行安装的宿主依赖，它没有被打包：沙箱依赖宿主内核的用户命名空间，只能由宿主提供。缺失时 `serve` 会直接失败并给出安装命令：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
sudo pacman -S bubblewrap            # Arch
sudo apk add bubblewrap              # Alpine
```

只想先看 Web UI、暂不使用沙箱执行时，可用 `--skip-sandbox-check` 启动；此时 `run_python` / `run_shell` 会失败，其余功能正常。bubblewrap 已安装但宿主限制了无特权用户命名空间时，`serve` 会给出告警并继续启动：API 与 UI 仍可正常启动、`GET /health` 会反映 runner 状态，但每次 `run_python` / `run_shell` 都会失败。Ubuntu 24.04+ 上通常的修复方式是：

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### 命令与选项

```
ScienceDiscovery serve [选项]        启动 Web UI、控制 API、agent-loop 网关与 runner
ScienceDiscovery extract --to <目录>  只解包内嵌运行时，不启动
ScienceDiscovery version             打印版本与内置 Node / CPython / micromamba 版本
ScienceDiscovery help                显示帮助
```

| 选项 | 默认值 | 作用 |
|---|---|---|
| `--data-dir <路径>` | `./science-agent-data` | 运行时数据目录，布局同[配置参考的存储布局](../reference/configuration.md#存储布局) |
| `--host <地址>` | `127.0.0.1` | Web UI / API 绑定地址 |
| `--port <端口>` | `4310` | Web UI / API 端口 |
| `--runner-port <端口>` | `4311` | runner 端口（仅回环） |
| `--gateway-port <端口>` | `4312` | gateway 端口（仅回环） |
| `--env-file <路径>` | — | 启动前读取 `KEY=VALUE` 配置；已存在的环境变量优先 |
| `--bwrap <路径>` | `PATH` 中的 `bwrap` | bubblewrap 可执行文件 |
| `--skip-sandbox-check` | 关 | 缺少 bubblewrap 时仍启动；沙箱执行不可用 |
| `--no-scientific-envs` | 关 | 不初始化托管科学环境 |

[配置参考](../reference/configuration.md#环境变量)中的变量同样生效，可直接导出或写进 `--env-file`。API、gateway 与 runner 默认都只监听回环。确需对外提供 API 时，应先更换 `SCIENCE_AGENT_AUTH_TOKEN`，在可信且受保护的网络中显式使用 `--host 0.0.0.0`。

### 二进制里有什么

| 组成 | 说明 |
|---|---|
| 启动器 | Node single-executable application，注入固定版本 `node` 二进制，因此产物是正常的 ELF 可执行文件 |
| Node 运行时 | 供控制 API 与 runner 使用 |
| CPython 3.12 | 可重定位发行版，无需宿主 Python；同时作为首启 gateway venv 的基础解释器 |
| Web 静态资源 | 预构建的 `apps/web/dist` |
| gateway wheel 与首启清单 | 自有代码的 `science-agent-gateway` wheel、带哈希的锁定依赖清单、uv wheel 与 deer-flow 的版本 pin |
| micromamba | 固定版本，首次 `serve` 播种到 `<数据目录>/scientific-envs/bin/micromamba`，之后 Runner 按同一发布清单校验 |

不含 uv、deer-flow 与 gateway 的第三方 Python 依赖（见[首次启动安装的依赖](#首次启动安装的依赖)），不含 Neo4j，也不含 starter Python/R 科学环境与 conda 包缓存：首次创建 starter 环境仍需访问允许的软件包渠道。

### 数据目录

`serve` 默认把运行时数据写到当前目录下的 `science-agent-data/`，可用 `--data-dir <路径>`（或 `SCIENCE_AGENT_DATA_DIR`）改写。该目录是唯一运行时根：项目、会话、工作区、密钥、服务环境与日志都在其中，请作为整体备份；删除它会清除全部项目、会话、凭证与审计记录。完整存储布局见[配置参考](../reference/configuration.md#存储布局)。
