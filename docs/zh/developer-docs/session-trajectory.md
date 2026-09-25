# Session 轨迹与模型上下文

Session 标题旁的 **轨迹** 入口打开只读查看器。它将主 Agent、子 Agent 的执行放到同一个真实时间坐标中，并提供节点详情和 NDJSON 导出。

## 如何使用

1. 执行任务后，点 Session 标题旁的 **轨迹** 在当前 Session 的对话区内切换到只读轨迹视图（不是弹窗）；会话栏入口随之变为「对话」，与查看器右上角 ×、Escape 一样都能切回。查看器不实时订阅模型输出，点击刷新可读取新发布的记录。模型输出只展示请求结束后的最终结果，不把未结束的流式正文当作返回。轨迹视图是 Session 的主区视图，URL 以路径段 `/projects/<id>/sessions/<id>/trajectory` 保存打开状态，刷新和浏览器前进/后退可恢复；旧 `?trajectory=open` 链接仍兼容解析并归一化为路径段。离开该 Session 即关闭轨迹视图，切回不自动重开。
2. 上方始终展示所有 Agent 的时间条，不受下方 Agent 或事件类型筛选影响。时间轴左侧的 Agent 标签列（日期角标 + 各 Agent 名）整块固定，横向滚动条常显于轨道区顶部；按住 Ctrl 滚动以指针位置为锚横向缩放，缩放和窗口宽度不改变行结构。时间轴区域高度与下方事件列表宽度可拖动调整（也支持键盘方向键），时间轴最多只能拖到刚好完整显示全部车道。下方筛选先选 Agent（每次一个）、再选事件类型（复选，可全选/清空），默认选择主 Agent 并按 Run 分组；点击其他 Agent 的时间标记会自动切换下方选择、重置不匹配的类型筛选并定位事件。模型过程与工具/MCP 分行，同类事件只按真实时间重叠分配子行。密集时间点会统一横向展开并保留分隔，精确时间可悬停查看。
3. 详情保留「事件内容」和「Agent 状态」。模型输入的事件内容直接展示本次固定输入，其他事件展示思考、最终返回或工具参数/结果；有确切关联时可点「查看本次输入」定位对应输入事件。不再提供独立的模型上下文和组装证据页签；组装诊断仍在 API 和导出中，不删除原证据。
4. 输入分成两个独立区域：系统提示与消息按实际顺序显示；工具定义来自独立的 `tools` 字段，放在可折叠工具列表中，各定义也可按名称展开。右侧加宽彩色导航显示系统贡献、用户、模型回复、工具调用/结果名称、Skill 等标签；只按已记录角色、贡献元数据或唯一调用 ID 标注，不从正文猜测来源。默认定位最新消息，顶部可直达系统提示、首条和最新消息；完整消息 JSON 按需展开。
5. 导出 NDJSON 保存轨迹证据。文件可能包含用户对话和工具返回的敏感业务内容，请妥善保管。
6. 查看器只显示模型输入、最终输出、思考、工具和 MCP。状态及生命周期分类全部隐藏，包括运行开始/完成/失败/取消、恢复和子 Agent 通知；列表、时间条、图例和类型筛选使用同一规则，不提供「全部记录」切换。工具/MCP 节点自身的失败结果仍可见。隐藏仅影响展示，所有原始证据仍保留在导出中，Agent 状态继续在详情页查看。列表按 Agent + Run 分组，同一 Run 只显示一个标题；记录自身的 contextId 仍精确关联调用，不能因视觉分组而混用上下文。Run 表示一次 Agent 执行，turn 是该 Run 内的轮次，# 是事件流序号。
7. 右侧首先显示「事件内容」，可切换「原始 JSON」。模型输入的原始视图对应同一个固定 `ModelContextSnapshot.input`，不把组装过程或当前状态混进输入；其他事件显示其原始事件内容。未知结构不猜测正文，保留 JSON 查看。
8. 每次请求只显示一个「模型返回」，正文、本次 usage 和工具调用声明在同一节点查看；主子 Agent、列表与时间条规则一致。流式正文及子 Agent 的 assistant 聊天投影不单列。请求未完成或历史记录没有最终返回时，不用部分正文伪造结果，已有思考和输入仍可查看，生命周期失败记录可从导出查阅。用量显示已记录的输入/输出/总 Token 和缓存 Token，不以 Run 累计值或相邻事件时间推测；缺失字段标注「未记录」，不当作零。旧 ModelAction 的 result.usage 同样可读，缺少时间时保留为无时间调用记录。

## 组件与数据链路

