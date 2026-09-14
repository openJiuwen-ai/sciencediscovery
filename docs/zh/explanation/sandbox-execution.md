# 沙箱执行：services/runner

Runner 是无 root 的代码执行器：Agent 的常规执行统一使用 `run_shell`，包括 `python -m`、Python 文件与 `Rscript`，在 bubblewrap + seccomp 沙箱内访问当前 Agent×Runner 的 Workspace。每次调用启动新进程，不跨调用继承 cwd、export 或解释器内存。沙箱网络默认 `none`；见 §3.1。Runner 同时管理 micromamba 科学环境，默认监听回环 `127.0.0.1:4311`，由 API 调用。

## 1. 源码结构

| 文件 | 作用 |
|---|---|
| `server.ts` | HTTP 路由、Bearer + HMAC 鉴权、Workspace 准入与执行队列、启动预检 |
| `executor.ts` | 一次性沙箱执行：bwrap 参数组装、配额与超时、工作区快照 |
| `execution-manager.ts` | 受管理 Shell 的生命周期、状态/日志/取消与已提交 Workspace 回执 |
| `kernel-manager.ts`、`shell-session-manager.ts`、`session-env-profile.ts` | 旧内部基础组件；HTTP 执行不再启动持久 worker，也不注入历史 profile |
| `environment-store.ts` | 科学环境 provisioning：micromamba、目录 catalog、命名环境原地更新与 revision 记录 |
| `seccomp.ts` | x86_64/aarch64 seccomp BPF（拒绝同一类高风险 syscall，`EPERM`），baseline 与 network 两套 profile 按宿主架构写入 `.sciencediscovery-data/runner-runtime/seccomp-*.bpf` |
| `egress-gateway.ts` | 沙箱网络访问的宿主侧出口：按 policy revision 复用的 UDS HTTP 服务，域名允许列表与地址分类 |
| `egress-bridge.ts` | 沙箱内 TCP→UDS 桥接脚本、宿主解释器探测与 bwrap 绑定参数 |
| `request-auth.ts` | HMAC-SHA256（token + 时间戳 + body SHA256），30 秒新鲜度窗口 |

## 2. HTTP 面

- 无鉴权：`GET /health`（沙箱模式、科学环境能力）。
- Bearer 鉴权：`GET /status`、`GET/POST /environments…`（含 install/uninstall/delete）、`GET /environment-revisions…`、`GET/POST /environment-setup`、`GET /kernels`、`POST /kernels[/:id]/teardown`。
- Bearer + 签名头（`x-science-execution-timestamp` / `x-science-execution-signature`）：`POST /execute`（Python/R，仅 ephemeral）、`POST /execute-shell`。
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
常规 Shell（包括其中启动的 Python/R）与旧 ephemeral 语言端点共用同一结论。

核心参数（`buildSandboxLaunch`，同时产出注入的 env 映射与 cwd 用于溯源）：

```text
--die-with-parent --new-session
--unshare-all --unshare-user [--disable-userns]  # 全命名空间隔离（含网络）；实测可用时才禁止嵌套 userns
--cap-drop ALL
--ro-bind /usr /usr（+ /bin /lib /lib64 symlink、/dev、--tmpfs /tmp）
--proc /proc | --ro-bind /proc /proc              # 默认新建 procfs；被拒时回退为 bind 并告警
--ro-bind /dev/null /usr/bin/{python3*,R,Rscript}   # 启用科学环境时屏蔽宿主解释器
--ro-bind <所选环境前缀> /opt/science-env          # 科学环境只读挂载
--bind <Agent×Runner 工作区> /workspace --chdir /workspace|<本次显式 cwd>
--clearenv --setenv HOME /tmp --setenv PATH …（Python 另加 PYTHONNOUSERSITE=1；不注入历史 profile）
--seccomp 3                                          # BPF 过滤器经 fd 3 传入
```

