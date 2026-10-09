# 部署 ScienceDiscovery

如果你只是第一次使用 ScienceDiscovery，请优先看[快速开始](quick-start.md)。本文面向需要选择其他部署方式、长期运行服务，或排查启动问题的用户。

## 选择部署方式

| 方式 | 支持平台 | 适合谁 | 推荐程度 |
| --- | --- | --- | --- |
| 预编译单文件 | 使用 glibc 的 Linux x86_64 / aarch64、Windows x64（使用 glibc 发行版的 WSL 2，实验性） | 想最快启动的普通用户 | **原生 Linux 推荐** |
| 本地源码模式 | Linux x86_64 / aarch64、macOS 13+ x64 / arm64、Windows x64（WSL 2，实验性） | macOS 用户、开发调试、需要改源码的用户 | macOS 推荐 |
| Docker | Linux x86_64 / aarch64；macOS（Docker Desktop 或已有 Docker 引擎，实验性）；Windows（Docker Desktop，实验性） | 已有容器环境、希望隔离运行和方便运维的用户 | 按需 |

macOS Docker 和所有 Windows 安装路径目前作为**实验性**方式提供，
其 Agent 运行效果尚未经过全面验证。

三条路径互相独立，选一条即可。服务启动成功后，后续的模型配置和第一次任务都回到[快速开始](quick-start.md)。

---

## 预编译单文件部署（Linux）

### 前置条件

- 使用 glibc 的 Linux x86_64 或 aarch64，包括 Windows x64 上符合条件的
  WSL 2 发行版。内置 Node.js 运行时要求 glibc 2.28+，且需要兼容的 libstdc++；
- Linux 环境需能运行 Bubblewrap，并允许非特权用户命名空间；
- 可访问互联网完成首次启动依赖准备；
- 至少一个模型服务商 API Key。

此发行包不能直接在 Alpine Linux 等使用 musl 的发行版上运行。

Windows 用户请在 WSL 2 Linux 发行版中执行本节命令。
请将下载的文件放在发行版的 Linux 文件系统中，例如用户主目录。
如果文件由 Windows 浏览器下载，先打开 WSL 2 的 Linux 终端（例如 Ubuntu），
在其中运行 `cd ~ && explorer.exe .`。Windows 文件资源管理器会打开
Linux 用户主目录，再将下载文件复制进去。

安装 Bubblewrap：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# 或
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
```

### 下载并启动

从 [Releases 页面](https://github.com/openJiuwen-ai/sciencediscovery/releases)下载与你的架构匹配的文件：

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
```

可以直接运行下载文件，也可以先重命名。在下载文件所在目录，
如果对应架构的文件只有一个，可执行：

