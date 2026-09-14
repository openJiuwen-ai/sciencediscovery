# Ascend NPU 宿主 Broker 设计说明

本文只记录 Ascend NPU Broker 的问题背景、设计边界与文档入口。具体部署参数、工具契约、Runner 安全边界分别维护在仓库已有专题文档中，避免把运维说明和工具清单重复写在一份设计文档里。

## 1. 背景

在已验证的 Ascend 910B3 主机上，宿主 MindSpore 可以正常访问 NPU；同一探针进入 Runner 的 bubblewrap namespace 后会失败，典型错误为：

```text
Container ID verify failed (session ct_id=0; device ct_id=...)
```

那次测量是在宿主整个 `/dev` 都可见的情况下做的，这个报错是驱动在那种情况下的正常反应，而不是设备直通的限制：进入 mount namespace 后驱动按调用者 `/dev` 里可见的卡枚举，且是 all-or-nothing，只要有一张卡被别的租户占着，整次调用就对所有卡失败。

因此选中的芯片最终还是交进了沙箱——新建 `/dev`、只放选中的芯片、从 0 重新编号——这台机器上沙箱内的 `npu-smi info` 与 MindSpore 都能跑。launch 怎么拼、芯片是否可用怎么判定，见[沙箱执行](sandbox-execution.md) §3.2。

下面的 Broker 是另一条按需开启的路径，保留给不属于普通 Agent 执行的白名单宿主作业。

## 1.1 沙箱内的 NPU 与状态读取

Broker 之外，Runner 现在也能把选中的 Ascend 芯片交给 bubblewrap 沙箱（新建 `/dev` + 逐设备 `--dev-bind`，沙箱内从 0 重新编号）。这条路径要回答两个问题：机器上有哪些计算芯片，以及每颗芯片对应哪个 `/dev/davinciN`。

读取顺序是先驱动、后命令行：

- **DCMI（默认）**：用宿主 Python 以 `ctypes` 调用驱动自带的 `libdcmi.so`，逐芯片拿到所在卡号、卡内芯片号、chip logic id（就是设备号）、芯片名、健康与占用。不需要编译任何东西；`SCIENCE_AGENT_NPU_PYTHON_PATH` 可指定解释器。
- **npu-smi（回退）**：宿主没有可用 Python 或驱动调用失败时，用 `npu-smi info -m` 取「卡 / 芯片 / chip logic id / 芯片名」的对应关系，再用 `npu-smi info` 的表格补读数，按（卡, 芯片）join。`-m` 中 logic id 为 `-` 的芯片（如 Mcu）不是计算设备，不会出现在清单里。

**设备身份一律用 chip logic id，不用卡号**：一卡一芯的硬件（910B）上两者相等，一卡两 die 的硬件（910C）上不相等，用卡号会绑错 die。用户勾选的粒度因此是芯片（die），勾选集合按 logic id 升序在沙箱内从 0 重新编号，与运行时 rank 一一对应。

支持范围是 Ascend 910 系列；其他芯片（包括 310 开发板）会被列出但不可勾选，理由里会写明芯片名。

## 2. 设计边界

