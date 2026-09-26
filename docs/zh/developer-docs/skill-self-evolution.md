# Skill 自演进：当前实现

**Status: Current implementation**

本文描述当前 Skill self-evolution 路径。它不是自动修改内置 Skill 的后台学习系统，也不是“任务完成后自动发布新 Skill”。

当前机制采用**提案 → 用户授权 → 发布新版本**的受控流程。

## 1. 设计目标

Self-evolution 的目标是把一次任务中值得复用的方法沉淀为 Skill，同时保持：

- 用户知道发生了什么；
- 写回只进入可写 Skill Library；
- 变更先形成可检查 proposal；
- 发布前重新检查当前 library head；
- 运行中的 Skill 版本保持冻结；
- 内置 Skill 不被 Agent 自行覆盖。

## 2. 两条相关路径

### Reviewable Skill draft

用户可以从明确需求或现有 Session 生成 Skill draft。Draft 仍需人工查看/确认后才成为 managed Skill。

相关代码主要位于：

- `packages/specialist/src/skills.ts`
- API Skill draft/import routes
- SkillManager UI

这一条用于“生成一个可审核 Skill”。

### Skill Library self-evolution proposal

Agent 可以通过运行时工具提出 Library 更新：

```text
propose_skill_library_update
```

该工具只创建 pending proposal，不直接修改 library head。

用户允许发布后，Agent/流程再调用：

```text
publish_skill_library_update
```

一个或多个同 library proposal 会合并为一个新 Library version。

## 3. Proposal 数据流

```text
Agent run
   │
   ├─ read existing Skill / inspect task evidence
   │
   ▼
propose_skill_library_update
   │
   ▼
SkillLibraryCatalog.proposeUpdate()
   │
   ├─ require rationale
   ├─ require sourceRefs
   ├─ force author.kind = self-evolution
   ├─ dry-run commit
   └─ persist pending proposal
              │
              │ user/permission allows publication
              ▼
publish_skill_library_update
              │
              ▼
SkillLibraryCatalog.publishProposal(s)
              │
              ├─ rebuild against current head
              ├─ validate packages
              ├─ detect conflicts
              ├─ persist packages/version
              └─ advance head
```

Proposal 保存的是“建议的变更 + 来源 + dry-run 结果”，不是已经生效的 Skill。

## 4. 为什么发布时还要重新构建

Proposal 创建后，Library head 可能已被其他用户或运行更新。

因此 publish 不直接复用旧 dry-run version，而是：

1. 读取当前 head；
2. 将 proposal operations 重新合并；
3. 重新运行 validation / conflict detection；
4. 无冲突才生成新 version。

这避免 proposal 静默覆盖之后发生的修改。

## 5. 内置 Library 是只读边界

`BUILT_IN_SKILL_LIBRARY_ID` 由系统从仓库 `skills/` seed。

Self-evolution proposal 不能写入 built-in library。

需要演进的 Skill 应放入可写 library；内置能力升级仍通过源码/release 流程完成。

## 6. Run 不会被新 head 污染

运行开始时，`enabledSkillLibraries` 中的 `head` 会解析成具体：

- `libraryId`
- `versionId`
- `contentHash`

因此一个已经开始的 run 不会因为 proposal 被发布而改变 Skill 集。

新版本只影响之后重新解析 library refs 的运行。

## 7. Tool 暴露条件

`packages/skill/src/plugin.ts` 根据宿主提供的 ports 构建 Skill tools。

Self-evolution 相关 tool 只有宿主提供：

- `proposeSkillLibraryUpdate`
- `publishSkillLibraryUpdate`

时才会加入当前 Agent 的 tool table。

不要假设所有 Agent / Reviewer / Specialist 都天然拥有发布能力。

## 8. 权限与人工控制

发布属于改变持久能力库的写操作，应经过产品权限和用户意图边界。

核心原则：

- Agent 可以提出；
- proposal 可以被查看；
- 用户决定是否允许发布；
- 发布形成新版本，不改写历史；
- conflict 必须显式返回，不能自动“最后写入者获胜”。

## 9. 当前明确不代表什么

当前 self-evolution **不等于**：

- 模型权重训练；
- 自动在线学习；
- 每次任务结束自动生成 Skill；
- 自动接受评价分数并无条件发布；
- 对 built-in Skill 的自动修改；
- 已实现向量/模型驱动的 Skill Library 检索。

Skill Library 当前搜索实现见 [Skill Library 当前实现](skill-library-management.md)。

## 10. 修改这条链路时

需要同时检查：

- `packages/workspace` 中 proposal/publish tool schema；
- `packages/skill` plugin 是否正确暴露 tools；
- `services/api/src/skill-library-catalog.ts` proposal / publish 语义；
- HTTP proposal API；
- permission / audit；
- runtime Skill version freeze；
- UI review/publish 路径；
- tests 和用户旅程。

## 相关文档

- [Skill Library 当前实现](skill-library-management.md)
- [技能渐进式披露](skill-progressive-disclosure.md)
- [组件与插件机制](plugins.md)
