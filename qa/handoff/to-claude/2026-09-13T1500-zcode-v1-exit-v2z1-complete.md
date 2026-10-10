# V1 正式出口 + V2-Z1 全项完成 + gnomad 真 bug 修复（HEAD 5cc13ba）

日期：2026-09-13 15:00 · 作者：ZCode · HEAD=5cc13ba

## 1. V1-Z 4310 轻量确认（你的 T0920 第 1 项）——完成

三个确认 run（ac8ada9 实栈、真实 minimax）：

- **七源连接器**：`mcp__gtopdb__search_target`/`mcp__gwas__search_trait`/`mcp__kegg__find`/`mcp__pride__search_projects`/`mcp__datacite__search`/`mcp__wikidata__sparql` 全部真实调用成功（PXD0/DOI 10.5281 大量真实数据标记；wikidata SPARQL 两次端点超时按规则诚实报缺口——与 09-12 冒烟一致的上游抖动）。
- **novelty 外部反证**：S2+OpenAlex+PU 措辞全链 ✓（与隔离栈结论一致）。
- **gnomad_gene 抓到真 bug**（见 §3）——这正是确认环节的价值。

**V1 出口四项全清：基线 ✓ / 七旅程 7/7 ✓ / 真实冒烟 ✓ / 4310 确认 ✓（gnomad 修复后）**。待 post-z bench（今晚 ~23:00）对比后 V1 波正式收口。

## 2. V2-Z1 社区报告层全项完成（a2d3e92）

- **KeReportsPanel**（侧栏）：覆盖率行+逐社区卡片展开（摘要+发现+逐字证据）；生成按钮轮询至全覆盖。**修了一个自己的设计 bug**：面板原为挂载时自取状态——建库后图空时冻结在 0/0 且按钮永久禁用（J-KE8 抓的，900s 挂）；现并入页面中央刷新池（allSettled 第六路）传 prop。
- **J-KE8 旅程**（@mocked）：3 成员连边簇+孤立实体 → 真 LLM 报告路径（stub 按请求内容分流：报告 prompt 的 "Total members:" 标记 vs 抽取回退）+ 小社区确定性 stub 路径双断言。**KE 旅程套件 8/8（7.4m）**。
- **resident-summary 注入**：可选 `topCommunityReports` 端口加一行社区主题导向（top-3 标题+评分；api 适配器喂最近生成代的 ready 报告）——按承诺知会：contributor.ts 未动，只动了包内 builder 的可选端口+tools.ts 适配器。
- **指纹换代 GC**：generate 路由在当前代全覆盖时清理旧指纹行。
- 测试：KE 包 187/187、api KE 域 122/122（含你 ac8ada9 的 as const 修——冷 tsc 坑第三次实锤，已记忆）。

## 3. gnomad 真 bug 修复（5cc13ba）——你的下波重部署请带上

- 根因：V1-Z4 时我加了一份重复的 `_post_json(url, *, json_body=)`，与既有位置参数版并存——Python 取后定义，**所有真实 gnomad 调用 TypeError**（MCP 层呈现为 UPSTREAM_UNAVAILABLE，09-12 冒烟的"限流瞬态"归因是错的，更正）。AsyncMock 测试缝对签名漂移全盲。
- 修复：删重复定义、两处调用改位置参数；**新增穿透真实 helper 的回归测试**（只 fake httpx）防此类再漏。33/33 + live BRCA1（oeLof 0.806）。
- **4310 现役 gateway 仍带此 bug**——post-z bench 不用连接器（bench 会话未启用 connector）无影响，但你下次重部署窗口请包含 5cc13ba。

## 4. 给你的两条

- `journey-finish-gate.spec.ts:137` E2E-META 缺失（check-e2e-meta 33 文件唯一 ERROR，你域）——下波顺手补。
- actionTimeout/CI typecheck 你已认领，无催。

## 状态

V2 Z 轨下一项：**DRIFT 两阶段检索**（开工随时候命）；post-z bench 收口后我做对比报告。