- 常规执行统一使用 `run_shell`，包括 `python -m`、Python 文件和 `Rscript`；每次使用新沙箱（Linux 上为 bubblewrap + seccomp），不跨调用保留解释器状态。
- NPU 模型作业不走持久 kernel REPL。
- Host NPU Broker 默认关闭，只有 `SCIENCE_AGENT_NPU_BROKER=1` 时才向 Agent 暴露 `run_npu_job`。
- Broker 只运行 workload 白名单中的固定 entrypoint，不提供任意宿主 shell。
- 内置 NPU workload（包括 smoke test）需要托管 Python 环境。Agent 用 `environment_id` 选择环境，API 解析最新版并传给 Broker 内部审计字段；缺少可用 Python runtime 时在入队前拒绝。Agent 不再选择历史 Revision。
- workload 子进程在宿主 namespace 中运行，用于访问 CANN / MindSpore / Ascend 设备；路径、Session、job 生命周期仍由 Runner 校验。
- Agent 可写的 `config.json` 只描述 workspace 输入、preset 与运行参数；Python、helper scripts、CANN、HMMER、MindScience、模型权重/数据库目录等宿主资产只能来自管理员环境变量或 workload manifest。它们可以位于 `/home`、共享盘或其他部署目录，但不能由 Agent 在 `config.json` 中改写。
- 抗体 adapter 不执行 Session workspace 里的 helper 脚本；如 manager 生成了 `<workspace>/helpers/...` 脚本路径或 `--scripts-dir <workspace>/helpers` 目录参数，adapter 会重写到宿主 skill/bundle 的只读 `scripts/` 目录并拒绝残留的 workspace helper 执行路径。
- Protenix 等模型代码、权重、数据库、HMMER、CANN、MindScience checkout 是部署资产或 skill 资产，不进入通用 Runner 代码。

## 3. 文档落点

| 需要查什么 | 应看哪里 |
|---|---|
| 如何启用 / 关闭 Broker，以及 `.env` 参数含义 | [配置参考](../reference/configuration.md#环境变量本地模式) |
| Agent 能看到什么 NPU 工具、参数怎么填 | [内置工具清单](../reference/builtin-tools.md#其他条件工具) |
| 选中的芯片如何进沙箱、可用性如何判定 | [沙箱执行](sandbox-execution.md#32-沙箱内的-ascend-npu) |
| Broker 为什么是沙箱外的例外，以及有哪些安全校验 | [沙箱执行](sandbox-execution.md#33-ascend-npu-broker可选的宿主执行) |
| Broker 在整体进程模型里的位置 | [整体运行时架构](architecture.md#25-职责切分核心原则) |
| 默认 workload 白名单 | `services/runner/workloads/npu-workloads.default.json` |

## 4. 扩展原则

Broker 的可扩展性来自“注册新的 workload manifest”，不是开放任意命令。新增模型时应增加或部署新的白名单条目，并保持：

- 固定 entrypoint；
- `shell: false`；
- 默认通过 `run_npu_job(environment_id=...)` 所选托管环境的最新版解析 Python，解析出的 Revision 仅在内部保留用于审计；只有自定义 manifest 显式使用 `${python}` 时才读取 `SCIENCE_AGENT_NPU_PYTHON`；
- workspace 与仓库路径 `realpath` 边界校验；
- 明确的环境变量 / 站点资产引用；
- 按 Session 隔离的 status / logs / result / cancel；
- job 状态沿用 `queued -> running -> succeeded | failed | cancelled | interrupted`。

直接把 NPU 设备透传进 bwrap 只能作为未来优化：必须在目标部署上通过真实 Ascend 算子探针后才可启用；探针失败时继续回退到 Broker。

## 5. 已知限制

- Phase 1 采用全局单 Broker worker：不同 Session 的 NPU job 也是跨 Session FIFO，因此某个 Session 里的长作业或卡住的作业会让其他 Session 后续作业继续排队。
- NPU Broker job 暂无 wall-clock 超时；运维应让 workload entrypoint 自身有边界，或通过 cancel 显式取消作业。
- 持久化 catalog `.sciencediscovery-data/npu-jobs/jobs.json` 暂不自动清理，并且每次追加 job 输出都会全量重写。catalog 读取是 best-effort：文件损坏不会阻止 Runner 启动。

## 6. 测试入口

Runner 侧针对 NPU Broker 的测试命令：

```bash
pnpm --filter @sciencediscovery/runner build
node --test --test-name-pattern "NPU Broker" services/runner/dist/server.test.js
```

覆盖重点包括默认关闭、显式启用、HMAC submit、workload 白名单、workspace 路径逃逸拒绝、`${repo:...}` realpath 边界、Protenix workload 执行、Protenix 入口拒绝 AF3 intent 配置、产物收集与 Runner 重启后的 interrupted 状态。
