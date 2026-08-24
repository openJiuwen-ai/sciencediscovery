# 内置工具清单（模型可见）

本文列出 Agent 循环中模型可见的全部工具。工具由 `packages/workspace` 的 `createWorkspaceTools` 构建，并由 `packages/tools` 注册和调度：**实现全部在 Node 控制面**，模型请求里只带名称、描述与 JSON Schema（见 [agent-backend.md](../explanation/agent-backend.md)）。除标注「恒有」外，工具是否出现取决于会话配置；最终列表还会经 `toolPolicy` 过滤（子 Agent 可被限制为白名单子集）。

## 基础工具（恒有）

| 工具 | 参数 | 行为与边界 |
|---|---|---|
| `list_files` | 无 | 递归列出会话工作区文件（路径/大小/修改时间），跳过符号链接，最多 500 个 |
| `read_file` | `path` | 读工作区内 UTF-8 文本文件，上限 1 MB；路径经工作区逃逸校验 |
| `list_artifacts` | 无 | 列出当前 Project 中跨 Session 的用户可见产物，包含来源、创建 Session 快照和最新版本元数据 |
| `read_artifact` | `artifact_id` 或 `name`，可选 `version` | 按 Project 产物身份读取指定版本；文本返回 UTF-8，二进制返回 base64，内容上限 1 MB |
| `declare_artifact` | `path` 或 `paths`（1–50 项），可选 `name`、`description` | 将当前 Agent 可写工作区内的文件显式声明为 Project 产物。单 `path` 保留原返回，`name` 默认等于规范化后的工作区相对 `path`，可显式覆盖为其它安全逻辑路径；`paths` 优先且逐项返回 `ok/error`，成功项不回滚，每项使用自身完整相对 path 并忽略顶层 `name/description`；name 中的 `/` 在产物侧边栏显示为虚拟目录，不创建或移动物理文件；预览 kind 由服务端内部推断，最终报告也必须声明 |
| `run_python` | `code`，可选 `environmentRevisionId`、`kernelMode: ephemeral\|persistent` | 在 bubblewrap 沙箱执行 Python；默认一次性进程，可选托管环境与持久内核；非零退出即工具错误 |
| `run_shell` | `command` 或 `scriptPath` 二选一，可选 `arguments`、`kernelMode` | 有界 shell：默认复用 Session 持久 shell 会话（`cd`/`export`/`source` 跨调用生效，白名单变量也注入后续 `run_python`/`run_r`；见 [sandbox-execution.md §8](../explanation/sandbox-execution.md#8-持久-shell-会话与-session-env-profile)）；`kernelMode=ephemeral` 为一次性干净 shell；只见工作区，网络按沙箱网络访问策略（默认无网络） |

`run_python` / `run_shell` 首次执行会触发 `code` 类权限卡片（见[运行时行为参考](runtime-behavior.md#权限与评审器)）。执行产生的文件仍保留 diff 与 derivation 审计，但不会仅因出现在工作区就进入产物目录；Agent 必须调用 `declare_artifact`，用户上传、MCP 下载与拉回的远程任务输出则由控制面在入口处注册。

## Web 工具（恒有）

| 工具 | 参数 | 行为与边界 |
|---|---|---|
| `web_search` | `query`（1-2000 字符） | 自动聚合搜索：先试已配置 key 的付费 Provider，再试开启的免费引擎，取第一个出结果的；返回片段与 URL，不代表已读全文 |
| `web_fetch` | `url`（完整 http(s) URL） | 抽取指定公开网页；拒绝凭证 URL、内网/环回地址；不做跨 Provider 降级 |

两者均由 Node 发起独立权限检查，写 CAS 快照和 `WebInvocation` 审计，厂商调用也在 Node 进程内完成。详见 [web-tools.md](web-tools.md)。

## 编排工具

| 工具 | 出现条件 | 参数要点 |
|---|---|---|
| `propose_plan` | 主运行注入 | `scope`（≤2000 字符）、`steps`（1-20 项）、`feasibilityConfidence: high\|medium\|low`、可选 `caveats`；计划是进度记录，不阻塞后续执行 |
| `task` | 主运行注入（子 Agent 内不可再派生） | `description`（≤80 字符）、`prompt`（≤20000）、可选 `brief`（Brief v1 契约，见 [subagent-orchestration.md](../explanation/subagent-orchestration.md#41-subagent-brief-v1-契约)）、`inputPaths`（≤50）、`max_turns`（≤300）、`timeout_seconds`（≤3600）、`specialistId`、`tools`（白名单，≤32）；同轮多次调用可并行 |
| `query_graph` | 在 System Settings 中启用 Science Memory | `query`：跨会话记忆图的大小写不敏感子串搜索，返回 `{hits, total, truncated}` |

## 科学环境工具

出现条件：科学环境已启用且完成 setup（`executeScientific` + 环境列表注入）。

| 工具 | 参数 | 说明 |
|---|---|---|
| `run_r` | 同 `run_python`（`code` / `environmentRevisionId` / `kernelMode`） | 在托管 R 环境 revision 中执行；输出附带 revision 与 kernel mode |
| `environment_list` | 无 | 列出全局共享的只读 base 与命名环境，以及当前不可变 revision ID |
| `environment_create` | `name`、`language: python\|r`，可选 `baseEnvironmentId` | 从对应只读 base（或指定 base）克隆命名环境；首次显式创建 R 环境时按需准备 R base |
| `environment_delete` | `environmentId` | 删除命名环境；base 拒绝删除 |
| `environment_install` | `environmentId`、`packages[]`，可选 `manager` / `channels[]` / `indexUrl` | `manager` 默认 `conda`；Python 环境可选 `pip` 安装一个或多个 PyPI 规格或当前 Session workspace 相对 `.whl`。仅 `manager=pip` 可传独立 HTTPS `indexUrl`，效果等价于单次 `pip --index-url` 并覆盖全局 pip 源。包规格不接受远程 URL；本地 wheel 按 SHA-256 持久保存并写入 revision snapshot。conda 渠道仍须在白名单或内置镜像预设内 |
| `environment_uninstall` | `environmentId`、`packages[]` | 使用 conda package spec 卸载；成功产生新 revision |

四个 mutation 工具使用独立的 `code / scientific-environments` 权限资源；base 始终只读。Agent 系统提示明确要求通过这些工具治理托管前缀，不把 `run_shell` 中直调 conda/mamba/micromamba/pip 作为支持路径。系统设置中的 pip 源可选 `Official upstream`、`Tsinghua TUNA`、`USTC` 或 `Huawei Cloud`，其中 `Huawei Cloud` 使用 `https://mirrors.huaweicloud.com/repository/pypi/simple`；conda 源可选前三项，不提供 Huawei Cloud 预设。设置页只显示来源名称，不附加地区描述。源优先级为“单次显式源 > 全局选择 > 官方上游”。设置页没有 Session workspace 上下文，因此 pip 只能使用 PyPI 名称规格，不能提交本地 wheel 路径。`indexUrl` 仅在 `manager=pip` 时有效，必须是符合实现校验的 HTTPS 且不得含凭据、query 或 fragment（长度 ≤2048、无空白/控制字符，首尾空白会被裁剪）。离线缓存模式仍校验该字段，但安装命令会静默忽略网络 index，改用 `--no-index --find-links`。pip 自定义源应通过结构化的 `indexUrl` 表达，不要用 `run_shell` 直调 pip 拼参数。等价于 `pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu` 的受控调用示例：

```json
{
  "environmentId": "<named-python-env-id>",
  "manager": "pip",
  "packages": ["torch", "torchvision"],
  "indexUrl": "https://download.pytorch.org/whl/cpu"
}
```

## 科研 MCP 工具（动态）

出现条件：会话启用了对应 MCP 来源。命名 `mcp__<source>__<tool>`（如 `mcp__pubmed__search`），描述与输入 schema 来自来源 manifest，按需发现（`deferred: true`，模型初始只见工具名，schema 经 `tool_search` 晋升后暴露），返回内容视为不可信外部数据。注入链路、逐层过滤与模型可见性见 [science-connectors.md](../explanation/science-connectors.md) 第 3 节。

配套的文件工具：

| 工具 | 出现条件 | 参数与边界 |
|---|---|---|
| `artifact_download` | 任一 MCP 来源启用 | `mcpInvocationId` + `candidateId`（来自此前 MCP 调用返回的 `ArtifactCandidate`），可选 `destinationPath`；等待权限与下载终态，**不**解析 PDF |
| `paper_extract_pdf` | 论文抽取接线 | `artifactJobId`（必须是已完成的下载任务）；触发有界 PDF 抽取（见 [paper-worker.md](paper-worker.md)） |

下载与抽取必须分属不同模型回合——同回合工具并行执行，没有 `dependsOn` 机制。

## 其他条件工具

| 工具 | 出现条件 | 参数要点 |
|---|---|---|
| `run_npu_job` | Runner 启用 `SCIENCE_AGENT_NPU_BROKER=1` 且加载到 NPU workload 白名单 | `operation=list_workloads\|submit\|status\|logs\|result\|cancel`；`workload_id` 必须来自白名单，`config_path` 必须是当前 Session workspace 相对路径；需要 Python 的 workload 使用 `environment_revision_id` 选择托管科学环境，省略时使用 Session 当前 revision；内置 workload 为 `npu.smoke_test` 与 `antibody.protenix.v1` |
| `describe_skill` | 本次运行至少选择一个技能 | `query`（支持名称/描述关键词、`select:skill-a,skill-b` 精确选择、`+term rest` 必含名称检索）；只返回技能 metadata 与资源摘要，不返回完整 `SKILL.md` |
| `read_skill` | 本次运行至少选择一个技能 | `skillId`（枚举限定为本次运行选中的技能）；按需读取冻结 revision 的完整 `SKILL.md` instructions，并列出可选 supporting resources |
| `read_skill_resource` | 选中的技能中至少一个带文本资源 | `skillId`（枚举限定为本次运行选中的技能）+ `path`；读取 `read_skill` 后按需加载 supporting resource，返回有界 UTF-8 内容，**从不**执行或安装 |

技能加载流程见 [skill-progressive-disclosure.md](../explanation/skill-progressive-disclosure.md)：`describe_skill` 检索本次运行的技能目录，`read_skill` 和 `read_skill_resource` 读取本次运行的冻结快照。

`run_npu_job` 不是通用宿主 shell。它只把 Agent 请求转成 Runner 内 Host NPU Broker 的作业操作，由 Broker 按 JSON 白名单启动固定 entrypoint，并按当前 Session 校验 job 的 status / logs / result / cancel。默认 NPU workload 的 Python 由 Runner 根据 `environment_revision_id` 在 `.sciencediscovery-data/scientific-envs/` 中解析，Agent 不能提交任意解释器路径。技能应先用 `environment.list` 和指定 revision 的 `run_python` 验证依赖；没有满足条件的环境时，通过 `environment.create` / `environment.install` 创建新 revision，再把返回的 revision ID 交给 `run_npu_job`。内置抗体 workload 使用 Protenix 路径 `antibody.protenix.v1`；其他模型后端需要显式自定义白名单或后续扩展。

## 一致性说明

- 工具描述文本以 `packages/workspace/src/workspace.ts` 中的 `description` 字段为准，本文为摘要。
- 会话禁用某来源/能力时，相应工具不进入 `tools[]`，模型完全看不到——这是「不可见即不可调」的治理边界，而非运行时拒绝。
- 权限拒绝、配额超限等失败以结构化工具错误（`{ok: false, error: {code, message, retryable}}`）返回给模型，模型可解释或换路径。

## 相关文档

- [agent-backend.md](../explanation/agent-backend.md) — 工具规格如何下发到 gateway、回调如何执行
- [control-plane.md](../explanation/control-plane.md) — 权限系统与工具回调注册
- [sandbox-execution.md](../explanation/sandbox-execution.md) — `run_python` / `run_r` / `run_shell` 背后的沙箱
- [Ascend NPU 宿主 Broker](../explanation/ascend-npu-runner.md) — Ascend NPU Broker 的设计背景与文档入口
