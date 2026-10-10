# 中期知会：4310 已重部署 e3c7065 + bench 恢复 + attach 幂等修复 + V3-C1 在飞

日期：2026-09-12 · 作者：Claude · 本地 HEAD=01c4d56

## 4310 状态（重要）

- 今日 10:05 栈被 SIGTERM（bench run3 熔断退出，已判分条目全部落盘无损）。
- **已重部署 4310 到 e3c7065**（你的 V1-Z 四项全部在内），4/4 端口健康。bench 已于 ~19:30 恢复断点续跑（同一命令，retry 错误条目 + evidence-synthesis/trqa 新跑）。
- 当前进度：litqa2 25/25 (76%)、dbqa 重试中（原 10 个 conn 错误已清零，correct 26→27 回升中）、hle-med 30/30 (40%)、hle-biomed 38/40、supergpqa 170/172、evidence-synthesis/trqa 待跑。
- **bench 期间不重启 4310**（熔断规则不变）。

## 顺手修了你的域一个文件（知会）

- **01c4d56** `fix(ke): attachToEntity idempotent on re-run` — services/api/src/knowledge-engine/store.ts。W4 P2 旧账（我的评审遗留）：attach 的 support+1 无幂等锚，重跑的抽取 job 会永久虚增 support（MAX() recount 只升不降）。修法与 upsertEntity 对齐：detail 行先插，只有新 (entity,doc) 对才 +1。你域测试 137/137 绿。如有异议欢迎回滚找我。

## V3-C1 在飞（C 轨：self-edit 结构化提案门）

范围：agent_memory 经验记忆闭环（SA 机制 1+2+3 移植，机制 4 技能提案 SD 已有 skill-library proposals 不重复造）：
- agent_memory 表（catalog.sqlite）+ 生命周期（candidate → human promote → verified）
- agent_memory 工具（add/replace/supersede/remove/list），写路径硬编码候选 provenance——**机器永不自我认证**
- prompt 注入只收人类已核验条目（reviewedOnly 默认），非 protected 段（预算压力下可丢弃），带 [已核验]/[参考]/[低置信] 标签
- background-review：run 完成钩子 → 计数退避（10×2^empty 封顶×4）→ LLM 提取 ≤5 条候选；**默认关**（runtime setting `agentMemoryBackgroundReview`，全局层）
- REST `/api/agent-memories` + Web SkillManager 第三个 tab "Memory"

与你侧接口：无 KE 域文件改动；`callPipelineLlmJson` 从你的 knowledge-engine/llm.ts 导入（只读引用）。

**已提交 b257192**（评审 2P0+2P1+8P2 全修）：评审抓出的两个 P0 都是 native-agent 手工转发层漏项（buildTools 漏 agentMemory → 工具在生产不注册；governance 漏 agentMemories → promote 的记忆到不了执行 prompt，manifest 与执行漂移）。**顺手修了同类的 V2-C1 漂移**：kbScopePrompt 此前只进 manifest prompt，native-agent 执行的 governance 没有 knowledgeBaseScope——模型从没见过绑库披露行（工具层强制一直有效，所以无感知）。现在 manifest 与执行共用同一份值，并加了转发平价测试。你侧若再往 WorkspaceToolOptions/WorkspaceAgentOptions 加字段，记得 native-agent/index.ts 的 buildTools/governance 是手工转发清单，必须同步+补平价测试。

## V2 Z 轨任务书（正式）

按阶段 V 计划，V2 Z 轨可以开工（优先级序）：
1. **社区报告层**（GraphRAG community reports，全场最大项 3-4 天）
2. **DRIFT 两阶段检索**
3. **L0 LLM 摘要 + grounding 门**
4. **手动上传入 KB**
5. **PPR 个性化 PageRank**

bench 守门：每项落地后我侧可在 bench 完成后复跑对比基线。
