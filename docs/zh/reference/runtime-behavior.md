# 运行时行为参考

根目录 [README_zh.md](../../../README_zh.md) 覆盖基础使用流程。本文集中说明模型、设置继承、技能、权限与评审、超时、会话生命周期和执行限制的当前行为。

## 模型

每个配置包含显示名、base URL（如 `https://api.openai.com/v1`）、模型 ID、可选 **Vision capable** 标志，以及 API token。

- **任务模型** — 用于聊天与 agent 运行
- **证据评审模型** — 可选的独立语义评审模型
- 提供方 token 静态加密存储（数据目录中的 `model-secrets.key`，AES-256-GCM，仅属主可读）。API **从不**返回原始 token（只返回是否已存储）。
- 数据目录须与密钥文件一并保护与备份。这不是 OS 钥匙串。

## 运行时设置与继承

运行时设置包括任务模型、证据评审模型、启用的连接器、语义评审开关，以及技能选择（模式与可选白名单）。除技能选择外，各字段按以下顺序**独立**解析：

1. **系统配置 → Global defaults** 中的全局默认
2. Project 旁齿轮动作中的 Project 覆盖
3. Session 标题栏 **Settings** 中的 Session 覆盖

全局设置直接定义系统默认。在 Project / Session 编辑器中，字段保持 **Inherit** 时会跟随上一级可用值（含父级之后的变更）。作用域编辑器会显示生效值及其来源（global / Project / Session）。连接器列表是**整表替换**而非合并：显式覆盖为空列表会禁用全部继承项。技能选择从 Project 层起独立解析：默认模式为 **all**，即所有已安装技能对运行与 `/` 均可用，Global 不携带技能设置；Project 可切换为 **selected** 并以白名单收窄，Session 可继承或覆盖 Project 的模式与白名单。在 selected 模式下，`/` 只提示生效集合内的技能，运行会拒绝白名单外的技能附件。

新 Session 默认继承。创建 Session 时仍要求解析后的任务模型存在且已保存提供方 token。运行开始时会快照设置；修改父级只影响之后的运行，不会改写进行中或历史运行已记录的配置。

## 技能管理

打开 **系统配置 → Skills** 可查看内置的 `life-science-evidence-brief`、`structure-pocket-inspection` 或管理本地技能。可移植包遵循 Agent Skills 布局：

```text
my-skill/
  SKILL.md          # 必需：YAML frontmatter + Markdown 说明
  scripts/          # 可选；会保存但不会自动执行
  references/       # 可选文本资源
  assets/           # 可选包资源
```

`SKILL.md` 要求小写连字符形式的 `name`（与包目录名一致）以及非空 `description`。管理器支持手工编辑、自然语言工作流草稿、从当前 Session 蒸馏的可审草稿、本地 `SKILL.md`/ZIP 导入，以及 HTTPS/SSH URL + 可选 ref/子目录的 Git 导入。Git 凭证只存在于本机 credential helper 或 SSH 配置中，**不会**出现在仓库 URL 或模型上下文里。不支持注册表、市场、签名与自动更新。

技能只在全局库中存一份。创建或导入后默认即可用（all 模式），无需在 Global 中勾选——Global 不参与技能设置；如需收窄，在 Project 或 Session 运行时设置中切换为 selected 并勾选白名单。每次托管编辑产生不可变 revision；运行开始时冻结所选 revision，Prompt Manifest 记录技能 ID、revision、version 与包哈希。仅在 selected 模式下引用某技能的 Project 或 Session 会阻止该技能删除；all 模式下的存储列表不阻止删除。

导入内容视为不可信本地数据。ZIP 条目会检查路径穿越、符号链接、加密、重复路径，以及归档限制（上传 25 MiB、解压 50 MiB、500 个文件、单资源 10 MiB、`SKILL.md` 512 KiB）。运行时 Prompt 只列出生效技能的名称、描述与 revision；模型需要时先用 `describe_skill` 查看 metadata，再用 `read_skill` 读取冻结 revision 的完整 instructions。选中的文本资源可在读取技能后通过有界工具 `read_skill_resource` 按需读取。`scripts/` 下文件仅为包可移植性保留，**不会**自动安装、调用或复制进 Python 工作区。

## 托管科学环境

Runner 启动与健康检查不会等待环境安装。新数据目录会在后台下载并校验自管 micromamba，然后只创建 Python base；在 **系统配置 → Environments** 可查看当前 state、phase、说明、失败原因与时间，失败后可重试。默认不会下载 R；第一次显式创建 R 命名环境时才按需准备 R base，升级前已经存在的 R base 不会删除。

环境 catalog 是实例级全局共享的，不按 Project 隔离。Python/R base 只读且不可删除；需要增删包时先创建命名环境。设置页与 Agent 都通过受控 API 创建/删除环境、安装/卸载 conda package spec，每次成功变更都会生成不可变 revision 并使 `currentRevisionId` 前移。不要让 Agent 用 `run_shell` 直接调用 conda、mamba、micromamba 或 pip 修改托管前缀；这不是受支持路径，也绕开 revision 溯源。

