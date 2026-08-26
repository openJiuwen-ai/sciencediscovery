# Skill 自演进设计

本文描述如何基于现有 Skill 库和 subagent 框架实现一个可审阅、可回滚的 Skill 自演进闭环。这里的“自演进”不是修改基础模型参数，而是让 Agent 在任务之后把可复用经验沉淀成 Skill，并通过 Skill Library 版本化、召回和分发。

现有 Skill Library MVP/M1 已经提供了大部分框架底座：

- Skill 库、库版本、批量提交、diff 和 rollback。
- 运行时挂载一个或多个 Skill Library。
- run 创建时把 `head` 固定成具体版本。
- 从挂载库里召回 top-N Skill，再进入现有渐进式披露。
- Prompt Manifest 记录实际使用过的库版本和 Skill 快照。

因此，当前框架层面的主要矛盾不是“多 agent 编排”，而是把 Skill 更新做成一个**可触发、可审阅、可评估、可回滚**的产品闭环。

截至当前实现，M1.5 的底座已经具备：

- Agent / subagent 可以调用 `propose_skill_library_update` 创建 pending proposal。
- 工具支持结构化 `upsert_skill` 输入，由工具层自动生成合法 `SKILL.md`，减少 YAML frontmatter 错误。
- 后端对 proposal 执行 Skill Library dry-run，返回 diff、diagnostics 和 conflicts。
- 前端 Skill Manager 可以展示 pending proposal、diff，并支持单个或批量 publish。
- Agent 可以调用 `publish_skill_library_update` 发布 proposal，但必须经过现有权限确认流程。
- 多个 subagent 并行生成的多个 proposal 可以合并发布成一个新的 Skill Library version。

## 1. 与 EvoSkill 的关系

EvoSkill 的核心思路可以复用：

```text
执行任务
  -> 找失败样本
  -> Proposer 分析失败并提出 create/edit skill
  -> Skill-Builder 生成 skill folder
  -> 评估 candidate
  -> 通过后进入后续任务
```

但我们不需要额外发明一套多 agent 框架。ScienceDiscovery 已经有 subagent，因此可以直接用 subagent 承担这些角色：

- 主 Agent 或 reviewer 负责发现失败样本。
- `proposer` subagent 负责分析失败轨迹，提出新增或修改 Skill 的建议。
- `skill-builder` subagent 负责生成标准 Skill package。
- 现有 Skill Library Catalog 负责 dry-run、校验、diff、commit 和 rollback。

EvoSkill 里的 program branch / frontier 可以先不实现。后续如果需要多候选并行演进，可以把它映射到多个 `SkillLibraryVersion`，而不是引入 git branch 作为新的事实源。

## 2. 目标与非目标

目标：

- 允许 Agent/subagent 提出 Skill Library 更新。
- 更新必须先 dry-run，返回 diff、diagnostics 和 conflicts。
- 默认由用户确认后再发布到 Skill Library；Agent 也可以发起 publish，但必须走权限确认。
- 发布后的 Skill 仍通过 M1 召回链路进入后续 run，不直接污染所有上下文。
- 记录本次更新来自哪些 run、artifact、reviewer finding 或人工反馈。

非目标：

- 不新增独立多 agent 编排系统，直接复用 subagent。
- 不让 Agent 静默 commit Skill Library。
- 不在第一阶段实现 frontier、自动发布策略或复杂 benchmark 调度。
- 不修改基础模型权重。

## 3. 最小闭环

第一阶段建议做“人工确认式自演进”：

```text
Run 完成
  -> 主 Agent / reviewer 识别失败或可复用经验
  -> 启动 proposer subagent 生成 Skill 更新建议
  -> 启动 skill-builder subagent 生成 Skill package
  -> Agent 调用 propose_skill_library_update 创建 pending proposal
  -> 后端执行 Skill Library dry-run
  -> 前端展示 diff / diagnostics / 来源
  -> 用户确认 publish，或 Agent 调用 publish_skill_library_update 后等待用户授权
  -> 后续 run 从挂载库中召回新 Skill
```

