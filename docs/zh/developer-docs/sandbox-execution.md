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
| `seccomp.ts` | x86_64/aarch64 seccomp BPF（拒绝同一类高风险 syscall，`EPERM`），baseline、network 与无 egress 的 NPU 兼容 profile 按宿主架构写入 `.sciencediscovery-data/runner-runtime/seccomp-*.bpf` |
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

### 可用性与修复

安装、构建和启动工作台不再要求本地沙箱可用。源码/Docker 启动脚本与二进制启动器在本地 Runner 不可用时仍保持 API/UI 可用。无需代码执行的 Agent 任务可以继续；本地 Runner 的状态不能代替远端执行能力的检查。

每个 Runner 在自己的进程中探测可执行文件及沙箱配置。携带有效 bearer token 的 `GET /health` 响应中，`execution` 包含 `instanceId`、`checkedAt`、依赖可用性、沙箱可用性、就绪状态与原因。带鉴权的 `GET /execution-capability` 读取缓存；`POST` 在修复后刷新，同时刷新共用的沙箱配置缓存。API 对应入口为 `/api/runners/{runnerId}/execution-capability`。没有此接口的旧 Runner 视为能力未知，需要升级，不能直接视为安全可用。

Runner 设置保留能力状态与**重新检查**按钮。Agent 可调用 `check_runner(runner_id?)`，直接刷新目标 Runner 的同一份能力报告，不依赖沙箱。该工具只诊断，不执行代码、不挂起等待。执行前发现 Runner 不可用时，工具返回 `RUNNER_UNAVAILABLE`、`dispatched: false`、`operationId`、原因与修复建议；本次调用已结束，不进入执行队列。Agent 自行决定继续其他工作、说明阻塞并结束本轮，或显式调用 `wait_for_runner(operation_id)`。

Agent 决定等待用户选择时，须调用等待工具；仅最终回复“已暂停”不会创建待处理操作。展示卡片不执行修复、安装、切换机器或代码，因此即使用户禁止这些操作，也无需为展示用户请求的选项再次确认。收到选择后仍须遵守用户约束。框架不会把每次 Runner 失败都强制变为等待状态。

只有 `wait_for_runner` 才会创建对话卡片并暂停 Agent 的外部等待计时。卡片展示 Agent、待执行操作、原因和建议，提供修复后重检、选择可用且已授权的其他 Runner、取消本次操作（非整个任务）。不同操作的选择彼此独立。所有选择均返回 Agent；重试与切换会重新探测，但**绝不执行或重放旧调用**，须由 Agent 重新调用执行工具；换机器时先准备目标工作区、输入与环境。重检失败也返回诊断，是否再次等待仍由 Agent 决定，不自动轮询修复状态。任务取消、进程关闭或十分钟未决定会清理等待。刷新浏览器通过 `GET /api/sessions/{sessionId}/execution-blocks` 恢复卡片，响应经 `POST /api/sessions/{sessionId}/execution-blocks/{id}` 提交；重复或过期响应不会下发代码。等待存于内存，不提供 API 重启后的任务恢复。设置页定期读取能力缓存，也能反映 Agent 发起检查后的状态。

Runner 自身也会在占用执行 ID 前，以 HTTP 503 和 `EXECUTION_UNAVAILABLE` 拒绝不可用的沙箱执行，读取/取消/管理接口仍可使用。**没有无沙箱兜底**，Always Allow 也不会关闭沙箱。探测成功仅证明沙箱可以构建，不保证每个科学依赖包或 GPU 配置正确。检查与受阻结果记录在工具轨迹中；API 操作日志记录 `runner_wait_requested`、`execution_decision`，Runner 记录 `execution_unavailable`。宿主机执行与扩大授权范围属于后续独立特性。

### 沙箱配置

执行能力要求 bwrap 支持：`--cap-drop --die-with-parent --new-session --seccomp --unshare-all --unshare-user`，并实际运行一次探针；失败时标记计算不可用，不阻止管理服务启动。

