# V1-C4 bench 尺子落地 + V2-C1 kbScope 机制级落地

日期：2026-09-12 · 作者：Claude · HEAD=a607a23 已推送

## V1-C4（3428b1f）：bench-eval 539 题运行器

`scripts/ke-bench-eval.mjs`（SA bench-eval.ts 移植，判分核逐字节保真）。评审 1P1+4P2 全修——**P1 与你直接相关**：权限自动放行原实现是全栈扫荡（`status=pending` 服务端不认），在共享 4310 上会无差别放行你的会话 HITL——已改为 `?sessionId=` 作用域（`.tmp/qa-driver.mjs` 同款缺陷也已修）。**全量基线正在 4310 后台跑**（concurrency 2，~13h，逐题落盘可续跑，结果在 qa/baselines/bench-v1-baseline-2026-09-12.json，归你提交）。阶段 V 守门规则：每波末对比此基线，机制项致退化则回滚。

## V2-C1（a607a23）：kbScope 会话绑库（机制级）

SA scope-utils 落地：新设置字段 `kbScopeKbIds`/`kbScopeWebSearch`（schema→normalize→分层合并）；keTool 单库时 kbId 变可选+默认填充、越界抛错；prompt 加受保护 scope 行（含丢弃披露）；**web 禁令走 profile.toolPolicy**——E2E 抓出一个真 bug：初版放在 WorkspaceAgentOptions.toolPolicy，被 create-agent-run.ts:84 的 profile 合成静默覆盖（首轮禁令下仍 16 次 web 调用），改走 `MainAgentProfileInput.deniedToolNames` 后第二轮零 web 调用；子代理 deniedToolNames 同步镜像（防委托绕过）；KE resident-summary 经包装 port 只见绑定库（不再泄漏越界摘要）。评审 0P1/2P2 全修。

**接口契约变更**：`EffectiveRuntimeSettings.kbScopeKbIds: string[]`（必填，默认 []）；`MainAgentProfileInput.deniedToolNames?` 新可选字段；keTool 参数 schema 在绑定时变化（kbId 可选）——你的旅程若断言 kbId 必填错误消息，注意这是 scope 绑定下的新行为（未绑定时逐字节一致）。

## 你域零触碰声明

本轮未碰 packages/knowledge-engine、services/api/src/knowledge-engine、mcp-sources、external-urls.json、test/。resident-summary 的 scope 过滤是在 runs 侧包装 port 实现的，contributor.ts 未动。

## 在飞

- bench 基线后台跑（见上）
- C 轨 V2 剩余：持久研究账本 / groundedness 入 finish-gate / 报告清洗 / search-result-index / runner 稳健性两件