## 权限与评审器

启用连接器或具备运行时**不等于**执行授权。首次匹配的代码或连接器动作会暂停并弹出权限卡片（除非已有未撤销授权）。持久授权列于 **系统配置 → Permissions**；撤销后下一次匹配动作会再次询问。目录类工具仍限制在工作区内，授权**不会**关闭 bubblewrap 文件系统隔离，也**不会**改变生效的沙箱网络策略（该策略只由系统设置决定）。

Reviewer Specialist 默认关闭；在系统配置中启用后，可通过工作区的 **Run review** 或明确的对话请求审核 Artifact。Quick 档位执行 Citation 格式检查与 Computation 溯源链检查，结果以独立卡片持久化并注入后续主 Agent 上下文，但不会阻塞当前对话。文本产物版本提供 diff，同时保留两个不可变版本。

## 超时与运行状态

在 **系统配置 → Timeouts** 中可设置 Agent 无响应、Agent 单轮、Runner 执行、持久内核空闲、权限等待五项产品墙钟超时。**Agent 无响应**会在本轮长时间没有流式输出或进度时自动停止；**Agent 单轮**限制完整一轮（模型、工具与流式输出）的总时长。每个字段均支持 **Unlimited**（API 与环境变量中用 `0` 表示）。默认 Agent 无响应 240 秒，其余四项无限。环境变量仅作为新数据目录的初值；首次持久化后，以设置页中的值为准。请求签名新鲜度等内部协议安全窗口刻意不暴露。

**系统配置 → Runtime status** 展示活跃 Session 运行、Runner 队列/在执行任务与持久内核。页面自动刷新。请求达到配置超时时，流会给出精确原因与时长，并在 Session 历史中保留为同样的超时说明。

要停止长时间运行或卡住的请求，使用 Composer 中的 **Stop run**：它会取消当前 Agent run，将中止信号经 Gateway 与工具回调贯通，杀掉在途的 bubblewrap 执行，并立即从运行状态中移除排队的 Runner 任务。运行状态页可为单个持久内核按 ID 执行 **Teardown** 回收。有这些控制后，默认无限执行在正常用户取消时无需重启 Runner。外部 HTTP 传输超时（语义评审模型调用、paper worker、science-sources 检索/下载）属下游 IO 护栏，刻意不纳入这些产品运行时设置。

## 会话生命周期与删除

在 Session 导航中使用 **Active**、**Archived**、**All** 过滤。归档保留消息、工作区文件、论文与审计历史，但会话变为只读：运行、改设置、上传、连接器调用、论文变更与权限变更均被阻止。恢复后可再写。

**Delete** 是永久删除，不同于归档。删除前 UI 会请求服务端生成的影响预览，展示受影响的活跃/归档 Session 与数据类别，并要求精确输入资源名称。删除 Session 会移除其全部工作区与历史。删除 Project 会级联删除其下全部活跃与归档子 Session 以及 Project 设置。两者均不可撤销；若数据可能仍需使用，请先备份数据目录。

## 执行限制

没有计算资源档位，也没有 CPU/内存配额：沙箱代码可使用主机能提供的资源。仍保留的护栏是：可配置的单次执行墙钟超时（本地模式默认无限）、Runner 工作区总量默认 10 GiB、单次执行 stdout+stderr 默认保留 1 GiB（超限截断），以及全局单一执行 worker（同一时刻只跑一个沙箱任务）。Runner 当前不设置独立的单文件执行配额，但文件仍计入工作区总量。API 上传另有单文件 1 GiB、单请求 10 GiB 和累计工作区 10 GiB 的入口限制；这些上传限制不等同于 Runner 输出限制。完整变量和层级见[配置参考](configuration.md#配额层级)。隔离本身不变：bubblewrap 命名空间、seccomp，且主机文件系统只暴露会话工作区。网络是可配置策略而不是常量：默认 `none`（沙箱无网卡）；管理员在 **系统配置 → 沙箱网络** 开启 **域名允许列表** 后，沙箱仍然没有网卡，出站只经本部署的 egress gateway 并按允许域名过滤。生效策略随 Permission Epoch 快照，可在 `/api/health.sandboxNetwork` 查看；详见[沙箱执行](../explanation/sandbox-execution.md#31-沙箱网络访问)。

## 论文阅读器限制

每个 PDF 最大 50 MiB、200 页；抽取上限为 2000 万文本字符、256 张表、128 个插图、24 页预览。**无 OCR**。嵌入文本很少的页面可标记为需要视觉模型；具备视觉能力的模型配置最多分析 4 张图。视觉输出是模型解读，不是权威转录。

文章级许可约束复用。Europe PMC 开放获取 PDF 路径使用遗留的 PMC OA Web Service / HTTPS 布局（计划于 2026 年 8 月退役）。