沙箱形态有两处会被环境拒绝，都由运行时实测决定，并按「先定 `/proc`，再定 `--disable-userns`」的顺序判定，
避免两者互相误判。检测实现见 `packages/sandbox-capability`，按二进制路径缓存；能力探测与执行共享该缓存。
launcher 启动工作台不再强制通过沙箱预检，实际执行以目标 Runner 的能力为准。

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
- **宿主侧 socket 放在短的运行时目录**，而不是数据目录：依次尝试 `$RUNTIME_DIRECTORY`（systemd `RuntimeDirectory=`）、`$XDG_RUNTIME_DIR`、`/run/user/<uid>`、`/tmp`，全部不可用时才退回 `<dataDir>/eg`。每个候选目录都以 `0700` 创建并校验属主后才使用，因此 `SCIENCE_DISCOVERY_DATA_DIR` 的长度不再决定网络功能能否使用；沙箱内看到的始终是固定的 `/run/sciencediscovery/egress.sock`。
- bridge 先监听再 fork，真实负载是它的子进程并继承 stdin/stdout/stderr；退出码透传。
- seccomp 换成 network profile：只放行 socket 族调用（`socket/connect/bind/listen/accept/accept4/socketpair`），ptrace、mount、setns、bpf、keyring、io_uring 等继续拒绝；raw/packet socket 需要 `CAP_NET_RAW`，已被 `--cap-drop ALL` 挡住。
- 允许列表条目为 `example.org`、`*.example.org`（只在 label 边界匹配，且不含 apex），可加 `:443` 限定端口；IP 字面量既不能作为条目，也不能作为请求目标。
- gateway 先解析域名再按地址分类：默认拒绝回环、链路本地与私网地址，并连接被批准的那个 IP，避免解析与连接之间被换掉。内网镜像场景可显式打开「允许私网地址」。
- 边界：**不解密 TLS**，只按 CONNECT / 绝对 URI 的主机名判定，因此宽泛条目仍是宽泛授权。
- 策略变更会轮换 Permission Epoch；新执行使用新的策略快照。
- 科学环境 install 的网络（conda 频道 / pip index / 离线缓存）与本策略互不影响。

#### 对话内网络授权

Skill 脚本或命令需要 HTTP 访问前，Agent 调用 `request_sandbox_network`，显式提供准确的
`hosts`（可带端口）、简短 `purpose` 和目标 `runner_id`。询问模式会暂停并展示包含主机及用途的
对话权限卡。批准返回一次性 `authorizationId`，需在新的 `run_shell` 调用中作为
`network_authorization_id` 传入；始终允许模式自动批准准确主机的权限请求：显式工具调用事先声明主机，执行归属明确的
白名单拒绝也可在失败后生成同一请求并返回令牌，但绝不自动重放。仅新增批准的主机，
原有配置的白名单继续保留，原有 open 模式不收窄。
本路径不接受通配符、URL 或 IP 地址。

请**事先一次声明所有已知的必需主机**。例如脚本同时需要 `a.example.org` 和 `b.example.org`，
应在同一个 `hosts` 列表中请求两者。批准不会跨执行累积；观测到的拒绝只包含该次执行实际尝试的主机。
脚本若遇到首个失败便停止，逐个申请可能造成两个主机交替请求。发现其他必需主机时，先核对上次执行的
副作用，再为安全的**新执行**请求完整的已知主机集合。授权绝不重放脚本。

令牌仅属于当前 Agent、运行和 Runner，提交前即消耗，提交结果不明时也不能重用。同类授权
仅匹配本次 Agent 运行的相同目标和主机集合，撤销后未用令牌失效；不能继承给子 Agent、
其他 Runner 或后续运行。执行使用独立网络 Epoch，保留既有配置并仅新增批准主机，保持部署的私网过滤和出口路由，
不修改全局配置或共享会话 Epoch。未携带令牌的调用仍遵循原有策略。

白名单模式下，每次 Shell 执行的网关独立归属该执行。未放行域名通过 `networkDeniedHosts`
返回，即使脚本吞掉 HTTP 错误也标记托管执行失败；所属运行仍活动时会弹出同一对话权限卡。
`networkPermission` 返回决定及批准后的新调用令牌，绝不自动重放。重试前先核对输出、文件及
远端副作用；结果不明的执行必须先查明。不支持的主机以 `networkPermission.blockedHosts` 逐项说明并保持阻塞，不妨碍为其他合法主机弹卡。
私网地址过滤或出口路由错误不会通过此卡绕过。

拒绝、取消、关闭或超时保持离线。必需的检索应明确显示阻塞/未完成及原因，禁止静默退化成
看似完成的 web_search 报告。默认 `none` 保留原有 socket 过滤、独立网络命名空间且无桥接；
不透明脚本失败不能可靠揭示主机，因此不保证自动弹出带具体域名的卡片。Agent/Skill 必须显式
声明已知主机；Skill 作者应写明所需主机并要求执行前申请。MCP/Web 的宿主访问和系统配置的
持久网络白名单独立管理；预检横幅只是辅助，不能替代执行时的对话授权。

### 3.2 沙箱内的 Ascend NPU