旧同步端点在客户端断开时 abort。受管理 Shell Execution 不因客户端等待期限或断开而自动停止，取消须走 Execution 管理端点。

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
- bridge 先监听再 fork，真实负载是它的子进程并继承 stdin/stdout/stderr；退出码透传。
- seccomp 换成 network profile：只放行 socket 族调用（`socket/connect/bind/listen/accept/accept4/socketpair`），ptrace、mount、setns、bpf、keyring、io_uring 等继续拒绝；raw/packet socket 需要 `CAP_NET_RAW`，已被 `--cap-drop ALL` 挡住。
- 允许列表条目为 `example.org`、`*.example.org`（只在 label 边界匹配，且不含 apex），可加 `:443` 限定端口；IP 字面量既不能作为条目，也不能作为请求目标。
- gateway 先解析域名再按地址分类：默认拒绝回环、链路本地与私网地址，并连接被批准的那个 IP，避免解析与连接之间被换掉。内网镜像场景可显式打开「允许私网地址」。
- 边界：**不解密 TLS**，只按 CONNECT / 绝对 URI 的主机名判定，因此宽泛条目仍是宽泛授权。
- 策略变更会轮换 Permission Epoch；新执行使用新的策略快照。
- 科学环境 install 的网络（conda 频道 / pip index / 离线缓存）与本策略互不影响。

### 3.2 沙箱内的 Ascend NPU

选中的昇腾芯片会被交进沙箱。这份文档早先写的是做不到——因为在 bwrap namespace 里探测会报 `Container ID verify failed (session ct_id=0; device ct_id=...)`。那次测量是在宿主整个 `/dev` 都可见的情况下做的，这个报错是驱动在那种情况下的正常反应，而不是设备直通的限制：进入 mount namespace 后，驱动按调用者 `/dev` 里可见的卡枚举，且是 all-or-nothing，只要有一张卡被别的租户占着，整次调用就对所有卡失败。只暴露选中的芯片就不再满足这个条件，910B3 上沙箱内的 `npu-smi info` 与 MindSpore 都能正常跑。

launch 具体做的事：

- 保留 bubblewrap 新建的 `--dev /dev`，再对每颗选中的芯片加一条 `--dev-bind`，外加宿主实际存在的管理节点（`davinci_manager`、`devmm_svm`、`hisi_hdc`）。没被选中的芯片在沙箱里根本不存在。
- 选中的芯片按设备号升序从 0 重新编号，因此不论宿主怎么编号，rank 0..n-1 就是 `/dev/davinci0..n-1`。
- 重述 `--clearenv` 会清掉的 CANN 环境，其中 `LD_LIBRARY_PATH` 必须包含 `/usr/local/Ascend/driver/lib64/common`（`libascend_hal.so` 依赖的 `libc_sec.so` 只在这里）；宿主有 `/etc/ascend_install.info` 时以只读绑入。
- 只有携带芯片的 launch 才把 `/usr/local/bin` 前置到 `PATH`，让 `npu-smi` 能作为命令直接执行；不带芯片的沙箱 PATH 一个字节不变。
- 其余一律不变：`--unshare-all --unshare-user --cap-drop ALL`、seccomp 过滤器与网络策略与任何其他执行相同。

**哪些芯片可选由逐芯片的真实探针决定，不看宿主清单**：用一个与真实执行同形态的一次性沙箱只绑那一颗芯片，在里面跑 `npu-smi info`。宿主会把沙箱根本打不开的卡报成健康，所以只有探针通过的芯片才能勾选；而且每次执行前会对它点名的芯片重探一遍——期间被别的租户占走的芯片会让执行以卡号明确失败，而不是在框架深处报一个不指名的错。支持范围是昇腾 910 系列，其他芯片会列出但拒绝，理由里写明芯片名。

机器状态优先通过驱动自带的 DCMI 接口读取（用宿主 Python，不编译任何东西），不可用时回退到 `npu-smi info -m` 加 `npu-smi info`。设备身份一律用 chip logic id（即 `/dev/davinciN` 的 N），不用卡号，因为一张卡可能带不止一颗计算 die。

### 3.3 Ascend NPU Broker（可选的宿主执行）

与上面那条路径相互独立，Runner 仍然提供按需开启的宿主 NPU Broker，用于不属于普通 Agent 执行的白名单宿主作业：`SCIENCE_AGENT_NPU_BROKER=1` 时才暴露 `run_npu_job`，只接受白名单里的 `workloadId` 并以 `shell: false` 启动固定 entrypoint，作业子进程在宿主 namespace 中运行。设计背景见 [Ascend NPU 宿主 Broker](ascend-npu-runner.md)。

## 4. 执行模型与配额

