# 部署 ScienceDiscovery

如果你只是第一次使用 ScienceDiscovery，请优先看[快速开始](quick-start.md)。本文面向需要选择其他部署方式、长期运行服务，或排查启动问题的用户。

## 选择部署方式

| 方式 | 支持平台 | 适合谁 | 推荐程度 |
| --- | --- | --- | --- |
| 预编译单文件 | Linux x86_64 / aarch64 | 想最快启动的普通用户 | **推荐** |
| 本地源码模式 | Linux x86_64 / aarch64、macOS x64 / arm64 | macOS 用户、开发调试、需要改源码的用户 | 推荐 |
| Docker | Linux x86_64 / aarch64 | 已有容器环境、希望隔离运行和方便运维的用户 | 按需 |

三条路径互相独立，选一条即可。服务启动成功后，后续的模型配置和第一次任务都回到[快速开始](quick-start.md)。

---

## 预编译单文件部署（Linux）

### 前置条件

- Linux x86_64 或 aarch64；
- Bubblewrap；
- 可访问互联网完成首次启动依赖准备；
- 至少一个模型服务商 API Key。

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

可以直接运行下载文件，也可以先重命名：

```bash
mv ScienceDiscovery-<version>-linux-<architecture> ScienceDiscovery
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
- 希望修改源码或调试的用户；
- 不使用预编译 Linux 单文件的环境。

### 前置条件

两种平台都需要：

- Node.js 22.19+；
- pnpm 11.1.2；
- Python 3；
- uv 0.9+；
- Git；
- curl。

沙箱要求：

- Linux：Bubblewrap 0.6+，推荐 0.8+；
- macOS：使用系统自带 Seatbelt，不需要 Bubblewrap。

### 获取源码并启动

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery
git checkout feat/jiuwenswarm

scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

第一次启动会安装依赖并构建项目，需要联网。

后续已经构建完成时可以使用：

```bash
./scripts/start-stack.sh --mode local --no-build
```

启动成功后，终端同样会打印 `Open to sign in` 链接。

### macOS 注意事项

macOS 当前仅支持本地源码模式，不支持直接运行 Linux 单文件，也不支持本文的 Linux Docker 路径。

如果启动时报 Seatbelt 不可用，先确认：

```bash
test -x /usr/bin/sandbox-exec
```

若该命令失败，或当前终端本身运行在更严格的沙箱中，请先解决宿主环境限制。

---

## Docker 部署（Linux）

Docker 适合已经使用容器运维、希望将运行环境与宿主隔离的用户。

### 前置条件

- Linux x86_64 或 aarch64；
- Docker Engine 24+；
- Docker Compose v2；
- 足够的磁盘空间用于镜像、构建缓存和科学计算环境；
- 构建阶段可访问 Docker Hub、npm、PyPI 等依赖源。

> macOS / Windows Docker Desktop 不是当前支持路径。代码执行沙箱依赖 Linux 内核能力。

### 1. 准备配置和数据目录

在仓库根目录执行：

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

```bash
docker compose build
docker compose up -d
```

检查状态：

```bash
docker compose ps
curl -fsS http://127.0.0.1:4310/health
```

正常情况下，健康接口的顶层 `status` 应为 `ok`。

如果状态为 `degraded`，先查看日志：

```bash
docker compose logs --tail=200
```

### 3. 打开 Web UI

查看启动日志中的登录链接：

```bash
docker compose logs | grep -A 2 'Open to sign in'
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

`docker compose down` 不会删除宿主上的 `data/`。

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

`degraded` 通常表示代码执行侧没有正常启动。检查启动日志，并确认沙箱依赖满足要求。

### Linux 提示缺少 `bwrap`

安装 Bubblewrap：

```bash
sudo apt-get install -y bubblewrap
# 或
sudo dnf install -y bubblewrap
```

如果已经安装但仍失败，可能是宿主禁止无特权用户命名空间。详细机制见[沙箱执行设计](../developer-docs/sandbox-execution.md)。

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

### `data/` 不可写

确认目录在 `docker compose up` 之前已经创建，并且 uid/gid 与 `.env` 配置一致：

```bash
ls -ld data
id -u
id -g
```

### 容器启动了，但 `/health` 是 `degraded`

先查看：

```bash
docker compose logs --tail=200
```

常见原因是宿主不支持容器内的沙箱能力。

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