选中的昇腾芯片会被交进沙箱。这份文档早先写的是做不到——因为在 bwrap namespace 里探测会报 `Container ID verify failed (session ct_id=0; device ct_id=...)`。那次测量是在宿主整个 `/dev` 都可见的情况下做的，这个报错是驱动在那种情况下的正常反应，而不是设备直通的限制：进入 mount namespace 后，驱动按调用者 `/dev` 里可见的卡枚举，且是 all-or-nothing，只要有一张卡被别的租户占着，整次调用就对所有卡失败。只暴露选中的芯片就不再满足这个条件，910B3 上沙箱内的 `npu-smi info` 与 MindSpore 都能正常跑。

launch 具体做的事：

- 保留 bubblewrap 新建的 `--dev /dev`，再对每颗选中的芯片加一条 `--dev-bind`，外加宿主实际存在的管理节点（`davinci_manager`、`devmm_svm`、`hisi_hdc`）。没被选中的芯片在沙箱里根本不存在。
- 选中的芯片按设备号升序从 0 重新编号，因此不论宿主怎么编号，rank 0..n-1 就是 `/dev/davinci0..n-1`。
- 重述 `--clearenv` 会清掉的 CANN 环境，其中 `LD_LIBRARY_PATH` 必须包含 `/usr/local/Ascend/driver/lib64/common`（`libascend_hal.so` 依赖的 `libc_sec.so` 只在这里）；宿主有 `/etc/ascend_install.info` 时以只读绑入。
- 只有携带芯片的 launch 才把 `/usr/local/bin` 前置到 `PATH`，让 `npu-smi` 能作为命令直接执行；不带芯片的沙箱 PATH 一个字节不变。
- 保留 `--unshare-all --unshare-user --cap-drop ALL` 与生效网络策略。沙箱为 Runner 当前 UID/GID 挂入各一条记录的 `passwd/group`，因为基础 MindSpore 张量运算虽能容忍 `getpwuid` 失败，CANN GE/TBE 初始化却会把它当成致命错误。NPU 执行使用独立 seccomp 变体，放行 CANN/TE Python 模块导入时使用的 socket-family 调用；它不挂 egress bridge，仍在独立 network namespace 内，所以 `networkPolicy=none` 仍无外部网络路由。普通非 NPU 执行继续使用 baseline profile；NPU 执行也继续拒绝 ptrace、mount、setns、bpf、keyring、io_uring 等基线拒绝项。

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
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:4310/health | jq '.workspace, .runner.maxWorkspaceBytes, .runner.maxFileBytes, .runner.maxOutputBytes'

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

## 8. Runner 恢复的真实模型 E2E

[`test/journey-runner-recovery-real.spec.ts`](../../../test/journey-runner-recovery-real.spec.ts)
包含两条 `tier:l3` 用例，由 merge queue 的 `merge` profile 选入串行 basic
worker，每日与 release 测试也继承执行；普通 PR L2 不调用真实模型。

- **等待分支**：自然语言要求实际执行，受阻时等待用户决定，不直接指定工具名或要求弹卡片。
  检查模型主动调用 `wait_for_runner`，operation ID 对应失败操作，真实前端显示卡片且刷新后保留；
  浏览器取消后，选择进入下一次模型输入，Agent 正常结束且不重新提交代码。
- **结束分支**：用户明确要求环境不可用时解释原因并结束，不等待。
  检查模型实际收到 Runner 故障、给出最终答复，且从未调用等待工具或遗留等待卡片。

故障通过真实 Runner HTTP 服务指向临时目录中不存在的沙箱程序产生，不修改宿主机安全设置，
不模拟模型、不插入卡片、不强制工具选择。Session 仅允许使用该 Runner，执行请求不得进入
Runner 的执行端点。另有不使用模型的 ST 检查故障环境仍可连接、直接执行被拒绝。

在隔离测试实例准备好后，配置 `E2E_API_TOKEN`、`E2E_BASE_URL`（或 `E2E_API_URL`）、
`E2E_LLM_BASE_URL`、`E2E_LLM_MODEL`、`E2E_LLM_TOKEN`，执行：

```bash
cd .e2e
E2E_REAL=1 npx playwright test ../test/journey-runner-recovery-real.spec.ts --project=real
```

每例限时四分钟，不自动重试。不使用 LLM Judge，保留标准 journey 报告、模型输入与工具协议、
Runner 请求、执行时间和 Provider 返回的 token 用量，失败时也收集。
单次通过不是对模型指令遵循能力的普遍保证；通过轨迹区分模型决策错误与工具未暴露、结果丢失、
前端渲染等框架问题。证据记录所选后端，native 通过不能替代 Swarm 验证，反之亦然。

