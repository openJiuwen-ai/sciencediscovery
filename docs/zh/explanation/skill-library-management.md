# 技能库管理初步设计

本文面向 [GitCode Issue #116](https://gitcode.com/mindspore/ScienceAgent/issues/116) 中的框架侧需求：支持技能库作为可版本化资源被创建、检索、挂载和回滚，并提供应用层自演进循环把技能产物原子写回来的接口。

渐进式披露本身不在本文设计范围内。现有 `describe_skill` / `read_skill` / `read_skill_resource` 的语义继续保留；本设计补齐它前面的库级管理、目录级召回和运行快照选择。

## 1. 背景与现状

当前仓库已经具备单个技能的管理与运行快照能力：

- `services/api/src/skills.ts` 的 `SkillCatalog` 能导入、创建、更新、删除 managed skill，并为每个 managed skill 保存递增 revision。
- `validateSkillPackage` 已校验 Science Skills 包形态：根目录 `SKILL.md`、YAML frontmatter、可选 `assets/` / `references/` / `scripts/` 等资源。
- `SkillCatalog.resolve(ids)` 会把当前技能内容复制成 `RuntimeSkillSnapshot`，运行期间读取的是这份冻结快照。
- `packages/agent-runtime/src/runtime.ts` 的 `buildSkillSystemSection` 只把已选技能的 metadata 放入 system prompt，完整正文按需读取。
- `services/api/src/prompt-manifest.ts` 已把本次运行使用的 `skillRefs` 记录为 `id/hash/version/revision`。

缺口在于：

- 资源模型仍是“全局技能目录 + 单技能 revision”，没有“技能库”这一等资源。
- 版本只能表达单个技能的更新，不能表达一批技能编辑的原子提交，也不能对库级版本做 diff / rollback。
- 运行设置只有 `enabledSkillIds` 和 `skillSelectionMode`，无法指定“挂载哪个技能库、哪个版本、多个库的优先级”。
- `describe_skill` 只在本次运行已选技能内检索。技能数量增长后，人工选择技能和把所有 metadata 写入 prompt 都不可持续。
- 应用层自演进循环没有稳定写回接口，只能退化为模拟用户逐个调用技能编辑接口。

## 2. 目标与非目标

目标：

- 引入 `SkillLibrary` 作为框架资源，支持多个技能库并存。
- 支持库级不可变版本：每次提交产生新版本，版本由内容 hash / version id 标识，可回退到任意历史版本。
- 支持批量编辑原子提交：新增、更新、删除多个技能要么全部生效，要么全部不生效。
- 支持版本 diff：看出相对父版本新增、删除、修改了哪些技能。
- 支持运行时指定一个或多个技能库版本，并在 Prompt Manifest 中记录库版本与最终技能快照。
- 提供目录级召回接口：给定任务 query，从全库或指定库版本中返回候选技能，再进入现有渐进式披露流程。
- 提供自演进循环写回接口：循环提交候选技能编辑、评估摘要和产物引用，框架校验并生成新库版本。

非目标：

- 不设计判分、生成/判别器协同、审计抽样、门控回滚、显著性检验、断点续跑、成本统计等自演进循环逻辑。
- 不重新设计 `read_skill` 的渐进式披露协议。
- 不引入 ScienceAgent 私有技能 DSL；技能产物仍保持 Agent Skills / Science Skills 包兼容。
- 不在第一阶段实现高阶语义冲突自动修复；框架只提供检测结果、阻塞策略和人工/应用层决策入口。

## 3. 核心概念

### SkillPackage

单个技能包，继续沿用现有形态：

```text
<skill-id>/
  SKILL.md
  references/*
  scripts/*
  assets/*
```

`SKILL.md` frontmatter 至少包含：

```yaml
---
name: antibody-protenix-pipeline
description: Run the governed antibody design pipeline.
metadata:
  version: 1.0.0
  domain-tags: antibody, protein-design
  triggers: antibody design tasks requiring RFdiffusion or Protenix validation
---
```

库管理层应规范化并索引这些字段：

- `id/name`：稳定身份，遵循现有小写字母、数字、单连字符规则。
- `description`：目录召回主字段。
- `domainTags`：领域标签，可由 `metadata.domain-tags` 或未来明确 frontmatter 字段归一得到。
- `triggers`：触发条件，可由 `metadata.triggers` 或未来明确 frontmatter 字段归一得到。
- `instructions`：`SKILL.md` 正文。
- `resources`：现有资源摘要与 hash。
- `packageHash`：沿用现有 `packageHash(files)` 口径。

### SkillLibrary

技能库是一个命名集合，不直接存放内容，而是指向一个 head 版本：

```ts
interface SkillLibrary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  headVersionId: string;
  defaultMountPriority: number;
  readOnly: boolean;
}
```

建议内置技能归入只读库 `builtin`，用户和自演进产物进入 managed library。这样现有 built-in skill 与 managed skill 可以统一参与组合、优先级和召回。

### SkillLibraryVersion

库版本是不可变快照，记录该版本包含的全部技能引用：

```ts
interface SkillLibraryVersion {
  id: string;
  libraryId: string;
  sequence: number;
  parentVersionId?: string;
  createdAt: string;
  createdBy: SkillLibraryCommitAuthor;
  message: string;
  contentHash: string;
  skills: SkillLibrarySkillRef[];
  evaluation?: SkillLibraryEvaluationSummary;
}

interface SkillLibrarySkillRef {
  id: string;
  name: string;
  description: string;
  domainTags: string[];
  triggers: string[];
  version: string;
  packageHash: string;
  packageRef: string;
  resources: SkillResource[];
  diagnostics: SkillValidationDiagnostic[];
}
```

`contentHash` 由版本 manifest 中的 `skills` 按 `id` 排序后稳定序列化计算。只要库内容相同，hash 相同；版本 id 可以使用 `libv_<sequence>_<hash-prefix>` 或 UUID，API 对外同时返回二者。

### SkillLibraryCommit

一次提交是从某个 base version 派生的一组编辑：

```ts
interface CommitSkillLibraryVersionRequest {
  baseVersionId: string;
  message: string;
  author: SkillLibraryCommitAuthor;
  operations: SkillLibraryOperation[];
  evaluation?: SkillLibraryEvaluationSummary;
  dryRun?: boolean;
}

type SkillLibraryOperation =
  | { op: "upsert"; skillId: string; package: SkillPackageInput; expectedPackageHash?: string }
  | { op: "delete"; skillId: string; expectedPackageHash?: string };
```

`expectedPackageHash` 用于乐观并发控制：应用层循环基于某版本修改某个技能时，可以声明它期望覆盖的旧 hash；若 base version 中对应技能已变化，则返回 `409`，避免静默覆盖。

`SkillPackageInput` 支持三种来源，便于自演进循环把产物写回来：

```ts
type SkillPackageInput =
  | {
      kind: "inline";
      skillMarkdown: string;
      resources?: Array<{ path: string; contentBase64: string }>;
    }
  | {
      kind: "artifact";
      artifactId: string;
      artifactVersionId?: string;
      subdirectory?: string;
    }
  | {
      kind: "session-workspace";
      sessionId: string;
      path: string;
    };
```

- `inline` 适合小型技能，由循环直接提交 `SKILL.md` 和少量资源。
- `artifact` 适合循环已把技能包 ZIP 或目录归档声明为 Project Artifact 的情况，框架从 Artifact/CAS 读取指定版本。
- `session-workspace` 适合应用层同进程循环刚在某个 Session 工作区生成技能目录的情况；服务端必须用现有 workspace path resolver 校验路径在该 Session 内。

无论来源如何，框架都应归一成 `Map<path, Buffer>` 后复用 `validateSkillPackage`，不信任调用方提供的 name、hash 或资源摘要。

## 4. 存储设计

建议新增独立库级存储，不破坏现有 `data/skills` 布局：

```text
<data-dir>/skill-libraries/
  catalog.json
  packages/
    sha256/<package-hash>/package/...
    sha256/<package-hash>/package.json
  libraries/
    <library-id>/
      library.json
      versions/
        <version-id>/manifest.json
      head
      .staging/*
```

设计要点：

- `packages/sha256/<hash>` 是技能包内容地址。先写 staging，校验 hash 后原子 rename；相同技能包复用同一目录。
- `manifest.json` 是库版本事实源，包含该版本的完整技能索引，不依赖 head 的活动状态。
- `head` 或 `library.json.headVersionId` 指向当前默认版本。回滚只新增一个指向历史内容的新版本，或更新 head 指针；建议第一阶段采用“新增 rollback commit”，保留线性审计。
- 提交时先完整构造新 manifest、写入缺失 packages、运行校验和冲突检测，再原子发布 version manifest，最后更新 head。
- 复用现有 `SkillCatalog` 的校验函数和 mutation queue 思路；库级提交需要以 libraryId 为粒度串行化。

迁移策略：

- 保留 `/api/skills` 作为兼容视图，默认展示 `builtin + default managed library head` 的技能集合。
- 现有 `data/skills` managed skill 可在启动时懒迁移到 `managed-default` 技能库，每个 current skill 成为初始版本的一条 `SkillLibrarySkillRef`。
- 短期内可以由新的 `SkillLibraryCatalog` 包装现有 `SkillCatalog`，对外先提供库级 API；待 UI 和运行设置迁移后，再收敛底层存储。

## 5. API 设计

### 库管理

| 方法与路径 | 说明 |
|---|---|
| `GET /api/skill-libraries` | 列出技能库及 head 版本摘要 |
| `POST /api/skill-libraries` | 创建空技能库，返回初始空版本 |
| `GET /api/skill-libraries/:libraryId` | 获取库详情 |
| `PATCH /api/skill-libraries/:libraryId` | 更新库名称、描述、默认优先级 |
| `GET /api/skill-libraries/:libraryId/versions` | 列出版本历史 |
| `GET /api/skill-libraries/:libraryId/versions/:versionId` | 获取某版本 manifest |
| `POST /api/skill-libraries/:libraryId/versions` | 从 base version 提交一批编辑 |
| `POST /api/skill-libraries/:libraryId/rollback` | 基于历史版本创建 rollback commit |
| `GET /api/skill-libraries/:libraryId/diff?base=&head=` | 返回两个版本之间的技能增删改 |

`POST /versions` 成功响应：

```json
{
  "libraryId": "managed-default",
  "versionId": "libv_42_ab12cd34",
  "sequence": 42,
  "contentHash": "ab12cd34...",
  "diff": {
    "added": ["foo-skill"],
    "modified": ["bar-skill"],
    "deleted": []
  },
  "diagnostics": []
}
```

`dryRun: true` 时只返回 diff、diagnostics、conflicts，不发布版本，供自演进页面预检。

### 目录级召回

```http
POST /api/skill-libraries/search
```

请求：

```json
{
  "query": "design antibody candidates and validate structures",
  "libraries": [
    { "libraryId": "builtin", "versionId": "head", "priority": 0 },
    { "libraryId": "evolved-antibody", "versionId": "libv_12_...", "priority": 10 }
  ],
  "limit": 20,
  "filters": {
    "domainTags": ["antibody"]
  }
}
```

响应只返回可进入现有渐进式披露的候选 metadata：

```json
{
  "candidates": [
    {
      "libraryId": "evolved-antibody",
      "versionId": "libv_12_...",
      "skillId": "antibody-screening",
      "description": "...",
      "domainTags": ["antibody"],
      "triggers": ["..."],
      "score": 0.83,
      "packageHash": "..."
    }
  ]
}
```

第一阶段检索实现可沿用 `searchSkills` 的字符串/正则打分并扩展到 `description + domainTags + triggers`。接口层保持稳定，后续可替换为向量索引或混合召回。

### 自演进循环写回

应用层循环推荐只调用一个写回入口：

```http
POST /api/skill-libraries/:libraryId/versions
```

`author.kind` 用来标识写入来源：

```ts
type SkillLibraryCommitAuthor =
  | { kind: "user"; userId?: string }
  | { kind: "self-evolution-run"; projectId: string; sessionId?: string; runId?: string; jobId?: string };
```

`evaluation` 存应用层评估摘要，不要求框架理解所有指标：

```ts
interface SkillLibraryEvaluationSummary {
  datasetId?: string;
  testAccuracy?: number;
  passRate?: number;
  baselineVersionId?: string;
  metricSummary?: Record<string, number | string | boolean>;
  artifactRefs?: Array<{ artifactId: string; versionId?: string; label: string }>;
  notes?: string;
}
```

框架侧职责：

- 校验请求 JSON、技能包格式、大小限制、路径安全和 UTF-8。
- 校验 `baseVersionId` 存在且属于目标库。
- 应用全部 operations 到 base manifest，生成 candidate manifest。
- 计算 diff、packageHash、contentHash。
- 执行基础冲突检测。
- 若非 dry-run，原子发布新版本并返回版本摘要。

应用层职责：

- 决定何时提交、何时回滚。
- 解释评估指标和显著性。
- 决定冲突诊断是阻塞、降级还是继续观察。

## 6. 运行时挂载与快照

运行设置新增库引用字段：

```ts
interface RuntimeSkillLibraryMount {
  libraryId: string;
  versionId?: string; // 缺省为提交 run 时解析到的 head
  priority: number;
}

interface RuntimeSettingsOverrides {
  enabledSkillLibraries?: RuntimeSkillLibraryMount[];
  enabledSkillIds?: string[]; // 兼容旧设置
  skillSelectionMode?: "all" | "selected";
}
```

解析流程：

1. 创建 run 时读取 Project / Session 生效设置。
2. 将每个 `versionId: "head"` 立即解析成具体 version id 与 contentHash，写入 `settingsSnapshot`。
3. 对多个库版本按 `priority` 从高到低合并技能。
4. 同名技能用最高优先级版本获胜；若优先级相同且 `packageHash` 不同，返回冲突，要求用户或应用层显式调整优先级。
5. 若设置了 `enabledSkillIds` 白名单，则在合并后的库视图上再过滤。
6. 对最终候选集做目录级召回，得到本次 run 实际暴露给渐进式披露的技能快照。

Prompt Manifest 建议扩展：

```ts
interface PromptManifest {
  skillLibraryRefs?: Array<{
    libraryId: string;
    versionId: string;
    contentHash: string;
    priority: number;
  }>;
  skillRefs: PromptSkillRef[];
}
```

`skillRefs` 继续记录最终进入本次 run 的技能快照，保证历史兼容；`skillLibraryRefs` 解释这些技能来自哪些库版本。评估运行必须固定 version id，不能使用浮动 head，否则自演进过程中库变化会污染指标。

## 7. Diff、回滚与冲突检测

版本 diff：

- `added`：head 有、base 无的 skill id。
- `deleted`：base 有、head 无的 skill id。
- `modified`：两边都有但 `packageHash` 不同。
- `unchanged`：两边都有且 `packageHash` 相同。

回滚：

- `POST /rollback` 接收 `targetVersionId` 和当前 `baseVersionId`。
- 服务端把 `targetVersionId` 的 manifest 作为新内容，从当前 head 创建一个新的 rollback 版本。
- 这样历史保持只追加，Prompt Manifest 中引用过的旧版本永远可复现。

基础冲突检测分两层：

- 结构冲突：同一提交内重复 upsert 同一 skill、删除不存在 skill、`expectedPackageHash` 不匹配、同优先级多库同名不同 hash。这类冲突应阻塞提交或运行。
- 语义冲突：不同技能的 `domainTags/triggers` 高重叠，但 description 或指令中出现明显相反约束。第一阶段只返回 warning 诊断；后续可接入应用层审计模型生成 `SkillConflictDiagnostic`。

## 8. 与现有代码的落点

建议模块拆分：

- `packages/schema/src/skill-libraries.ts`：新增库、版本、提交、diff、搜索相关共享类型。
- `services/api/src/skill-libraries.ts`：实现 `SkillLibraryCatalog`，复用 `validateSkillPackage`、`packageHash`、`SkillCatalogError` 风格。
- `services/api/src/http/index.ts`：新增 `/api/skill-libraries*` 路由。
- `services/api/src/runs/index.ts`：在 `computeSettingsSnapshot` / run 创建阶段解析库挂载为固定版本，并决定本次 run 的技能快照。
- `packages/schema/src/runtime-settings.ts`：加入 `enabledSkillLibraries`，保留 `enabledSkillIds` 兼容。
- `packages/schema/src/provenance.ts` 与 `services/api/src/prompt-manifest.ts`：加入 `skillLibraryRefs`。
- `apps/web/src/api/skills.ts`：新增前端 API client；SkillManager 后续可显示库、版本、diff 和回滚。

第一阶段不必修改 `packages/agent-runtime/src/runtime.ts` 的 `read_skill` 行为。需要改动的是传入 agent-runtime 的 `skills` 集合：它应来自“已固定库版本 + 目录级召回”的结果，而不是当前全量 `enabledSkillIds`。

## 9. 分阶段落地

分阶段文档：

- [MVP：技能库版本与自演进写回](skill-library-management-mvp.md)
- [M1：运行时挂载与目录级召回](skill-library-management-m1.md)
- [M2：混合召回、冲突诊断与 UI 迁移](skill-library-management-m2.md)

阶段关系：

- MVP 先让技能库成为可提交、可回滚、可审计的框架资源。
- M1 再让运行链路可以挂载库版本，并只暴露召回后的候选技能。
- M2 最后提升召回质量、冲突诊断和用户侧管理体验。

## 10. 关键约束

- 任何运行、评估、审计都必须绑定具体库版本和技能 package hash。
- 自演进循环只能通过提交新版本改变库，不应直接写活动目录。
- 技能包格式保持可移植；ScienceAgent 的库 manifest 是管理索引，不是技能运行格式。
- 写回接口默认不信任应用层产物，必须重新校验技能包、路径、大小和 hash。
- 历史版本不可变，删除或清理只能在未来 GC 中处理未被 Prompt Manifest / Artifact / 版本 manifest 引用的包。
