# 沙箱执行：services/runner

Runner 是无 root 的代码执行器：所有 `run_python` / `run_r` / `run_shell` 都在 bubblewrap + seccomp 沙箱内运行，默认无网络、仅见会话工作区。沙箱网络访问是可配置策略，默认 `none`；见 §3.1。它同时托管科学环境（micromamba）与持久内核。仅监听回环 `127.0.0.1:4311`，API 是唯一客户端。

## 1. 源码结构

| 文件 | 作用 |
|---|---|
| `server.ts` | HTTP 路由、Bearer + HMAC 鉴权、单 worker 执行队列、启动预检 |
| `executor.ts` | 一次性沙箱执行：bwrap 参数组装、配额与超时、工作区快照 |
| `kernel-manager.ts` | 持久内核：JSON 行协议 REPL、空闲超时、按会话/ID/revision 回收 |
| `shell-session-manager.ts` | 持久 Shell 会话：沙箱内 bash 驱动循环，保留 cwd/export，空闲超时回收 |
| `session-env-profile.ts` | Session env profile：从 shell 沉淀白名单变量与 cwd，注入后续执行 |
| `environment-store.ts` | 科学环境 provisioning：micromamba、目录 catalog、不可变 revision |
| `seccomp.ts` | x86_64/aarch64 seccomp BPF（拒绝同一类高风险 syscall，`EPERM`），baseline 与 network 两套 profile 按宿主架构写入 `.sciencediscovery-data/runner-runtime/seccomp-*.bpf` |
| `egress-gateway.ts` | 沙箱网络访问的宿主侧出口：按 policy revision 复用的 UDS HTTP 服务，域名允许列表与地址分类 |
| `egress-bridge.ts` | 沙箱内 TCP→UDS 桥接脚本、宿主解释器探测与 bwrap 绑定参数 |
| `request-auth.ts` | HMAC-SHA256（token + 时间戳 + body SHA256），30 秒新鲜度窗口 |

## 2. HTTP 面

- 无鉴权：`GET /health`（沙箱模式、并发=1、科学环境能力）。
- Bearer 鉴权：`GET /status`、`GET/POST /environments…`（含 install/uninstall/delete）、`GET /environment-revisions…`、`GET/POST /environment-setup`、`GET /kernels`、`POST /kernels[/:id]/teardown`。
- Bearer + 签名头（`x-science-execution-timestamp` / `x-science-execution-signature`）：`POST /execute`（Python/R，ephemeral 或 persistent kernel）、`POST /execute-shell`。
- 启用 NPU Broker 时：`GET /npu/workloads` 使用 Bearer；`GET /npu/jobs?session_id=...` 与单个 job 的 status/log/result 使用 Bearer + Session 校验；`POST /npu/jobs` 与 job cancel 额外要求签名头。

执行请求带 executionId 幂等（60 秒内重复 → 409）。

## 3. 沙箱构造

启动预检要求 bwrap 支持：`--cap-drop --die-with-parent --new-session --seccomp --unshare-all --unshare-user`，并实际运行一次探针。

沙箱形态有两处会被环境拒绝，都由运行时实测决定，并按「先定 `/proc`，再定 `--disable-userns`」的顺序判定，
避免两者互相误判。检测实现见 `packages/sandbox-capability`，按二进制路径缓存；launcher 的 `probeSandbox`
与 runner 共用同一结论，避免出现「预检通过但工具全挂」。

**其一，`/proc` 的提供方式。** 默认 `--proc /proc`，让沙箱拥有自己的 procfs，只看得见自己的进程。
Docker 默认的 readonlyPaths / maskedPaths 会让内核拒绝在沙箱自己的 pid 命名空间里挂载新的 procfs
（报 `Can't mount proc on /newroot/proc: Operation not permitted`）。此时自动回退为 `--ro-bind /proc /proc`
并打印 warning：执行仍可进行，但沙箱看见的是容器的进程列表。官方 Compose 通过 `systempaths=unconfined`
保住默认的强形态；回退不是默认，也不应改用 `privileged` 消除。

| 探测结果 | 结论 | 行为 |
|---|---|---|
| 能新建 procfs | `new` | 使用 `--proc /proc` |
| 新建被拒但 bind 可用 | `bind` | 改用 `--ro-bind /proc /proc` 并告警 |

