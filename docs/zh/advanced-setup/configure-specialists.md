# 创建与使用自定义 Specialist

本教程创建一个“队列数据核查”角色，演示如何把团队的研究要求变成可复用配置。先完成[快速开始](../getting-started/quick-start.md)，准备可用模型和科学计算环境。

## 1. 明确职责与交付

先写清角色负责什么、需要哪些输入以及交付什么。下面的角色负责检查输入，不负责直接解释治疗效果。它不需要外部文献连接器。

## 2. 创建角色

进入 **系统配置 → Specialists**，点击新建，填写：

| 字段 | 示例 |
| --- | --- |
| 名称 | `cohort-data-checker` |
| 描述 | 检查队列表的字段、缺失值、重复记录和筛选人数，交付可复现核查结果。 |
| 指令 | 使用下方示例，再按本实验室数据规范修改。 |

```text
你负责核查用户提供的队列数据。
先读取字段和实际数据范围；不确定哪个字段标识患者时，先说明歧义。
记录行数、患者数（仅在可以确定时）、重复值和缺失值。
如需筛选，说明依据并记录筛选前后数量，不自行补造数据。
保存实际执行的脚本与核查结果，声明为产物，在最终回复中给出入口。
没有足够信息时明确记录限制，不从核查直接推断治疗效果。
```

只选择角色需要的连接器。若角色需要自建数据接口，先按[自定义 MCP 教程](configure-custom-mcp.md)配置并测试，再回到角色页面选择。

支持按角色选择技能的界面中，可选 `code-engineer`。在 JiuwenSwarm 后端，角色编辑器会显示技能由 Swarm 管理的提示，不提供同样的技能复选框；改到 **Skills** 的 JiuwenSwarm 视图确认所需技能可用。不要把未显示的设置当作已经生效。

保存后，自定义角色出现在角色列表中。内置角色只支持启停；若要改变某个预置职责，创建自己的角色，而不是修改内置条目。

## 3. 在会话中验证

新建 Session，上传一份你有权使用的小 CSV，在会话的 Specialist 选择器中选中该角色。发送：“请核查这个文件的数据质量，交付核查脚本和结果。”

检查执行记录是否真正读取文件，并在产物区打开脚本与结果。如果没有运行代码，检查模型工具能力、环境状态和审批；如果需要的来源不可用，检查连接器配置。角色名称本身不能证明工作按预期完成。

选择 Specialist 让它承担当前会话角色，与让主 Agent 分派给它一个子任务，是两种不同用法。需要跨角色协作时，保留协调者，并在任务中说明分工需求，再查看实际子任务记录。

## 4. 逐步完善

根据试运行结果调整描述、指令和资源范围，再开始新任务验证。模型、凭据与运行环境仍按平台的对应设置配置，不是在这个角色表单里独立创建。

- [专业 Specialist](../core/specialists.md)：预置角色与适用场景。
- [导入与管理 Skill](configure-skills.md)：加入自己的方法与脚本。

## Codex 专家运行时（Phase 2）

通过 API 配置 `runtime: {"kind":"codex"}`，并通过 `task(specialistId=…)` 显式委派。
省略 runtime 或使用 native 时行为不变。高级选项 model、reasoningEffort、
timeoutSeconds（1–86400）和 fallback 可在同频道对话中向专家提出，专家调用
`configure_specialist_runtime` 校验应用。密钥始终只在交互式配密卡输入，
单独加密保存，不进入对话、正文或 argv；Always Allow 不提供密钥。卡片支持关闭回退。

外层为 Runner 的 Bubblewrap/seccomp 启动逻辑，内层 Codex 使用
`danger-full-access` 避免嵌套 userns。每任务独立 Workspace 和私有 CODEX_HOME，
退出清理。模型传输可访问 API，原生 shell、搜索、MCP 和子代理禁用或拒绝；
平台工具使用独立 Runner 和原有离线/白名单策略，权限在同频道请求。
模型进程沙箱当前要求 Linux API 主机本地 Bubblewrap。execution=direct 需要
独立 direct_code 同意，不继承沙箱 Always Allow。部署端可配置
SCIENCE_AGENT_CODEX_BASE_URL，专家元数据不接受此字段。

显式 handoff API 为 `declare_artifact(path=…)` / `declare_artifact(paths=…)`。
只有成功声明的回执进入 artifacts[]；未声明文件不自动登记 Artifact、文件变化时间线、
生成文件来源或执行 Workspace 快照/diff。命令、日志、状态仍可审计。
父代理通过 Artifact ID/版本读取交付物，不使用子代理本地路径。

进程、鉴权或工具不可用导致无法运行时默认可见地回退 builtin-code-engineer。
设置 fallback=false、在对话中要求关闭或在配密卡取消勾选可禁用回退。
取消、超时、回合耗尽、普通任务失败、拒绝直执不回退；平台工作已派发后也不自动重放。
缺密钥先等待配密卡；取消或超时该等待不会启动原生任务。

持久 SDK 线程恢复、多运行时/ACP、共享沙箱和完整可观测性不属于 Phase 2。
参见 [English configuration guide](../../en/advanced-setup/configure-specialists.md)。

### Phase 3：Claude Code 与 ACP

`runtime.kind` 现在支持 `claude-code` 和 `acp`，沿用显式 `task`、平台工具、
权限请求及 `declare_artifact` 交付契约。主智能体可在委派前调用
`configure_specialist_runtime(specialistId, settings)`，配置只影响后续任务。
密钥通过同会话配密卡提交，按会话与运行时分别加密保存，不进入专家配置、
目录、命令参数或配置工具入参。通用端点为
`POST /api/subagents/:id/runtime-config`，旧 `codex-config` 继续兼容。

服务端通过 `SCIENCE_AGENT_CLAUDE_BINARY`、`SCIENCE_AGENT_ACP_BINARY` 设置独立
可执行文件的绝对路径；`SCIENCE_AGENT_ACP_ARGS` 只接收非密钥 JSON 参数数组。
Claude 使用 `ANTHROPIC_API_KEY`，ACP 可执行程序需自行从 `SD_ACP_TOKEN` 读取凭据，
无需认证时卡片填 `none`。不支持交互 OAuth 登录。可执行文件必须适配 Runner
最小文件系统，任意宿主包目录不会挂载。Claude 需支持 bare 模式和 JSON Schema
输出，建议使用含 bare 隔离修复的 v2.1.286 或更新版本。Claude 禁用原生工具；
ACP 不声明文件/终端能力，拒绝原生工具审批和调用更新。所有实际工作经过平台
工具和权限总线。ACP 的模型及推理选项必须由会话配置选项提供；不支持时明确失败。

并发子任务各有独立 Workspace、Runner 执行身份和私有模型进程目录，复用已有并发
调度，不引入共享沙箱。`runtimeDiagnostics` 提供结构化失败类别、任务回退次数与
外层运行时启动探针结果。探针不代表认证成功或逃逸测试通过，不请求内层沙箱。
验证使用协议桩及真实 API/Runner；真实 Claude/ACP 成功认证仍需获批凭据与兼容程序。
iCode 因打包、认证和工具隔离需要独立验证而延后；完整监控、P1/P2 编排、界面润色
及压力/逃逸验收矩阵均留待后续。详细配置见
[英文说明](../../en/advanced-setup/configure-specialists.md#phase-3-claude-code-and-acp)。
