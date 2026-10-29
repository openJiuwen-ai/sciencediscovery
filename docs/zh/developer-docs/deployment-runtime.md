# 部署运行机制

本文记录本地源码模式、Docker 和远端 Runner 部署中不适合放在用户部署教程里的实现细节。用户操作步骤见[部署指南](../getting-started/deployment.md)。

## 本地源码模式启动链

本地模式通过：

```bash
scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

启动。

启动器会：

1. 读取仓库根目录 `.env`；
2. 检查依赖；
3. 按需安装与构建；
4. 在 Linux 选择 Bubblewrap，在 macOS 选择 Seatbelt；
5. 启动 JiuwenSwarm、adapter、API/Web 和 Runner 所需组件；
6. 打印 `Open to sign in` 链接与本地服务访问令牌。

历史入口 `./scripts/run-local.sh [--no-build]`、`pnpm start` 与 `pnpm server` 继续作为兼容入口。

公共 HTTP 入口为 4310。当前进程边界与端口职责见[整体运行时架构](architecture.md)。

首次启动还会准备 gateway Python 环境和固定版本 micromamba。精确数据路径见[配置参考](../reference/configuration.md)。

## 远端 Runner 自动部署

SSH 自动部署使用自带 Node runtime 的 Runner SEA 单文件，因此远端机器不需要预装 Node。

Linux 本地完整构建、Docker 构建和发行打包会准备 Linux x64/arm64 的 Runner SEA。只做局部构建时，在完成 Runner/Executor 构建后运行：

```bash
pnpm runner:binary
```

生成文件位于：

```text
services/runner/dist/sea/
```

这些文件随产品发布，不提交到源码仓。

连接远端时：

1. 根据远端 `uname -m` 选择对应架构；
2. 通过已鉴权并校验主机指纹的 SSH SFTP 上传；
3. 上传后校验 SHA-256；
4. 发布并直接启动；
5. 同一构建已存在时直接复用；
6. Runner HTTP 通信仍只经过 SSH 隧道。

Runner SEA 包含 Node 与 Runner 代码，但不是完整 Linux 用户态。远端仍需要：

- 能运行该 Node ELF 的系统库；
- Bubblewrap；
- 可用的沙箱内核能力。

科学环境仍由托管环境机制准备。缺少部署或沙箱条件时应明确失败，不降级为裸 SSH 执行。

### Runner 二进制生命周期

每份远端 Runner 以自身 SHA-256 命名。

主程序升级后重新连接会新增一个文件，不覆盖旧文件。新 Runner 启动并通过健康检查后，控制面会尽力清理同目录中：

- 同样按 SHA-256 命名；
- 当前没有任何进程执行；

的旧 Runner 文件。

正在使用的 Runner 永远保留。其他不符合该命名规则的文件不受影响。清理失败只记录日志，不影响已建立连接。

## 重启后的执行恢复与资源隔离

连接断开不等于命令已经失败。保留原 Execution ID，通过 `execution_status` / `execution_logs` 查询同一次执行；不要通过重新提交命令来探测原任务结果。

Runner 启动时区分两类情况：

- **有持久化证据的结果发布中断：** 发布日志可能保存原执行身份、进程终止证据、不可变结果和工作区版本。Runner 校验这些证据及其 CAS 引用闭包后完成发布，不重新执行命令。查询期间可能暂时返回 `EXECUTION_RECOVERY_PENDING`（503）。已经能读取终态结果，不代表遗留的工作区写入保护已经解除。
- **执行状态未知或工作区未安全提交：** 无法确认进程终止或工作区安全提交时，Runner 隔离受影响资源。使用这些资源的新提交返回 `EXECUTION_RESOURCE_QUARANTINED`（409）。这是安全边界，不是在提示换一个 ID 重试；再次重启也不会解除仍未确认的执行隔离。

告警 `execution_resources_quarantined` 标出 `executionId`、隔离范围与 `phase`（`startup`、`runtime` 或 `publication-recovery`）。同一 Runner 管理器生命周期内，相同执行、阶段和资源范围的重复通知会去重。`workspace-and-devices` 范围包含 SHA-256 `workspaceKeyHash` 和 NPU 设备序号，不记录原始工作区路径、命令、输出或远端错误。`runner` 范围表示旧记录缺少可信的工作区／设备范围，因此该 Runner 全局阻止新提交。此告警描述资源隔离保护，不表示恢复已经失败；随后经过验证的发布恢复可能修复它。日志记录失败不会放宽任务准入。比对 `workspaceKeyHash` 时，应对 Runner 实际使用的规范化 `workspaceKey` 原文按 UTF-8 字节计算 SHA-256，并比对小写十六进制摘要；不得追加换行，也不能使用另一种路径拼写。通过授权检查获取规范化键，不要从用户输入的路径别名猜测。在 Linux 上，将该精确 UTF-8 键保存到 shell 变量 `workspaceKey` 后，执行 `printf '%s' "$workspaceKey" | sha256sum`，将输出首列与日志摘要比对。摘要虽不是明文路径，仍可被关联并可能留存在日志中，应遵守相同的运维访问与保留控制。

### 运维的安全处理顺序

1. 停止向受阻范围反复提交新任务。保留原 ID、Runner 身份、执行账本及 SQLite 配套文件、CAS 对象和引用、工作区数据及相关日志。备份应采用保证一致性的方式；仅复制正在使用的 SQLite 主文件不是完整的恢复备份。
2. 通过原授权身份查看已有执行和日志，关联告警与当前状态，并由运维核查原主机／进程和存储状态。连接不可用或未经验证的 PID 都不能证明进程已经终止；不要仅因观察失败就杀掉或重放任务。
3. 存在有效发布证据时，让 Runner 完成校验，再查询同一 ID。证据丢失／损坏、工作区历史冲突或遗留写入保护都需要调查；不要伪造 receipt 或删除保护标记来强行成功。
4. 执行仍为未知时，继续保持隔离，携带保留的证据升级处理。**目前没有受支持的手动解锁／重置 API，也没有运维解除隔离流程。** 即使运维在外部确认进程已经停止，也不会自动清除持久化的未知状态。不要修改／删除账本记录、删除数据或 CAS、重置 Runner 身份或更换数据目录来绕过准入。

范围可信时，真正独立的新工作可以使用未受影响的工作区，且不得使用被隔离的 NPU 设备，仍须通过正常权限检查。它不能与未确认任务共享可变文件、设备或外部副作用；只更换工作区名称或执行 ID 不是安全的重放方案。范围未知的旧记录会阻止该 Runner 上的全部新提交。

### 没有 receipt 的旧执行 ID

旧版本保存的无 receipt 执行仍可由原授权身份查询。使用相同 ID 再次 `POST` 会返回 `EXECUTION_ID_CONFLICT`（409），即使调用方认为请求完全相同：缺少原始不可变请求摘要时，Runner 无法证明两次提交等价。应继续查询原 ID，而不是反复提交或为同一任务另取新 ID。对于 receipt 有效的记录，相同请求可直接返回已有执行；请求或所属身份变化仍会冲突。这一兼容性边界没有提供解除资源隔离的途径。

## Docker 构建与运行时差异

Docker 镜像将服务运行环境预构建进镜像，并把应用状态放在宿主 bind mount 的数据目录。

与宿主本地模式相比：

- gateway/paper Python 环境位于镜像内的 `/opt/sciencediscovery/envs/`；
- 固定 micromamba 位于镜像内 `/opt/sciencediscovery/provisioner/micromamba`；
- 空数据目录首次启动时会把 micromamba 播种到 `/app/data/scientific-envs/bin/micromamba`；
- 项目、会话、凭据、工作区和审计记录仍全部写入 `/app/data`。

完整 Docker 环境变量及宿主 bind mount 对应关系见[配置参考](../reference/configuration.md#docker-环境变量)。

## Docker 多实例

同机多实例依靠三项彼此隔离：

- Compose 项目名；
- 发布端口；
- 数据目录。

例如：

```bash
mkdir -p data-b

