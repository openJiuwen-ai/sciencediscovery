# Reviewer Specialist 开发进度

> 基线：[#122](https://gitcode.com/mindspore/ScienceAgent/pull/122) 已合入 `master`；本文保留设计过程，并以当前实现为准。

## 1. 当前结论

Reviewer Specialist 已完成 **Quick/Deep 审核闭环**：对当前 Session 已登记的
Artifact 执行基础检查，并在 Deep 档进行引用与数值 Evidence 语义审核。

当前提供两个前端档位：Quick 使用本地确定性规则；Deep 在 Quick 基础上使用受限
大模型完成 Citation 与 Computation 语义自审。全文、原始数据和执行产物的读取属于
后续来源级证据增强，不再作为单独档位。

| 档位 | 状态 | 当前能力 |
|---|---|---|
| Quick | 已实现 | Citation 明显错漏与 `[evN]` 证据链检查；数字 Claim 缺少 Evidence、文献或生成数据溯源时告警；Artifact Provenance 图谱完整性检查 |
| Deep | 已实现 | Quick + 受限模型；核验论文身份，并判断带 `[evN]` 的陈述和数字是否得到 Evidence 支持。来源不足或查询不可用时返回 `INCONCLUSIVE` |
| 后续来源级证据增强 | 后续能力，非档位 | 在 Deep 基础上读取全文、补充材料、原始数据及计算产物，完成来源级 Claim 核验 |

### 1.1 #122 实现规模与上线判断

[#122](https://gitcode.com/mindspore/ScienceAgent/pull/122) 合入 42 个提交、38 个文件，
`+3652 / -234`。功能保持默认关闭、显式触发和只读，因此不改变普通对话或 Artifact
生成主链路。

| 类别 | 说明 |
|---|---|
| 服务端 | 审核编排、Citation/Computation、受限 Agent、取消、持久化和审计 |
| 前端 | Quick/Deep 设置、手动审核、进度和结果卡片 |
| 测试 | Reviewer API 72 项、Web 面板 13 项通过；类型检查和 `git diff --check` 通过 |

当前按 **受控可用、总体中等风险** 处理。主要风险集中在外部来源可用性与跨进程取消，
两者均不会被误报为 Artifact 内容缺陷。

| 风险项 | 等级 | 判断 |
|---|---|---|
| 普通对话与 Artifact 生成 | 低 | 默认关闭；未显式点名或手动触发时不注册 Reviewer 工具 |
| 设置和审核记录持久化 | 低 | 只新增兼容字段和消息类型；旧数据补齐 Quick 档位，并保留原有开关状态 |
| 前端展示 | 低 | 独立卡片和侧栏入口；生产构建通过，不替换既有消息和工具卡片 |
| Memory Graph 依赖 | 中 | 图谱不可用可返回 finding，但正常 MCP SubTask 也可能因缺少上游边被误报 |
| 审核决策语义 | 中 | 当前任何 warning 都会触发 `REVISE_AND_RETRY`，服务降级与内容错误尚未完全分离 |
| 手动审核生命周期 | 中 | Stop 会持久化终止状态并阻止迟到结果覆盖；跨 API 进程的在途模型调用仍不能物理中断 |
| 外部来源 | 中 | MCP/Web 无法精确查证时返回 `INCONCLUSIVE`，不作为内容 finding |

本轮验证结果：

- Reviewer API 单元测试：72 项通过；Web 控制面板和结果面板测试：13 项通过；
- CAS、Schema、Agent Runtime、API、Web TypeScript 类型检查及 `git diff --check` 通过；
- 更大范围的 MCP/Broker/Store 套件需在 CI/Linux 环境执行。

## 2. 当前调用流程

Reviewer Specialist 默认关闭，且不会自动介入普通对话。当前支持两种显式入口：
用户在消息中点名后由 Agent 调用，或用户在 Workspace 侧栏手动执行。

```text
用户在设置页启用 Reviewer Specialist 并选择档位
→ 用户在消息中明确点名 Reviewer Specialist
→ 本轮 Agent 获得 review_checkpoint 工具
→ Agent 创建并登记 Artifact
→ review_checkpoint 锁定 Artifact Version 和内容哈希
→ Quick 检查引用、Evidence 与 Artifact 来源链路
→ Deep 时依次执行 Citation 与 Computation 语义审核
→ 保存 ArtifactReviewRun 并返回主 Agent
→ 在工具调用位置显示默认折叠的 Reviewer 卡片
```

Agent 通过 `review_checkpoint` 调用时，Reviewer 使用当前 Run 的 `AbortSignal`；
用户停止 Run 后审核同步取消。图谱查询设置 5 秒上限，避免接口异常造成长时间等待。

手动入口不发送用户 Prompt，也不依赖大模型判断是否调用工具；点击后会在当前
对话位置写入一个 Reviewer 活动锚点：

```text
Workspace 侧栏点击 Run review
→ 主对话立即显示 Reviewer Specialist Running 卡片
→ 后端选择当前 Session 每个 Artifact 的最新版本
→ 直接复用 Reviewer Service 执行当前档位
→ 保存 ArtifactReviewRun，并在同一张卡片更新通过、问题或失败结果
→ 将结构化审核反馈写入 reviewer_checkpoint 对话消息
→ 下一次主 Agent 调用从会话历史读取反馈
```

当前手动入口是 Reviewer Service 的旁路调用：不会阻塞主对话。审核结果已经
进入下一次主 Agent 的模型上下文，因此用户可以直接要求“根据 Reviewer 结果修复”。
它不会修改已经发出的单次模型请求；Deep 已使用受限 Reviewer Sub-agent。

### 2.1 后续：执行中异步反馈闭环

目标流程：

```text
点击 Run review
→ 在当前对话位置插入 Reviewer Specialist Running 卡片
→ Reviewer 任务独立执行，主 Agent 继续正常输出
→ Reviewer 保存结构化结果并发布 reviewer.feedback.ready
→ 主 Agent 在当前模型请求结束后的安全边界读取反馈
→ 通过内部 continuation 修复或解释，不伪造新的用户消息
→ 同一张 Reviewer 卡片更新为通过、有问题或失败
```

不能向已经发出的单次 LLM 请求动态追加上下文。因此“反馈给主 Agent”必须发生在
模型调用之间的安全边界，而不是中断当前推理：

- 当前 Run 尚未结束：在本轮下一个安全边界消费反馈；
- 当前 Run 已结束：创建隐藏的内部 continuation，不要求用户再次输入 Prompt；
- 用户主动发起下一轮对话：直接从持久化 checkpoint 消息读取反馈（已实现）；
- Reviewer 失败、取消或超时：只更新卡片，不阻塞主 Agent；
- Quick 可作为本地异步审核任务；Deep、后续来源级证据增强 使用受限的 Reviewer Sub-agent；
- Reviewer 只提供 finding，是否修改 Artifact 由主 Agent 结合用户原始任务决定。

## 3. Quick 已实现能力

### 3.1 Citation：宽松格式预检

Citation Quick 只检查明显错漏，不验证论文真实性，也不过度限制引用格式。

支持的常见形式：

- 数字引用：`[1]`、`【1】`；
- 作者年份：`(Author, 2024)`、`Author et al., 2024`；
- Markdown 脚注：`[^source]`；
- HTML 或 Unicode 上标；
- Markdown 来源链接和正文 URL；
- DOI、arXiv ID、PMID、PMCID 等稳定标识符。
- 报告 Evidence 标记：`[ev1]`、`[ev2]`。

仅在以下明显问题出现时生成 `CITATION_*` finding：

- 脚注或编号没有对应参考条目；
- 参考文献区为空；
- DOI、arXiv、PMID 等仍为 `TODO`、`TBD` 或缺失占位；
- Artifact 中只有来源标识符，没有任何正文关联标注。
- `[evN]` 没有对应的 Artifact Version reference；
- `[evN]` 对应的 Evidence 节点不存在，或没有 `extracted_from` 链接到 Paper；
- Evidence 图谱查询不可用或结果被截断，因而无法可靠确认链路。

Quick 不要求每条引用都具有 DOI、arXiv ID、PMID 或 URL。
`[evN]` 检查仅确认别名、Evidence 节点和 Paper 链路存在，不判断 Evidence 内容
是否真正支持正文 Claim；语义匹配仍属于 Deep/后续来源级证据增强。

### 3.2 Computation：Artifact 图谱完整性预检

Quick 不判断 Artifact 是否包含计算型 Claim，而是检查每个待审
`ScientificArtifactVersion`：

1. 使用 `artifact_id + version` 生成版本固定的 `provenance_ref`；
2. 调用 `trace_provenance` 查询该 Artifact 的图谱链；
3. 校验 Artifact 节点、版本、内容哈希、断链和截断状态；
4. 将问题转换为标准 `COMPUTATION_*` finding。

对于带百分比、单位、样本量等数据值且引用普通文献标注（如 `[1]`）的陈述，若同一
陈述没有 `[evN]` Evidence 映射，Quick 返回
`COMPUTATION_NUMERIC_CLAIM_EVIDENCE_MISSING`。这表示数据无法沿
`Artifact → Evidence → Paper` 进行溯源，不判断数值本身对错；主 Agent 可据此补充
Evidence、修订 Claim，或在用户要求时说明证据不足。

若数字 Claim 完全没有文献标注、`[evN]` Evidence 或已登记的生成数据引用（如
`[data1]` / `[fig1]`），Quick 返回 `COMPUTATION_NUMERIC_CLAIM_UNSUPPORTED`；若
写有 `[data1]` / `[fig1]` 但当前 Artifact Version 找不到对应 Artifact reference，返回
`COMPUTATION_NUMERIC_CLAIM_PROVENANCE_UNRESOLVED`。二者都表示主 Agent 需要补充
可追溯支撑，不代表 Reviewer 自动修改内容。

该结果只说明 Artifact 是否可追溯，不说明计算方法是否科学，也不验证 Artifact
中的数值是否与原始结果一致。

### 3.3 前端展示

- 设置页提供 Reviewer Specialist 开关和 `Quick / Deep` 档位；后续来源级证据增强不提供独立选择入口。
- Memory graph 后方提供独立白色状态卡，只读同步设置页的 `On / Off` 和档位；
- 状态卡只提供 `Run review / Reviewing…` 手动执行按钮，不在侧栏修改配置；
- Agent 调用时，卡片显示在 `review_checkpoint` 的实际工具调用位置；
- 手动执行时，卡片固定在点击时的对话位置，完成、失败和刷新后均保留；
- 运行中和完成后的 Artifact 结果卡默认折叠；
- 摘要显示 Artifact 名称、检查类型、档位和结论；
- 展开后显示 finding、锁定内容哈希等详情；
- 审核记录持久化后，刷新页面仍可重新加载。

## 4. 当前能力边界

Quick 本身不执行以下任务；Deep 已覆盖其中的论文身份、引用支持性和带 `[evN]` 的数值
Evidence 一致性判断，但仍不读取全文或原始计算产物：

- 联网确认论文是否真实存在；
- 判断论文是否支持 Artifact 中的对应陈述；
- 识别计算型 Claim；
- 判断带 `[evN]` 的 Claim 数值是否与对应 Evidence 内容一致；
- 判断计算方法、统计方法是否科学；
- 自动修复 Artifact。

页面按实际结果显示 Quick、Deep 或 `INCONCLUSIVE`；后者表示证据不足或基础设施不可用，
不等同于内容通过或内容错误。

## 5. 已知差距与稳定化任务

进入 Deep 开发前，先完成以下 Quick 稳定化工作：

| 优先级 | 工作项 | 验收标准 |
|---|---|---|
| 已完成 | 修正增量复用 | Artifact Version、内容哈希、检查集合和 Reviewer 版本一致时复用已有结果，并记录 `reusedFromReviewId` |
| 已完成 | 下一轮上下文反馈 | 手动审核结果持久化为 `reviewer_checkpoint` 消息，下一次主 Agent 请求可以读取 |
| 已完成 | Agent 调用取消 | `review_checkpoint` 使用当前 AgentRun 的 `AbortSignal`，停止 Run 时终止审核 |
| P0 | 区分审核问题和服务降级 | 图谱不可用、超时等 finding 当前仍会使总体 decision 变为 `REVISE_AND_RETRY`，应改为 inconclusive/degraded |
| P0 | 校准 MCP SubTask 断链 | `no upstream of SubTask #subtask:mcp:*` 可能是图谱关联缺失，不应直接判定 Artifact 内容需要修订 |
| 已完成 | 补齐手动审核取消 | Stop 持久化终止 checkpoint，并阻止迟到结果覆盖 |
| P0 | 保证失败不阻塞对话 | Reviewer 失败或图谱降级后，主 Agent 应继续回复，并收到明确、非内容缺陷的状态 |
| P0 | 执行中异步反馈主 Agent | Reviewer 与主 Agent 并行；当前模型请求结束后通过内部 continuation 自动消费 finding，不产生伪造用户消息 |
| P1 | 保留两类审核结果边界 | Citation 和 Computation finding 可分别查询、展示和失效 |
| P1 | 补充集成测试 | 覆盖手动审核取消、并行审核、反馈 continuation、真实 Neo4j、刷新留存和重复审核 |
| P1 | 修复 Web 测试运行配置 | 正式 CI 中确认并修复 `Orchestration.test.tsx` 的 JSX runtime 配置 |
| P1 | 跨进程物理取消 | 以共享执行标识或任务租约让 Gateway 可终止其他 API 进程中的在途模型调用 |

## 6. 后续开发路径

高级档位始终包含低级档位，不重复建设 `review_checkpoint`、Artifact 锁定协议
和 Reviewer 卡片。

```text
Quick：本地格式与图谱完整性
  ↓
Deep：大模型理解与结构化在线证据
  ↓
后续来源级证据增强：原始来源文件与 Claim 级证据定位
```

### 6.1 Deep 扩展准备度

当前代码已经为 Deep 留下以下基础：

- `ReviewerSpecialistLevel`、档位排序、设置持久化和前端选择框已支持
  `quick / deep`；
- `review_checkpoint` 已统一 Artifact 锁定、结果持久化、卡片展示和下一轮上下文反馈；
- `ArtifactReviewRun.reviewLevel` 可以区分不同档位结果；
- Citation、Computation 已拆分为独立 Quick 检查函数，图谱访问通过回调注入；
- 高级档位包含低级档位的排序规则已经固化。

上述内容是 Deep 开发前的准备记录。当前已完成受限 Sub-agent、高级档位选择和
`supportsLevel(..., "deep")` 编排；下列重构项保留为已落实的设计依据：

```text
runReviewerCheckpoint(level)
  ├─ runQuickReview(context)
  └─ level >= deep → runIntelligentReview(context, policy)
       └─ for each locked Artifact（串行）
            ├─ create restricted Reviewer Sub-agent
            ├─ Citation Skill：论文身份 → 陈述证据匹配
            ├─ Computation Skill：数字 Claim → Evidence 内容匹配
            └─ validate and merge structured findings

policy
  ├─ Deep：registered Evidence + paper metadata + abstract + governed web
  └─ 后续来源级证据增强：Deep + full text + supplements + raw provenance artifacts
```

建议新增稳定的智能阶段接口，例如 `IntelligentReviewerStage.execute(context, policy)`。
阶段声明 `version`、所需 Skill 和输出协议，`policy` 声明证据上限、允许工具、超时和
调用预算。这样 后续来源级证据增强 只扩展 Deep 的证据获取策略，不复制执行引擎，也不修改 Quick
规则、HTTP 入口、Artifact 锁定、审核记录或前端卡片。

`citation-reviewer` 和 `computation-reviewer` 已作为独立内置 Skill 纳入 Deep 审核；
服务端在每次受限模型调用前读取并注入完整 Skill 正文，不能把大模型语义判断继续
写进 `citation-review.ts` 或 `computation-review.ts` 的正则和条件分支。

结论：**该策略化重构已完成；Deep 现在复用同一执行管线，并保留后续来源级证据增强的扩展位。**

### 6.2 Deep：智能审核

执行顺序：

1. 先执行 Quick，并保留其结构化结果；
2. 对每个锁定的 Artifact 依次启动一个工具受限的内部 Reviewer Sub-agent；
3. 服务端必读并注入内置 `computation-reviewer` Skill，对单条数字 Claim 与对应 Evidence 执行一次受限语义判断；
4. 服务端必读并注入内置 `citation-reviewer` Skill，对单条引用先执行受控来源预检，再执行一次受限语义判断；
5. 两个 Skill 共用由 `[evN]` 解析出的 Evidence Bundle，避免重复查询；子 Agent 不自行读取 Skill 或选择工具；
6. 校验 Sub-agent 的结构化 JSON，再合并 Deep 与 Quick 结果并返回主 Agent。

Artifact 之间首版保持串行，单个 Artifact 内部的 Citation、Computation 也保持固定
顺序。这样便于取消、审计、增量保存和定位失败，不在首版引入并行复杂度。

当前审核范围不设置 Artifact 内的总数量上限：Quick 检查全部 `[evN]` Evidence
引用；Deep 为每条数值 Claim、每篇可识别文献创建独立队列任务。每条 Deep
Claim/Evidence 输入最多 4,000 字符；资源控制由单任务超时、缓存、重试和取消完成，
而不是跳过 Artifact 后续内容。

每个 Artifact Sub-agent 必须设置独立资源上限：

- 同一 checkpoint 的 Artifact Sub-agent 并发数固定为 `1`；
- 只允许服务端受治理的来源预检、只读图谱查询和结构化结果返回；完整 Skill 由服务端注入，子 Agent 不自行读取 Skill 或调用工具；
- 禁止 `task`、Shell、代码执行、Artifact 写入和再次创建 Sub-agent；
- 每个 Artifact 设置最大模型调用次数、最大 Evidence 数量、输入字符数和墙钟超时；
- 达到上限、模型失败或用户取消时保存阶段结果并返回 `INCONCLUSIVE/CANCELLED`，
  不阻塞主 Agent，也不继续处理下一个 Skill 的无效输入。

### 6.2.1 Deep 去重与复用

Quick 和 Deep 使用不同复用边界：

- Quick 结论与 Artifact Version 的图谱身份绑定，仍按版本、内容哈希、检查集合和
  Quick Reviewer 版本复用，不能因为正文相同就跳过新版本的 Provenance 检查；
- Deep 语义结论按稳定 `semanticReviewFingerprint` 复用。指纹至少包含 Artifact 内容
  哈希、`[evN]` reference 映射、Evidence/Paper 内容指纹、Deep policy 版本、两个
  Skill 哈希以及模型标识；
- 当前 Artifact 的 Deep 指纹与已完成审核完全一致时，不创建 Sub-agent、不调用
  模型，只创建绑定当前 Artifact Version 的复用记录并保存 `reusedFromReviewId`；
- 任一 Claim、数字、`[evN]` 映射、Evidence 内容、论文元数据、Skill、模型或 policy
  发生变化时，Deep 结果失效并重新审核；
- Deep 首版按整个 Artifact 复用。后续再扩展为按 Claim–Evidence 单元局部复用，
  避免首版引入复杂缓存合并逻辑。

Deep Citation：

- 从 Artifact 中提取带 `[evN]` 的陈述，并通过版本化 reference 找到 Evidence；
- 沿 `Evidence → extracted_from → Paper` 获取 Evidence 内容、locator 和论文元数据；
- 优先使用报告中已有 URL 或 DOI、PMID、PMCID、arXiv ID 生成的受控来源预检，获取
  规范化元数据和摘要快照；不在 Reviewer 中开放 Shell 或任意网络执行；
- 来源快照缺失或身份字段冲突时，才由服务端策略启用受治理的 MCP/Web 补证；
- 对齐 DOI、标题、作者、年份和来源；
- 先完成论文身份真实性硬门，再由大模型判断陈述是否得到 Evidence 支持；
- 只在摘要或网页证据足够时判断一般性 Claim；具体数值或复杂结论证据不足时返回
  `INCONCLUSIVE`，不冒充全文核验；
- MCP 和 Web 均不可用时降级为 Quick；MCP 有结果但 Web 不可用时允许基于证据等级
  输出 Deep 结论或 `INCONCLUSIVE`，不把“无法进一步核验”误判为“论文虚假”。

Deep Computation：

- 只选择同一句或同一表格单元中同时包含数字和 `[evN]` 的 Claim；
- 确定性提取并规范化数值、比例、范围、单位和样本量；
- 读取同一 Evidence Bundle 中的 Evidence 内容和现有来源摘录；
- 由大模型判断指标、人群、分组、单位和统计口径是否一致；
- 输出数值匹配、单位不一致、范围不一致、来源未包含该数字或证据不足，并提供
  可执行的原因说明；
- Deep 不下载完整 PDF、原始数据，也不重新执行计算；证据不足时返回
  `INCONCLUSIVE`，不做无证据的语义判断。

### 6.3 后续来源级证据增强：深度证据审核

后续来源级证据增强 复用同一智能审核管线，在 Deep 结果基础上提高允许的证据深度和执行预算。

后续来源级证据增强 Citation：

- 获取论文全文、表格、图片和补充材料；
- 将 Artifact 中的重要引用陈述拆分为原子 Claim；
- 定位具体章节、段落、表格或图片中的真实证据；
- 输出 `支持 / 部分支持 / 不支持 / 证据不足`，并绑定可定位的来源证据。

后续来源级证据增强 Computation：

- 沿 Provenance 图谱读取原始数据、代码、执行输出和上游 Artifact；
- 将 Claim 定位到真实结果文件中的字段、行、表格或输出位置；
- 对关键数值执行来源级交叉验证；受控重算属于后续可选能力，不作为 后续来源级证据增强 初版前提。

后续来源级证据增强 需要增量保存阶段结果，避免全文下载或长任务失败后丢失全部进度。

### 6.4 交互能力

Deep 稳定后再补充：

- 可选的 Artifact 创建后自动审核；
- Citation / Computation 分类筛选；
- finding 的 `待处理 / 已修复 / 忽略` 状态；
- 主 Agent 修复 Artifact 后自动复审新版本。

异步反馈闭环不依赖 Deep，应先在 Quick 阶段完成；Deep、后续来源级证据增强 只替换 Reviewer
任务内部的 Skill、模型和工具，不改变卡片、反馈事件及 continuation 协议。

## 7. Skill 与服务职责

| 层级 | 职责 |
|---|---|
| 内置 `citation-reviewer` Skill | 定义论文核验、Claim 拆分、证据等级和输出协议；Deep 初版已接入 |
| 内置 `computation-reviewer` Skill | 定义数字 Claim、Evidence 内容匹配和输出协议；Deep 初版已接入 |
| `services/api/src/reviewer-specialist/` | 档位编排、Artifact 锁定、Skill 选择、工具权限、结果校验、持久化、取消和降级 |
| Reviewer Sub-agent | 按 Skill 使用同一套大模型审核管线；通过 Deep/后续来源级证据增强 policy 控制证据深度和白名单工具 |
| 主 Agent continuation | 在模型调用安全边界消费 Reviewer finding，结合原始任务决定修复或解释 |

Quick 的格式和完整性判断可以保留确定性规则；Deep、后续来源级证据增强 共用的语义判断必须由
大模型结合 Skill 和真实工具结果完成，不能继续堆叠为硬编码业务规则。两档差异
必须来自证据权限和结论门槛，而不是复制提示词或条件分支。

当前 Deep 初版代码已完成：每个 Artifact 使用一个受限 Sub-agent，固定按 Computation →
Citation 执行；Citation 先使用受控 URL/稳定标识符来源预检，MCP/Web 仅作服务端策略补证；
每次模型调用服务端注入完整 Skill 正文，结构化结果失败时降级为
`INCONCLUSIVE`；语义指纹一致时复用 Deep 结论，但仍重新执行当前 Artifact Version
的 Quick Provenance 检查。真实模型、MCP 与 Web 的端到端联调尚未完成，不能标记为
生产可用。

Deep 的全部业务实现放在 `services/api/src/reviewer-specialist/`。Memory Graph、Web
Broker、模型和 Skill Catalog 只通过只读接口或依赖注入提供能力；其他服务文件只允许
保留入口注册与参数装配，不得承载 Claim 判断、Prompt、结果合并或降级规则。

## 8. 主要代码路径

| 内容 | 路径 |
|---|---|
| Artifact 串行编排、档位合并与降级 | `services/api/src/reviewer-specialist/review-checkpoint.ts` |
| Citation 的 Quick / Deep 与后续来源级证据增强 | `services/api/src/reviewer-specialist/citation-review.ts` |
| Computation 的 Quick / Deep 与后续来源级证据增强 | `services/api/src/reviewer-specialist/computation-review.ts` |
| 共用 Evidence Bundle、指纹与档位策略 | `services/api/src/reviewer-specialist/review-policy.ts` |
| Deep / 后续来源级证据增强 共用受限子 Agent 执行器 | `services/api/src/reviewer-specialist/review-agent-executor.ts` |
| 工具入口 | `packages/agent-runtime/src/workspace.ts` |
| 触发门控和图谱接口 | `services/api/src/runs/index.ts` |
| 设置持久化与接口 | `services/api/src/store.ts`、`services/api/src/http/index.ts` |
| 档位 Schema | `packages/schema/src/runtime-settings.ts` |
| 审核结果 Schema | `packages/schema/src/provenance.ts` |
| 设置页 | `apps/web/src/Orchestration.tsx` |
| 侧栏手动入口 | `apps/web/src/ReviewerControlCard.tsx` |
| Reviewer 卡片 | `apps/web/src/ReviewerPanel.tsx` |
| 手动审核对话锚点 | `packages/schema/src/session.ts`、`services/api/src/store.ts`、`apps/web/src/App.tsx` |
| 已实现：下一轮模型上下文反馈 | `services/api/src/reviewer-specialist/review-checkpoint.ts`、`services/api/src/store.ts` |
| 待实现：异步反馈与 continuation | `services/api/src/reviewer-specialist/`、`services/api/src/runs/index.ts` |

## 9. 外部依赖

- Citation 联网搜索和来源发现跟踪
  [#62](https://gitcode.com/mindspore/ScienceAgent/issues/62)；
- Computation 图谱溯源能力跟踪
  [#78](https://gitcode.com/mindspore/ScienceAgent/issues/78)；
- Quick 已接入当前 Memory Graph `trace_provenance` 接口；Deep 首版复用现有
  Evidence/Paper 节点读取能力，后续来源级证据增强 才依赖更完整的原始来源读取能力。
