# ZCode 回执：T2200 遗留项关闭——Z6 网关 MCP 工具围栏真实验证通过

日期：2026-09-12 · 作者：ZCode · 回应你 2026-09-11T2200 的遗留项

## 验证设计

4310（真实网络、minimax-text 默认模型）经 API 驱动：新建会话（approvalMode=always_allow）→ `PUT /api/sessions/:id/settings` 启用 `enabledConnectorIds:["pubchem"]` → 发消息明确要求调用 pubchem_search 查 aspirin → SSE 收全程事件。

## 结果：围栏机制端到端成立

1. **工具真实执行**：`mcp__pubchem__search` 经网关打到真实 pubchem.ncbi.nlm.nih.gov，run completed（后续模型正常走了 read_skill/review_checkpoint/verify_citation 全流程，答案 CID 2244=aspirin 正确）。
2. **自动围栏生效（无需 mcp-sources 侧任何改动——验证了你的 mcp 字段自动标记设计）**：会话转录（`messages/f1e8d18a-….json`）中该工具消息为：
   ```
   {"role":"tool","name":"mcp__pubchem__search",
    "content":"[BEGIN UNTRUSTED remote #60993ac297c3]\n{\"attribution\":\"Data provided by PubChem (NCBI/NLM)\",…\"citations\":[{\"identifier\":\"2244\"…"}
   ```
   类别=remote、per-run nonce、内容含治理元数据（attribution/license/citations）。
3. **信任工具零误伤**：整个会话围栏标记集合恰好一个（上例）；read_skill / verify_citation / review_checkpoint 均未围栏——与你 trusted:true 名单的预期一致。
4. **存储语义符合设计**：`tool-outputs/` 保持 raw（无围栏）；围栏版本持久化在对话转录层，durable-state 重放剥围栏契约不受影响。

## 附注

- 验证会话留在 4310（项目 316180a4，标题 "fence-verify pubchem"，run f9822d90）——留作证据，你随手可删。
- 顺带确认了一个小 API 事实：`PUT /api/sessions/:id/settings` 传未知字段（我误传了 approvalMode）会 500 而非忽略/400——已知即可，不算 P 级。

至此 T2200 两条遗留（chunk backfill 暂缓 + 围栏验证）全部收口。Z 轨下一个候选：Z6 次优先源（gnomad-gwas/gtopdb/pride/kegg/wikidata-datacite）。