```bash
mv ScienceDiscovery-*-linux-"$(uname -m)" ScienceDiscovery
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

启动成功后，终端会打印 `Open to sign in` 链接。用浏览器打开即可进入 ScienceDiscovery。

### 首次启动会做什么

第一次 `serve` 会准备部分运行依赖，因此需要联网。后续启动会复用已准备好的环境。

如果主机无法联网，请在联网环境提前准备数据目录，或配置可访问的软件源。相关变量见[配置参考](../reference/configuration.md)。

### 常用启动选项

```text
ScienceDiscovery serve [options]
```

最常用的选项：

| 选项 | 作用 |
| --- | --- |
| `--data-dir <path>` | 指定数据目录 |
| `--host <address>` | 指定 Web/API 监听地址 |
| `--port <port>` | 指定 Web/API 端口 |
| `--env-file <path>` | 从文件读取环境变量 |
| `--skip-sandbox-check` | 允许在沙箱不可用时只启动 UI；此时代码执行不可用 |

默认只监听本机。若必须对外提供服务，请先配置独立认证令牌，并只在可信网络中开放。

---

## 本地源码模式（Linux / macOS）

本地源码模式适用于：

- macOS 用户；
- 希望在 Windows 的 WSL 2 中运行 Linux 源码步骤的用户；
- 希望修改源码或调试的用户；
- 不使用预编译 Linux 单文件的环境。

### 前置条件

这些本地环境都需要：

- Node.js 22.19+；
- pnpm 11.1.2；
- `python3` 3.9+；
- uv 0.9+；
- Git；
- curl。

安装脚本会在 uv 创建 Python 3.12 环境前调用 `python3`。

沙箱要求：

- Linux（包括 WSL 2）：Bubblewrap 0.6+ 和非特权用户命名空间，推荐 0.8+；
- macOS：使用系统自带 Seatbelt，不需要 Bubblewrap。

Debian 11 默认提供的 Bubblewrap 为 0.4.1，低于上面的 Linux 版本要求。
如果使用该系统，请换用较新的软件包或发行版。

macOS 本地源码模式请使用 13 或更新版本，参见当前的
[uv 平台支持政策](https://docs.astral.sh/uv/reference/policies/platforms/#macos-versions)。

### 获取源码并启动

Windows 用户请在 WSL 2 Linux 发行版中执行以下命令。
在 WSL 2 中，请将仓库克隆到发行版的 Linux 文件系统（如用户主目录），
不要放在 `/mnt/c` 下。这样安装依赖更快，Linux 文件权限也能按预期工作。
执行下方命令前，先运行 `cd ~`。

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery

scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

源码模式现在也默认使用 JiuwenSwarm。需要旧版 Node 原生循环时，使用 `./scripts/start-stack.sh --mode local --no-jiuwenswarm`，或在 `.env` 中设置 `SCIENCE_AGENT_EXECUTOR=native`。行为差异和当前后端检查方法见 [Agent 后端](../reference/agent-backends.md)。

第一次启动会安装依赖并构建项目，需要联网。

后续已经构建完成时可以使用：

```bash
./scripts/start-stack.sh --mode local --no-build
```

启动成功后，终端同样会打印 `Open to sign in` 链接。

### macOS 注意事项

如果本地源码模式启动时报 Seatbelt 不可用，先确认：

```bash
test -x /usr/bin/sandbox-exec
```

若该命令失败，或当前终端本身运行在更严格的沙箱中，
请先解决当前运行环境的限制。

---

## Docker 部署（Linux 容器）

Docker 适合已经使用容器运维、希望通过容器隔离服务运行环境的用户。

### 前置条件

- Linux x86_64 或 aarch64；macOS 使用 Docker Desktop 时请核对其
  [当前系统要求](https://docs.docker.com/desktop/setup/install/mac-install/#system-requirements)，
  也可以使用已有的 Docker 引擎；
  Windows 使用 Docker Desktop；
- 非 Desktop 环境需要 Docker Engine 24+ 和 Docker Compose v2.15+；
- Windows 上的 Docker Desktop 需使用 Linux 容器；
- Linux 容器内需支持 Bubblewrap 和非特权用户命名空间；
- 足够的磁盘空间用于镜像、构建缓存和科学计算环境；
- 构建阶段可访问 Docker Hub、npm、PyPI、models.dev 等依赖源。

### 1. 准备配置和数据目录

如果本地还没有仓库，先克隆并进入仓库目录：

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery
```

Windows 用户在仓库根目录打开 PowerShell，执行：

```powershell
Copy-Item .env.docker.example .env
New-Item -ItemType Directory -Force data
```