这个流程里，Agent 不能静默发布。真正 commit 仍必须由用户在前端手动 publish，或由 Agent 发起 `publish_skill_library_update` 并通过权限确认后完成。

## 4. 已补齐的框架接口

当前 API 层和 Agent 工具层已经具备 Skill Library 写入能力：

- `POST /api/skill-libraries/:libraryId/versions`
- `POST /api/skill-libraries/:libraryId/proposals`
- `POST /api/skill-library-proposals/:proposalId/publish`
- `POST /api/skill-library-proposals/publish`
- 支持 `dryRun`
- 支持 `author.kind = "self-evolution"`
- 支持 diff、diagnostics、conflicts 和 rollback

Agent 工具：

```text
propose_skill_library_update
publish_skill_library_update
```

`propose_skill_library_update` 语义：

- 输入目标库、base version、更新说明和 Skill package。
- 后端只执行 dry-run。
- 返回 diff、diagnostics、conflicts 和一个 pending proposal id。
- 不更新 `head`。
- 不发布新版本。

这个工具可以复用现有 `CommitSkillLibraryVersionRequest` 的主体，但强制：

- `dryRun: true`
- `author.kind: "self-evolution"`
- 必须带 source refs，例如 run、session、artifact 或 reviewer finding。
- 不能写 built-in 只读库。
- 不能覆盖用户未授权的库。

`publish_skill_library_update` 语义：

- 输入一个或多个 pending proposal id。
- 多个 proposal 必须属于同一个可写 Skill Library。
- 后端把多个 proposal 合并成一次 Skill Library commit。
- 发布前必须经过权限确认，不能静默执行。
- 失败时返回 conflicts，不推进 `head`。

## 5. Subagent 分工

自演进内部角色通过 subagent prompt 实现，不需要新运行时抽象。

### proposer subagent

职责：

- 读取失败 run 的目标、轨迹、工具错误、reviewer findings 和最终输出。
- 判断是否真的需要 Skill 更新。
- 决定是新增 Skill 还是修改已有 Skill。
- 给出简短理由和适用边界。

它可以输出三类结果：

- `create`：需要新增一个 Skill。
- `edit`：需要修改某个已有 Skill。
- `no-op`：问题不适合沉淀为 Skill。

### skill-builder subagent

职责：

- 把 proposer 的建议写成标准 Skill package。
- 生成 `SKILL.md`、description、triggers、domain tags。
- 必要时生成 `references/` 或 `scripts/`。
- 避免把 ground truth、私密路径、token、一次性样本内容写入 Skill。

skill-builder 的产物进入 `propose_skill_library_update`，由后端复用现有 Skill 校验逻辑。

## 6. 前端需要展示什么

前端不需要变成复杂的“自演进工作台”。当前 Skill Manager 已经展示 pending proposal，并支持 Reject、Publish、Publish selected。下一步应把 proposal 和产生它的 run 更自然地串起来，在 Session / Run 视角展示：

- 来源：哪个 run / session / artifact / reviewer finding。
- 目标库和 base version。
- 新增或修改了哪些 Skill。
- Skill Library diff。
- diagnostics 和 conflicts。
- 操作：`Reject` / `Publish`。

发布后生成新的 `SkillLibraryVersion`，用户仍然可以用现有 diff / rollback 能力回退。

## 7. 下一步建议

M1.6 已经补上 Run 级自演进入口。目标是让用户不用手写 prompt，也不用记工具名，就能从一次任务结果中沉淀 Skill。

当前流程：

```text
Run 完成
  -> 用户在已完成 Run 下点击“Summarize as Skill”
  -> 后端启动一个普通 Agent run
  -> proposer subagent 判断是否值得沉淀
  -> skill-builder subagent 生成结构化 upsert_skill
  -> 主 Agent 调 propose_skill_library_update
  -> 前端在当前 Session / Skill Manager 展示 pending proposal
  -> 用户 publish selected
```

M1.6 已实现的具体工作项：