**其二，`--disable-userns`（禁止嵌套 userns）。** 是否追加同样由实测决定，而不是看版本号或 `--help`：
该选项的实现是往 `user.max_user_namespaces` 写值，因此在 LXC 和把 `/proc/sys` 挂成只读的容器里，
即使 bwrap ≥ 0.8 认识该选项，写入也会失败并让整个 launch 中止。检测方式是先用带该选项的最小沙箱探一次，
失败再用不带该选项的最小沙箱探一次（两次都在上面已定好的 `/proc` 形态上进行），从而区分三种情况：

| 探测结果 | 结论 | 行为 |
|---|---|---|
| 带选项即可启动 | `supported` | 追加 `--disable-userns` |
| 旧版 bwrap 不认识该选项 | `option-unknown` | 省略并告警，提示升级 bubblewrap |
| 认识但环境拒绝写 sysctl | `option-rejected` | 省略并告警，说明只读 `/proc/sys` |
| 不带选项也起不来 | `sandbox-unusable` | 沙箱整体不可用，预检告警 |

两处降级都只减少对应的那一项，其余隔离（命名空间、seccomp、挂载白名单）不受影响，
`run_python` / `run_r` / `run_shell` 与 persistent kernel / persistent shell 仍可执行并共用同一结论。

核心参数（`buildSandboxLaunch`，同时产出注入的 env 映射与 cwd 用于溯源）：

```text
--die-with-parent --new-session
--unshare-all --unshare-user [--disable-userns]  # 全命名空间隔离（含网络）；实测可用时才禁止嵌套 userns
--cap-drop ALL
--ro-bind /usr /usr（+ /bin /lib /lib64 symlink、/dev、--tmpfs /tmp）
--proc /proc | --ro-bind /proc /proc              # 默认新建 procfs；被拒时回退为 bind 并告警
--ro-bind /dev/null /usr/bin/{python3*,R,Rscript}   # 启用科学环境时屏蔽宿主解释器
--ro-bind <revision 前缀> /opt/science-env          # 科学环境只读挂载
--bind <会话工作区> /workspace --chdir /workspace|<profile cwd>
--clearenv --setenv HOME /tmp --setenv PATH …（Python 另加 PYTHONNOUSERSITE=1；
  另注入 Session env profile 的白名单变量，见 §8）
--seccomp 3                                          # BPF 过滤器经 fd 3 传入
```

取消（客户端断开或 Stop run）→ `AbortController` → `SIGKILL`。

### 3.1 沙箱网络访问

沙箱网络访问是系统设置里的策略，由 API 在创建 Permission Epoch 时快照进 epoch（`networkPolicy` + `networkAccess`，含内容派生的 `revision`），Runner 按该快照决定沙箱形态。它与「网络代理」设置无关：后者管的是 API / Gateway / MCP 自身的出站，不影响沙箱代码。

| 模式 | 沙箱形态 |
|---|---|
| `none`（默认） | 与历史行为完全一致：`--unshare-all`、无 `--share-net`、基线 seccomp 拒绝全部 socket 系统调用，不挂通道、不注入出站 env |
| `domain-allowlist` | **仍然** `--unshare-all` 且**不加** `--share-net`。沙箱唯一的出口是挂载进来的 Unix domain socket |

`domain-allowlist` 的数据面：

```text
沙箱进程（独立 netns，无网卡）
  └─ HTTP_PROXY=http://127.0.0.1:18118
       └─ egress bridge（沙箱内，监听沙箱自己的回环）
            └─ /run/sciencediscovery/egress.sock（bind-mount）
                 └─ egress gateway（Runner 进程内，与 Runner 同用户）
                      └─ 按域名允许列表放行 → 公网
```

要点：

- **无 root、无 CAP_NET_ADMIN、不依赖 socat**。bridge 是产品自带的标准库 Python 脚本，解释器与标准库以只读方式绑到 `/opt/sciencediscovery-net/`；宿主没有可用 python3 时该模式直接失败（fail-closed），并在 `/health.sandboxNetwork` 报告原因。
- bridge 先监听再 fork，真实负载是它的子进程并继承 stdin/stdout/stderr，因此持久内核与持久 shell 的行协议不受影响；退出码透传。
- seccomp 换成 network profile：只放行 socket 族调用（`socket/connect/bind/listen/accept/accept4/socketpair`），ptrace、mount、setns、bpf、keyring、io_uring 等继续拒绝；raw/packet socket 需要 `CAP_NET_RAW`，已被 `--cap-drop ALL` 挡住。
- 允许列表条目为 `example.org`、`*.example.org`（只在 label 边界匹配，且不含 apex），可加 `:443` 限定端口；IP 字面量既不能作为条目，也不能作为请求目标。
- gateway 先解析域名再按地址分类：默认拒绝回环、链路本地与私网地址，并连接被批准的那个 IP，避免解析与连接之间被换掉。内网镜像场景可显式打开「允许私网地址」。
- 边界：**不解密 TLS**，只按 CONNECT / 绝对 URI 的主机名判定，因此宽泛条目仍是宽泛授权。
- 策略变更会轮换 Permission Epoch 并回收该 Session 的持久内核与 shell（epoch id 是复用键的一部分）。
- 科学环境 install 的网络（conda 频道 / pip index / 离线缓存）与本策略互不影响。