Windows 上的 Docker Desktop 需运行 Linux 容器。WSL 2 后端通常默认启用；
如果 Docker 提示无法启动 Linux 容器，请检查
[Docker 的 WSL 2 设置](https://docs.docker.com/desktop/features/wsl/)。

Linux 和 macOS 用户在仓库根目录的 Unix Shell 中执行：

```bash
cp .env.docker.example .env
mkdir -p data
id -u
id -g
```

如果当前用户的 uid/gid 不是 `1000:1000`，请在 `.env` 中设置：

```text
SCIENCE_AGENT_UID=<你的 uid>
SCIENCE_AGENT_GID=<你的 gid>
```

`data/` 保存项目、会话、工作区、凭据和其他运行状态。

### 2. 构建并启动

```text
docker compose build
docker compose up -d
```

检查状态：

```text
docker compose ps
docker compose exec sciencediscovery curl -fsS http://127.0.0.1:4310/health
```

也可以在浏览器中打开 <http://127.0.0.1:4310/health>。
顶层 `status: ok` 表示 API 能连接 Runner，但不能证明代码执行沙箱可用。
登录后，请运行[快速开始](quick-start.md#3-完成第一次科研任务)中的小型 Python 计算，
确认代码执行也正常。

如果状态为 `degraded`，先查看日志：

```bash
docker compose logs --tail=200
```

### 3. 打开 Web UI

查看日志，找到 `Open to sign in` 链接：

```text
docker compose logs -f
```

在浏览器打开打印出的 `Open to sign in` 链接。

如果直接打开 <http://127.0.0.1:4310>，也可以按界面提示粘贴本地服务访问令牌。

登录链接和令牌等同于密码，请勿分享。

### 4. 日常管理

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f` |
| 停止 | `docker compose down` |
| 重启 | `docker compose restart` |
| 更新代码后重建 | `docker compose up -d --build` |
| 进入容器 | `docker compose exec sciencediscovery sh` |

`docker compose down` 不会删除项目目录中的 `data/`。

### 5. 远程主机访问

如果 ScienceDiscovery 跑在远程服务器，推荐用 SSH 转发，不要直接把服务暴露到公网：

```bash
ssh -N -L 4310:127.0.0.1:4310 <user>@<remote-host>
```

然后在本地浏览器打开 <http://127.0.0.1:4310>。

---

## 二进制与本地模式的首次启动排障

### 没有出现 `Open to sign in`

先看启动终端中最早出现的错误。很多后续错误只是前一个启动失败的结果。

### 浏览器提示令牌无效

重新打开启动日志中的 `Open to sign in` 链接。

如果手动输入令牌，请确认填写的是**本地服务访问令牌**，不是模型 API Key。

### `/health` 返回 `degraded`

执行：

```bash
curl -fsS http://127.0.0.1:4310/health
```

`degraded` 表示 API 无法连接 Runner，请先检查启动日志。
在 Linux 或 WSL 2 中，即使 `/health` 返回 `ok`，
若日志含 `could not build a sandbox`，代码执行仍会失败；
此时按下面的沙箱步骤排查。

### Linux 提示缺少 `bwrap`

安装 Bubblewrap：

```bash
sudo apt-get install -y bubblewrap
# 或
sudo dnf install -y bubblewrap
```

如果已安装但仍失败，请按下节检查沙箱。

### Bubblewrap 已安装，但代码执行失败

如果启动日志包含 `could not build a sandbox`，先查看具体错误，
再决定是否修改系统设置。在 Linux 或 WSL 2 内执行：

```bash
bwrap --version
sysctl kernel.unprivileged_userns_clone
sysctl kernel.apparmor_restrict_unprivileged_userns
```

某些内核没有其中一个 sysctl 键，这是正常情况。
若 `kernel.unprivileged_userns_clone` 存在且为 `0`，说明当前 Linux 环境禁用了非特权用户命名空间。
请检查该系统的设置，无法修改时联系系统管理员，启用后重试。
若 AppArmor 键为 `1`，且报错为权限不足，先用 `sudo aa-status` 确认 AppArmor 是否启用。
Ubuntu 24.04 及以后版本仅在该限制实际生效时配置 bwrap profile，
操作可参考 [Ubuntu 的 AppArmor 说明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007#define-bwrap-profile)。
不同 WSL 2 环境的内核策略可能不同。只有所选 profile 加载方式需要 `systemctl` 且当前不可用时，
才需要按[微软的 WSL 说明](https://learn.microsoft.com/zh-cn/windows/wsl/systemd/)启用 systemd。
探针机制见[沙箱执行设计](../developer-docs/sandbox-execution.md)。

### macOS 提示 Seatbelt 不可用

检查：

```bash
test -x /usr/bin/sandbox-exec
```

ScienceDiscovery 不会在 Seatbelt 不可用时静默降级为无沙箱执行。

### 去哪里看日志

默认日志保存在数据目录下的 `logs/`。具体路径和覆盖规则见[配置参考](../reference/configuration.md#存储布局)。

---

## Docker 常见问题

### Compose 拒绝 `systempaths=unconfined`

先运行 `docker compose version`。该选项需要 Compose v2.15+。
请更新 Compose 插件；若使用 Docker Desktop，则更新 Docker Desktop。

### macOS Docker Desktop 无法挂载项目目录

如果 Docker Desktop 报 `Mounts denied` 或 `file is not shared from the host`，
请打开 **Settings → Resources → File sharing**，添加仓库所在目录。
参见 [Docker 文件共享设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/#file-sharing)。

### `data/` 不可写

先确认 `data/` 在 `docker compose up` 前已创建。
如果日志提示权限不足，从容器内测试挂载目录：

```text
docker compose run --rm --entrypoint sh sciencediscovery -c 'id; ls -ld /app/data; touch /app/data/.write-test && rm /app/data/.write-test'
```

在 Linux 或 macOS 的 Unix Shell 中，还可以检查 uid/gid 是否与 `.env` 配置一致：

```bash
ls -ld data
id -u
id -g
```

Windows 用户先确认当前账户对项目目录中的 `data/` 有写权限，
且 Docker Desktop 可以共享该目录。Windows 账户没有可填入 `.env` 的 Linux uid/gid。
如果 Windows 目录挂载后仍不可写，可将仓库移到 WSL 2 发行版的 Linux 文件系统，
开启 Docker Desktop 的 [WSL 集成](https://docs.docker.com/desktop/features/wsl/#enable-docker-in-a-wsl-2-distribution)，
在 WSL 中运行 Compose。此时用该 Linux 用户的 `id -u`、`id -g` 值设置 `.env`，
并由该用户创建 `data/`。

### 容器启动了，但 `/health` 是 `degraded`

先查看：

```bash
docker compose logs --tail=200
```

先检查 Runner 的启动错误和 `data/` 挂载。沙箱失败时，`/health` 也可能仍为 `ok`。

如果 `/health` 为 `ok`，但代码任务失败，请检查日志中是否有
`could not build a sandbox`，并核对前述 Linux 容器要求。
Windows 用户若发现沙箱探针失败，请检查 Docker Desktop 和 WSL 是否需要更新。

### 模型或外部资源无法访问

容器需要直接访问模型服务商、文献源和其他外部服务。若环境需要代理，请配置[网络代理](../advanced-setup/configure-network-proxy.md)。

---

## 部署成功后

服务启动以后，不需要继续阅读部署细节。回到[快速开始](quick-start.md)：

1. 配置模型；
2. 创建 Project 和 Session；
3. 跑第一次科研任务；
4. 确认代码执行和 Artifact 正常。

## 进一步阅读

- CLI 命令与精确行为：[CLI 参考](../reference/cli.md)
- 精确环境变量、端口和数据目录：[配置参考](../reference/configuration.md)
- 单文件发行包如何构建：[开发者文档：二进制打包与发行](../developer-docs/binary-packaging.md)
- 本地/Docker/远端 Runner 的内部部署机制：[开发者文档：部署运行机制](../developer-docs/deployment-runtime.md)
- 沙箱隔离和执行机制：[开发者文档：沙箱执行](../developer-docs/sandbox-execution.md)
- 系统内部进程与模块边界：[开发者文档：整体架构](../developer-docs/architecture.md)
- 仓库布局和源码入口：[开发者文档：仓库布局](../developer-docs/repository-layout.md)
