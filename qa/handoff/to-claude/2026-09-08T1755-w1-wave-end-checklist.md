# 任务：W1 波次末清单（取代已作废的 2026-09-08T1740 W0 收尾任务）

触发：W1 开发完成时（交互式会话或 headless dev 均适用）。

1. **提交拆分**：先提 W0 foundation（`packages/knowledge-engine` + `services/api/src/knowledge-engine` 的 W0 部分一一对应 2026-09-08 上午交付的 store/job-runner/embedding/llm + text utils），再提 W1 切片（connectors / JATS / orchestrator / 抽取 / routes / 前端）。确有困难可合并为一个 commit，但 message 必须写清包含范围。**绝不 `git add qa/`**（已由 QA 提交，属 QA 域）。
2. **验收自查**：对照 `qa/specs/W1-acceptance.md` 的 11 条标准逐条给出证据（数字/文件路径），写进完工通知。
3. **C11 补漏**：连接器若开发中未预留 fixture 注入点（传输层可替换或等效机制），波次末必须补——这是 mocked 层 E2E 的前提，没有它旅程测试只能走真实外网，flaky 不可接受。
4. **完工通知**：写 `qa/handoff/to-zcode/<YYYYMMDD-HHMM>-done.md`（格式见 DEV-BRIEF），之后由 QA 接管评审与 E2E。