## 4. 执行模型与配额

- **全局单 worker**：`server.ts` 用 Promise 链（`executionTail`）串行化全部执行；排队项可在出队前被 abort 移除。
- **配额**（可配置）：
  - 工作区总量默认 **10 GiB**（`SCIENCE_AGENT_MAX_WORKSPACE_BYTES` / 系统设置 `runnerMaxWorkspaceBytes`）；**`0` = 不限制**。有限时执行前检查，执行中每 100 ms 轮询，超限 `SIGKILL`。
  - **无单文件配额**（`/health.maxFileBytes` 固定为 `0`）。
  - 执行输出默认保留 **1 GiB**（`SCIENCE_AGENT_MAX_OUTPUT_BYTES` / `runnerMaxOutputBytes`）；超限时截断首尾并标注，**不判失败**；`0` = 不截断。
  - 上传单文件默认 **1 GiB**、单次 multipart 请求默认 **10 GiB**（`uploadMaxFileBytes` / `uploadMaxRequestBytes`）；`0` = 不限制。
- **超时**：`DEFAULT_EXECUTION_TIMEOUT_MS = 0`（无限）；可被请求或 `SCIENCE_AGENT_EXEC_TIMEOUT_MS` 覆盖，到时 SIGKILL。
- 无 CPU/内存配额（`RESOURCE_LIMIT_MODE = "none"`）。

### 如何查看 / 修改配额

```bash
# 查看 API 上传限额与 runner 回退值
curl -s http://127.0.0.1:4310/health | jq '.workspace, .runner.maxWorkspaceBytes, .runner.maxFileBytes, .runner.maxOutputBytes'

# 查看/修改持久化系统配额（对新执行立即生效）
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:4310/api/quota-settings
curl -s -X PUT -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  http://127.0.0.1:4310/api/quota-settings \
  -d '{"runnerMaxWorkspaceBytes":10737418240,"runnerMaxOutputBytes":1073741824,"uploadMaxFileBytes":1073741824,"uploadMaxRequestBytes":10737418240}'
```

也可在 Web → Settings → **Quotas** 中调整（Upload per file / Upload per request / Workspace total / Execution output，单位均为 GiB；勾选 Unlimited = 0）。上传区提示与 `/health.workspace` 使用同一套持久化值。

环境变量（需重启对应服务；首次播种系统设置初始值）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `SCIENCE_AGENT_MAX_WORKSPACE_BYTES` | `10737418240`（10 GiB） | 执行侧工作区总量；`0` = 不限 |
| `SCIENCE_AGENT_MAX_OUTPUT_BYTES` | `1073741824`（1 GiB） | 执行输出保留预算；`0` = 不截断 |
| `SCIENCE_AGENT_SHELL_IDLE_MS` | 回退 `SCIENCE_AGENT_KERNEL_IDLE_MS` | 持久 Shell 会话空闲 TTL；`0` = 不限 |
| `SCIENCE_AGENT_WORKSPACE_MAX_BYTES` | `10737418240` | API 上传累计工作区上限；`0` = 不限 |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_FILE_BYTES` | `1073741824` | 上传单文件上限；`0` = 不限 |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES` | `10737418240` | 单次 multipart 请求体上限；`0` = 不限 |

## 5. 语言运行时

| 语言 | 一次性执行 | 持久内核 |
|---|---|---|
| Python | `python3 -I -`（stdin 读代码） | `python -I -u -c <worker>`，exec 于常驻 namespace |
| R | `R --vanilla --slave` | `R --vanilla --slave -e <worker>` |
| Shell | `bash --noprofile --norc -euo pipefail -s` | `bash --noprofile --norc -c <driver>`，行协议驱动循环 |

解释器来自宿主 `/usr/bin` 或科学环境 `/opt/science-env/bin`。

## 6. 科学环境

