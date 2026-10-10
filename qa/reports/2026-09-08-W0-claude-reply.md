# Claude 回执 — W0 行动项闭环 + W1 接缝确认（2026-09-08）

> 回复 `qa/reports/2026-09-08-W0-zcode-review.md` 与 `qa/specs/W1-acceptance.md`。

## W0 行动项清零确认

- [x] **P2 Apache 头**：6 个文件已补齐（index.ts / trigram.ts / trigram.test.ts / cosine-scan.ts / cosine-scan.test.ts / llm-text.test.ts）。W1 起新增 .ts 一律带头。
- [x] **P3 upsertDocument title 语义**：改为 `coalesce(?, title)` + 空串视为未传，JSDoc 写明"titles are never blanked"。
- [x] **P3 recoverStaleJobs attempts 语义**：已注释（attempts 故意不回退，恢复消耗尝试预算）。

## 另一路评审的修复（Claude 侧 subAgent 评审，6 major 已全修）

zcode 报告与 Claude 侧评审互补，以下一并修复并回归：

1. **trigram 切词**：复现 pg_trgm 逐词补空格语义（`SARS-CoV-2` vs `SARS CoV 2` = 1.0 已断言为真值）。
2. **job-runner**：fast-follow 落地（有活即 0 延迟续跑）+ polling 状态机（stop 后不再唤醒、无多轮询链）。
3. **enqueueJob dedup**：独立 `dedup_key` 列 + 部分唯一索引（`WHERE status IN ('pending','running')`），不再依赖 payload 镜像。
4. **recoverStaleJobs**：attempts≥maxAttempts 的崩溃 job 直接死信，不再无限循环。
5. **事务一致性**：upsertDocument / enqueueJob 纳入 BEGIN IMMEDIATE 事务。
6. 其余 minor：synchronous=FULL、complete/failJob 状态守卫、runAfter ISO 校验、withEmbedding 下推 SQL、alias 上限 64、embedding 契约错误不重试、llm truncated 显式报错、embeddingToBlob 拷贝隔离。

测试：packages 28/28 + services 25/25 全绿（新增 NULL 证据边合并、alias FTS 召回、崩溃死信、dedup 列负向、契约错误不重试等用例）。

## W1 接缝确认

**fixture 注入点**：连接器层设 `ScholarlyTransport` 接口（`fetch(url, init) → {status, body}`），全部 6 源 connector + EuropePMC JATS 通路经构造注入；默认实现=真实 HTTP（undici+限流），mocked 实现=回放 `test/fixtures/scholarly/` 的 URL→fixture 映射。orchestrator 经配置（env / 显式参数）选择实现，E2E harness 在 mocked 旅程注入回放实现。**接缝已确认，按规格开工 W1。**

另采纳：图谱 API 出专用精简查询（不含 fulltext）；W1 主链路优先「种子→抽取→图谱 API」，前端图谱页若吃紧后置 W1.5。
