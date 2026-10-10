# C2 finish-gate 落地 + C5 补遗两技能（idea-debate / systematic-review）

日期：2026-09-11 · 分支 feature/knowledge-engine · 作者：Claude
> 接 2026-09-11T0100 的 C2 评估结论（中期项=native-agent 循环加 beforeFinish 钩子）与 T0200 的"待 Z3 解锁两技能"。Z3 已落地（d834172），两项均完成。**HEAD=4ace227 已推送**（注意：这次推送顺带把你们本地的 5 个提交 cc98894..3d6b007 一起带上了远端——它们是我提交时的祖先）。

## 评审与修复（FIX-FIRST → 全修）

评审 verdict 是 FIX-FIRST，9 条全修：
- **P1 门在普通会话是死代码**：review_checkpoint 注册挂在 reviewer-specialist 设置（默认关）+ prompt 正则上 → 改为"reviewer-specialist 开启且请求 OR 任一激活技能声明 preFinishAudit"即注册（runs/index.ts）。这是本波次最重要的修复。
- **P1 旅程不可能绿**：修复上述注册门后 J-FG1 原样成立，无需 prompt 规避。
- **P2 时间线断言打在不渲染的 chrome 上**：review_checkpoint 无 artifact 关联时渲染 null → 旅程改断言持久化 run 事件流（tool.started review_checkpoint + finish_gate continue）。
- **P2 finish_gate 事件不可见**：三层管道补齐（runtime RunEvent → AgentEvent → RunStreamEvent `finish_gate`），versioning 的事件缓冲区从 beforeTurn 清空改为 afterTurn 刷入段落后清空（门事件不再被丢弃）。**UI 侧 timeline 目前忽略 finish_gate 类型（安全）——timeline 展示徽章留给你们 Z4 域**。
- **P2 capped continue 误标 finish**：新增 denied 动作。
- **P3 once-per-session 扫描**：改为只扫当前 run 段（最后一个真实 user 消息之后），新任务重新触发审计。
- **P3**：judge 未闭合 think 块剥除；四个 C5 技能 1.0.0→1.1.0（内容变了按惯例 bump）；旅程 stub SSE 字段 finish_reason。

## C2 finish-gate（已完成）

**机制**：TurnLifecycle 新增可选 `beforeFinish`（packages/runtime-core/src/runtime.ts）——模型返回无工具调用的回合（= 即将收尾）时触发，返回 `continue` 则注入一条 user 消息 directive 让循环再走一轮；返回 undefined/finish 则正常完成。硬性上界双保险：单次运行 `MAX_FINISH_GATE_CONTINUATIONS=2` + 继续仍消耗 maxModelTurns 预算。收尾轮先过 afterTurn 持久边界再触发门（门故障不丢轨迹）。新事件 `finish_gate {action, turn}` 进 RunEvent 联合（versioning 的 event 流自动记录）。

**策略**（services/api/src/native-agent/finish-gate.ts，`FinishGateLifecycle` 装饰器，包住 versionRecorder）：
- 触发条件三与门：run 携带声明了 `metadata.pre-finish-audit: "true"` 的技能 AND 本 run 工具注册表有 review_checkpoint AND **当前 run 段内**尚无 review_checkpoint 工具结果（段=最后一个真实 user 消息之后；恢复的旧 run 不重触发，新任务会重新触发）。
- 每 run 最多注入一次。directive 要求：对照完整轨迹自审（每条事实陈述溯源/未决问题显式披露/预算限制披露）→ 调 review_checkpoint → 再给最终答案。
- 与 DA 的差异（刻意）：DA 用独立 audit 子代理+分数线；SD 把审计留在**同 run**——模型对自己的完整轨迹自审，规避 DA 轨迹截断导致审计恰好失明于尾部工具调用的教训。

**声明链路**：SKILL.md `metadata.pre-finish-audit: "true"` → skills.ts `resolve()` 读保留 frontmatter → RuntimeSkillSnapshot.preFinishAudit → runs/index.ts 透传 RuntimeSkill + 注册 review_checkpoint → native-agent 组合点。已声明的技能：hypothesis-tournament / tree-search / virtual-lab / robin-chain / idea-debate / systematic-review。

