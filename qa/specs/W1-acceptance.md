# W1 验收规格 — M0 薄切片（种子 → 图谱可见）

> 测试先行：本规格在 W1 开发开始前由 ZCode 写就。Claude 以此为验收目标开发。
> 来源：迁移计划 W1 节 + ZCode 评审建议。状态：**待 Claude 确认接缝**（fixture 注入点是新增要求）。

## 用户故事

作为研究人员，我创建一个知识库，输入种子查询（如 "Ebola virus glycoprotein antibody neutralization"），
系统自动下载约 10 篇论文、抽取实体与关系（每条证据可回溯原文），然后我在图谱页看到并可以点开实体详情。

## 验收标准

### A. 主链路（mocked 层，CI 可跑）
1. 建 KB 成功，出现在 KB 列表；
2. 种子查询发出后任务入队，状态可见（pending → running → succeeded），失败可重试；
3. 10 篇文档全部 `ready`（fixture 回放的学术 API，无真实出站）；
4. 实体数落在 150–250 区间（埃博拉 schema 词表：virus/protein/antibody/gene/epitope/method/dataset/drug/assay）；
5. **溯源门**：每条边的 evidence quote 在对应文档原文可验证（归一化子串或 ≥85% 词重叠），不可验证的关系被丢弃且计数可见；
6. 图谱页渲染：节点/边非空、无 console error、实体点击出详情（邻域+证据）。

### B. 真实通路（real 层，波次验收时跑）
7. 真实种子查询下载 ≥8/10 篇（允许学术 API 波动，失败计入外部环境归因）；
8. 抽取使用 minimax-text（管线 LLM），实体向量使用 siliconflow 1024 维，写入成功。

### C. 工程约束
9. `pnpm architecture:check` 通过；新增文件全部带 Apache 头；
10. 图谱 API 不使用 `SELECT *`（含 fulltext）的查询给前端；
11. 连接器保留 fixture 注入点（传输层可替换或等效机制），供 mocked 层回放 `test/fixtures/scholarly/`。

## 旅程规格（ZCode 将铺设的 journey-ke-* 骨架）

| 旅程 | 覆盖 |
|---|---|
| journey-ke-create-kb-seed | A1–A3（建库→种子→任务状态） |
| journey-ke-graph-renders | A6（图谱渲染+零 console error） |
| journey-ke-entity-detail | A6（实体详情+证据溯源） |
| journey-ke-seed-real | B7–B8（@real 标签，小预算） |

## 待实测项（不阻塞开发）

- Playwright 运行位置：Windows 直连 WSL :4310，或退回 WSL 内跑（`.e2e/` 组装环境两侧各试一次）。