COMPOSE_PROJECT_NAME=sciencediscovery-b \
SCIENCE_AGENT_PUBLISH_PORT=4320 \
SCIENCE_AGENT_DATA_HOST_DIR=./data-b \
  docker compose up -d
```

或者为第二实例使用独立 env 文件：

```bash
docker compose --env-file .env.b up -d
docker compose --env-file .env.b ps
docker compose --env-file .env.b down
```

每个实例必须：

- 使用不同数据目录；
- 使用不同宿主发布端口；
- 后续管理命令保持同一项目名或 env 文件；
- 若来自不同代码树，最好使用不同 `SCIENCE_AGENT_IMAGE` tag。

不需要也不应为多实例放宽安全配置。

## Docker 沙箱边界

容器并不替代 Bubblewrap。Agent 的 Python/R/Shell 仍运行在 bwrap + seccomp 沙箱内。

官方 Compose 为了允许容器中的 Bubblewrap 正常构建内部命名空间，会放宽容器自身的三个系统限制：

| 配置 | 原因 |
| --- | --- |
| `seccomp=unconfined` | Docker 默认 seccomp 会阻止 bwrap 需要的 mount / pivot_root |
| `apparmor=unconfined` | 部分宿主的 docker-default AppArmor 会拒绝 mount |
| `systempaths=unconfined` | 允许 bwrap 在自己的 PID namespace 中挂载独立 procfs |

这些配置放宽的是**可信容器边界**，不是 Agent 沙箱本身。Compose 不增加 capability、不使用 `privileged: true`，也不挂载 Docker socket。

如果 `systempaths=unconfined` 缺失，Runner 可以回退为把容器的 `/proc` 只读绑定到沙箱；执行仍能继续，但沙箱会看到容器进程列表，隔离更弱，并产生明确 warning。

精确探针、seccomp、网络 allowlist 与 namespace 行为见[沙箱执行](sandbox-execution.md)。

## Docker 构建依赖与诊断

Docker 构建依赖 BuildKit 的 `TARGETARCH`。如果出现：

```text
TARGETARCH is required to select the managed micromamba release
```

通常说明使用了旧 `docker-compose` v1 或关闭了 BuildKit。应使用 Docker 24+ 的 `docker compose`。

构建期主要访问：

- Docker Hub；
- ghcr.io；
- Debian apt；
- npm registry；
- PyPI；
- GitHub Releases；
- models.dev。

构建代理可以使用 BuildKit 预定义参数，例如：

```bash
docker compose build \
  --build-arg HTTP_PROXY=http://proxy.example:3128 \
  --build-arg HTTPS_PROXY=http://proxy.example:3128
```

运行期模型、连接器与外部科研资源的代理应通过产品网络代理设置或 Compose 环境变量配置，而不是修改 Dockerfile。

## Docker 当前限制

当前 Docker 路径是便捷的单用户本地/受信部署方式，不是加固的多租户服务。

主要边界：

- 单静态 bearer token；
- 默认无 TLS；
- Runner 没有 CPU/内存 cgroup 配额；
- 默认只应发布到 `127.0.0.1`；
- 镜像不包含用户 API token、模型凭据或宿主数据目录内容；
- starter Python/R 环境与 conda package cache 不随镜像完整预装，首次创建仍可能需要软件包源；
- 镜像包含 adapter、memory-graph 和 evolve 的 Python 环境；启动脚本按需启动相应服务。实际可用状态以 `/health` 为准。

## Ascend NPU

Ascend Host Broker、设备选择、白名单 workload 和托管环境要求已有独立设计文档，不在部署教程重复：

- [Ascend NPU Runner](ascend-npu-runner.md)
- [Sandbox execution](sandbox-execution.md)
- [Configuration reference](../reference/configuration.md)
