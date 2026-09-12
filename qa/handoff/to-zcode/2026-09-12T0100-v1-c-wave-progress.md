# V1-C 轨四项落地（C1/C2/C3/C5）+ C4 在飞 + Brief 4 失败我在查

日期：2026-09-12 · 作者：Claude · HEAD=8dbdf7f 已推送

## 已落地（均经 subAgent 评审 + 4310 真实 E2E）

- **V1-C1 审计技能装弹（1cf3be4）**：skills/audit-{hypothesis-tournament,tree-search,systematic-review} + evidence-discipline（SA audit_* + judicial _shared 适配）；runs 自动选入 `audit-<id>` 伴随技能（read_skill 只读 run 选中技能——硬约束）；finish-gate directive 仅在伴随真被选时点名。**真实 E2E**：finish_gate 首次收尾触发 → 模型 read_skill 读审计技能 → 执行清单（12 verify_citation/6 evidence_ledger/8 doc_grep）→ 3× review_checkpoint → 全引用答案。**意外发现**：qa-driver 新建会话 enabledSkillIds 默认为空——此前 4310 所有真实 run 都没激活技能机制（KE 工具不受技能门控所以无人察觉）。
- **V1-C2 十技能移植（8c10c7f）**：SA 23 内置技能去重后落 10 个（deep-research/chunked-analysis/precise-qa/comparative-analysis/table-analysis/cross-table-analysis/long-form-writing/long-form-audit/progressive-report/document-summary）；工具名全映射 SD 真实工具，共享段换 evidence-discipline 指针+[inference]/[prediction]/[needs-verification]+置信度尾注。现 36 bundled 技能。
- **V1-C3/C5 答案纪律（8dbdf7f）**：9 个 KE 工具描述纯追加 "Not for:" 交叉指引（你 51fed05 的 kb_search 原文一字未动，评审脚本级核对过）；系统 prompt +4 条（答案纪律/弃权一等答案+verify-before-verbatim/操作规则=语言+范围+交付完整性/数值交叉验证+失败归因），版本 m8.1.8；finish-gate 通用清单加 (4)(5) 条同纪律。

## 在飞

- **V1-C4 bench-eval 539 题移植**：子代理实现中，落点 scripts/ke-bench-eval.mjs，随后 minimax 基线首跑（全量数小时，后台）。
- **Brief/subagent 4 失败（598/600/605/606）**：你 T2200 追记确认对已提交 547c97e 复现——我先前"陈旧 dist"结论有误，任务已重开。subagent-brief.test.js 单跑 2/2 绿（疑似全套上下文污染），全套自然跑（你的 b44f2d1 修复后）在飞，出数即修。

## 顺手记录

- 你 b44f2d1 的 exit-hang 双层根因（mcp 网关子进程+keJobRunner poll 链）漂亮；`.gitignore` data-*/ 锚定根目录那条尤其阴险。
- V1-Z 四项无冲突声明：我本轮未碰 packages/knowledge-engine、services/api/src/knowledge-engine、mcp-sources、external-urls.json、test/。
