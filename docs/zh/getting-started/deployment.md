# 部署 ScienceDiscovery

根目录 [README_zh.md](../../../README_zh.md) 给出最短启动路径。本文说明其他安装和运行方式：
从源码构建便携二进制、用于高级容器运维的 Docker，以及面向开发和调试的本地源码模式。
环境变量、默认端口、配额和存储布局见[配置参考](../reference/configuration.md)。

## 三种部署方式

| 方式 | 支持的操作系统 | 用户拿到的东西 | 运行环境依赖 | 适用场景 |
|---|---|---|---|---|
| [单文件二进制](#单文件二进制部署) | Linux x86_64/aarch64 | 预打包可执行文件，或从源码构建的产物 | 运行时需 Bubblewrap，仅自行构建时需源码工具链 | 新用户的最短路径，或可搬运的内部发布产物 |
| [Docker 镜像](#docker-部署) | Linux x86_64/aarch64 | 容器镜像 + Compose 文件 | Docker Engine 24+、Compose v2 | 高级容器运维 |
| [本地模式](#本地模式源码检出) | Linux x86_64/aarch64、macOS x64/arm64 | 源码仓库 | Node、pnpm、uv、Python；Linux 使用 Bubblewrap，macOS 使用系统内置 Seatbelt | 开发与调试 |

**这三条路径互相独立，请选定一条，不要混用。** 二进制部署从构建到运行全程不涉及 Docker：可执行文件自带 Node、CPython、gateway 依赖、Web 静态资源与 micromamba。需要容器化部署时走镜像路径，不要把二进制包塞进镜像。

三者都不打包 Neo4j。ScienceMemory 需要外部 Neo4j 服务器，未配置时该功能保持关闭，Web 与对话主路径不受影响。

## 单文件二进制部署

### 下载并运行已发布的二进制

预打包二进制是新用户的最短路径。请在
[Releases 页面](https://github.com/openJiuwen-ai/sciencediscovery/releases)下载与你的设备架构匹配的产物：

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
```

再将下列命令中的文件名替换为已下载的文件：

```bash
chmod +x ScienceDiscovery-<version>-linux-<architecture>
./ScienceDiscovery-<version>-linux-<architecture> serve
```

### Runner 构建版本

Runner 版本使用构建时 Git commit 的前 8 位，而不是内部里程碑名称。`pnpm build` 自动写入构建信息，SEA 打包保留同一信息；运行机器不需要 Git。工作树有已跟踪文件的未提交改动时附加 `-dirty`，正式发布应从干净提交构建。

没有 Git 元数据的源码归档可在构建时设置 `SCIENCE_AGENT_BUILD_COMMIT=<完整 commit SHA>`；既没有 Git 信息也没有指定 SHA 时显示 `unknown`，不伪造版本号。构建标识不表示版本大小；远端与本地不同只提示，不单独阻止连接。已经部署的旧 Runner 仍报告旧标识，更新其构建后才改变。

### 构建并运行

本节说明如何从当前源码构建、校验并运行产物。打包输出是每个架构一个文件，另附 `VERSION` 与 `SHA256SUMS`：

```text
ScienceDiscovery-<版本>-linux-x86_64
ScienceDiscovery-<版本>-linux-aarch64
```

在仓库根目录按当前设备架构构建、校验并运行：

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

`serve` 依次启动 bubblewrap runner、JiuwenSwarm、其适配器和带 Web UI 的控制 API，顺序与健康检查同
[本地模式](#本地模式源码检出)一致，然后打印 `Open to sign in` 链接与本地服务访问令牌。适配器提供
对外端口，API 在其后运行；随包的 Python MCP server 由 API 按需拉起，不受 supervisor 托管。默认监听
<http://127.0.0.1:4310>。打开启动日志中的 `Open to sign in` 链接，浏览器会自动保存本地服务访问令牌
并登录；若直接打开 <http://127.0.0.1:4310>，也可在连接引导中粘贴日志里的本地服务访问令牌并保存。
请勿分享该登录链接。设置了 `SCIENCE_AGENT_AUTH_TOKEN` 时使用该指定令牌。Ctrl-C 会按启动的反序停止
全部服务。

## 二进制与本地模式的首次启动排障

本节适用于已发布的二进制和本地源码模式。容器专属问题请看 [Docker 常见问题](#常见问题)。

**浏览器拒绝本地服务访问令牌。** 打开 `serve` 输出的 `Open to sign in` 链接。若直接打开了本地地址，
或令牌被拒绝，Web UI 会打开连接设置（Connection）。请在其中粘贴启动输出里的本地服务访问令牌，
而不是模型 API Key，并确认令牌与浏览器对应同一个数据目录。

**`/health` 报告 `"status":"degraded"`。** 这表示 runner 不可用。先查看终端中的第一条启动错误，
再检查下述日志。正常启动后，执行 `curl -fsS http://127.0.0.1:4310/health`，顶层 `status` 应为 `ok`。

**Linux 上缺少 `bwrap`，或沙箱检查失败。** 按[运行环境依赖：bubblewrap](#运行环境依赖bubblewrap)
中的命令安装 Bubblewrap。若已安装但用户命名空间不可用，请按[沙箱与宿主要求](#沙箱与宿主要求)
排查。macOS 的本地源码模式使用 Seatbelt，不使用 Bubblewrap。

**日志在哪里。** 二进制和本地模式默认将滚动服务日志写入 `<data-dir>/logs`。除非传入
`--data-dir` 或设置 `SCIENCE_DISCOVERY_DATA_DIR`，否则 `<data-dir>` 为
`./.sciencediscovery-data`。日志名称和覆盖方式见[存储布局](../reference/configuration.md#存储布局)。

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

### 运行环境依赖：bubblewrap

bubblewrap 是**唯一**需要用户自行安装的运行环境依赖，它没有被打包：沙箱依赖操作系统内核的用户命名空间。缺失时 `serve` 会直接失败并给出安装命令：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
sudo pacman -S bubblewrap            # Arch
sudo apk add bubblewrap              # Alpine
```

开启**沙箱网络访问**的 `domain-allowlist` 模式时，本机还需要一个可用的 `python3`（沙箱内
egress bridge 的解释器，可用 `SCIENCE_AGENT_EGRESS_PYTHON` 指定）。缺失时该模式的执行会直接失败
并说明原因，默认的 `none` 模式不受影响；两种模式都**不需要** root、额外 capability 或系统防火墙配置。

只想先看 Web UI、暂不使用沙箱执行时，可用 `--skip-sandbox-check` 启动；此时 `run_shell` 会失败，其余功能正常。bubblewrap 已安装但系统限制了无特权用户命名空间时，`serve` 会给出告警并继续启动，排查方式与 [Docker 的沙箱与宿主要求](#沙箱与宿主要求)相同。

### 命令与选项

```text
ScienceDiscovery serve [选项]        启动 Web UI、控制 API 与沙箱 runner
ScienceDiscovery run [输入] [选项]    作为命令行客户端连一个已运行的 serve，跑一个 agent 任务
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
| `--jiuwenswarm` | **开** | 智能体轮次跑在内置的 JiuwenSwarm 上而非原生循环；为兼容保留此参数，这已经是默认行为 |
| `--no-jiuwenswarm` | 关 | 改为跑原生循环；等价于 `SCIENCE_AGENT_EXECUTOR=native` |

[配置参考](../reference/configuration.md#环境变量本地模式)中的变量同样生效，可直接导出或写进 `--env-file`。API 与 runner 默认都只监听回环。确需对外提供 API 时，应先更换 `SCIENCE_AGENT_AUTH_TOKEN`，在可信且受保护的网络中显式使用 `--host 0.0.0.0`。

### run 子命令（CLI 客户端）

日常交互推荐使用 Web UI（通过 `serve` 启动时打印的 `Open to sign in` 链接打开并自动保存本地服务访问令牌，或在连接设置中粘贴保存）。`run` 是同一 `serve` 的命令行前端，与 Web UI 行为一致，适用于在终端中直接执行或将任务接入管道与脚本。`run` 自动加载与 `serve` 相同的 token（来自 `.env` 或 `--data-dir`），无需显式指定。agent 产出的文件存放于 `--data-dir` 的 `projects/<id>/sessions/<id>/workspace/` 下，不在当前工作目录，可通过该路径直接访问或在 Web UI 产物栏查看。

先起 `serve`，再开一个终端跑 `run`：

```bash
./ScienceDiscovery serve                 # 终端 1：起服务（常驻）
./ScienceDiscovery run "帮我写个快排"    # 终端 2：作为客户端跑一个 agent 任务
```

默认连 `http://127.0.0.1:4310` 并从 `--data-dir`（默认 `./.sciencediscovery-data`）读 `serve` 生成的 token，因此只要 `run` 与 `serve` 用同一个 `--data-dir` 就无需额外设置。终端直接敲默认走 **text 模式**（答案到 stdout、进度到 stderr，遇权限弹 1/2/3 选择）；管道/脚本里跑默认走 **jsonl 模式**，且必须显式 `--auto-approve`（非交互不答权限会拒启）。完整选项见 `./ScienceDiscovery run --help`，设计详见 [issue #23](https://gitcode.com/openJiuwen/sciencediscovery/issues/23)。

> 本地模式下没有 `ScienceDiscovery` 二进制，`run` 用 `node services/launcher/dist/main.js run ...` 跑（指向 `start-stack.sh` 起的 serve，默认地址与 dataDir 一致，同样无需额外设置）。Docker 模式下容器内不跑 `run`，从宿主机跑时需 `--data-dir ./data` 指向 bind mount 的数据目录（或 `--token` 显式给），其余默认。

### 二进制里有什么

| 组成 | 说明 |
|---|---|
| 启动器 | Node single-executable application，注入固定版本 `node` 二进制，因此产物是正常的 ELF 可执行文件 |
| Node 运行时 | 供控制 API 与 runner 使用 |
| CPython 3.12 | 可重定位发行版，无需宿主 Python；同时作为首启 gateway venv 的基础解释器 |
| Web 静态资源 | 预构建的 `apps/web/dist` |
| gateway wheel 与首启清单 | 自有代码的 `sciencediscovery-gateway` wheel、带哈希的锁定依赖清单、uv wheel 的版本 pin |
| JiuwenSwarm 与适配器 | 固定版本的 JiuwenSwarm 与自有代码的 `sciencediscovery-adapter` wheel，连同各自完整的第三方依赖树一起在构建时装好——跟 gateway 不同，不推迟到首次启动，因为 JiuwenSwarm 自身体量（约 1.5 GB）是发布包体积最大的单一来源 |
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

## 本地模式（源码检出）

源码模式支持 Linux x86_64/aarch64 与 macOS x64/arm64。两者使用相同的启动命令，均需 Node.js 22.19+、pnpm 11.1.2、Python 3、uv 0.9+、Git 和 curl。沙箱依赖按平台区分：

- Linux 需要 Bubblewrap 0.6+（推荐 0.8+）及可用的无特权用户命名空间；
- macOS 使用系统内置的 Seatbelt，启动脚本会自动调用 `/usr/bin/sandbox-exec`，不需要安装 Bubblewrap。

与预打包二进制和 Docker 镜像一样，本地源码模式默认使用 JiuwenSwarm。先安装固定版本，
再启动整套服务：

从仓库根目录执行：

```bash
scripts/jiuwenswarm.sh setup                         # 一次性：克隆固定版本、安装、创建实例
./scripts/start-stack.sh --mode local                 # 安装、构建并启动全部服务
./scripts/start-stack.sh --mode local --no-build      # 仅启动（需已完成过构建）
```

SSH 自动部署使用自带 Node runtime 的 Runner SEA 单文件，不要求目标机预装 Node。Linux 本地完整启动、Docker 构建和二进制发布会准备 Linux x64/arm64 两份 Runner；只做分包构建的开发者可在构建 Runner/Executor 后运行 `pnpm runner:binary`。生成文件位于 `services/runner/dist/sea/`，随产品发布，不提交到源码。

连接时按远端 `uname -m` 选择对应文件，经已鉴权、已校验主机指纹的 SSH SFTP 通道流式上传，校验 SHA-256 后发布并直接启动；同一构建已存在则复用。Runner 的 HTTP 通信仍只经 SSH 隧道。SEA 包含 Node 与 Runner 代码，不包含完整 Linux 用户态：目标机仍需可运行该 Node ELF 的系统库、Bubblewrap 和可用沙箱能力；科学环境按原有托管环境机制准备。缺少部署或沙箱条件时明确报错，不降级为裸 SSH 执行。

每份二进制按自身 SHA-256 命名，所以主程序升级后重连是新增一个文件而不是覆盖旧文件。新二进制启动并通过健康检查之后，控制面会删除同目录下其余以 SHA-256 命名、且没有任何进程正在执行的 Runner 二进制——单个约 120 MB，长期迭代会累积到数 GB。正在被执行的二进制一律保留，包括别的控制面连接正在使用的；目录里不符合该命名的文件不受影响。这一步是尽力而为，失败只记入连接日志，不影响已经建立的连接。

共用入口在本地模式下会读取仓库根目录 `.env`、校验[环境要求](../../../README_zh.md#环境要求)
中列出的依赖、按需安装与构建，然后以本机普通进程启动各服务。脚本在 Linux 自动选择
Bubblewrap，在 macOS 自动选择 Seatbelt，无需手动设置 `SCIENCE_AGENT_SANDBOX_PROVIDER`。默认服务如下：

| 服务 | 地址 | 作用 |
|---|---|---|
| JiuwenSwarm | `~/.jiuwenswarm-instances/sciencediscovery` | 运行智能体循环；未运行时由 `scripts/jiuwenswarm.sh` 启动 |
| 适配器 | 127.0.0.1:4310 | 对外端口；反向代理 API，并桥接 JiuwenSwarm 的模型与工具调用 |
| `services/api` | 127.0.0.1:4410 | 控制 API + Web UI，位于适配器之后（前台） |

启动成功后，终端会打印 `Open to sign in` 链接与本地服务访问令牌。另开终端执行 `curl -fsS http://127.0.0.1:4310/health`，然后在浏览器打开启动日志中的 `Open to sign in` 链接（浏览器会自动保存本地服务访问令牌并登录）。停止脚本（Ctrl-C）会一并停止其启动的后台服务。原有 `./scripts/run-local.sh [--no-build]` 命令仍受支持，它只是转调本地模式的薄包装；`pnpm start` 与 `pnpm server` 继续使用这一兼容入口。无人值守部署时可把脚本交给进程管理器（如 Linux 的 systemd user unit，或 Linux/macOS 均可用的 tmux），也可以在 Linux 上改用 [Docker 部署](#docker-部署)；runner 设计上始终只监听回环。

首次启动会在 `.sciencediscovery-data/envs/gateway` 下准备 Python 3.12 环境，它提供随包的 Python MCP server（biomed、UniProt）所用的解释器；同时会按宿主平台和架构准备固定版本的 micromamba，因此首次启动需要访问依赖源。本仓已无 submodule。

如果 macOS 启动时报 Seatbelt 不可用，先确认 `test -x /usr/bin/sandbox-exec` 成功，并检查当前终端或上层沙箱是否禁止应用 Seatbelt profile；启动过程不会在 Seatbelt 不可用时静默降级为无沙箱执行。macOS 支持仅适用于本地源码模式，Linux 单文件二进制和 Docker 路径不能直接在 macOS 上运行。

需要在 Ascend 主机上运行宿主 NPU workload 时，启动方式仍是本地模式入口；管理员在 `.env` 中显式设置 `SCIENCE_AGENT_NPU_BROKER=1` 及对应 workload 入口后，Runner 才会向 Agent 暴露 `run_npu_job`。启用前应先创建并验证一个面向 Ascend 栈的托管 Python scientific environment revision；内置 NPU workload（包括 smoke test）会提交到该 revision，而不是读取 `SCIENCE_AGENT_NPU_PYTHON`。完整参数见[配置参考](../reference/configuration.md#环境变量本地模式)，设计边界见 [Ascend NPU 宿主 Broker](../developer-docs/ascend-npu-runner.md)。

## Docker 部署

单个镜像承载完整技术栈：容器入口 `docker-entrypoint.sh` 转调 `scripts/start-stack.sh --mode docker`，在一个容器内按与本地模式相同的顺序启动 bubblewrap runner 和带 Web UI 的控制 API，随包的 Python MCP server 由 API 按需拉起；Docker 专属预检只在该模式执行。builder 阶段使用 pnpm 与 uv；运行镜像携带 Node、预构建的服务 Python 环境、bubblewrap，以及按 `TARGETARCH` 下载并校验的固定版本 micromamba。镜像同样内置了 JiuwenSwarm 与其适配器，做法与单文件二进制包相同，且**默认**就跑在它上面。运行环境只需要 Docker。

本节按「准备 → 构建 → 启动 → 浏览器连接 → 配置模型」给出完整步骤，之后是日常管理、数据目录、多实例、环境变量、沙箱要求与常见问题。命令都在仓库根目录执行。

### 前置条件

- Linux x86_64 或 aarch64 宿主机，Docker Engine 24+（自带 BuildKit）与 Compose v2 插件；`docker compose version` 应输出 `v2` 或更高。构建依赖 BuildKit 的 `TARGETARCH`，旧的 `docker-compose` v1 或关闭 BuildKit 的构建会以 `TARGETARCH is required` 失败。macOS / Windows 上的 Docker Desktop 不支持：沙箱依赖 Linux 内核的用户命名空间。
- 磁盘：镜像约 3.9 GB（其中约 1.6 GB 是 JiuwenSwarm 自身的依赖闭包），构建缓存另占数 GB；首次启动自动创建的 starter Python 科学环境会向数据目录写入约 2 GB。
- 网络：**构建期**需要访问 Docker Hub（`node:22-bookworm` 基础镜像）、`ghcr.io`（uv 镜像）、Debian apt 源、npm registry、PyPI、GitHub Releases（micromamba）与 `models.dev`（模型目录快照）。**运行期**镜像内的服务本身不再联网，但首次启动会在后台创建 starter Python 环境，需要访问 conda-forge 或其镜像；模型 API、文献源等由容器直接出站，需要走代理时见[常见问题](#常见问题)。
- 容器内可用的无特权用户命名空间——bubblewrap 沙箱依赖它。**判据是产品实际跑的 bwrap 探针，不是某个 sysctl 的取值**：容器入口和 runner 启动时都会真正构建一次最小沙箱，据此决定沙箱能否工作。起栈之后按[第 3 步](#第-3-步启动并确认健康)的探针命令正面复核；探针失败后的排查项见[沙箱与宿主要求](#沙箱与宿主要求)。

### 第 1 步：准备配置与数据目录

```bash
cp .env.docker.example .env   # 已有 .env 时把其中的键合并进去
id -u; id -g                  # 不是 1000 时改 .env 里的 SCIENCE_AGENT_UID / SCIENCE_AGENT_GID
mkdir -p data                 # 承载全部运行时状态的宿主目录，必须在 up 之前创建
```

`.env` 只被 Compose 读取，用于向 `docker-compose.yml` 插值；容器不读镜像内的 `.env`。默认值即可运行：发布在 `127.0.0.1:4310`，令牌首次启动自动生成。`data` 目录必须先建好并归当前用户所有：bind mount 的宿主路径不存在时 Docker 会以 root 创建它，容器里的 `node` 用户随即写不进去，入口脚本会立即退出并提示目录不可写。

### 第 2 步：构建镜像

```bash
docker compose build
```

产物是 `sciencediscovery:local`（可用 `SCIENCE_AGENT_IMAGE` 改 tag）。首次构建会安装 workspace 依赖、编译 Web UI、解析 paper、gateway 和适配器三个 Python 环境、从 PyPI 安装 JiuwenSwarm、下载 micromamba 与模型目录快照，全程需要外网；缓存全空时在一台普通 x86_64 机器上约需两三分钟，网络慢时更长。之后只改源码的重建会复用依赖层缓存，JiuwenSwarm 也在内——除非 `JIUWENSWARM_TAG` 变了，否则不会重新下载。

Docker 构建会根据 BuildKit 的 `TARGETARCH` 选择 `linux/amd64` 或 `linux/arm64` 对应的 micromamba，并用 Runner 共用的发布清单校验 SHA256。二进制保存在镜像的 `/opt/sciencediscovery/provisioner/micromamba`；容器首次面对空的 `/app/data` bind mount 时把它复制到默认托管路径，Runner 随后再次按同一清单校验。这个流程不需要在**运行时**访问 GitHub。

### 第 3 步：启动并确认健康

```bash
docker compose up -d
curl -fsS http://127.0.0.1:4310/health
docker compose ps
```

`up -d` 后几秒内 `/health` 即应返回 JSON：`"status":"ok"` 且 `"runner":{"status":"ok",…}` 表示控制 API 与沙箱 runner 都已就绪；`"status":"degraded"` 或 `"runner":{"status":"unavailable"}` 说明 runner 没起来，看 `docker compose logs`。`docker compose ps` 的状态列在启动后最多 60 秒内显示 `health: starting`，随后变为 `healthy`；这是 Compose 健康检查的观察窗口，不是故障。

runner 就绪后再正面复核一次沙箱：

```bash
docker compose exec sciencediscovery sh -c '
  bwrap --unshare-all --unshare-user --die-with-parent \
    --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib \
    --symlink usr/lib64 /lib64 --proc /proc /usr/bin/true' \
  && echo "沙箱探针通过"
```

这就是 `packages/sandbox-capability` 探测时使用的参数组合。请保留外层 `sh -c`：`docker compose exec` 直接把 `bwrap` 作为会话首进程时无法建立回环网络，会给出与沙箱能力无关的误报。

首次启动还会做两件事，都只写数据目录：把镜像内的 micromamba 播种到 `./data/scientific-envs/bin/micromamba`；然后在后台创建 starter Python 科学环境（从 conda-forge 解析并下载，约 2 GB，通常需要几分钟）。创建期间 Web 与对话已可使用，只有依赖托管环境的执行要等它完成；`/health` 里 `runner.scientificEnvs.startersReady` 变为 `true` 即完成。不需要托管环境时设 `SCIENTIFIC_ENVS=0`。

### 第 4 步：在浏览器中连接

启动输出里有一条登录链接和一条本地服务访问令牌：

```bash
docker compose logs | grep -A 2 'Open to sign in'
```

```text
Open to sign in: http://127.0.0.1:4310/#token=<令牌>
Local service access token (generated on first start): <令牌>
  Stored in /app/data/secrets/auth-token.
```

在浏览器打开这条链接即可：页面读取 URL 片段里的令牌并保存到浏览器本地存储，随即从地址栏移除，直接进入工作台首页。**链接里的端口永远是容器内端口 4310**——若在 `.env` 里改了 `SCIENCE_AGENT_PUBLISH_PORT`（例如 4410），请把链接里的 `4310` 换成发布端口再打开。

不用链接时也可以直接打开 <http://127.0.0.1:4310>：页面会弹出「系统设置 → 连接」引导，把令牌粘贴到「本地服务访问令牌」输入框，点「保存」，再点「保存并关闭」。令牌有两处来源：容器日志，或宿主上的文件 `./data/secrets/auth-token`（属主为容器 uid，权限 600）。设置了 `SCIENCE_AGENT_AUTH_TOKEN` 时使用该指定值，不再写这个文件。容器重启不会更换令牌。

登录链接与令牌等同于密码，请勿分享；它不是外部模型的 API Key。

服务跑在远程机器上时，不要把端口发布到 `0.0.0.0`，在本地终端做 SSH 转发后按同样方式打开：

```bash
ssh -N -L 4310:127.0.0.1:4310 <用户>@<远程主机>   # 然后在本地浏览器打开 http://127.0.0.1:4310
```

### 第 5 步：配置模型并开始第一次任务

镜像不内置任何模型。首页的「配置模型」入口指向 **系统设置 → 模型注册表**：新建一个模型连接、填入服务商 API Key 并保存，再在 **全局默认值** 中把它设为任务模型。之后创建项目、发起第一次会话，见[快速开始教程](quick-start.md)。容器直接向模型服务商出站；需要经代理访问或模型服务跑在宿主机上时，见[常见问题](#常见问题)。

### 在 JiuwenSwarm 上运行智能体

镜像已经内置了 JiuwenSwarm 与适配器，且**默认**就跑在它上面，无需任何配置。首次启动会在 `./data` 下创建实例，和其他数据一样能挺过 `docker compose down` 和镜像重建。公共端口由适配器提供服务，未迁移的路由会代理到其后的 API（默认端口 +100）；浏览器地址和令牌流程不变。公共端口上的 `GET /agent/info` 会说明当前跑的是哪个后端。

想改回原生循环，给容器命令加上 `--no-jiuwenswarm`：

```yaml
# docker-compose.override.yml
services:
  sciencediscovery:
    command: ["--no-jiuwenswarm"]
```

```bash
docker compose up -d
```

### 日常管理

| 操作 | 命令 | 说明 |
|---|---|---|
| 看日志 | `docker compose logs -f` | 启动顺序 runner → API；登录链接与沙箱告警都在这里 |
| 看状态 | `docker compose ps` | 含健康检查结果 |
| 停止 | `docker compose down` | 删除容器与网络；`./data` 保留 |
| 重启 | `docker compose restart` | 不重建镜像 |
| 更新代码后 | `docker compose up -d --build` | 重建镜像并重建容器；数据与令牌保留 |
| 改了 `.env` 后 | `docker compose up -d` | Compose 发现服务配置变化会自动重建容器 |
| 进入容器 | `docker compose exec sciencediscovery sh` | 以 `node` 用户进入 `/app` |
| 完全重置 | `docker compose down && rm -rf data` | 删除全部项目、会话、令牌与模型凭证 |

### 数据目录

宿主目录 `./data` 以 bind mount 挂载到 `/app/data`，是唯一的持久化位置，布局与宿主机安装的[存储布局](../reference/configuration.md#存储布局)一致。**不使用任何 Docker 命名卷**：每个 project、session、工作区、凭证与审计记录都是宿主上的普通文件，可直接查看、备份与删除，并且在 `docker compose down` 和镜像重建后依然存在。备份就是备份整个目录。

如果宿主机上已有用于本地安装的 `data/`，想让容器状态与之分开，在 `.env` 中设置 `SCIENCE_AGENT_DATA_HOST_DIR` 即可，例如 `SCIENCE_AGENT_DATA_HOST_DIR=./docker-data`，不需要改 `docker-compose.yml`；新目录同样要先 `mkdir -p`。

容器默认以 uid/gid `1000:1000` 运行。如果你的账号 id 不同，请在 `.env` 中设置 `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID`（`id -u`、`id -g`）并重建容器；否则入口脚本会立即以明确的「目录不可写」提示退出，而不是在更深处失败。

有两处与宿主机安装不同：

- uv 管理的 Python 环境**不**写入数据目录，而是烘焙在镜像的 `/opt/sciencediscovery/envs/{gateway,paper}` 中。这样 bind mount 只保存应用状态，全新的 `compose up` 也无需联网。
- 固定版本 micromamba 烘焙在 `/opt/sciencediscovery/provisioner/micromamba`，空数据目录首次启动时播种到数据目录下的 `scientific-envs/bin/micromamba`，即容器内 `/app/data/scientific-envs/bin/micromamba`、宿主侧 `./data/scientific-envs/bin/micromamba`。显式设置 `SCIENCE_AGENT_PROVISIONER_PATH` 时不播种，Runner 继续使用该管理员覆盖路径。

### 同机运行多个实例

默认单实例不需要任何额外设置：`docker compose up -d` 用当前目录名作为 Compose 项目名，发布在 `127.0.0.1:4310`。

要在同一台机器上再跑一个实例，给它自己的 **Compose 项目名**、**发布端口**和**数据目录**即可。服务没有写死 `container_name`，容器名与默认网络名都由项目名派生，所以改项目名就能把两个实例隔开：

```bash
mkdir -p data-b               # 第二个实例的数据目录也要先建，否则 Docker 会以 root 创建它
COMPOSE_PROJECT_NAME=sciencediscovery-b \
SCIENCE_AGENT_PUBLISH_PORT=4320 \
SCIENCE_AGENT_DATA_HOST_DIR=./data-b \
  docker compose up -d
```

把这三个变量写进一个独立的 env 文件更省事，之后每条命令都带上它：

```bash
docker compose --env-file .env.b up -d
docker compose --env-file .env.b ps
docker compose --env-file .env.b down
```

注意：

- 项目名决定容器名（`<项目名>-sciencediscovery-1`）和默认网络名；`docker compose -p <项目名> ...` 与 `COMPOSE_PROJECT_NAME` 等价。
- 每个实例必须有自己的 `SCIENCE_AGENT_DATA_HOST_DIR`。数据目录承载全部状态，两个实例共用会互相覆盖；令牌也按实例各自生成。
- 每个实例必须有自己的 `SCIENCE_AGENT_PUBLISH_PORT`，宿主端口重复时 `up` 会报 `port is already allocated`。
- 两个实例从不同代码树构建时，分别设置 `SCIENCE_AGENT_IMAGE`，避免后构建的镜像覆盖同一个 tag。
- 后续所有管理命令都要带同一个项目名或同一个 env 文件，否则 `docker compose ps` / `down` 操作的是另一个实例。
- 多实例不需要、也不应该放宽任何安全配置：`security_opt` 保持下表三项，不要改用 `privileged`。

### 环境变量

Docker 部署的变量分三层；放错层就会「设了没效果」。

**编排层**：只被 Compose 读取，决定容器怎么起，不进入容器环境。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | 当前目录名 | 容器名与网络名的前缀（`<项目名>-sciencediscovery-1`）；同机多实例靠它隔离 |
| `SCIENCE_AGENT_IMAGE` | `sciencediscovery:local` | 构建并运行的镜像 tag |
| `SCIENCE_AGENT_DATA_HOST_DIR` | `./data` | bind mount 到 `/app/data` 的宿主目录 |
| `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID` | `1000` | 容器进程的 uid/gid，必须能写数据目录 |
| `SCIENCE_AGENT_PUBLISH_HOST` | `127.0.0.1` | 发布到的宿主网卡；`0.0.0.0` 会把服务暴露到网络 |
| `SCIENCE_AGENT_PUBLISH_PORT` | `4310` | 映射到容器 4310 的宿主端口 |

**容器层**：`.env.docker.example` 里其余的键，由 `docker-compose.yml` 的 `environment` 块逐个转发进容器；留空等于使用内置默认值。完整清单与默认值见[配置参考的 Docker 环境变量](../reference/configuration.md#docker-环境变量)，最常用的几项：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SCIENCE_AGENT_AUTH_TOKEN` | 首次启动生成 | 浏览器 / API 的本地服务访问令牌 |
| `SCIENTIFIC_ENVS` | `1` | 托管科学环境，含首次启动的 starter Python 创建；`0` 关闭 |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | 托管环境允许的 conda 渠道，逗号分隔 |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | 空 | 预置的离线包缓存；设置后环境创建不再联网 |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `7200000` | 单次沙箱执行的墙钟上限 |
| `SCIENCE_AGENT_LOG_LEVEL` | `INFO` | 运行日志级别；日志落在 `./data/logs/` |
| `SCIENCE_AGENT_CONTEXT_*` | 内置默认 | 上下文装配的模式与预算，见[上下文装配](../../en/developer-docs/context-assembly.md) |
| `SCIENCE_AGENT_SSH_CONFIG_PATH` | 空 | 远程 runner 的 SSH 配置文件（容器内路径，放在 `./data/ssh` 下即可） |
| `SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED` | `true` | 用量看板的汇率换算；无法访问公网汇率源的部署可关闭 |

**镜像层**：`Dockerfile` 固定、不应通过 `.env` 改的值——`SCIENCE_AGENT_DATA_DIR=/app/data`、`SCIENCE_AGENT_HOST=0.0.0.0`、`SCIENCE_AGENT_PORT=4310`、runner 的 `127.0.0.1:4311`，以及镜像内 Python 环境、模型目录快照与 micromamba 的路径。要换宿主端口改 `SCIENCE_AGENT_PUBLISH_PORT`，不要改 `SCIENCE_AGENT_PORT`。

其他没有列出的变量（例如 `HTTP_PROXY`、`SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS`）不会自动进入容器。需要时新建 `docker-compose.override.yml`，把它们追加到服务的 `environment` 块，Compose 会自动合并：

```yaml
services:
  sciencediscovery:
    environment:
      HTTPS_PROXY: "http://proxy.example:3128"
      NO_PROXY: "127.0.0.1,localhost"
```

### 沙箱与宿主要求

容器**不**替代、也不削弱 bubblewrap 沙箱——agent 的 Python/R/shell 仍在 `bwrap` 下运行，保留独立命名空间与 seccomp 过滤；除非管理员配置了沙箱网络的域名允许列表，否则完全无网络。即使开启允许列表，沙箱仍然独占一个空的网络命名空间，只能经 Runner 的 egress gateway 出站。bubblewrap 需要创建用户命名空间、在其中挂载并新建 procfs，而 Docker 的默认安全配置会阻止这些，因此 Compose 服务放开以下三项，不多给任何权限：

| 配置 | 为什么需要 |
|---|---|
| `seccomp=unconfined` | Docker 默认 seccomp 配置只对持有 `CAP_SYS_ADMIN` 的容器放行 `mount` / `pivot_root`，而 bubblewrap 需要在自己的命名空间内调用它们 |
| `apparmor=unconfined` | Debian/Ubuntu 宿主上的 `docker-default` AppArmor 配置直接拒绝 `mount` |
| `systempaths=unconfined` | 放开 Docker 对 `/proc`、`/sys` 的默认只读与屏蔽路径（readonlyPaths / maskedPaths）。没有它，内核会拒绝 bubblewrap 在沙箱自己的 pid 命名空间里挂载新的 procfs（报 `Can't mount proc on /newroot/proc: Operation not permitted`），产品只能回退成绑定容器的 `/proc` |

不增加任何 capability，也不使用 `privileged: true`，不挂载 Docker socket。这三项放松的是**容器**边界，而不是 agent 沙箱：请把该容器视为可信的本地软件，与宿主机安装的定位一致。

**若未放开 `systempaths`（例如沿用旧版 Compose、裸 `docker run` 或 K8s 默认配置）**：产品会自动回退为 `--ro-bind /proc /proc`，执行仍可进行，但沙箱内看到的是**容器的进程列表**，而不是只有自己的进程。回退时 runner 启动日志与预检都会打印明确 warning，说明原因与影响。要恢复更强的隔离，请加回 `systempaths=unconfined`，不要改用 `privileged`。

探针失败时，API 与 UI 仍可正常启动、`GET /health` 仍会反映 runner 状态，但每次 `run_shell` 都会失败。入口脚本与 runner 都会在 `docker compose logs` 中打印明确告警，并附上 bubblewrap 自己的失败行——先读那一行，它指明了被拒绝的是哪一步。

按以下顺序排查，不要跳过前两项直接改内核参数：

1. **Compose 的 `security_opt` 是否被删改。** 上表三项缺一都会让探针失败：缺 `seccomp` / `apparmor` 表现为无法创建命名空间，缺 `systempaths` 表现为 `Can't mount proc on /newroot/proc`。
2. **宿主的 AppArmor 配置。** Ubuntu 24.04+ 默认限制无特权用户命名空间，但这项限制是**按 profile 配置**的：`/etc/apparmor.d/` 下可以为具体程序授予 `userns create`，容器运行时也可以带自己的 profile。因此 `kernel.apparmor_restrict_unprivileged_userns` 为 1 并不等于沙箱不可用——本项目在该值为 1 的 Ubuntu 24.04 宿主上探针照常通过。**只要探针通过，就不需要改这个值。**
3. **内核开关，仅在前两项排除后作为最后手段。** 它需要 root，并且不持久：

   ```bash
   sysctl kernel.unprivileged_userns_clone             # 暴露该开关的内核上应为 1
   sysctl kernel.apparmor_restrict_unprivileged_userns # 为 1 时结合上一条判断，不要仅凭它下结论
   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # 确认探针确实因它失败后再执行
   ```

### 常见问题

**`docker compose build` 报 `TARGETARCH is required to select the managed micromamba release`。** 构建没有走 BuildKit：用的是旧的 `docker-compose` v1，或设置了 `DOCKER_BUILDKIT=0`。改用 Docker 24+ 自带的 `docker compose`，或显式 `DOCKER_BUILDKIT=1 docker compose build`。

**构建在下载阶段失败或极慢。** 先看失败的是哪个 stage：`micromamba` 阶段访问 GitHub Releases，`model-catalog` 阶段访问 `models.dev`（不可达时该阶段会以 `test -s` 失败，看起来像仓库坏了，其实是网络），`builder` 阶段访问 npm registry 与 PyPI，`runtime` 阶段访问 Debian apt 源。网络恢复后直接重跑，已完成的层会复用。需要代理时不用改 `Dockerfile`：`docker compose build --build-arg HTTP_PROXY=http://proxy.example:3128 --build-arg HTTPS_PROXY=http://proxy.example:3128`（BuildKit 预定义参数），或在 Docker 客户端配置文件里配置 `proxies`。

**容器启动即退出，日志是 `The data directory /app/data is not writable by uid …, gid …`。** 容器进程的 uid/gid 写不进宿主数据目录。两种常见原因：你的账号 id 不是 1000，把 `id -u` / `id -g` 写进 `.env` 的 `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID`；或者数据目录是 Docker 在 `up` 时以 root 自动创建的（bind mount 源不存在），删掉它后 `mkdir -p data` 再来。改完执行 `docker compose up -d` 让 Compose 重建容器。`restart: on-failure:3` 会先重试三次，之后 `docker compose ps` 显示 `Exited`。

**`up` 报 `Bind for 127.0.0.1:4310 failed: port is already allocated`。** 宿主端口已被占用，常见于同一台机器已经跑着另一个 ScienceDiscovery。改 `.env` 的 `SCIENCE_AGENT_PUBLISH_PORT`，不要去停别人的服务；之后登录链接里的端口也相应替换。

**找不到登录链接或令牌。** 日志被滚掉或容器已重启过：`docker compose logs | grep -A 2 'Open to sign in'`，或直接在宿主上 `cat ./data/secrets/auth-token`。令牌保存在数据目录里，重启容器不会更换（日志会写 `restored from local storage`）；删除数据目录或换 `SCIENCE_AGENT_DATA_HOST_DIR` 才会重新生成。

**浏览器提示「本地服务访问令牌被拒绝」。** 粘贴的不是这个实例当前的令牌：填成了模型 API Key，或复制自另一个实例 / 另一个数据目录，或数据目录重建后令牌已变。以 `./data/secrets/auth-token` 的内容为准重新粘贴。

**`/health` 返回 `"status":"degraded"`，`runner.status` 为 `unavailable`。** runner 没起来或已退出。看 `docker compose logs` 里第一条错误；容器内任一进程退出时入口会带着它的状态码停掉整个栈，Compose 再按 `on-failure` 重启。

**日志出现 `WARNING: bubblewrap cannot create a sandbox in this container`。** 沙箱探针失败：API 与 UI 正常，但每次 `run_shell` / `run_python` 都会失败。按[沙箱与宿主要求](#沙箱与宿主要求)的顺序排查——`security_opt` 三项、宿主 AppArmor profile、最后才是内核开关；不要改用 `privileged`。

**runner 启动日志说回退为绑定容器的 `/proc`。** Compose 里缺了 `systempaths=unconfined`（常见于自己改写的 `docker run` 或 K8s 清单）。执行仍能进行，但沙箱能看到容器的进程列表；加回该项即可恢复独立 procfs。

**模型连不上：超时、`ECONNREFUSED`，或必须经代理。** 三种做法：在 **系统设置 → 网络代理** 添加一条 `custom_url` 代理并设为全局默认，不用重启容器；或者用上面的 `docker-compose.override.yml` 给容器注入 `HTTPS_PROXY` 等变量，`up -d` 后在代理设置里选 `environment` 类型（详见[配置网络代理](../advanced-setup/configure-network-proxy.md)）。模型服务跑在宿主机本身（例如本机的 Ollama）时，容器里的 `127.0.0.1` 指向容器自己：在 override 文件里给服务加 `extra_hosts: ["host.docker.internal:host-gateway"]`，模型地址填 `http://host.docker.internal:<端口>`，或者直接填宿主的局域网 IP。

**首次启动后 CPU 一直很高，`./data` 涨到约 2 GB，进程里有 `micromamba`。** 正常：starter Python 科学环境正在后台创建，完成后 `/health` 的 `runner.scientificEnvs.startersReady` 变为 `true`。conda-forge 访问慢时把 `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` 指向镜像站（内置的清华、中科大镜像地址 Runner 始终接受）；离线环境预先填充 `SCIENCE_AGENT_PACKAGE_CACHE_DIR`；完全不需要托管环境就设 `SCIENTIFIC_ENVS=0`。

**`docker compose ps` 长时间 `health: starting`，或变成 `unhealthy`。** 健康检查是容器内的 `curl http://127.0.0.1:4310/health`，`start_period` 为 60 秒，超过后仍不健康说明 API 没起来，看日志。宿主特别慢（例如 QEMU 模拟的架构）时入口等待 runner 的 60 秒上限可能不够，用 override 文件设置 `SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS` 加大。

**第二个实例起不来。** 逐项对照[同机运行多个实例](#同机运行多个实例)：它的数据目录是否先 `mkdir -p`（否则同上面的「目录不可写」）、发布端口是否重复、项目名是否与第一个不同；管理命令是否带了同一个项目名。

**Runner 版本显示 `unknown`。** 预期行为：镜像构建上下文不含 Git 元数据，`pnpm build` 写不出 commit 标识。不影响功能，只影响远程 runner 的版本对比提示。

**磁盘被镜像和构建缓存占满。** `docker image ls sciencediscovery` 查看镜像，`docker builder prune` 清构建缓存，`docker image prune` 清悬空镜像；`./data` 里的 `scientific-envs/` 可通过系统设置删除不再使用的环境版本。

### 限制

- 单用户，信任模型与宿主机安装一致：一个静态 bearer token、无 TLS、无多用户账号。默认只发布到 `127.0.0.1`，因为 Docker 发布的端口会绕过宿主上大多数防火墙规则；只有在可信网络中才设置 `SCIENCE_AGENT_PUBLISH_HOST=0.0.0.0`，并请先更换 token。
- 镜像中不含任何 API token、模型凭证或宿主 `.sciencediscovery-data/` 内容——`.dockerignore` 排除了 `.sciencediscovery-data/`、`.env`、`node_modules/`、构建产物与本地缓存。凭证只通过 Compose 环境变量和 bind mount 的数据目录进入容器。
- 镜像已包含固定版本 micromamba，运行时不再为该二进制访问 GitHub；但本迭代**没有**打包 starter Python/R 科学环境或 conda package cache。首次创建 starter Python 仍需访问允许的软件包渠道；只有另行填充并设置 `SCIENCE_AGENT_PACKAGE_CACHE_DIR` 后，软件包解析才可离线进行。
- 镜像不含 memory-graph 与 evolve 两个 Python 边车的环境，`start-stack.sh --mode docker` 也不会启动它们：ScienceMemory 图谱在 Docker 中保持关闭（`/health` 的 `memoryGraph` 为 `disabled`，开启后只会变成 `degraded`），进化搜索无法启动。需要这两项功能时使用本地模式或二进制部署。
- 该镜像是便捷封装，不是经过加固的多租户部署；单静态 bearer token、无 TLS、runner 无 CPU/内存配额等安全边界不因容器化而改变。

### 生成 micromamba 双架构发布包

以下脚本生成两套独立 Linux 包，并在输出目录写入版本文件与 tarball 校验清单：

```bash
./scripts/package-micromamba-release.sh --output dist/micromamba-release
sha256sum --check dist/micromamba-release/SHA256SUMS
```

默认产物为 `sciencediscovery-micromamba-<版本>-linux-x86_64.tar.gz` 与 `sciencediscovery-micromamba-<版本>-linux-aarch64.tar.gz`。每个包只含 `bin/micromamba` 和记录目标架构、上游文件名及二进制 SHA256 的 `manifest.json`；输出目录另含 `VERSION`、`SHA256SUMS`。脚本**不会**创建或收集 starter Python/R 环境、conda 软件包缓存或其他 Python 树。

可用 `--arch x86_64` / `--arch aarch64` 只生成一种架构，或用 `--dry-run` 在不下载的情况下核对版本、URL 与 SHA256。受限构建机也可先按发布清单准备两个原始二进制，再通过 `--source-dir <目录>` 进行本地校验与打包。