- **Provisioner**：固定版本 micromamba（Linux x86_64/aarch64 URL + SHA256 来自 Runner、Docker 与发布脚本共用的 `micromamba-releases.json`）。宿主机进程模式首次 setup 按架构下载校验后缓存到 `.sciencediscovery-data/scientific-envs/bin/micromamba`；Docker 镜像构建期下载校验，并在空 data bind mount 首启时从 `/opt/sciencediscovery/provisioner/micromamba` 播种到同一默认路径，所以运行时无需为 micromamba 访问 GitHub。`SCIENCE_AGENT_PROVISIONER_PATH` 可覆盖默认路径。
- **异步 bootstrap**：Runner 监听并可响应 `/health` 后，在后台准备 Python base；`GET /environment-setup` 返回 state、phase、message、error 与时间戳，`POST` 只触发串行重试/补装并立即返回进度。失败不会终止 Runner。
- **基础环境**（固定版本）：冷启动默认只创建只读 Python base（Python 3.12 + numpy/pandas/scipy/matplotlib），不默认下载 R。用户或 Agent 显式创建第一个 R 命名环境时，才按需创建只读 R base（R 4.4 + tidyverse/data.table）。升级前已有的 `starter-r` 会保留。
- **全局 catalog**：base 与命名环境是实例级共享资源，不按 Project 隔离。兼容性上 catalog 仍使用 `starter` / `task` kind；产品语义分别是 base / named。
- **受控软件源**（实例级/全局，不按 Project 隔离）：源设置存于系统级 catalog，不进 Project/Session 覆盖；`condaSource` 与 `pipSource` 各自独立。pip 可选 `Official upstream`（`upstream`）、`Tsinghua TUNA`（`tsinghua`）、`USTC`（`ustc`）或 `Huawei Cloud`（`huawei`），其中 Huawei Cloud 的精确 index 为 `https://mirrors.huaweicloud.com/repository/pypi/simple`；conda 可选前三项，不提供 Huawei Cloud 预设。设置页只显示来源名称，不附加地区描述。解析优先级全程为 **单次显式源 > 全局默认 > 官方上游**：pip 取 `environment_install` 的 `indexUrl`，缺省回落到所选 `pipSource` 预设，再缺省为 `https://pypi.org/simple`；conda 取请求 `channels`，缺省回落到所选 `condaSource` 预设，再缺省为 `conda-forge`。Browser 环境安装入口与 Agent 安装入口共用同一 resolver；`GET|PUT /api/environment-source-settings` 负责读取和保存全局预设。旧 catalog 缺字段或含未知预设时按非严格模式回落 `upstream` 并回写迁移后的设置。conda 安装以 `--override-channels --strict-channel-priority` 强制；`SCIENCE_AGENT_SCIENTIFIC_CHANNELS`（兼容默认仍为 `conda-forge`）依旧是 operator 侧的频道白名单，但 TUNA/USTC 内置预设中的精确频道 URL 始终被 Runner 视作受控白名单的一部分，即便 operator 仅列出 `conda-forge` 也会接受——这是落实全局镜像选择的必要扩展，副作用是 operator 无法仅凭该变量完全禁止这些预设镜像；自定义任意频道仍须显式列入 operator 白名单，否则被拒绝。设置 `SCIENCE_AGENT_PACKAGE_CACHE_DIR` 后进入离线缓存模式：pip `indexUrl` 仍执行 HTTPS 安全校验，conda channel 仍执行白名单校验；校验通过后，安装命令不访问网络源，而是分别使用 `--no-index --find-links <dir>` 和 `--offline`。pip 网络 index 因而被静默忽略，revision 记 `offline-cache:pip`；CRAN/Bioconductor 在离线模式下被拒绝；本地 wheel 仍从内容寻址副本安装。
- **布局**：`.sciencediscovery-data/scientific-envs/{catalog.json, provisioner/, bin/micromamba, revisions/<env>/rev-<uuid>/, snapshots/rev-<uuid>.json, wheels/<sha256>/<filename>.whl}`。
- **不可变 revision**：base 不可删除或直接安装/卸载包；命名环境的每次 install/uninstall 都先克隆 current revision，成功后生成新快照并前移 `currentRevisionId`，旧 revision 上的内核被回收。
- **受控变更**：设置页和 Agent 的 `environment_create/environment_delete/environment_install/environment_uninstall` 都经 API、权限门禁与 Runner 校验；`environment_install` 默认使用 conda，Python 命名环境也可选 pip。pip 的显式源是单独校验的 HTTPS `indexUrl`：仅允许 HTTPS、非空 hostname、不得含凭据、query 或 fragment、长度 ≤2048、无空白/控制字符（首尾空白会被裁剪），Runner 用参数数组传入，不拼接 shell；包列表不接受选项式注入或远程 URL。Agent 可提交当前 Session workspace 相对 `.whl`，Runner 会拒绝路径逃逸/URL，复制到内容寻址 wheel store，复核 SHA-256 后只从持久副本安装，并把来源路径、hash、发行名/版本写入 revision snapshot。设置页没有 Session workspace 上下文，只允许 pip 名称规格。不要用 `run_shell` 直接执行 conda/mamba/micromamba/pip 修改托管前缀；沙箱只读挂载也会阻止该旁路成为正式变更方式。

