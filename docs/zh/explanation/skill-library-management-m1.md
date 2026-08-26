# 技能库管理 M1 落地

M1 目标是让技能库真正进入运行链路：执行任务时可以挂载一个或多个技能库版本，并从库里自动选出本次任务需要的候选技能。

## 要解决的问题

MVP 解决了“库能提交、能回滚”。但如果运行时仍然依赖人工勾选技能，技能库规模变大后仍然不可用。

M1 要补齐：

- 运行时指定技能库版本。
- 多个技能库同时挂载。
- 同名技能按优先级合并。
- 从挂载库中做目录级召回。
- 运行开始时固定库版本，避免评估被演进中的 head 污染。

## 交付内容

- Runtime settings 增加 `enabledSkillLibraries`。
- run 创建时把 `head` 解析成具体 `versionId + contentHash`。
- 支持多库挂载优先级。
- 支持同名技能去重与结构冲突阻塞。
- 新增 `/api/skill-libraries/search`。
- run 只把召回后的候选技能传给现有渐进式披露流程。

## 运行时解析流程

1. 读取 Project / Session 生效设置。
2. 解析每个技能库挂载项。
3. 如果用户选择的是 `head`，立即固定为具体版本。
4. 按优先级从高到低合并技能。
5. 同名技能保留最高优先级版本。
6. 如果同优先级下同名技能 hash 不同，阻塞运行并返回冲突。
7. 用任务 query 在合并后的库视图中召回候选技能。
8. 把候选技能 resolve 成冻结快照，交给 `describe_skill/read_skill`。

## 核心接口

```http
POST /api/skill-libraries/search
```

请求包含：

- `query`：用户任务或应用层构造的检索文本。
- `libraries`：要搜索的库版本和优先级。
- `limit`：返回候选数量。
- `filters`：领域标签等过滤条件。

响应返回候选技能 metadata，不返回完整 `SKILL.md` 正文。

## 验收标准

- Session 可以配置挂载多个技能库。
- 浮动 `head` 在 run 创建时被固定成具体版本。
- 同一个 run 中 Prompt Manifest 记录固定后的 `skillLibraryRefs`。
- 同名技能能按优先级稳定合并。
- 同优先级冲突会阻塞运行。
- 大库场景下 system prompt 不再写入全库 metadata，只写入召回候选。

## 暂不做

- 不实现复杂向量索引，第一版可用字符串/标签/触发条件检索。
- 不改变 `read_skill` 的完整正文读取协议。
- 不做语义冲突模型审计。
