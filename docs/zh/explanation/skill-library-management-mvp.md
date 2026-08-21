# 技能库管理 MVP 落地

MVP 目标是先把“技能库能被框架管理、应用层循环能把技能产物写回来”跑通。此阶段不要求运行时自动召回，也不要求 UI 完整迁移。

## 要解决的问题

当前只有单技能管理能力。自演进循环如果产出一批技能，只能逐个模拟用户编辑，无法表达“这一批修改是同一次评估后的原子提交”，也无法方便回滚。

MVP 要把技能库变成一个可版本化资源：

- 一个技能库包含多个技能。
- 每次提交产生一个不可变库版本。
- 一批技能编辑要么全部成功，要么全部失败。
- 自演进循环只调用一个写回接口即可提交产物。

## 交付内容

- 新增 `SkillLibraryCatalog`，负责技能库、版本和技能包存储。
- 新增共享 schema：`SkillLibrary`、`SkillLibraryVersion`、`CommitSkillLibraryVersionRequest`、`SkillLibraryDiff`。
- 新增 `/api/skill-libraries` 相关接口。
- 支持 `POST /api/skill-libraries/:libraryId/versions` 批量 `upsert/delete`。
- 支持 `dryRun`，提交前返回 diff、diagnostics 和 conflicts。
- 支持版本 diff 和 rollback。
- Prompt Manifest 增加 `skillLibraryRefs`，记录库版本来源。

## 核心接口

```http
POST /api/skill-libraries/:libraryId/versions
```

请求包含：

- `baseVersionId`：本次提交基于哪个库版本。
- `operations`：本次新增、更新或删除哪些技能。
- `author`：来源是用户还是自演进循环。
- `evaluation`：应用层传入的评估摘要，框架只存储，不解释指标。
- `dryRun`：只预检，不真正发布版本。

成功后返回：

- 新版本 id。
- 库内容 hash。
- 本次 diff。
- 校验诊断。

## 存储要求

- 技能包按内容 hash 存储，重复包复用。
- 库版本 manifest 不可变。
- 更新 head 必须在版本 manifest 成功写入后进行。
- 回滚建议创建一个新的 rollback 版本，而不是改写历史。

## 验收标准

- 能创建技能库。
- 能提交一批技能包并生成新版本。
- 任一技能包校验失败时，整批提交不生效。
- 能查看两个版本之间的新增、删除、修改。
- 能回滚到旧版本。
- Prompt Manifest 能记录运行使用过的库版本引用。

## 暂不做

- 不改造运行时技能自动召回。
- 不实现向量检索。
- 不做完整 SkillManager UI 迁移。
- 不做语义冲突自动判断。