- 在 completed / failed / interrupted Run 的 timeline 下展示“Summarize as Skill”入口。
- 点击后 queue 一个普通 Agent run，使用固定 M1.6 prompt 驱动 proposer / skill-builder subagent。
- 默认推荐目标库为 `project-skills`；后端会把所有可写 Skill Library 提供给自演进 run，LLM 可以选择更匹配的库。
- 固定 prompt 强制优先使用 `upsert_skill` 结构化输入，避免手写 `SKILL.md`。
- 固定 prompt 要求 proposal 带上原始 `session` / `run` source refs。
- 自演进 run 不允许再次作为自演进源，避免递归总结。
- 发布仍在 Skill Manager pending proposal 区域完成。

仍需补强：

- proposal 卡片目前主要展示 diff 和 rationale，后续可把适用边界、风险说明、来源 run 链接展示得更清楚。
- 目前至少需要一个可写 Skill Library；后续可以把 `project-skills` 做成 Project 创建时的默认库或一键创建。
- 发布后可以在当前 Session 显示“新 Skill 将在后续 run 通过库召回生效”的明确提示。

M1.6 之后，再进入 M2 的评估辅助发布：

- 给 proposal 关联 reviewer findings 或轻量 replay 结果。
- 对新增 Skill 做基本质量检查：是否过宽、是否泄露一次性样本、是否包含私密路径。
- 展示“建议 publish / 建议 reject / 需要人工修改”的质量摘要。

## 8. 运行时边界

自演进发布后的 Skill 不会自动进入所有 Agent 上下文。运行时仍遵循 M1：

1. Project / Session 挂载 Skill Library。
2. run 创建时 pin 具体库版本。
3. 运行开始时从挂载库召回 top-N。
4. 召回候选与手动 selected skills 合并。
5. Agent 通过 `describe_skill` / `read_skill` 渐进式读取。

因此，自演进只是更新库内容；是否能被 Agent 看到，仍由库挂载、召回和用户设置共同决定。

## 9. 安全原则

- Agent 可以 propose；publish 必须经过用户确认权限。
- 所有自动生成的 Skill 更新必须 dry-run。
- built-in 库默认只读，不允许自演进写入。
- ground truth、参考答案和 benchmark hidden data 只能用于分析失败，不能写入 Skill 正文。
- Skill 必须写明适用边界，避免过宽触发。
- 发布只创建新版本，不改写历史版本。
- 用户可以通过 rollback 撤回错误演进。

## 10. 分阶段落地

### M1.5：Agent 可提出 Skill 更新（已实现）

- 新增 `propose_skill_library_update` Agent 工具。
- 工具内部调用 Skill Library dry-run。
- proposer / skill-builder 直接用现有 subagent 实现。
- 前端展示 pending proposal 和 diff。
- 用户手动 publish，或 Agent 发起 publish 并等待用户权限确认。
- 支持多个 pending proposal 合并发布。

### M1.6：Run 级自演进入口（已实现）

- 在 Run / Session 页面提供“总结为 Skill”的手动入口。
- 使用现有 subagent 执行 proposer / skill-builder。
- 生成 pending proposal 后回到当前 Session 展示。
- 让用户可以在当前上下文中 publish selected。

### M2：评估辅助发布

- 为 proposal 关联 reviewer 结果或 benchmark 分数。
- 支持 baseline/candidate 对比。
- Skill Library version 展示评估摘要。
- 仍默认人工确认发布。

### M3：受控自动发布

- 只对低风险新增 Skill 开启 policy 自动发布。
- 修改高命中 Skill、删除 Skill、评估回退仍需人工确认。
- 可以基于历史命中率和失败率调整召回排序。

## 11. 与现有 Skill 库文档的关系

- `skill-library-management-mvp.md` 解决“Skill 库能存、能提交、能回滚”。
- `skill-library-management-m1.md` 解决“运行时能挂载库并召回候选 Skill”。
- `skill-library-management-m2.md` 解决“召回质量、冲突诊断和版本质量视图”。
- 本文关注自演进闭环：让 Agent/subagent 能安全地提出 Skill Library 更新，并逐步把更新纳入审阅、发布和评估流程。
