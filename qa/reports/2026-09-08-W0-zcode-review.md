# W0 波次报告 — ZCode 独立评审（2026-09-08）

**结论：PASS（有条件）** —— W0 基础设施代码质量高、设计合理，可以进入 W1；但 1 项 P2 应在 W1 开始前修复。

## 评审范围

未提交工作区：`packages/knowledge-engine/`（7 文件）+ `services/api/src/knowledge-engine/`（7 文件）+ `services/api/package.json`（+1 依赖行），共 2124 行逐行评审。对照计划：`C:\Users\xjtlb\.claude\plans\deepanalyze-d-codespace-deepanalyzet-ht-precious-kahan.md` W0 节。

## 代码评审发现

### P2（应修）

1. **6 个文件缺 Apache 许可头**（仓库惯例是每个 .ts 带华为版权头，后期反哺上游要求一致）：
   - `packages/knowledge-engine/src/index.ts`
   - `packages/knowledge-engine/src/text/trigram.ts` / `trigram.test.ts`
   - `packages/knowledge-engine/src/text/cosine-scan.ts` / `cosine-scan.test.ts`
   - `packages/knowledge-engine/src/text/llm-text.test.ts`
   （`llm-text.ts` 有头但同包不一致，恰好说明是遗漏而非决策。）

### P3（观察，不阻断）

2. `services/api/src/knowledge-engine/store.ts:400-404` — `upsertDocument` 更新路径 `title = ?` 绑定 `input.title ?? existing.title`：显式传空串 `""` 会覆盖已有标题（非 nullish 合并）。建议与其他字段一致走 coalesce，或在 JSDoc 写明语义。
3. `store.ts:758-763` — `recoverStaleJobs` 将 running→pending 但不回退 `attempts`：崩溃恢复会消耗尝试次数。语义可接受（防无限重试），建议注释写明是有意为之。

### 值得肯定的设计（供后续波次沿用）

- `ke_migrations` 版本表 + 顺序迁移 + 事务包裹，DA 的迁移纪律完整移植；
- `toFtsQuery` 对用户输入逐 token 引号包裹，FTS5 MATCH 无注入面；
- `salvageJson`/`stripThinkingProcess` 把 MiniMax-M3 think 块方括号陷阱写成了回归测试；
- job-runner 故意串行（防学术任务风暴 OOM）+ claim/fail/backoff/dead-letter 语义完整；
- embedding 客户端 429/5xx 才重试、AbortSignal.any 组合超时，干净。

## E2E 结果矩阵

W0 无用户可见旅程（纯基础设施，未接线 bootstrap）——本波次以单测 + `pnpm check` 为验收，已由 Claude 会话验证绿（27+20）。ZCode 未重复执行（本波次无部署面），W1 起按六拍循环补齐。

## 对 W1 的建议（测试先行输入）

1. **学术 API 录制回放必须进 W1**：种子旅程依赖 arxiv/S2/EuropePMC 真实出站，限流会导致旅程 flaky。建议连接器层预留 fixture 注入点（或传输层可替换），mocked 层全本地。
2. **W1 体量偏重**（连接器 6 源 + JATS 转换 + 抽取 + REST + cytoscape 前端一个波次）：如果中途吃紧，优先保「种子→抽取→图谱 API」主链路，前端图谱页可后置到 W1.5。
3. **图谱 API 勿直接用 `listDocuments`**（默认 `SELECT *` 含 fulltext 大字段，10k 上限）；给图谱页出专用精简查询。

## 给 Claude 的行动项

- [ ] P2：给上述 6 个文件补 Apache 头（services 侧文件头格式照抄 `store.ts`）
- [ ] P3（可选）：`upsertDocument` title 语义统一，或 JSDoc 说明
- [ ] P3（可选）：`recoverStaleJobs` attempts 语义注释
