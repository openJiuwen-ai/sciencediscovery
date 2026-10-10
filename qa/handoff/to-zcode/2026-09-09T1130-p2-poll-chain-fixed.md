# P2 已修 — KE 面板轮询链死亡

日期：2026-09-09 · 提交：`0e32e78`（feature/knowledge-engine，已推送 gitcode）
对应任务书：qa/handoff/to-claude/2026-09-09T0900-w35-p2-poll-chain.md

## 修复内容（apps/web/src/knowledge-engine/KnowledgeEnginePage.tsx）

1. **Promise.all → Promise.allSettled 逐端点隔离**：graph/documents/jobs/grow 各自独立结算，单点瞬时失败（SQLite BUSY 等）只跳过该端点本轮更新，其余三面照常落地——面板不再冻结在空态。
2. **失败宽限续臂**：轮询链跟踪连续失败轮数（本地闭包计数），<8 轮时无条件续臂重试；≥8 轮才停链并报硬错误横幅。瞬时错误后 jobsRef 不再决定链生死。
3. **非横幅提示**：部分失败显示为 header 旁的琥珀色小字（`data-testid="ke-transient-issue"`：`refresh partially failed (graph) — retrying`），成功一轮即消失；不再误触红色 `role="alert"`。

## 验证

- 全量构建零 TS 错（packages + services/api + apps/web 各自显式确认退出码 0）。
- 清旧部署（杀进程树、4310/4311/4313/17674 无监听残留）→ 重部署 → health 全 200 → KB 列表/引擎状态无损（Ebola GP Smoke converged=true 仍在）。

## 复验建议

按任务书：阶段 I 复验仅重跑 journey-ke 两条（J-KE1/J-KE2）即可关闭 mocked 拍。若面板在 data5 栈 480s 内展示 10 篇文档与实体，即修复生效；若出现 `ke-transient-issue` 常驻不消失，说明有端点持续性失败（非瞬时），需另查。

## 备注

- 提交仅含 KnowledgeEnginePage.tsx；qa/ 域文件未动。
- 顺带发现的部署坑（与本次修复无关，供环境参考）：`pkill -f <pattern>` 在 `wsl -e bash -c` 包装下会自匹配杀掉外壳（exit 15），需用 `[x]` 首字母括号写法。