## C5 补遗（Z3 解锁后落地）

- `skills/idea-debate/SKILL.md`：gap_candidates（SD 已有同名工具）三类确定性候选 → 5 视角 task 子代理辩论（替代 workflow_run council）→ tournament_rank Elo（六维评分逐字保留）→ 三段式产出。PU 原则/两段反证回路/外部证据标注纪律全保留。
- `skills/systematic-review/SKILL.md`：计划清单+research_state → 广度 kb_search/concept_explore → 深度 kb_expand/doc_grep + **引用链走 entity_unified_search 的 citations 段（Z3 激活）+ verify_citation**（替代 DA 的 run_sql citation_contexts 查询——SD 无 run_sql）→ quote-first 归因 + 逐 claim 溯源契约（挂接 C6 citation-eval 三指标）。
- 两技能均声明 pre-finish-audit，已注册 BUNDLED_SKILL_IDS + BUILT_IN_VERSIONS（1.0.0）。

## 测试与 E2E

- runtime-core 20/20（+5：continue 注入+事件序/双重上限帽/工具调用中不触发/门抛错先提交轨迹/denied 事件钉住）
- finish-gate 7/7（含 run 段边界两条）、skills 19/19、native-agent+versioning 32/32、workspace 87/87、context 42/42、tools 46/46、server subagent 过滤 17/17；architecture 245 文件 OK
- **J-FG1 旅程绿**（test/journey-finish-gate.spec.ts，我方独立 4490 栈，已拆除）：收尾尝试 → 指令注入（stub 请求体断言）→ review_checkpoint → 最终答案 + 事件流双断言
- dev 栈 4310 已用最新构建重部署（数据完好：Ebola KB 118 实体、minimax 配置在、22 技能含两个新技能）

## 接口契约（Z 侧如碰到请知悉）

- RunEvent 联合多了 `finish_gate` 成员——事件消费方（UI/日志投影）遇到未知 type 应忽略，若你们有 exhaustive switch 需加分支。
- TurnLifecycle.beforeFinish 为可选方法，versioning.ts 不用改。
- KE 域文件本次零触碰。

## 真实层进展（本会话并行）

- dev 栈（4310）已配 minimax-text（MiniMax-M3，openai-compatible）为全局默认模型，连通性测试 ok。
- Ebola GP Smoke KB 真实抽取跑通：10/10 文档 ke_extract succeeded，**118 实体 / 131 边**，证据逐字 quote 抽查 normalized-match 通过（PDF 换行差异，归一化后命中）。
- **agent 会话真实层 E2E 通过**：问"Ebola glycoprotein 与宿主因子的相互作用"→ 工具链 list_knowledge_bases → validate_entities ×2（正确选中 Ebola GP Smoke KB）→ deep_dive/concept_explore/entity_unified_search → run_python 写报告 → declare_artifact。最终答案 6 条相互作用全部带逐字 quote（hSP-D/ficolin-1 等）。**亮点**：agent 发现 W4 E2E fixture KB 里有 NPC1/Cathepsin B 节点但 documentsReady=0、evidenceQuote 全 null → 明确拒绝计入"有据相互作用"并说明反幻觉原则——W9 三级注入在真实层按设计生效。HITL：run_python 触发权限阻塞 → 放行后正常续跑。
- 注意：手动驱动 /messages 时 JSON body 的 Chinese prompt 要显式 UTF-8（Windows console 会写 GBK 进 .mjs 字面量 → 乱码 prompt，agent 靠英文关键词自愈了）。
- **C6 citation-eval 真实 judge 跑通**（minimax 作 judge，Ebola 真实语料）：quote 预检正确识别 normalized/missing；recall 严格判定符合预期（quote 只覆盖部分事实点时正确 NOT_ENTAILED；伪造 quote 自蕴含——正是 caveats 记录的 recall 边界，由 quote 预检兜底）。**修了一个真 bug**：runner 的 judge max_tokens=32 对推理模型必然截断（think 烧完预算，verdict 没输出）→ 改 2048 + 解析前剥 `<think>` 块（scripts/ke-citation-eval.mjs，与管线 stripThinkingProcess 同策略）。
