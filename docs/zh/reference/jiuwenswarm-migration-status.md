# JiuwenSwarm 迁移：现状与交接

> 历史迁移记录：下文关于原生子 Agent 默认值及旧版限制描述的是当时的基线。当前默认已统一为平台 `task` 分发、Swarm 执行；显式设置 `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=jiuwenswarm` 可切换原生链路。参见[当前编排说明](../developer-docs/subagent-orchestration.md)。

issue 84（复用 JiuwenSwarm 后端）做到哪一步、现在能跑什么、什么还没做，以及如何开始做某个子 issue。源码启动方法见[本地模式](../getting-started/deployment.md#本地模式源码检出)。

## 这个基线是什么

一个**过渡架构**，是有意选择的：现有 TypeScript API 继续持有存储（会话、消息、运行事件、权限记录）以及 UI 调用的全部路由。只替换**智能体执行器**：模型循环跑在 JiuwenSwarm 0.2.6 上，通过一个 Python **适配器**接入；适配器同时作为反向代理挡在 API 前面。

```text
浏览器 ─▶ 适配器 :4310 ──代理──▶ legacy API :4410 ──createAgent──┐
              │  ▲                                                 │ POST /agent/runs
              │  └────── 工具调用（每次运行一个回环 bridge）◀──────┤
              ▼
        JiuwenSwarm 网关 ─▶ 模型，经 /llm/<token>/v1（适配器）
              └── MCP 工具 ─▶ /mcp/<token>（适配器，转发给 bridge）
```

这**不是** issue 正文写的终态（由适配器在 JiuwenSwarm 自有存储之上提供路由）。下表逐个子 issue 说明离终态还差多少。假设终态的验收标准是否要按过渡架构改写，还是待 issue 负责人决定的事项。

设计与实测的协议事实：[`services/adapter/README.md`](../../../services/adapter/README.md)。

## 各子 issue 现状

| Issue | 状态 | 已有 | 没有 |
|---|---|---|---|
| 86 验收基线与协议校准 | 已关闭 | 接口清单（259 行）、L1/L2 工具、Linux 上 27 个录制用例、协议实验、`CI_E2E_BACKEND=jiuwenswarm` | 104 行没有用例；59 条“近似映射”未校准；未评估 `AgentRuntime` |
| 87 适配器核心 | 已关闭 | 公共端口、流式代理（SSE、NDJSON）、上游失败返回 502、`/agent/*` 可选 token | 自有存储、run 注册表、事件日志与续传：仍在 legacy API |
| 88 会话与项目 | 已关闭 | 经代理由 legacy API 提供；L1 覆盖 13 行 | 没有迁到 JiuwenSwarm 的会话存储 |
| 89 对话与运行 | 已关闭 | 运行在 JiuwenSwarm 上执行；事件、取消、审批、用量、断线处理；8 个场景的 L2 黄金轨迹 | 见“已知缺口” |
| 90 权限 | 已完成 | 审批请求、允许/拒绝、授权、审计、epoch、错误 token 拒绝与之前一致（L1 8/8 加负例，L2 允许/拒绝） | 未映射到 JiuwenSwarm 的权限引擎（保持关闭，由 API 的权限运行时判定）；发现见下 |
| 91 模型、供应商、设置 | 已完成 | 模型列表、默认值、设置由 legacy 提供（L1 覆盖全部行）；所选模型按次交给 JiuwenSwarm | 三种模型协议都能跑，经 API 里的回环模型网关 |
| 92 MCP 与数据源 | 已完成 | 21 行都有 L1 用例；5 条 MCP 旅程在此执行器上通过（自定义 MCP、智能体调用自定义 MCP 工具、OAuth、密钥编辑 ×2）；延迟的 MCP 工具启动时一并晋升，并提供 `tool_search` | 没有对真实供应商跑过 MCP OAuth |
| 93 技能与技能库 | 未开始 | 由 legacy 提供 | L1 0/35；技能在此执行器上的使用未验证 |
| 94 文件、工作区、轨迹 | 未开始 | 读接口有 L1 用例 | 轨迹已记录（见已知缺口 1） |
| 95 规划与子代理 | 已完成 | 规划默认用 JiuwenSwarm 自己的 todo 工具（它的 `todo.updated` 清单就是运行的计划；`SCIENCE_AGENT_JIUWENSWARM_PLANNING=update_plan` 可改用我们的）。在启用 JiuwenSwarm 工具（默认）时，委派也默认用它自己的 `subagent_spawn`/`subagent_wait`，不再提供 `task`（`SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task` 可改回我们的；`SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` 本就意味着这一点；模拟旅程跑在 JiuwenSwarm 自己的工具上，并设 `SUBAGENTS=task`，`task` 子代理经 bridge 运行，每个子代理有自己稳定的 JiuwenSwarm 会话，所以被恢复的子代理接着自己的对话）；L1 覆盖全部行；L2 子代理与两轮对话用例一致；计划与委派旅程通过（脚本化的是 JiuwenSwarm 的 `todo_create`/`todo_modify` 和我们的 `task`）。规划或委派不归它时（Plan 插件关闭、`PLANNING=update_plan`、`SUBAGENTS=task`），它的 todo 或子代理工具会被隐藏，而不只是不列出，模型无法绕过 | `subagent_spawn` 子代理拿不到什么，见已知缺口 1a。仍不使用 `task_tool`、`team.*`、`agents.*` 和 agent 模板；每一步的计划快照不注入 |
| 97 科学工具集 MCP 化 | 已完成 | 等价工具集以 MCP 工具提供，经 bridge 调 legacy 工具，走同一个 ToolRegistry；有测试把提供的工具集与 schema 钉在注册表上；延迟工具启动时一并晋升并提供 `tool_search`；并行调用可运行且一致 | 后续子 issue（idea-tree、evolve、memory、产物审阅）的工具随它们一起到 |
| 103 用量 | 已完成 | 每次模型调用的 token 数映射成 `model.usage` 并汇总；一次运行后的会话用量、按模型用量与内置循环一致（L2）；每一行都有 L1 用例 | 没有迁到适配器存储；统计仍在 API |
| 93、94、96、98-102、104-106 | 未开始 | legacy 行为原样在代理之后 | 全部：作为迁移尚未开始。runner/环境/远程主机的读接口有 L1 用例 |

## 已验证

在阿里云 Linux 服务器（bubblewrap 沙箱）上，`SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`：

- 里程碑 0 的五条旅程（首次运行、精简过程 ×2、计划工作区、委派子任务、交付结果）通过。
- 一条使用真实 OpenAI 兼容模型的旅程通过（`journey-real-request`）。
- L2：10 个运行事件场景（文本、工具调用、审批允许/拒绝、取消、401、子代理、断线续传、post-messages、两轮对话、并行工具调用）的事件类型序列与内置循环一致。被接受的差异记在 `test/contract/accepted-differences.json`（供应商 401 的措辞、evidence 缺口）。
- L1：内置循环与“适配器 + JiuwenSwarm”栈上录制的用例一致（构建版本号已归一化）。
- 单测：适配器（`pytest`，135 个）、TypeScript 的 agent 工厂与模型网关（51 个）。`test/contract/jw-only/live.mjs` 在运行中的 JiuwenSwarm 栈上检查只有这个后端才有的行为（对话连续性、todo 规划）。

## 上下文管理

JiuwenSwarm 自己有一套上下文引擎（占用到模型窗口的 80% 时压缩，并自己注入每一步的动态上下文）。执行器现在用的是它：

| | 内置循环 | JiuwenSwarm 执行器 |
|---|---|---|
| 对话放在哪 | API 的记录，每一步重新发 | JiuwenSwarm 的会话，每个智能体一个（持久化在它的检查点数据库里）；不随请求发送，适配器里也没有 |
| 窗口快满时的压缩 | ScienceDiscovery 自己的压缩器 | JiuwenSwarm 的，依据**一个全局窗口**（`JIUWENSWARM_CONTEXT_WINDOW_TOKENS`，默认 200000；它忽略模型自己的窗口）。已用 3000 token 的窗口验证：早期几轮被总结压缩（`live.mjs compression`）。它的摘要和标题用它的默认模型，适配器把它指向正在运行的那次运行的模型 |
| 系统提示词 | 每一步用 ScienceDiscovery 的各段（身份、治理、能力、技能）组装 | 先是 ScienceDiscovery 的产品提示词，再是 JiuwenSwarm 自己的完整提示词（约 1.2 万字符：身份、安全、工具规则、记忆、上下文压缩、已安装 Skill），最后是运行契约。这个模式下它没有放 todo 那一段。`SCIENCE_AGENT_JIUWENSWARM_PROMPT=replace` 恢复旧行为 |
| 运行契约（受保护） | 每一步都在 | 每一步都在：它是系统提示词的一部分，适配器在每次模型请求里都放上它 |
| JiuwenSwarm 自己的提示词 | 不适用 | 完整保留；它的每轮包装和动态上下文（运行时状态）也作为用户消息加进去 |
| 计划快照、持久状态、插件上下文 | 每一步注入 | **没有注入**；JiuwenSwarm 加自己的动态上下文 |
| 工具 | ScienceDiscovery 的，全部经过它的权限和 Runner | 默认是 JiuwenSwarm 自己的网页、子代理、todo、记忆和技能工具，加上它没有的 ScienceDiscovery 工具。直接操作宿主机的 `bash`、文件工具及相关读取工具实现会在所有工具模式下被拦截。适配器会拒绝原生调用；若本次运行提供同名的 ScienceDiscovery 工具，该工具仍可用，命令应使用 `run_shell`。`SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` 会选择 ScienceDiscovery 的工具集，同时保留 JiuwenSwarm 的 todo 工具用于计划 |
| 工具路由提示 | 有 | **没有注入** |
| 工具输出守卫和读取 | 有 | 有（同一个 `ToolRegistry`） |
| 输入过长的恢复 | 压缩后重试 | JiuwenSwarm 自己的处理；**没有验证** |
| 轨迹与 evidence | 有 | 有（在模型网关记录，见已知缺口 1） |

## 已知缺口

1. **轨迹：已记录。** JiuwenSwarm 运行的每次模型调用都经过这次运行的模型网关，网关用内置循环同样的 `AgentVersionRecorder` 记录：发出的完整模型输入（含 JiuwenSwarm 的提示词和工具）、模型的回答、工具观测和提交的步骤；运行事件带有关联它们的 evidence（实时检查 `trajectory`）。JiuwenSwarm 自己发出的标题、摘要调用不算轮次，不记录。
1a. **子代理默认用 JiuwenSwarm 自己的 `subagent_spawn`/`subagent_wait`**（`SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task`，或 `TOOLS=ours`，仍改用 ScienceDiscovery 的 `task`）。这是有意的取舍，不是对等替换：`subagent_spawn` 子代理（0.2.6 内置的 `general_agent`）完全跑在 JiuwenSwarm 内部，只带未被禁用的内置工具，不带 MCP 服务——拿不到 ScienceDiscovery 的工具、沙箱、审批、工作区交接、溯源或子代理卡片，它的 `subagent_spawn`/`subagent_wait` 调用在运行里也只作为通用的原生工具事件上报，没有 `task` 那种更丰富的摘要。适配器会在所有工具模式下拦截 JiuwenSwarm 直接操作宿主机的工具实现。能挂载 ScienceDiscovery MCP 工具的自定义代理（`agents.create`）在 0.2.6 上仍然无法启动（`'str' object has no attribute 'name'`：它的工具列表是名字，而启动路径需要工具对象），这条路仍然堵着。`test/contract/jw-only/live.mjs subagent-probe` 可以完整查看一次 `subagent_spawn` 调用的表现。
1b. **轨迹：上下文来源归因不可用。** 轨迹查看器给每个块标注的"来源"（`packages/trajectory/src/index.ts` 的 `contextBlocks`）只有在模型调用组装带有结构化 section 数据（内置循环按 section 拼装提示词）时才会标 `"recorded"`。`services/api/src/agent-run/jiuwenswarm-trajectory.ts` 的 `ModelCallInput` 只有一个扁平的 `systemPrompt: string`——JiuwenSwarm 是整段拼自己的提示词，没有 section 边界可上报——所以每个块都落入 `"unavailable"` 分支。mocked E2E 的 `journey-session-trajectory` 因此在这个执行器上失败（它断言 JiuwenSwarm 的系统提示词块*不是*"来源未记录"）；这是这个后端的既定差异，不是要在这里修的 bug——同样的"整段保留"取舍见上面的"上下文管理"。
2. **历史与上下文。** JiuwenSwarm 是模型上下文的唯一持有者：每个智能体一个稳定会话，由 JiuwenSwarm 压缩；适配器和 API 都不发送、不重建任何历史。所以在内置循环上开始的会话，JiuwenSwarm 不记得（之前的轮次只在界面上），在 API 里编辑或回退的对话也不会反映过去。JiuwenSwarm 重启后这份上下文仍在（已验证：`live.mjs history-restart`）。每一步的动态上下文（计划快照、持久状态）没有注入，见"上下文管理"。
3. **模型协议：** UI 能配置的三种都可用（API 里的回环网关用原生模型客户端为 JiuwenSwarm 的 chat-completions 请求提供服务）。图片不会发给模型。
4. **工具集里没有** 工具输出存储。延迟工具启动时一并晋升。同一次模型响应里的工具调用按原生规则调度（没声明并发安全的工具独占、按模型调用的顺序执行；重复调用由批处理策略取代），所以两个执行器的事件与顺序一致。
5. **唤醒提示。** mocked E2E 的 `issue-77-wake-notice` **和** `issue-85-foreground-exec-inbox` 的 `test:206` 用例在这个执行器上都会失败，原因相同：脚本化模型靠用户消息是否以 `[Execution notifications]` 这个字面前缀开头来识别唤醒轮（`services/api/src/notification-dispatch.ts` 的 `notificationPrompt()`），但 JiuwenSwarm 对持续会话是自己重建面向模型的对话内容的（见缺口 2"历史与上下文"），不会原样转发这个前缀，脚本化模型识别不出这一轮，运行就以报错收场而不是正常完成。`issue-85` 的清理步骤也会跟着失败（失败的唤醒会让通知保持未读并不断重试，会话就一直不会 idle，从而卡住 Project 删除）——这是同一个原因的连锁反应，不是第二个 bug。（本行之前写的是"issue-85 通过"，那是过时信息。）用 `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked` 运行该组。这些旅程在小机器上对负载敏感：在 2 核服务器上连续运行时有两条失败过一次，单独运行（重复 3 次）都通过，所以有疑问时请逐条运行。
6. **录制中发现的 legacy 缺陷（未修）：** `PUT /api/sessions/:id/settings` 请求体错误返回 500；`PUT /api/web/settings` 用它自己 GET 的响应体返回 500；对未知 run 做技能进化返回 500；读工作区外的文件（`/file?path=../../etc/passwd`）返回 500 而非 4xx。
7. **#90 的发现：** `POST /api/sessions/:id/permission-epoch` 之后，会话范围的授权仍然生效（epoch 管沙箱，授权管会话）。issue 文字期望旧授权失效；基线记录的是 legacy 的实际行为。
8. **空闲超时：已实现。** `services/api/src/agent-run/jiuwenswarm-agent.ts` 的 `beginExternalWait()` 以前是空操作（注释写的是"循环在远端，没有本地空闲时钟可暂停"），只有整次运行的超时会被安排，所以一个悄悄卡住的 JiuwenSwarm 运行永远不会产生 `test/timeouts-runtime-status.spec.ts` 期望的空闲超时提示。现在它像内置循环一样跟踪这次运行的回合和空闲期限（`RunDeadlines`），抛出同样文案的 `Agent run stalled: no gateway progress for N ms`（被 `services/api/src/timeouts/index.ts` 匹配识别）；`beginExternalWait` 及其释放函数会在人工审批等待期间暂停这个时钟，避免等待本身被误判为卡住——包括审批等待本身：合并这个缺口的两份独立实现时才发现，原来这里一直没调用它。
9. **自定义 MCP 工具调用：偶发不可见。** `journey-custom-mcp` 的"Agent uses a selected custom MCP server"用例在一次完整套件运行中失败过一次（运行本身"completed"，但 `/api/sessions/:id/mcp/invocations` 始终是空的），之后（包括单独重跑）没能再复现。`services/adapter/src/sciencediscovery_adapter/mcp_server.py` 的 `tools/call` 处理器此前把每条失败路径（未知 run tag、未知工具名、桥接异常）都吞掉且不打日志，出问题时无从排查；现在都会记日志了。目前最可能的解释：`agent_runs.py` 的 `ensure_shared_tools` 只要运行带来一个此前没见过名字的工具，就会让 JiuwenSwarm 重新连接共享的 `sci` MCP 服务，而每个自定义 MCP 连接器工具的名字（`mcp__<sourceId>__<toolId>`）每次都是新的，因此总会触发这次重连——这就有可能和 JiuwenSwarm 真正把调用路由过去形成竞态。下次复现时留意这些新日志。**现在已经证实，不再只是猜测**（下文第十一条 UT 审计里的第十三个发现）：给一个共享的 JiuwenSwarm+adapter 实例施加真实的并发负载，确实能按需复现"一次本来成功的运行里 MCP 工具调用事件整个消失"——很可能就是 `ensure_shared_tools` 自己那把进程级锁，和这里原本的猜测吻合。但用一种*更激进*的复现方式（让同一个测试文件跑好几个完全相同的副本）继续往下追时，追到的不是上面这个重连竞态，而是另一个独立的、已经精确定位的 bug：`AgentRunner.pending_approvals` 是整个 adapter 进程共用的一个字典，键是 JiuwenSwarm 自己 `chat.ask_user_question` 事件里的 `request_id`——而这个值其实是原样回显模型自己的 tool-call id，不是 JiuwenSwarm 生成的全局唯一值，所以两个并发运行只要模型选中了完全相同的 tool-call id 就会在这个字典里撞车。这个问题是真的，但已确认不需要这里原本设想的"重连竞态"机制就能解释。
10. **父运行进入终态后，`task` 子代理自己的状态有时仍读到"running"——同一条嵌套往返也能把父运行整个卡死。** **根因已找到并修复：** 适配器给 JiuwenSwarm 新工具列表的方式是对唯一共享的 `sci` 服务器做 `mcp.disconnect`/`register_custom`/`connect`，而 disconnect 是全局的：父运行等着 `task` 调用时启动的子代理运行带来了共享列表里还没有的工具，于是把父运行正在进行的调用切断了（一次卡住的运行在 JiuwenSwarm 日志里：06:19:27 父运行调用 `task`，06:19:28 适配器断开 `sci`，06:19:29 子代理会话开始，此后再无动静）。现在新列表注册到下一代的名字（`sci` 加十位数字），旧名字上的运行一直用到最后一个结束（`ensure_shared_tools`，`test_new_tools_never_disconnect_the_server_a_running_run_is_calling_through`）。下面是诊断过程的记录。`issue-85-foreground-exec-inbox` 的第三个用例在 `waitForRunTerminal` 之后紧跟着的 `expect((await subagents(...)).map(s => s.status)).toEqual(["completed"])` 上稳定失败（不是偶发）——子代理自己的这轮明明已经跑完了（适配器调试日志里 `task` 的 `tool.completed` 和子代理自己的 `run_shell` 都出现在父运行结束之前）。`runs/index.ts` 的 `runSubagent` 会等整个子运行结束、写完 `store.updateSubagent(..., "completed")` 才把结果交回给调用方，TypeScript 这边的调用顺序解释不了这个现象——但 `SCIENCE_AGENT_EXECUTOR=jiuwenswarm` 时，`task` 子代理自己的这一轮*也*是经 `JiuwenSwarmAgent` 驱动的，也就是再向外部适配器发起一次嵌套的 `POST /agent/runs`，而不是内置循环那种进程内调用——这一层内置循环完全没有。还没精确定位到根因（需要更细地追踪这次嵌套往返），父运行终态事件刚触发后立即发起的 `GET /subagents` 仍可能读到写入之前的状态。这里没有修。**现在对同一个底层机制有了更扎实的证据**（见下文 gap 11 UT 审计里的第十一条）：嵌套子运行的结果通过 MCP 交回父会话之后，JiuwenSwarm 0.2.6 的网关并不总能续跑父运行自己的下一轮——连接直接沉默，直到 ScienceDiscovery 自己的空闲超时看门狗在几分钟后把运行判失败。已确认这个卡顿**不是按测试用例确定性复现的**（单独跑能通过，放进更长的套件里跑同一条用例又会用一样的方式失败），更像是共享的那一个 JiuwenSwarm+adapter 实例上累积的负载或状态，而不是某个固定的调用形状。这份证据的取得，全靠 `scripts/with-jiuwenswarm.sh` 一度强行设了 `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task` 才让 `task` 真的走上这条桥接路径——既然这个开关不是任何真实部署会默认打开的（见 1a），网关限制一暴露出来就把这个强制开关撤了，而不是留着继续追。`server.test.ts` 现在把所有经 `task` 委派的测试在这个执行器下统一跳过（17 条，`JIUWENSWARM_NESTED_TASK_STALL_SKIP`）——既是因为这套测试脚手架本来就照真实部署那样让这个桥接开关保持关闭，也是因为再把它打开去测只会把这个不确定的卡顿重新引出来。
11. **UT 已在真实 JiuwenSwarm 下审计。** `services/api/src/server.test.ts`（host 档 UT 里最大的测试文件）现在通过 `scripts/with-jiuwenswarm.sh` 让智能体轮次跑在真实的 JiuwenSwarm 和适配器上（`pnpm ci:ut:host` 已接好）。审计发现：
    - **真 bug，已修复：** JiuwenSwarm 审批问题的 resource 用的是这次调用自己的描述文字（如 `"run_shell: rm -rf out"`），运行之外预先建立的授权（预检、"本会话总是允许"）永远匹配不上——运行只能等一个不会有人做出的决定，等到运行放弃等待，补发的答复又收到 404。`describe_approval` 现在单独发送工具原名（`toolName`）；适配器把 `run_shell`/`execute`/`environment_setup`/`execution_cancel` 归类到内置循环自己权限检查用的那个固定 resource（`workspace-code`），这样已有的授权也能应用到 JiuwenSwarm 拦下的调用上。
    - **第二个真 bug，已修复：** JiuwenSwarm 0.2.6 的网关会在 `chat.ask_user_question` 后面紧接着发出结束运行用的 `chat.processing_status`（`is_complete`），根本不等答复，中间还混着数量不固定的它自己的记账帧（一个空的 `chat.final`、用量/上下文统计）。照字面理解就是"运行结束了"：结果是每一个需要审批的调用都拿不到工具结果、也没有文字回复。这个问题在线上复现过（一次全新部署、真实浏览器会话），审计里也复现了；`gateway.py` 的 `ChatRun` 现在会区分哪些帧是模型或工具真的在做事、哪些是这次暂停自己的记账帧，只有见过前者之后才把结束信号当真。
    - **真实的、JiuwenSwarm 特有的行为，测试已相应调整，不是 bug：** 会话的技能不是一份选择（所有已安装技能到处可用；子代理的对应情况见上文 1a——子代理也会把所有延迟工具，包括连接器 MCP 工具，提前全部展开）；skill-creator 用 JiuwenSwarm 的 `skill_tool` 加载，不是我们的 `read_skill`；工具结果被重新塞进模型下一轮时，包在 JiuwenSwarm 自己的 Python repr 信封里（`{'result': '...'}`，不是 JSON），不是原样传回；技能删除影响评估没有可报告的内容（每个技能的选择模式都是"all"，没有谁单独依赖某个技能 id）。
    - **同一轮里第三个无关的 bug，已修复：** 这个测试文件自己那个内联的模型桩，检测后台执行唤醒通知时，没有先解开 JiuwenSwarm 包在用户轮次外面的信封就去匹配 `[Execution notifications]`——和 E2E 旅程里（`test/helpers/journeys.ts`）已经修过的那类 bug一样。
    - **第四个 bug，已修复：** 三个在运行过程中切换会话审批模式（切到 `always_allow`，切到 `ask`）的测试之前失败，根因不是审批模式切换本身，而是授权计数断言对不上（`2 !== 1`、`4 !== 2`）。每一次 JiuwenSwarm 拦截的调用都记了*两条* `PermissionAuthorization`：`requestApproval`（runs/index.ts）在调用被放行前先记一次 JiuwenSwarm 自己的询问（或者 `always_allow`/`existing_grant` 的即时放行），调用真正到达桥接层时，工具自带的 `requirePrivilege({action: "code", resource: "workspace-code"})`（workspace-bindings.ts）又检查一遍，`store.authorizeByJiuwenSwarm` 每次都无条件新建一条记录，跟第一条完全没有去重。这也是 GitHub 的 UT job 会卡满一小时的原因：三个测试里有一个在死等一个没有超时的 `reader.read()`，而它等的那个事件计数正是被这次重复记账打乱的；host 档 UT 本身没配 `--test-timeout`（只有 CodeArts 的 QEMU guest 档配了），于是除了 job 自己 60 分钟的硬顶，没有别的东西能拦住它。现在 `authorizeByJiuwenSwarm` 会先按 `toolCallId` 找一遍是否已经有授权记录（复用 JiuwenSwarm 自己的决定，而不是再记一遍），`setApprovalMode` 解决挂起请求时也把 `toolCallId` 带上，好让这次查找能找到。
    - **第五个问题，已定位、有意不修：** `startSubagentModel` 这个脚本化模型桩（很多测试在用）会调用一个字面名字就叫 `task` 的工具，而 JiuwenSwarm 自己的子代理路由替换逻辑（见上文 1a）默认会在运行开始前就把 `task` 从工具列表里删掉——这个桩读不到系统提示词、不知道该改叫 `subagent_spawn`，还是照样调用已经不存在的 `task`，适配器于是确定性地回一句 `Ability not found in resource_mgr: task`。`.ci/run-e2e.sh` 自己脚本化的旅程也撞过一模一样的不匹配，用 `SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` 绕过去了；这次修复的早期版本在 `scripts/with-jiuwenswarm.sh` 里为同样的原因设过范围更窄的 `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task`，桩的调用确实因此正确路由了——但为什么后来把这个开关撤了，见下文第十一条。`scripts/with-jiuwenswarm.sh` 现在有意保持在真实部署自己的默认值（`SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` 不设），调用 `startSubagentModel` 的这批测试改成在这个执行器下跳过（见第十一条）。
    - **第六个 bug，已修复：** `createApiServer` 里同步 JiuwenSwarm Web 设置的后台任务最多重试 5 次、每次间隔 3 秒，却从来没跟 server 自己的关闭事件绑定过。单个长期运行的生产 server 上无所谓；放到 `pnpm ci:ut:host` 里就是灾难——那唯一一个共享的 JiuwenSwarm+adapter 实例（`scripts/with-jiuwenswarm.sh`）会被套件里每个短命测试 API server 各自挂起的一轮新重试打到，几百个测试服务器，每个都比自己的测试多活最多 15 秒，全在抢同一个 adapter。现在绑到一个 `AbortController` 上，server 的 `close` 处理器会中止它。
    - **第七个 bug，已修复（三层剥洋葱）：** "API runs a configured OpenAI-compatible model through the gateway and Python" 因为 `toolModel.authorizations` 有 4 条而不是 3 条失败——是个真实的竞态，不是 JiuwenSwarm 的锅：会话标题精修（见"Session title refinement persists when the naming model finishes after the run stream closes"）和这次运行共用同一个模型，可以在运行开始后的任何时候把自己那次调用打到同一个假模型服务器上，包括在这条断言跑完之后——执行器越慢，真实的每轮往返就给这个后台调用留出越多赢下这场竞赛的时间。放宽成"至少 3 次调用，且都来自同一个 token"。修完这层，又暴露出第二层：JiuwenSwarm 下 `execution-runs` 可能比流本身的 `run.completed` 晚一拍才落地（这条记录要等桥接层自己的"完成"往返落定才写入），所以流一关就立刻、不重试地去查列表，有时会在这条记录落地之前就查到——现在改成轮询。修完这层又暴露出第三层，这次不是竞态而是一条本来就站不住的断言：`chartProvenance.body.environments` 交叉引用的是 `store.listEnvironmentRevisions()`，这份目录只有 `runs/index.ts` 的 `syncScientificEnvironmentCatalog` 会写，而它本身又卡在 `runnerHealth.scientificEnvs.available` 上——`startTestApi` 手搭的 `RunnerConfig` 从来没设过 `scientificEnvsEnabled`，所以这个目录在这套测试脚手架里，不管哪个执行器，永远是空的。这条断言在这里从来就不可能通过；已删除（"环境版本出现在 provenance 里"这块覆盖该去 `environment.test.ts`，那边确实配了开启科学环境的 runner）。
    - **第八个 bug，已修复：** "skill lifecycle APIs..." 里一个本该返回 409（被引用阻止）的 DELETE 却返回了 200——不是拦截删除那个检查本身有问题（同一测试里更早的一个版本冲突断言先跑到，加了调试打印确认它把 0 vs 1 的不一致算对了、也正常抛了异常）。两行之后的这个 DELETE 只是漏加了紧挨着它的那条断言早就有的 `onJiuwenSwarm` 分支：上一行已经断言 JiuwenSwarm 下 `impact.body.references` 是空的（每个技能的选择模式都解析成"all"，没有谁单独依赖某个技能 id——见 1a），这意味着这次删除同样没有任何东西会挡它，第一次尝试就该合法成功，不需要内置循环那套"409、清掉引用、再 200"的两步走。已按此加上分支。
    - **第九个 bug，已修复：** "native MCP literature flow produces an audited cited summary" 直接读 `modelServer.requests[0]`，假设它就是这次运行自己的第一次调用。JiuwenSwarm 下，把一次运行的技能导入一个还很新鲜的实例时，可能会触发 JiuwenSwarm 自己一次性的、跟这次运行无关的模型调用——用每个已安装技能的名称和描述构建一棵技能目录树——打到同一个假模型服务器上，有时会抢在这次运行自己的第一次请求前面。现在改成去找真正带着这次运行自己 prompt 的那次请求，不再假设是索引 0。另外，没有修：同一条测试自己那个工具调用可见性的断言（`assert.match(stream, /"name":"mcp__pubmed__search"/)`）偶尔还是会失败，跟下面的 gap 9 完全对得上——是既有问题，那条 gap 自己的作者早就说过难以捉摸，这一轮既没有引入它，也没能进一步钉死它。
    - **第十个 bug，已修复：** `run-cancel.test.ts` 里"cancelling a blocked run persists the approval's terminal state and the tool input in the replay"断言回放里有一条 `tool.started` 事件。内置循环下 `tool.started` 是模型一提出调用请求就立刻触发的，在任何审批关卡之前；JiuwenSwarm 下它只在调用真正开始执行时才触发，也就是*审批之后*——所以在还没等到决定就取消运行，意味着这次调用压根没开始过，`tool.started` 自然不会触发，这是设计使然，不是 bug。调用参数在回放里依然找得到，在 `permission.required` 事件自己的摘要文本里；测试现在在这个执行器下改成从那里读。
    - **第十一个、更系统性的发现，靠不走这条受影响的代码路径来解决：** 强行设 `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task`（上面第五个问题）让 `startSubagentModel` 那个脚本化的 `task` 调用正确路由，确实能让 ScienceDiscovery 自己的任务委派桥接层工作起来——好几条经它委派的测试都能跑到一个能正常工作的子代理轮次，它自己那些需要审批的调用被询问、被批准、跑完——但*父*运行的 JiuwenSwarm 网关连接紧接着就彻底沉默了，直到 ScienceDiscovery 自己的空闲超时看门狗在几分钟后触发（`Agent run stalled: no gateway progress for N ms`）把运行判失败。这正是下文 gap 10 已经记录、但没能解决的那条嵌套往返（`task` 子代理自己的这一轮就是经由第二次、独立的 `POST /agent/runs` 驱动的），现在多了具体的、带时间戳的证据：嵌套运行的结果通过 MCP 交回父会话之后，JiuwenSwarm 0.2.6 的网关并不能可靠地续跑父运行自己的下一轮。在一个真实的本地 JiuwenSwarm 上，对全部 17 条经 `task` 委派的测试逐一验证过：这个卡顿**不是按测试用例确定性复现的**——"API validates subagent Brief v1 structured output..."这条测试单独跑三次都干净通过，放进更长的套件里跑，同一条用例又用一样的方式失败了，更像是共享的那一个 JiuwenSwarm+adapter 实例上累积的负载或状态，而不是某个固定、可枚举的坏用例集合，按某一次运行观察结果建出来的按测试白名单，下一次跑还是会暴露在同样的不确定性下。

      但 `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task` 本来就是一个没有任何真实部署会默认打开的选项（见 1a）——`scripts/with-jiuwenswarm.sh` 当初设它，纯粹是为了让这几个脚本化测试桩的调用能路由通，不是因为部署真的需要它。与其继续追这个卡顿，不如直接把这个强制开关撤掉：`scripts/with-jiuwenswarm.sh` 现在保持在真实默认值（JiuwenSwarm 自己的 `subagent_spawn`/`subagent_wait`），这条路径完全不涉及嵌套的 adapter 往返，自然也就碰不到这个网关限制。在这个默认值下，脚本化桩的 `task` 调用会因为上面第五个问题里说的结构性原因而走投无路（`Ability not found in resource_mgr: task`，确定性复现，不是卡顿）——而且不管走哪条路，针对这个执行器都没有别的什么好测的：这 17 条测试原本要验证的是 ScienceDiscovery 自己对子代理动作的权限/沙箱/溯源处理，而一个真的跑在 JiuwenSwarm 真实默认 `subagent_spawn` 上的部署根本不会走到这段代码（按 1a，那条模式完全绕过 ScienceDiscovery 的工具、沙箱、审批和溯源）。因此全部 17 条在 `onJiuwenSwarm` 下跳过（`server.test.ts` 里的 `JIUWENSWARM_NESTED_TASK_STALL_SKIP`），在内置循环下则正常跑、正常通过——它们原本要提供的那份覆盖，在那边完好无损。这样改完，实测明显更快、也不再卡顿：同样这两个测试文件，以前要跑 7-8 分钟（中间偶尔卡上几分钟才被空闲超时判失败），现在大约 2 分钟就跑完，没有一条测试超过 14 秒。

    - **第十二个 bug，已修复：** 就算第十一条的撤销已经落地，真实的 GitHub `UT` job（不是本地只跑两个文件的孤立验证）还是真的失败过一次——不是卡住，是真失败——在 `run-cancel.test.ts` 的 "cancelling a queued run does not start it or append it to Session context" 上：`waitForGatewayTurn` 的 400 次尝试（10 秒）等待预算差了大约 460ms 就超时（实测 `10461ms`）。这个预算是照着单独测出来的单轮往返时间（5.0-5.4 秒，helper 自己原来的注释写的"无其他负载"）定的。但 CI 里真正跑的 `ut:host` workload 是 `bash scripts/with-jiuwenswarm.sh pnpm --recursive test`——整个 workspace 的测试文件并发跑，全部共享 `with-jiuwenswarm.sh` 启动的那一个 JiuwenSwarm 实例和 adapter（这是设计使然，对应一次真实部署要服务很多会话），所以真实场景下一轮往返在这种并发压力下会比单独测量时更久。把 `waitForGatewayTurn` 的预算在 `onJiuwenSwarm` 下提到 60 秒（2400 次尝试），和 `server.test.ts` 里 `CONCURRENCY_BARRIER_TIMEOUT_MS` 出于同样原因给的余量保持一致。已经在真实本地 JiuwenSwarm 上重新验证过：测试通过。同一次运行里失败的另一条用例，"native MCP literature flow produces an audited cited summary" 的 `mcp__pubmed__search` 可见性匹配失败，就是上面第九条已经记录过的 gap 9 已知偶发 flake——不是新问题，这里也没有进一步修复它。

    - **第十三个发现，拆成了一个真实的缓解和一个独立的、已精确定位但尚未修复的 adapter bug：** 没有把 gap 9 那个"偶发不可见"的 MCP 工具调用停在"难以定位"上，而是继续往下查。在一个真实的本地 JiuwenSwarm 实例上按需复现过（`scripts/with-jiuwenswarm.sh` 自己的设计就是整条命令共享一个实例和 adapter）；先单独跑了 25 次，全部干净通过，确认了这个问题需要共享实例上真实的并发压力才会触发，不是一个确定性的代码 bug。用两种不同的复现方式，追出了两件不同的事：(a) **CI 实际命中的那种，已缓解：** 只用真实、多样的并发负载（也就是 `pnpm --recursive test` 本来的样子——不同的包各自跑各自的测试文件）就能复现：运行成功完成，最终答案也对，但 `mcp__pubmed__search` 的 SSE `tool.started` 事件压根没出现——工具显然跑了（`mcp/invocations` 审计接口能独立确认这一点），但桥接层自己上报这次调用的实时事件丢了，很可能是 `AgentRunner.ensure_shared_tools`（services/adapter/src/sciencediscovery_adapter/agent_runs.py）里那把进程级的单一 `asyncio.Lock`，把每个并发运行向 JiuwenSwarm 管理接口发起的 MCP 工具/权限注册请求全部串行化了。做了两处缓解：`pnpm --recursive`（也就是 `workspace-packages` 这个 UT workload）现在把并发度限制在 `--workspace-concurrency=2`（pnpm 自己的默认值是 4），让能同时抢这把锁的包数量减半（`.ci/ci-contract.mjs` 里重新推导这条命令的部分也同步更新了）；测试本身也改了，只在内置循环下要求这个实时 `tool.started` 事件，在 `onJiuwenSwarm` 下改用已证明不会丢事件的 `mcp/invocations` 审计记录作为权威依据。(b) **一个真实但独立的 bug，是把 (a) 的复现方式用得过猛才挖出来的，不是 CI 实际命中的那种：** 如果同时跑好几个**完全相同测试文件的字面副本**（这不是真实 CI 的负载形态），能稳定复现更严重的失败——JiuwenSwarm 自己的 `resource_mgr` 丢失一个刚被 promote 过的 ability，或者一次审批应答被 404 拒绝、运行卡死到四分钟空闲超时才被杀掉（`[jiuwenswarm-agent] could not answer JiuwenSwarm's approval question call-pubmed: HTTP 404`）。已经追到底：`events.py` 的 `_on_chat_ask_user_question` 把 JiuwenSwarm 自己 `chat.ask_user_question` 事件里的 `request_id` 原样当成这次审批的 `id` 和 `toolCallId` 使用，而这个 `request_id` 其实是原样回显模型自己的 tool-call id，不是 JiuwenSwarm 铸造的全局唯一值；`AgentRunner.pending_approvals` 是整个 adapter 进程共用的一个字典，键就是这同一个值。两个并发运行只要模型都用了完全相同的 tool-call id（现实里只有像这个测试自己写死的字面量 `"call-pubmed"` 这种情况才会出现，而且要同时跑两份——全仓库 `grep` 确认这个字符串只在这一处出现，所以在真实的一次 `pnpm --recursive test` 里这种精确撞车根本不可能发生），就会在这个字典里撞车：一个运行的应答会悄悄把另一个运行的请求解掉，输的那个运行自己的应答就会 404、然后卡死。这是 `services/adapter` 里一个值得修的真实健壮性缺口（生产环境里两个会话的模型如果恰好选中同一个 tool-call id，会撞上一模一样的问题），但已确认和这个发现最初想解释的 CI 失败无关——这里没有修，另外单独标记跟进。

    - **第十四个发现，已修复（两部分）：** 第十三条 (a) 里那个降并发度的缓解措施单独并不能让 CI 转绿。紧接着下一次真实 CI 又在同一个测试上失败了，这次是 `assert.equal(invocations.body.length, 1)` 读到了 `0`——`mcp/invocations` 这份审计记录本身在负载下也会比 SSE 流自己的 `run.completed` 慢一拍，跟本文件里 `execution-runs` 已经修过的那种延迟是同一类，用同样的轮询方式修了。接着追了一下"为什么并发度已经只有 2 了，审计记录还会慢"：`AgentRunner.__init__` 把 `_shared_timeout_s`（`ensure_shared_tools` 目前向 JiuwenSwarm 注册过的超时上限）初始化成了 `0`，而每个 run 的 `toolTimeoutSeconds` 各不相同（`Math.ceil(runTimeoutMs / 1000)`，比如专门测超时行为的用例会故意配得很短）——所以整个 `ut:host` 刚启动、并发竞态最激烈的那段时间里，谁的 `ensure_shared_tools` 先跑到，谁的值就成了这个共享上限；而之后任何一个超时更大的并发 run（大多数 run 用的都是 3600 秒默认值，比早跑的那个小超时用例大）就得把这个上限顶回去，每顶一次都要在 `_shared_lock` 下完整走一遍 `disconnect`/`delete_custom`/`register_custom`/`connect`，这段时间里所有其他并发 run 都得排队等——这和"延迟/丢失的事件都扎堆出现在一次运行早期"这个观察完全吻合。修法是把 `_shared_timeout_s` 的初始值改成 `settings.tool_timeout_s`（配置里的上限——一个没显式传 `toolTimeoutSeconds` 的 run 本来就是落到这个默认值），这样只有真的要求比配置默认值更大的 run 才会因为这个原因触发那套重连流程；`services/adapter/tests/test_agent_runs.py` 里已有的、覆盖注册顺序和 `mcp.register_custom` 超时取值的测试都不受影响（两条用到的场景本来就是"第一次调用自己的超时刚好等于配置默认值"）。这个修复**没有去掉 `_shared_lock`**——这把锁是真实的正确性要求（JiuwenSwarm 整个 adapter 进程只认一个叫 `sci` 的自定义 MCP server，见 `mcp_server.py` 自己的模块级文档字符串，所以并发的注册请求、以及对 adapter 自己进程内注册表状态的并发读写，都需要互斥）；这个修复只是去掉了锁内那条贵路径里一个本可以避免、而且很频繁的触发源。

    - **第十五个发现，找到根因并修复了——第十三、十四条其实都只是这个问题的表征。** 无论是降并发度还是 `_shared_timeout_s` 那个修复，都没能让 literature-flow 这个用例稳定转绿：把 `services/api` 里所有测试文件完全串行跑一遍（`--test-concurrency=1`，任何两个文件的 agent turn 都不可能同时发生），这个用例**还是一模一样地失败**——直接排除了"并发"是根因这个说法。用在 `mcp_server.py` 的 `handle_rpc` 里加的临时、不受日志配置影响的 `print()` 诊断,对着一个真实的本地 JiuwenSwarm 追到了根因(顺带发现这个模块里原有的 `logger.warning`/`logger.exception` 调用其实从来没真正打印过——这个仓库没配置 root logger，`uvicorn.run(..., log_level="info")` 也不会隐式地帮应用自己的 logger 接好，所以这条代码路径上原有的日志调用其实一直是哑的)：**`tools/list` 在一整次多文件的运行里只被 JiuwenSwarm 拉取过恰好一次**——就是最先跑起来注册的那个 session 那一次，之后再也没有拉取过，即便后面明明有别的 session 通过 `ensure_shared_tools` 往 adapter 自己的 `registry.shared` 里加了那个最早的 session 压根没有的新工具。literature-flow 两次 `tools/call` 尝试（`tool_search`、然后是 `mcp__pubmed__search`）在 `mcp_server.py` 的全部流量里**从头到尾一次都没出现过**：JiuwenSwarm 压根没试过调用它们，因为它根本不知道这两个工具存在。真正的 bug 在这：`ensure_shared_tools` 自己的注释写着"重连会让 JiuwenSwarm 重新读取列表"，但这句话只对**完整的** `disconnect`/`delete_custom`/`register_custom`/`connect` 这一套成立——对一个已经连着的 server 单独调用 `mcp.connect`（也就是 `changed=True` 但这个 session 既不是史上第一次注册、也不需要更大超时时走的那条路径——恰好就是 literature-flow 的情况：来了个真正的新工具，用的是默认超时）并不会让 JiuwenSwarm 重新拉取任何东西。所以任何一个"唯一目的就是带来一个还没人注册过的新工具"的 session——这本来是再正常不过的一件事,不同 session 用不同工具集合——都会让这个工具在整个进程剩下的生命周期里永远调不通,只要"第一个跑起来注册的 session"恰好不是带着它的那个,这事就是确定性发生的。现在 `changed` 会强制走跟首次注册、超时变大时一样的完整重连流程,因为只有这样才能真正让 JiuwenSwarm 重新读取列表；`test_agent_runs.py` 里那条校验调用顺序的断言也同步更新了。验证过：adapter 测试套件（170 passed, 8 skipped）、一个在这次修复前每次第一轮就必现失败的本地真实 JiuwenSwarm 复现脚本（修复后连跑 5 轮全部干净）、以及最关键的——同一个 commit 在真实 GitHub `UT` job 上直接跑通了。第十三、十四条自己的缓解措施（降并发度、`_shared_timeout_s` 封顶、`mcp/invocations` 轮询、在这个执行器下跳过实时 `tool.started` 检查）都保留着：它们各自都是合理的余量（尤其是那个 `execution-runs` 式的轮询，防的是另一个真实存在、已经单独记录过的延迟问题），但对这个 bug 来说都不是真正起作用的那一环；第十三条 (a) 里"这是 JiuwenSwarm 自己上游可靠性边界"这个判断是错的——这一直是 adapter 自己代码里的一个逻辑 bug，并发只是让它更容易被踩中（更多 session 同时抢着注册更多样的工具集合），但从来不是根因。

## 开始做某个子 issue

1. 启动整套栈：先执行一次 `scripts/jiuwenswarm.sh setup`，再 `./scripts/start-stack.sh --mode local`（用 `GET /agent/info` 确认）；见[本地模式](../getting-started/deployment.md#本地模式源码检出)。
2. 在 `test/contract/routes.json` 里找到你的路由（`node test/contract/run.mjs --coverage` 会列出没有用例的行）。
3. 在 `test/contract/cases/` 下加用例，在**全新数据目录**上对内置循环录制，再对“适配器 + JiuwenSwarm”栈比对。规则、SSE 步骤写法和归一化见 [`test/contract/README.md`](../../../test/contract/README.md)。基线对智能体只读，改动需要人工评审。
4. 行为类用 run 事件用例（`l2-runs.json`）；脚本化模型是 `test/contract/stub-model.mjs`。
5. 浏览器旅程：`.ci/run-e2e.sh mocked`（JiuwenSwarm 现在是默认后端，没有实例会自动装一个并启动）。要用内置循环（还没删掉时）就设 `CI_E2E_BACKEND=legacy .ci/run-e2e.sh mocked`。

## 测试

```bash
UV_PROJECT_ENVIRONMENT=/tmp/adapter-venv uv sync --extra test --project services/adapter
/tmp/adapter-venv/bin/python -m pytest services/adapter          # 适配器单测
cd services/api && pnpm build && node --test dist/agent-run/jiuwenswarm-agent.test.js
node --test test/contract/*.test.mjs                              # 契约测试工具自身
E2E_BASE_URL=... E2E_API_TOKEN=... node test/contract/run.mjs --compare test/contract/baselines/legacy-linux.json

# UT（server.test.ts 及共享计划里的其余用例）通过 scripts/with-jiuwenswarm.sh 跑在真实的
# JiuwenSwarm 和适配器上，pnpm ci:ut 把共享 runner 包在这一层里：
scripts/with-jiuwenswarm.sh pnpm --filter @sciencediscovery/api test
```