## 相关文档

- [Shell、环境与 Workspace](../core/execution-workspaces.md)：用户可见的执行行为。
- [control-plane.md](control-plane.md) — API 如何调用 Runner（签名、端点）
- [architecture.md](architecture.md) — 进程模型与端口
- [配置参考](../reference/configuration.md) — 相关环境变量、配额与数据落点
- [Ascend NPU 宿主 Broker](ascend-npu-runner.md) — Ascend NPU Broker 设计背景

## 显式授权的直执恢复

已配置的本机或远程 Runner 可达但沙箱不可用时，Agent 可通过 `request_direct_execution`
提交失败操作 ID、确切 Shell 命令和工作区相对目录。对话中的独立授权卡展示目标
Runner 实例、OS 账号、工作区、命令及失去隔离的影响。拒绝不执行任何命令；批准
只返回决策，Agent 必须用新的 `run_direct_shell` 调用确认返回的范围再执行。
系统 Shell 可以调用 Python，不会自动提升权限。

直执 Shell 启动时使用 `PATH=/usr/bin:/bin`，不加载 Shell 启动配置，也不继承
已激活的 conda 环境。使用 Homebrew 或 conda Python 时，应在提交授权的命令中
写明已安装解释器的绝对路径，例如目标机器上存在相应解释器时使用
`/opt/homebrew/bin/python3 -c 'print(42)'` 或
`/usr/local/bin/python3 -c 'print(42)'`。conda 应使用目标环境中 `bin/python`
的绝对路径。裸命令 `python3` 只搜索最小 PATH；在 macOS 上可能选中系统占位
程序或失败，而不是使用预期的安装。更换解释器会改变命令，需要匹配的直执授权。

沙箱的 Always Allow 和 JiuwenSwarm 普通工具授权不包含直执许可。“允许匹配”仅
覆盖当前 Session、Agent、run、目标实例、账号、工作区/目录及完全相同的命令。
不设固定 TTL；可通过现有权限管理撤销，run 结束或取消后不可继续使用，也不会
传给子 Agent 或后续 run。每个返回的授权在提交前即被消耗，即使提交失败也不可
重用。Runner 重启会改变实例标识，需要重新授权。当前仅支持沙箱故障后的恢复。

执行仍使用 Execution ID、日志、取消、超时、工作区版本和产物溯源；记录包含
`sandbox: none`、`networkPolicy: host`、授权引用及目标/账号/run/Agent。
结果未知时须先核实，不会自动重放命令。通过 `execution_status`、
`execution_logs` 和 `execution_cancel` 观察或取消任务。

直执不等同于沙箱：可访问主机文件、进程、网络和主机存储的凭据，没有 CPU、
内存或网络隔离。Shell 仅注入最小环境而不注入 Runner 服务凭据，但不能保护主机
文件中的凭据。工作区配额和产物记录不代表完整主机审计，主机副作用通常不可回滚。
取消会终止进程组，无法保证终止已逃离该进程组的后代进程。

#276 当前交付范围包括本机和已配置且可达的远程 Runner 临时系统 Shell 恢复。
失败操作固定目标 Runner，授权展示 Runner ID、实例、OS 账号及目标工作区。
Runner 在授权前校验远程逻辑工作区与实际目录，执行前再次校验。授权不能跨
本机/远程 Runner、工作区或账号使用。输入须显式传输，不会隐式复制本机文件。
远程输出保留在该 Runner 工作区，带已提交的工作区版本和执行审计；通过显式
工作区传输取回文件，不把远程路径当成本机产物。

提交前断连不执行命令。提交确认丢失或无法完成状态观察代表结果未知，不能据此
认定未执行。API 保留 Execution ID，不重新提交；须先核实该 ID 和目标工作区。
同一 Agent 在该 Runner 上有未知结果时，阻止新的直执授权。远程超时/取消继续
使用现有执行控制，保留最终错误和工作区版本。

托管环境选择、独立 SSH 运维或故障前直执仍不支持。Runner 不可达时，须使用
独立配置并获授权的连接；本路径不创建 SSH 凭据，也不修复连接。#276 仍保留
未交付的运维范围。提交并构建后可运行 `node test/api/direct-execution-journey.mjs`。
该旅程的远程目标是独立数据目录、显式配置的 loopback Runner，不代表真实跨机
网络或 SSH 验证；模型只使用本地脚本，不调用付费服务。
