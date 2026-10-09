# Skill Library 当前实现

**Status: Current implementation**

本文描述当前仓库中的 Skill Library 实现，不是路线图。事实源包括：

- `services/api/src/skill-library-catalog.ts`
- `services/api/src/http/skill-libraries.ts`
- `packages/skill/`
- `packages/specialist/`
- `@sciencediscovery/schema` 中的 Skill Library 类型

历史 MVP/M1/M2 阶段文档已删除，避免将阶段目标误认为当前行为。

## 1. 能力边界

Skill Library 解决四件事：

1. 将多个 Skill 组织成可版本化 library；
2. 以不可变 version 固定一次运行使用的 Skill 集合；
3. 支持搜索、diff、rollback 和冲突检测；
4. 支持 Agent/self-evolution 先提交 proposal，再由受控流程发布。

它不负责 Agent loop，也不直接负责上下文组装；运行时 Skill 工具和 context contribution 由 `packages/skill` / `packages/workspace` / `packages/context` 组合完成。

## 2. 主要代码

| 路径 | 责任 |
| --- | --- |
| `services/api/src/skill-library-catalog.ts` | Library/version/package/proposal 的持久化与原子 mutation |
| `services/api/src/http/skill-libraries.ts` | `/api/skill-libraries` 和 proposal HTTP 路由 |
| `packages/skill/src/plugin.ts` | Skill runtime plugin：tools + context contribution |
| `packages/skill/src/manifest.ts` | plugin manifest 与 settings fields |
| `packages/specialist/src/skills.ts` | Skill package 解析/验证与 runtime snapshot |
| `@sciencediscovery/schema` | Library、Version、Search、Proposal 等共享类型 |

## 3. 存储模型

默认根目录：

```text
<data-dir>/skill-libraries/
├── catalog.json
├── packages/
│   └── sha256/<prefix>/<hash>/package/...
└── libraries/
    └── <library-id>/
        └── versions/
            └── <version-id>.json
```

### Library

`catalog.json` 保存 library 元数据和 proposal 索引。Library 的 `headVersionId` 指向当前 head。

### Version

每次发布创建不可变 `SkillLibraryVersion`，记录：

- author；
- base/parent version；
- skills；
- content hash；
- evaluation metadata；
- rollback 来源（如有）。

### Package

Skill package 以内容 hash 存储。写入后会重新运行 `validateSkillPackage` 并验证 hash，失败则删除不完整内容。

## 4. 提交与并发语义

`SkillLibraryCatalog` 用进程内 mutation queue 串行化修改。

提交版本时：

1. 检查 library 是否存在；
2. 检查 `baseVersionId` 是否等于当前 head；
3. 对每个 upsert package 执行 `validateSkillPackage`；
4. 检查同一次提交重复编辑、删除不存在 Skill 等冲突；
5. 计算 diff 和 version content hash；
6. dry-run 或存在冲突时不发布；
7. 先持久化缺失 package；
8. 写不可变 version 文件；
9. 最后更新 catalog head。

因此 stale base 不会静默覆盖新的 head。

## 5. Built-in library

启动期间 `seedBuiltInSkillLibrary(repositoryRoot)` 将仓库 `skills/` 中的 `BUNDLED_SKILL_IDS` 同步到内置 library。

内置 library：

- 由系统 seed；
- 会删除当前版本中已经不再 bundled 的 Skill；
- self-evolution proposal 被禁止写入内置 library。

## 6. Runtime mount 与冻结

运行设置使用 `enabledSkillLibraries`。

`resolveEnabledRefs()` 在 run 开始时将：

- `head` 解析为具体 `versionId`；
- 读取对应 `contentHash`；
- 去重 library/version 对；
- 返回 `PromptSkillLibraryRef`。

这保证同一次 run 使用固定 version，而不会被之后的 head 更新污染。

Skill plugin manifest 声明的相关设置：

- `enabledSkillIds`
- `enabledSkillLibraries`
- `skillSelectionMode`

## 7. Search 当前实现

HTTP：

```http
POST /api/skill-libraries/search
```

当前搜索是**确定性的词法评分**，不是向量或模型检索。

主要规则：

- Skill id 与完整 query 相等：最高分；
- id 包含 query：高权重；
- description 包含 query：次高权重；
- query token 再对 id / description 累加；
- 只保留 score > 0；
- 每个 library 和总结果都有上限。

多 library 合并：

- higher priority 胜出；
- 同优先级同 Skill id 且 hash 不同会产生 `DUPLICATE_SKILL_PRIORITY_CONFLICT`；
- 返回固定 library refs、候选和冲突。

不要在文档或调用方假设当前已经实现向量检索或“混合召回”。

## 8. Proposal / self-evolution

Agent/self-evolution 不直接改 head，而可创建 `SkillLibraryUpdateProposal`。

Proposal 要求：

- rationale；
- sourceRefs；
- 以 dry-run commit 生成 diff/conflict/diagnostics；
- 初始状态为 `pending`。

可以：

- reject；
- publish 单个 proposal；
- 合并发布同一 library 的多个 pending proposals。

发布时重新基于**当前 head**构建 commit，因此 proposal 创建后 head 已变化时仍会重新做冲突检查。

内置 library 不接受 self-evolution proposal。

## 9. HTTP API

当前路由：

```text
GET/POST  /api/skill-libraries
POST      /api/skill-libraries/search
GET       /api/skill-libraries/:id
GET/POST  /api/skill-libraries/:id/versions
GET       /api/skill-libraries/:id/versions/:version
GET       /api/skill-libraries/:id/versions/:from/diff/:to
POST      /api/skill-libraries/:id/rollback
POST      /api/skill-libraries/:id/proposals

GET       /api/skill-library-proposals
POST      /api/skill-library-proposals/:id/publish
POST      /api/skill-library-proposals/:id/reject
POST      /api/skill-library-proposals/publish
```

精确 request/response 类型以 schema 和 route handler 为准。

## 10. 修改这块代码时

至少检查：

- package validation 是否仍只有一个事实源；
- head 更新是否仍发生在 version/package 持久化之后；
- stale base / duplicate operation 冲突语义；
- built-in library 是否保持只读 proposal 规则；
- runtime 是否固定具体 version/content hash；
- Skill plugin 的 context/tool 行为是否和 library selection 一致；
- API/UI 变更是否补测试。

## 相关文档

- [技能渐进式披露](skill-progressive-disclosure.md)
- [Skill 自演进](skill-self-evolution.md)
- [组件与插件机制](plugins.md)
- [动态上下文组装](context-assembly.md)