## 7. 持久内核

- 内核 = 一个常驻 bwrap 进程内的 Python/R REPL worker，stdin/stdout 走 JSON 行协议（`{code,id}` → `{id,exitCode,stdout,stderr,cwd,env}`）；输出按 `maxOutputBytes` 截断（首尾保留 + 标注）。
- 每次求值回报沙箱内实际 `cwd` 与进程 `env`，随执行结果回传给 API 落入溯源（§8）。
- 复用键：`sessionId : language : revisionId : permissionEpochId`——环境或权限 epoch 变化即换新内核。
- 空闲超时按请求或 `SCIENCE_AGENT_KERNEL_IDLE_MS`；到期回收并记录 `memoryLostReason`。可按会话、按内核 ID（运行状态页 Teardown）或按 revision 批量回收。

## 8. 持久 Shell 会话与 Session env profile

**持久 Shell 会话（A）**：`run_shell` 默认 `kernelMode=persistent`（once 级授权自动降级 ephemeral）。首次调用为 Session 启动一个常驻 bash（同样 clearenv + 白名单基线），驱动循环运行在该 bash 自身内，因此片段中的 `cd` / `export` / `source` 在会话内持续生效。

- 协议：stdin 一行 `<id> <base64(code)>`；响应一行 `__SA_RESULT__ <id> <exitCode> <b64 stdout> <b64 stderr> <b64 cwd> <b64 env -0>`。用户代码 stdin 为 `/dev/null`，stdout/stderr 重定向到 `/tmp` 文件，协议管道仅驱动使用。
- 语义：与一次性 `-euo pipefail` shell 不同，会话表现如交互式 shell——单条命令失败只上报退出码、不终止会话；用户代码显式 `set -e` 触发退出或 `exit` 会结束整个会话（下次调用重建并携带 `memoryStateLost` 原因）。
- 生命周期：复用键 `sessionId : shell : system-shell-bwrap-v1 : permissionEpochId`；Session 内任何执行（含 python/r）都会刷新空闲计时；空闲超过 `SCIENCE_AGENT_SHELL_IDLE_MS`（未设置时回退 `SCIENCE_AGENT_KERNEL_IDLE_MS`；`0`=不限）即回收。`/kernels` 与 `/status` 会以 `language: "shell"` 列出，teardown 端点同样适用。

**Session env profile（C）**：每次持久 shell 求值后，其 `env -0` 转储与 `pwd -P` 沉淀为该 `(sessionId, permissionEpochId)` 的 profile；后续 `run_python` / `run_r` / 一次性 `run_shell` 在 `--clearenv` 之后按受控策略注入。

- 注入策略（`session-env-profile.ts`）：仅注入名称合法（`[A-Za-z_][A-Za-z0-9_]*`）、非 Runner 保留键（`HOME/PATH/PYTHONPATH/PYTHONNOUSERSITE/R_ENVIRON_USER/PWD/…`）、非危险键（`LD_*`、`BASH_ENV`、`ENV`、`IFS`、`PYTHONSTARTUP`、`PYTHONHOME` 等）的变量；单值 >32 KiB 或总量 >256 KiB 的条目丢弃。cwd 仅当仍位于 `/workspace` 下且目录存在时生效。
- 安全边界不变：宿主 environ 从不进入 profile（shell 自身即从 clearenv 启动）；Runner 基线键始终由 Runner 设置，profile 不可覆盖。
- 生命周期与会话一致：shell 会话被回收（空闲/teardown/退出/epoch 变化）时 profile 一并清除；持久 Python/R 内核仅在 spawn 时注入 profile，已存在的内核不受后续 shell 变更影响。

## 相关文档

- [control-plane.md](control-plane.md) — API 如何调用 Runner（签名、端点）
- [architecture.md](architecture.md) — 进程模型与端口
- [配置参考](../reference/configuration.md) — 相关环境变量、配额与数据落点
- [Ascend NPU 宿主 Broker](ascend-npu-runner.md) — Ascend NPU Broker 设计背景