```text
NativeAgent / AgentVersionRecorder ── SessionStore 原有 Run 事件 JSONL
                                  │ 正文 / 思考 / 工具事件 + evidence
                                  │ contextRef / stateRef / payloadRef
                                  └───────── CAS：State / Context / Step / 正文
                                  │
                                  ├── 聊天投影
既有工具输出流 + MCP 审计 ───────────┤
                                  │
API 鉴权与 Session 范围适配 ── trajectory/server
                                  │ index / detail / export
Session 入口 ── 认证 TrajectoryPort ── trajectory/web
```

`packages/trajectory` 拥有合同、只读投影和查看器；`services/api/src/trajectory.ts` 注入 Session 的 Agent 范围和事件；HTTP 宿主负责认证，Web 宿主只负责入口和认证请求。组件不反向依赖 services/apps，不改 AgentLoop 或工具权限。

模型输入来自 `ModelContextSnapshot.input`，边界是 `ProviderModelClient.invoke`，不是当前重新组装的上下文，也不是供应商协议转换后的网络报文。对应 `ContextAssemblyRecord.state` 指向固定状态版本。新事件记录 `contextRef` 和 `recordedAt`，通过引用关联具体调用；同一 turn 输入超限重试仍可区分各次输入。模型只返回了部分思考时，只展示这部分，不生成缺失内容。

### 事件与版本各司其职

新执行只写 SessionStore 已有的 Run 事件流，不再创建独立 `trajectories/<agent-key>/<run-key>.jsonl`。原 JSONL 外层 `{createdAt, sequence, event}` 不变：`createdAt` 是持久化时间，`sequence` 是该文件内的顺序。`event.evidence` 增加 `agentId`、`agentRunId`、`requestExecutionId`、`turn`、采集时刻 `recordedAt` 和可选 `responseId` / `contextRef` / `stateRef`。连续增量合并时保留首个采集时间及 `endedAt`，不跨响应、Agent Run 或上下文合并。正文、思考和工具过程沿用原事件，不再平行记录一份原始事件日志。

没有聊天等价物的信息，以 `agent.record` 补充到同一事件流：`context.captured` 发布调用输入，`model.completed` 引用完整模型返回（含本次 usage），`state.committed` 关联成功 Step 后的状态，`context_recovery` 记录输入超限恢复。CAS 正文先持久化，入口随后写入。主 Agent 使用 main 流，子 Agent 使用已有 subagent 流，命令输出仍使用原工具输出流；这些文件都是同一 Run 事件体系，不要求物理合并成一个大文件。单流按 sequence 排序，跨流按队首的采集时间合并；不以 CAS hash、文件 mtime 或整轮结束时间排序。跨机器严格因果排序不是当前承诺。

旧独立 journal 和 `EventSegment` 只读兼容，不迁移、不重写、不删除。旧 EventSegment 与 Run 增量具有相同 Agent、responseId、通道且完整文本相同时，展示优先采用原 Run 事件，保留确切上下文关联；不同响应的相同文字不是重复。旧工具开始/结束事件按 Agent、权威执行归属、唯一 callId、工具名和完整参数匹配原 Run 工具事件；结束还须匹配状态、完整输出和 details。主子 Agent 都支持；重复 ID、不同参数或不完整结果不能静默合并。工具输出与 MCP 审计只在调用 ID 与 Agent/请求范围无歧义时关联。无可靠时间的调用标注「时间未记录」，不画时间轴位置；固定模型输入不会因后续调用而过期。备份必须同时包含 Run 事件流、旧兼容日志、CAS 和引用库；未来增加 GC 时，这些入口的内容引用均需纳入存活根。没有入口、没有记录的时间或正文，不从当前状态补造。

轨迹读取端不写数据。完整模型返回只保存一个 `ModelAction`，Run 的 `model.completed.payloadRef` 与成功 Step 的 action 指向同一对象；即使工具后续失败，也可读取已经发布的模型返回。旧 `AgentEventPayload` 仍可读。模型上下文和 Agent 状态复用版本系统快照；MCP 审计、命令输出、聊天增量有各自既有消费者，不因轨迹展示再复制一套。查看器仅将 `model.completed`（含旧 ModelAction 的只读归一化）作为模型输出节点，不按文字相似或邻近时间合并不同请求。原始增量继续服务聊天，并保留在 API/NDJSON 证据中；展示过滤不改写原日志或新增存储。

系统提示来源需以 `admitted.sections`、`rendered.sectionIds` 与实际 `systemPrompt` 逐字核对。未通过核对或走 legacy 回退时显示实际系统提示并标注来源不可用；候选贡献/压缩过程留在 API/导出的组装证据中，不冒充最终输入。`input-presentation` 只分区和生成标签，`input-view` 展示固定块；工具定义不是消息列表的尾部，消息间的工具结果仍留在原来的消息位置。

