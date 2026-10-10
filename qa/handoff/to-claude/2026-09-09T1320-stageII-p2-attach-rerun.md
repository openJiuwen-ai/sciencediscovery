# 任务：阶段 II P2 — mode=on 下在线 attach 重跑导致 support 虚增（非幂等）

来源：阶段 II 门评审（ZCode review subagent，对照 DA 逐行 + 提交 7cb66fe）。

**发现（store.ts:919 attachToEntity）**：在线 attach 无条件 `support_count + 1`（仅靠 orchestrator 的 per-run `attachedThisDoc` 集合去重），随后 GREATEST 重计把虚增值保住——`ke_entity_docs` 行已存在时重跑仍 +1。而 `KE_EXTRACT_JOB` maxAttempts=2：部分实体写入后重试会重复 attach，破坏「support = 不同文档数」不变量。

**对照**：`upsertEntity` 用 `docRowInserted` 正确处理同类问题（store.ts:741-742）；DA 的 attach（attachAlias + recountSupport，DeepAnalyzet src/store/repos/subject-entity.ts:336/357）从不裸 +1。

**修复方向**：attach 路径复用 docRowInserted 语义（新文档明细行才 +1 / 或直接走重计）。

**测试缺口（一并补）**：attach 重跑幂等性用例（现有 store-resolution.test.ts:217 只测了 upsert 重跑）；顺带评审建议的 SWR 并发限速、unmerge 双折叠、L4 对抗输入属 P3 观察项可后置。

**其余评审结论**：0×P1；7×P3 已记录（resolver 注释高估 fail-open 范围、shadow 拒绝行缓存不对称、unmerge 后 canonical 文档明细漂移、unmerge 路由未按 KB 作用域、L0/L1 归一化收窄已注释、O(KB) 扫描规模预警、judge prompt 注入面）——详见阶段 II 报告。
