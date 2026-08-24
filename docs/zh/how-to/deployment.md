# 部署 ScienceDiscovery

根目录 [README_zh.md](../../../README_zh.md) 给出最短启动路径。本文只描述部署操作；环境变量、默认端口、配额和存储布局见[配置参考](../reference/configuration.md)。

## 三种部署方式

| 方式 | 用户拿到的东西 | 宿主依赖 | 适用场景 |
|---|---|---|---|
| [源码构建单文件二进制](#单文件二进制部署) | 每个架构**一个**可执行文件 | 构建时需源码工具链；运行时需 bubblewrap | 制作可搬运的内部发布产物 |
| [Docker 镜像](#docker-部署) | 容器镜像 + Compose 文件 | Docker Engine 24+、Compose v2 | 已有容器平台，希望按容器方式运维 |
| [本地模式](#本地模式宿主进程) | 源码仓库 | Node、pnpm、uv、Python、bubblewrap | 开发与调试 |

**这三条路径互相独立，请选定一条，不要混用。** 二进制部署从构建到运行全程不涉及 Docker：可执行文件自带 Node、CPython、gateway 依赖、Web 静态资源与 micromamba。需要容器化部署时走镜像路径，不要把二进制包塞进镜像。

三者都不打包 Neo4j。Science Memory 需要外部 Neo4j 服务器，未配置时该功能保持关闭，Web 与对话主路径不受影响。

## 单文件二进制部署

### 构建并运行

本节说明如何从当前源码构建、校验并运行产物。打包输出是每个架构一个文件，另附 `VERSION` 与 `SHA256SUMS`：

```
ScienceDiscovery-<版本>-linux-x86_64
ScienceDiscovery-<版本>-linux-aarch64
```

在仓库根目录按宿主架构构建、校验并运行：

```bash
case "$(uname -m)" in
  x86_64|amd64|x64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
./scripts/package-binary-release.sh \
  --arch "$arch" --version local --output dist/binary-release-local
artifact="dist/binary-release-local/ScienceDiscovery-local-linux-$arch"
(cd dist/binary-release-local && sha256sum --check SHA256SUMS)
"$artifact" serve
```

`serve` 依次启动 bubblewrap runner 和带 Web UI 的控制 API，顺序与健康检查同[本地模式](#本地模式宿主进程)一致，然后打印 UI 地址。常驻的就是这两个进程：agent 循环、模型调用与 web provider 都在 API 进程内，随包的 Python MCP server 由 API 按需拉起，不受 supervisor 托管。默认监听 <http://127.0.0.1:4310>，用 `SCIENCE_AGENT_AUTH_TOKEN` 登录；未设置时，`serve` 会打印首次启动生成的 token。Ctrl-C 会按启动的反序停止全部服务。

首次 `serve` 会把内嵌运行时解包到 `~/.cache/science-discovery/payload/<payload-id>`（可用 `XDG_CACHE_HOME` 或 `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR` 改位置），之后启动直接复用。目录名带 payload 摘要，因此升级到新版本不会覆盖旧解包结果。如果仅存在旧的 `~/.cache/science-agent` 缓存，launcher 会把它一次性改名导入新位置并打印兼容提示；如果新位置已经存在，则保留新位置且打印跳过导入的原因。

### 首次启动安装的依赖

制品刻意不打包 uv 与 gateway 的第三方 Python 依赖树。首次 `serve` 在解包后会自动把它们装进数据目录（之后的启动直接复用，升级版本时只重建其中失效的部分）：

1. **uv**：从 PyPI 镜像（默认华为云 `https://mirrors.huaweicloud.com/repository/pypi/simple`）下载打包时固定版本与 SHA256 的 uv wheel，校验后解出二进制放到 `<数据目录>/tools/uv/`。
2. **gateway Python 环境**：用 uv 在 `<数据目录>/envs/gateway` 基于内置 CPython 建 venv，按打包时从 `services/gateway/uv.lock` 导出的带 SHA256 哈希的精确版本清单安装（`--require-hashes`），版本与锁文件完全一致、下载走配置的镜像。

相关环境变量（可写入 `--env-file`）：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SCIENCE_AGENT_PYPI_INDEX` | 华为云 PyPI 镜像 | Python 依赖使用的 package index |
| `SCIENCE_AGENT_UV_INSTALL_INDEX` | 同 `SCIENCE_AGENT_PYPI_INDEX` | 单独指定 uv wheel 的下载 index |
| `SCIENCE_AGENT_UV_PATH` | — | 直接使用已有的 uv，可跳过下载 |

离线主机可以提前在联网机器上完成一次首启，把整个数据目录拷贝过去；或用 `SCIENCE_AGENT_UV_PATH` 指向已安装的 uv，并把 `SCIENCE_AGENT_PYPI_INDEX` 指向可达镜像。

### 宿主依赖：bubblewrap

bubblewrap 是**唯一**需要用户自行安装的宿主依赖，它没有被打包：沙箱依赖宿主内核的用户命名空间，只能由宿主提供。缺失时 `serve` 会直接失败并给出安装命令：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
sudo pacman -S bubblewrap            # Arch
sudo apk add bubblewrap              # Alpine
```

开启**沙箱网络访问**的 `domain-allowlist` 模式时，宿主还需要一个可用的 `python3`（沙箱内 egress bridge 的解释器，可用 `SCIENCE_AGENT_EGRESS_PYTHON` 指定）。缺失时该模式的执行会直接失败并说明原因，默认的 `none` 模式不受影响；两种模式都**不需要** root、额外 capability 或系统防火墙配置。

只想先看 Web UI、暂不使用沙箱执行时，可用 `--skip-sandbox-check` 启动；此时 `run_python` / `run_shell` 会失败，其余功能正常。bubblewrap 已安装但宿主限制了无特权用户命名空间时，`serve` 会给出告警并继续启动，排查方式与 [Docker 的沙箱与宿主要求](#沙箱与宿主要求)相同。

### 命令与选项

```
ScienceDiscovery serve [选项]        启动 Web UI、控制 API 与沙箱 runner
ScienceDiscovery extract --to <目录>  只解包内嵌运行时，不启动
ScienceDiscovery version             打印版本与内置 Node / CPython / micromamba 版本
ScienceDiscovery help                显示帮助
```

| 选项 | 默认值 | 作用 |
|---|---|---|
| `--data-dir <路径>` | `./.sciencediscovery-data` | 运行时数据目录，布局同[配置参考的存储布局](../reference/configuration.md#存储布局) |
| `--host <地址>` | `127.0.0.1` | Web UI / API 绑定地址 |
| `--port <端口>` | `4310` | Web UI / API 端口 |
| `--runner-port <端口>` | `4311` | runner 端口（仅回环） |
| `--env-file <路径>` | — | 启动前读取 `KEY=VALUE` 配置；已存在的环境变量优先 |
| `--bwrap <路径>` | `PATH` 中的 `bwrap` | bubblewrap 可执行文件 |
| `--skip-sandbox-check` | 关 | 缺少 bubblewrap 时仍启动；沙箱执行不可用 |
| `--no-scientific-envs` | 关 | 不初始化托管科学环境 |

[配置参考](../reference/configuration.md#环境变量本地模式)中的变量同样生效，可直接导出或写进 `--env-file`。API 与 runner 默认都只监听回环。确需对外提供 API 时，应先更换 `SCIENCE_AGENT_AUTH_TOKEN`，在可信且受保护的网络中显式使用 `--host 0.0.0.0`。

### 二进制里有什么

| 组成 | 说明 |
|---|---|
| 启动器 | Node single-executable application，注入固定版本 `node` 二进制，因此产物是正常的 ELF 可执行文件 |
| Node 运行时 | 供控制 API 与 runner 使用 |
| CPython 3.12 | 可重定位发行版，无需宿主 Python；同时作为首启 gateway venv 的基础解释器 |
| Web 静态资源 | 预构建的 `apps/web/dist` |
| gateway wheel 与首启清单 | 自有代码的 `sciencediscovery-gateway` wheel、带哈希的锁定依赖清单、uv wheel 的版本 pin |
| micromamba | 固定版本，首次 `serve` 播种到 `<数据目录>/scientific-envs/bin/micromamba`，之后 Runner 按同一发布清单校验 |

不含 uv 与 gateway 的第三方 Python 依赖（见[首次启动安装的依赖](#首次启动安装的依赖)），不含 Neo4j，也不含 starter Python/R 科学环境与 conda 包缓存：首次创建 starter 环境仍需访问允许的软件包渠道。

### 生成双架构发布包

```bash
./scripts/package-binary-release.sh \
  --version local --output dist/binary-release-local       # x86_64 与 aarch64
(cd dist/binary-release-local && sha256sum --check SHA256SUMS)

./scripts/package-binary-release.sh \
  --arch x86_64 --version local --output dist/binary-release-local
```

构建机需要 `node`、`pnpm`、`uv`、`tar`、`zstd`、`sha256sum`，**不需要 Docker，也不需要 QEMU**（uv 只在构建期用于导出锁定依赖清单和构建 gateway wheel，不进入制品）。两个架构都能在同一台 x86_64 或 aarch64 机器上产出：Node 与 CPython 运行时按 `scripts/binary-release/runtimes.json` 中的固定版本与 SHA256 下载，gateway 的第三方依赖不再打包、改为首启在用户机器上按锁定清单安装，其余部分（TypeScript 产物、Web 资源、gateway wheel）与架构无关。打包脚本仍逐个检查内置 CPython 扩展模块的 ELF 架构，架构不符会让构建失败。本仓已无 submodule，普通检出即可构建。

输出目录包含两个可执行文件、`VERSION` 与 `SHA256SUMS`。gateway 的 Python 依赖树（duckdb、pandas、numpy、onnxruntime 等）不再随包分发，制品体积相比打包依赖树的旧格式显著缩小；这部分改为首次启动时经镜像下载。压缩等级默认 zstd 19，可用 `SCIENCE_AGENT_PAYLOAD_ZSTD_LEVEL` 在迭代时调低。

## 本地模式（宿主进程）

```bash
./scripts/start-stack.sh --mode local              # 安装 + 构建 + 启动全部服务
./scripts/start-stack.sh --mode local --no-build   # 仅启动（需已完成过构建）
```

共用入口在本地模式下会读取仓库根目录 `.env`、校验 [环境要求](../../../README_zh.md#环境要求) 中列出的依赖、按需安装与构建，然后以宿主机普通进程启动各服务：

| 服务 | 地址 | 作用 |
|---|---|---|
| `services/gateway` | 无端口 | 仅为随包 Python MCP server 提供解释器环境 |
| `services/runner` | 127.0.0.1:4311 | 无 root 的 bubblewrap 执行器（后台） |
| `services/api` | 127.0.0.1:4310 | 控制 API + Web UI（前台） |

停止脚本（Ctrl-C）会一并停止其启动的后台服务。原有 `./scripts/run-local.sh [--no-build]` 命令仍受支持，它只是转调本地模式的薄包装；`pnpm start` 与 `pnpm server` 继续使用这一兼容入口。无人值守部署时可把脚本交给进程管理器（如 systemd user unit 或 tmux），也可以改用 [Docker 部署](#docker-部署)；runner 设计上始终只监听回环。

首次启动会在 `.sciencediscovery-data/envs/gateway` 下准备 Python 3.12 环境，它提供随包的 Python MCP server（biomed、UniProt）所用的解释器；本仓已无 submodule。

需要在 Ascend 主机上运行宿主 NPU workload 时，启动方式仍是本地模式入口；管理员在 `.env` 中显式设置 `SCIENCE_AGENT_NPU_BROKER=1` 及对应 workload 入口后，Runner 才会向 Agent 暴露 `run_npu_job`。启用前应先创建并验证一个面向 Ascend 栈的托管 Python scientific environment revision；内置 NPU workload（包括 smoke test）会提交到该 revision，而不是读取 `SCIENCE_AGENT_NPU_PYTHON`。完整参数见[配置参考](../reference/configuration.md#环境变量本地模式)，设计边界见 [Ascend NPU 宿主 Broker](../explanation/ascend-npu-runner.md)。

## Docker 部署

单个镜像承载完整技术栈，并通过 `docker-entrypoint.sh` 兼容包装调用 `scripts/start-stack.sh --mode docker`。共用入口在一个容器内启动与本地模式相同的两个进程：bubblewrap runner，以及带 Web UI 的控制 API；Docker 专属预检仍只在该模式执行。builder 阶段使用 pnpm 与 uv；运行镜像携带 Node、预构建的服务 Python 环境、bubblewrap，以及按 `TARGETARCH` 下载并校验的固定版本 micromamba，宿主机只需要 Docker。

### 前置条件

- Linux x86_64 或 aarch64 宿主机，安装 Docker Engine 24+ 与 Compose v2 插件；runner 需要宿主内核提供可用的用户命名空间。
- 容器可用的无特权用户命名空间——bubblewrap 沙箱依赖它：

  ```bash
  sysctl kernel.unprivileged_userns_clone            # 暴露该开关的内核上应为 1
  sysctl kernel.apparmor_restrict_unprivileged_userns # Ubuntu 24.04+ 上必须为 0
  ```

### 构建与启动

```bash
cp .env.docker.example .env   # 或把其中的键合并进已有 .env
mkdir -p data                 # 承载全部运行时状态的宿主目录
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:4310/health
```

打开 <http://127.0.0.1:4310>，使用 `SCIENCE_AGENT_AUTH_TOKEN` 登录；未设置时，容器日志会打印首次启动生成的 token。首次构建会编译 Web UI、解析两个服务 Python 环境并下载 micromamba，耗时较长且需要外网；之后启动镜像内服务和取得 micromamba 不再需要联网。托管 starter Python 的软件包网络边界见下方“限制”。

Docker 构建会根据 BuildKit 的 `TARGETARCH` 选择 `linux/amd64` 或 `linux/arm64` 对应的 micromamba，并用 Runner 共用的发布清单校验 SHA256。二进制保存在镜像的 `/opt/sciencediscovery/provisioner/micromamba`；容器首次面对空的 `/app/data` bind mount 时，会把它复制到默认托管路径，Runner 随后再次按同一清单校验。这个流程不需要在**运行时**访问 GitHub。

```bash
docker compose logs -f        # 跟踪启动顺序：runner → API
docker compose ps             # 容器状态，含健康检查结果
docker compose down           # 停止并删除容器；./data 保留
docker compose up -d --build  # 拉取新代码后重建并重启
```

### 数据目录

宿主目录 `./data` 以 bind mount 挂载到 `/app/data`，是唯一的持久化位置，布局与宿主机安装的[存储布局](../reference/configuration.md#存储布局)一致。**不使用任何 Docker 命名卷**：每个 project、session、工作区、凭证与审计记录都是宿主上的普通文件，可直接查看、备份与删除，并且在 `docker compose down` 和镜像重建后依然存在。

如果宿主机上已有用于本地安装的 `data/`，想让容器状态与之分开，修改 `docker-compose.yml` 中 bind mount 的宿主侧路径即可，例如 `- ./docker-data:/app/data`。

容器默认以 uid/gid `1000:1000` 运行。如果你的账号 id 不同，请在 `.env` 中设置 `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID`（`id -u`、`id -g`）并重建容器；否则入口脚本会立即以明确的「目录不可写」提示退出，而不是在更深处失败。

有两处与宿主机安装不同：

- uv 管理的 Python 环境**不**写入数据目录，而是烘焙在镜像的 `/opt/sciencediscovery/envs/{gateway,paper}` 中。这样 bind mount 只保存应用状态，全新的 `compose up` 也无需联网。
- 固定版本 micromamba 烘焙在 `/opt/sciencediscovery/provisioner/micromamba`，空数据目录首次启动时播种到 `.sciencediscovery-data/scientific-envs/bin/micromamba`。显式设置 `SCIENCE_AGENT_PROVISIONER_PATH` 时不播种，Runner 继续使用该管理员覆盖路径。

### 沙箱与宿主要求

容器**不**替代、也不削弱 bubblewrap 沙箱——agent 的 Python/R/shell 仍在 `bwrap` 下运行，保留独立命名空间与 seccomp 过滤；除非管理员配置了沙箱网络的域名允许列表，否则完全无网络。即使开启允许列表，沙箱仍然独占一个空的网络命名空间，只能经 Runner 的 egress gateway 出站。bubblewrap 需要创建用户命名空间、在其中挂载并新建 procfs，而 Docker 的默认安全配置会阻止这些，因此 Compose 服务放开以下三项，不多给任何权限：

| 配置 | 为什么需要 |
|---|---|
| `seccomp=unconfined` | Docker 默认 seccomp 配置只对持有 `CAP_SYS_ADMIN` 的容器放行 `mount` / `pivot_root`，而 bubblewrap 需要在自己的命名空间内调用它们 |
| `apparmor=unconfined` | Debian/Ubuntu 宿主上的 `docker-default` AppArmor 配置直接拒绝 `mount` |
| `systempaths=unconfined` | 放开 Docker 对 `/proc`、`/sys` 的默认只读与屏蔽路径（readonlyPaths / maskedPaths）。没有它，内核会拒绝 bubblewrap 在沙箱自己的 pid 命名空间里挂载新的 procfs（报 `Can't mount proc on /newroot/proc: Operation not permitted`），产品只能回退成绑定容器的 `/proc` |

不增加任何 capability，也不使用 `privileged: true`，不挂载 Docker socket。这三项放松的是**容器**边界，而不是 agent 沙箱：请把该容器视为可信的本地软件，与宿主机安装的定位一致。

**若未放开 `systempaths`（例如沿用旧版 Compose、裸 `docker run` 或 K8s 默认配置）**：产品会自动回退为 `--ro-bind /proc /proc`，执行仍可进行，但沙箱内看到的是**容器的进程列表**，而不是只有自己的进程。回退时 runner 启动日志与预检都会打印明确 warning，说明原因与影响。要恢复更强的隔离，请加回 `systempaths=unconfined`，不要改用 `privileged`。

如果宿主仍然限制用户命名空间，API 与 UI 仍可正常启动、`GET /health` 会反映 runner 状态，但每次 `run_python` / `run_shell` 都会失败。入口脚本在启动时会做一次 bubblewrap 预检，因此 `docker compose logs` 中会出现带上述检查命令的明确告警。Ubuntu 24.04+ 上通常的修复方式是：

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### 限制

- 单用户，信任模型与宿主机安装一致：一个静态 bearer token、无 TLS、无多用户账号。默认只发布到 `127.0.0.1`，因为 Docker 发布的端口会绕过宿主上大多数防火墙规则；只有在可信网络中才设置 `SCIENCE_AGENT_PUBLISH_HOST=0.0.0.0`，并请先更换 token。
- 镜像中不含任何 API token、模型凭证或宿主 `.sciencediscovery-data/` 内容——`.dockerignore` 排除了 `.sciencediscovery-data/`、`.env`、`node_modules/`、构建产物与本地缓存。凭证只通过 Compose 环境变量和 bind mount 的数据目录进入容器。
- 镜像已包含固定版本 micromamba，运行时不再为该二进制访问 GitHub；但本迭代**没有**打包 starter Python/R 科学环境或 conda package cache。首次创建 starter Python 仍需访问允许的软件包渠道；只有另行填充并设置 `SCIENCE_AGENT_PACKAGE_CACHE_DIR` 后，软件包解析才可离线进行。
- 该镜像是便捷封装，不是经过加固的多租户部署；单静态 bearer token、无 TLS、runner 无 CPU/内存配额等安全边界不因容器化而改变。

### 生成 micromamba 双架构发布包

以下脚本生成两套独立 Linux 包，并在输出目录写入版本文件与 tarball 校验清单：

```bash
./scripts/package-micromamba-release.sh --output dist/micromamba-release
sha256sum --check dist/micromamba-release/SHA256SUMS
```

默认产物为 `sciencediscovery-micromamba-<版本>-linux-x86_64.tar.gz` 与 `sciencediscovery-micromamba-<版本>-linux-aarch64.tar.gz`。每个包只含 `bin/micromamba` 和记录目标架构、上游文件名及二进制 SHA256 的 `manifest.json`；输出目录另含 `VERSION`、`SHA256SUMS`。脚本**不会**创建或收集 starter Python/R 环境、conda 软件包缓存或其他 Python 树。

可用 `--arch x86_64` / `--arch aarch64` 只生成一种架构，或用 `--dry-run` 在不下载的情况下核对版本、URL 与 SHA256。受限构建机也可先按发布清单准备两个原始二进制，再通过 `--source-dir <目录>` 进行本地校验与打包。