- **同一 Workspace 单写**：同一物理 Workspace 的写入跨进程串行，不同 Workspace 可并行。执行进程退出并完成 CAS 快照/ref 提交后才释放租约；状态和日志查询不取写锁。
- **配额**（可配置）：
  - 工作区总量默认 **10 GiB**（`SCIENCE_AGENT_MAX_WORKSPACE_BYTES` / 系统设置 `runnerMaxWorkspaceBytes`）；**`0` = 不限制**。有限时执行前检查，执行中每 100 ms 轮询，超限 `SIGKILL`。
  - **无单文件配额**（`/health.maxFileBytes` 固定为 `0`）。
  - 执行输出默认保留 **1 GiB**（`SCIENCE_AGENT_MAX_OUTPUT_BYTES` / `runnerMaxOutputBytes`）；超限时截断首尾并标注，**不判失败**；`0` = 不截断。
  - 上传单文件默认 **1 GiB**、单次 multipart 请求默认 **10 GiB**（`uploadMaxFileBytes` / `uploadMaxRequestBytes`）；`0` = 不限制。
- **超时**：旧同步端点支持执行时限（默认无限），到时终止进程；受管理 Shell Execution 的客户端等待期限不触发自动终止。
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
| `SCIENCE_AGENT_WORKSPACE_MAX_BYTES` | `10737418240` | API 上传累计工作区上限；`0` = 不限 |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_FILE_BYTES` | `1073741824` | 上传单文件上限；`0` = 不限 |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES` | `10737418240` | 单次 multipart 请求体上限；`0` = 不限 |

## 5. 语言运行时

| 入口 | 执行进程 |
|---|---|
| 常规 `run_shell` | 新建严格模式 Bash，可启动所选环境的 Python 模块/文件、Rscript 等工具 |
| 旧 Python HTTP 端点 | ephemeral `python3 -I -` |
| 旧 R HTTP 端点 | ephemeral `R --vanilla --slave` |

解释器来自宿主 `/usr/bin` 或科学环境 `/opt/science-env/bin`。

## 6. 科学环境