## 接口与导出

部分旧子 Agent 事件只保存参数摘要，没有完整 `args`。执行归属、唯一 callId 和工具名匹配后，读取投影可从旧 EventSegment 补充完整参数；若双方都有参数且不一致则不合并。补充仅发生在读取结果中，不改写原 JSONL 或 CAS。

| 接口 | 返回 |
|---|---|
| `GET /api/sessions/:id/trajectory` | Agent 列表、事件 entries、无时间记录 untimedEntries、真实时间和完整性提示；historicalEntries 保留为兼容别名 |
| `GET /api/sessions/:id/trajectory/detail?id=…` | 本 Session 节点及其上下文、状态和组装证据 |
| `GET /api/sessions/:id/trajectory/export` | NDJSON 下载 |

导出首行为 `type: trajectory`，分别列出有时间与无时间记录索引，随后为记录的 `type: entry` 自包含详情，末行为 `type: complete` 和总记录数。界面过滤不删底层记录、不影响导出；兼容别名不会导致详情重复导出。断流或读取失败的文件没有完整结束标记，不能当作完整导出。导出是观察证据，不是可执行恢复包：工作区二进制、外部 MCP 服务和环境进程不随文件打包。

API 不提供任意 CAS 地址读取，必须先解析当前 Session 的主子 Agent 和发布引用；不存在的 Session/节点返回 404，未认证返回 401。结构化凭证字段会脱敏，但自由文本仍可能含敏感内容。

## 兼容性与限制

- 新增时间/关联字段向后兼容；历史记录缺少时间时列出但不伪造时间轴位置，缺上下文关联时明确提示。
- 成功 Step 仍原子提交。失败/取消输入通过审计根保留；run 收尾保存最后部分事件，但不推进成功 head。进程被强杀、持久化失败等未落盘内容无法恢复。
- 原 Run JSONL 沿用 SessionStore 的读取语义；旧独立 journal reader 对未完成尾行、序号缺口和损坏记录的诊断不代表原事件流拥有相同诊断。输入在模型调用前发布，增量串行写入，模型返回、Step 提交和 run 收尾排空队列。不用当前状态补造未发布快照，也不声称文件追加具有跨存储事务或断电持久化保证。
- 详情按需读取；原 Run 事件写入前可能合并连续模型增量，evidence 保留采集首尾时间，详情保留已持久化的合并内容，不承诺恢复供应商每个 token 包的边界。当前不提供无限体量的性能承诺，超大历史的分页/虚拟列表可继续演进。
- 这是基础观测组件，不是新的模型工具或插件启停项。导出/查看不会执行模型、工具、恢复、发布或演进操作。

参见：[组件与插件机制](plugins.md)、[Agent 后端](agent-backend.md)、[内容寻址存储](cas.md)。

### 记录阶段卡顿与取消诊断

Swarm 模型网关等待输入或输出轨迹记录时，会响应运行取消和客户端断连。
取消仅结束调用方的等待；已开始的记录仍在原有串行队列中完成，随后关闭 recorder，
避免在写入中途关闭存储。取消后不会因迟到的记录结果继续发起模型调用。

API 进程的 stderr 会自动输出 `[recording-progress]` JSON 日志：记录阶段超过
30 秒后，每 30 秒输出 `pending`，并记录最终的 `completed` 或 `failed`。
有取消信号的阶段还会输出 `abort_requested`。`operationId` 关联同一次操作，
`elapsedMs` 使用单调时钟；关联字段按层级包含 requestId、sessionId、trajectoryId、
agentId 和 turn。日志不记录提示词、工具参数、研究产物或密钥。

阶段包括 `recording_input` / `recording_completion`、`*.queue`、
`before_turn`、`capture_state`、`workspace_snapshot`、`authority_capture`、
`context_ref_commit`、`step_commit` 和 `finish.*`。排查时结合时间和关联 ID，
区分排队等待与实际读取、快照或提交。若需正常请求的完整阶段起止，启动 API 前设置
`SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS=1`；设置 `SCIENCE_AGENT_TRACE_MODEL_STREAM=1`
还可记录 `upstream_dispatched`，表示网关即将调用模型客户端，不代表网络数据已发出。
空闲超时的 activeModelRequests 也会区分记录、上游调用和接收响应阶段。

例如，在保存了 API stdout/stderr 的日志文件中查看：

```bash
rg '\[recording-progress\]|\[gateway-progress\]|\[model-stream\]' /path/to/api.log
```

这些日志用于定位下一次异常等待，并不说明历史上的慢记录根因已经确定。
如果事件循环本身被同步工作阻塞，定时日志也会延迟；需要结合外部 CPU、内存和 I/O 监控判断。
