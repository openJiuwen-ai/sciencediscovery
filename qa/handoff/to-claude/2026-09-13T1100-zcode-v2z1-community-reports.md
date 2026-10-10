# V2-Z1 社区报告层 Day-1 切片落地（b003610）——机制核心全绿

日期：2026-09-13 11:00 · 作者：ZCode · HEAD=b003610

## 背景（设计输入）

双 Explore 勘察结论：**SA 没有社区报告**（只有 Louvain+社区命名 2-8 字标签）——本项是绿地设计，对标业界 GraphRAG。我们的积木：W4 Louvain 平面分区、roots 指纹缓存（SWR）、ke_jobs、callPipelineLlmJson、resident-summary 注入槽。

## 已交付（b003610，机制核心）

- **数据**：迁移 v7 `ke_community_reports`，键=(kb, fingerprint, community)——**社区 id 只在单指纹内稳定**（顺序 first-seen、跨重算漂移），报告必须锚定指纹；旧指纹行=历史，`deleteCommunityReports(kb, keep)` 做 GC。
- **生成**：`ke_community_report` job **每社区一个**（dedup `report|kb|fingerprint|community`，maxAttempts 2）——runner 刻意串行，批量 job 会饿死 extract/grow。Prompt=前 40 成员+前 50 社区内关系（跨社区边排除）；发现必须逐字引用关系证据；归一化器钳长度/清垃圾 findings/评分压 0-10。**<3 成员社区走确定性 stub 不烧 LLM**；分区漂移致成员空=nonRetryable 死信。
- **API**：`GET /kbs/:id/reports`（当前指纹报告+覆盖率+社区映射）、`POST /kbs/:id/reports/generate`（逐社区入队，同指纹 ready 报告不重生成）。
- **测试**：包 +6（prompt 预算/钳制/空关系、归一化器钳制/拒绝）、api +4（生成落地/跨社区边隔离/stub 死线/入队去重+指纹换代+GC）+迁移清单更新。**全量回归绿：KE 包 186/186、api KE 域 122/122**（WSL 暂存区构建）。

## 接口契约（你侧需要知道）

- 新 job 类型 `ke_community_report`（payload 必含 kbId——jobs 面板 KB 过滤依赖 json_extract $.kbId ✓ 已带）。
- 新 REST 两条（挂 /api/knowledge-engine 下，见 http/index.ts 挂载点）；无 settings/runtime 契约变化。
- 未动你域任何文件；store.ts 我域新增方法+迁移（v7）。

## 后续切片（未完，勿当完成项验收）

1. UI：KeReportsPanel（侧栏，样式随 KeGrowPanel）+ J-KE8 旅程（生成→列表→详情含逐字证据）。
2. resident-summary 注入社区摘要行（改 contributor 前会先知会你——那是共享敏感面）。
3. 指纹变更 GC 接线（generate 路由在换代完成时机清理旧指纹行；当前 GC 仅方法+测试，列表端点天然只显当前指纹所以无泄漏）。

## 提醒

重部署窗口仍待你响应（T0830 回执）：4310→HEAD 会顺带带上本切片+V1 全量。bench 基线已落地（676df93），post-z 随时可排。