- **Provisioner**：固定版本 micromamba（Linux x86_64/aarch64 URL + SHA256 来自 Runner、Docker 与发布脚本共用的 `micromamba-releases.json`）。宿主机进程模式首次 setup 按架构下载校验后缓存到 `.sciencediscovery-data/scientific-envs/bin/micromamba`；Docker 镜像构建期下载校验，并在空 data bind mount 首启时从 `/opt/sciencediscovery/provisioner/micromamba` 播种到同一默认路径，所以运行时无需为 micromamba 访问 GitHub。`SCIENCE_AGENT_PROVISIONER_PATH` 可覆盖默认路径。
- **异步 bootstrap**：Runner 监听并可响应 `/health` 后，在后台准备 Python base；`GET /environment-setup` 返回 state、phase、message、error 与时间戳，`POST` 只触发串行重试/补装并立即返回进度。失败不会终止 Runner。
- **基础环境**（固定版本）：冷启动默认只创建只读 Python base（Python 3.12 + numpy/pandas/scipy/matplotlib），不默认下载 R。用户或 Agent 显式创建第一个 R 命名环境时，才按需创建只读 R base（R 4.4 + tidyverse/data.table）。升级前已有的 `starter-r` 会保留。
- **全局 catalog**：base 与命名环境是实例级共享资源，不按 Project 隔离。兼容性上 catalog 仍使用 `starter` / `task` kind；产品语义分别是 base / named。
- **受控软件源**（实例级/全局，不按 Project 隔离）：源设置存于系统级 catalog，不进 Project/Session 覆盖；`condaSource` 与 `pipSource` 各自独立。pip 可选 `Official upstream`（`upstream`）、`Tsinghua TUNA`（`tsinghua`）、`USTC`（`ustc`）或 `Huawei Cloud`（`huawei`），其中 Huawei Cloud 的精确 index 为 `https://mirrors.huaweicloud.com/repository/pypi/simple`；conda 可选前三项，不提供 Huawei Cloud 预设。设置页只显示来源名称，不附加地区描述。解析优先级全程为 **单次显式源 > 全局默认 > 官方上游**：pip 取 `environment_install` 的 `indexUrl`，缺省回落到所选 `pipSource` 预设，再缺省为 `https://pypi.org/simple`；conda 取请求 `channels`，缺省回落到所选 `condaSource` 预设，再缺省为 `conda-forge`。Browser 环境安装入口与 Agent 安装入口共用同一 resolver；`GET|PUT /api/environment-source-settings` 负责读取和保存全局预设。旧 catalog 缺字段或含未知预设时按非严格模式回落 `upstream` 并回写迁移后的设置。conda 安装以 `--override-channels --strict-channel-priority` 强制；`SCIENCE_AGENT_SCIENTIFIC_CHANNELS`（兼容默认仍为 `conda-forge`）依旧是 operator 侧的频道白名单，但 TUNA/USTC 内置预设中的精确频道 URL 始终被 Runner 视作受控白名单的一部分，即便 operator 仅列出 `conda-forge` 也会接受——这是落实全局镜像选择的必要扩展，副作用是 operator 无法仅凭该变量完全禁止这些预设镜像；自定义任意频道仍须显式列入 operator 白名单，否则被拒绝。设置 `SCIENCE_AGENT_PACKAGE_CACHE_DIR` 后进入离线缓存模式：pip `indexUrl` 仍执行 HTTPS 安全校验，conda channel 仍执行白名单校验；校验通过后，安装命令不访问网络源，而是分别使用 `--no-index --find-links <dir>` 和 `--offline`。pip 网络 index 因而被静默忽略，revision 记 `offline-cache:pip`；CRAN/Bioconductor 在离线模式下被拒绝；本地 wheel 仍从内容寻址副本安装。
- **布局**：`.sciencediscovery-data/scientific-envs/{catalog.json, provisioner/, bin/micromamba, revisions/<env>/rev-<uuid>/, snapshots/rev-<uuid>.json, wheels/<sha256>/<filename>.whl}`。目录保留旧命名，但命名环境通过 `runtimeRevisionId` 复用同一运行前缀，不为每次更新克隆一份环境。
- **原地更新与追溯 revision**：base 不可删除或直接安装/卸载包；命名环境在环境锁保护下原地更新，成功后生成新快照并前移 `currentRevisionId`。Revision 是追溯记录，不是可供 Agent 选择的历史运行前缀。
- **受控变更**：设置页和 Agent 的 `environment_create/environment_delete/environment_install/environment_uninstall` 都经 API、权限门禁与 Runner 校验；`environment_install` 默认使用 conda，Python 命名环境也可选 pip。pip 的显式源是单独校验的 HTTPS `indexUrl`：仅允许 HTTPS、非空 hostname、不得含凭据、query 或 fragment、长度 ≤2048、无空白/控制字符（首尾空白会被裁剪），Runner 用参数数组传入，不拼接 shell；包列表不接受选项式注入或远程 URL。Agent 可提交当前 Session workspace 相对 `.whl`，Runner 会拒绝路径逃逸/URL，复制到内容寻址 wheel store，复核 SHA-256 后只从持久副本安装，并把来源路径、hash、发行名/版本写入 revision snapshot。设置页没有 Session workspace 上下文，只允许 pip 名称规格。不要用 `run_shell` 直接执行 conda/mamba/micromamba/pip 修改托管前缀；沙箱只读挂载也会阻止该旁路成为正式变更方式。

## 7. 执行生命周期与迁移

HTTP `/execute`、`/execute-shell`、`/shell-executions` 在创建 Workspace 或启动代码之前拒绝 `kernelMode=persistent`。一次性授权也不再静默降级该请求。省略此字段或使用 `ephemeral`；长任务使用受管理 Shell Execution。

持久解释器可能在一次调用返回后留下线程或子进程，越过 Workspace 写锁与快照提交边界继续写入。Linux ephemeral 执行在最终快照和释放租约前结束整个 Bubblewrap PID namespace。受管理后台 Execution 则在真实负载运行期间持续持有写入权；它不是可跨调用复用的交互式 Shell。

历史 Session profile 不再注入。每次显式选择 cwd 与环境，需要的 export 和命令写在同一个脚本中。Python/R 内存不跨调用保留；Notebook 式共享内存不属于本次实现。

## 相关文档

- [control-plane.md](control-plane.md) — API 如何调用 Runner（签名、端点）
- [architecture.md](architecture.md) — 进程模型与端口
- [配置参考](../reference/configuration.md) — 相关环境变量、配额与数据落点
- [Ascend NPU 宿主 Broker](ascend-npu-runner.md) — Ascend NPU Broker 设计背景
