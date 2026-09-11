# C5 完工通知 + C3 两个 KE 域机制的设计提案（交 Z 轨）

日期：2026-09-11 · 作者：Claude（K3）· HEAD=1f2ecfc（已推送）

## C5 已落地（commit 1f2ecfc）

五个 DA 方法论技能移植进 `skills/`（英文、SD frontmatter、注册 BUNDLED_SKILL_IDS+BUILT_IN_VERSIONS 1.0.0）：

| 技能 | 核心机制 | DA 源 |
|---|---|---|
| hypothesis-tournament | task 子代理多视角生成（禁自扮）→ 批评评审 → tournament_rank Elo → 进化改写 → meta-review | hypothesis-engine |
| tree-search | 树编码进 research_state（[TREE Nxx] 约定全套保留）+ 预算表 7 行 + 软分收缩 + 消融复现均值±方差 + 终局只用留出信号 | hypothesis-engine |
| evidence-notes | 证据账本纪律（已适配你 W9 的 evidence_ledger 表面：add/query/verify/detect-conflicts） | subject-knowledge |
| robin-chain | 2-4 原子棒 + outputJsonSchema 契约交接 + 单棒失败隔离 | agent-patterns |
| virtual-lab | PI 主持 + 常设 Critic 逐条回应表 + 语义收敛信号 + 交叉质询轮 | agent-patterns |

**适配映射**（DA→SD）：workflow_run council → task 子代理同轮并发 + 显式交叉质询轮；write_file → run_python 落盘 + declare_artifact；push_content → 最终答复分节；DA frontmatter 机制（research-state 声明/pre-finish 审计/HITL checkpoints）→ prompt 层纪律（会话式确认点 + pre-finish 自审清单 + review_checkpoint 且注明其真实范围=工件引用审查非过程审计）。
**评审**：0 P1（幽灵工具零残留、核心纪律全保真），2 P2 + 4 P3 措辞/机制偏差已修。
**验证**：skills.test 18/18（注册表覆盖+frontmatter 校验自动覆盖新技能）、全量 build + architecture:check 绿。
**延后**：idea-debate / systematic-review 两个技能等你的 Z3（citation 链 + formulae 端点）落地后再移植（idea-debate 引用 formulae 端点、systematic-review 的引用链追踪阶段需要 citation_contexts 查询面）。

## C3 设计提案（KE 域，建议 Z 轨实施；OpenDDE-Harness 移植）

### ① 提案-校验写入门（typed proposal contract）

OpenDDE 原则：LLM 输出永远是"提案"，执行器做确定性硬校验，失败**保留为证据**而非只丢日志。SD 现状对照：抽取写入门已有溯源门（逐字/85% 词覆盖）——这是内容级校验；**缺的是结构级校验与失败证据化**：

- 抽取 LLM 输出：JSON schema 校验（实体/关系字段完整性、类型枚举、quote 长度上限）+ 失败样本落 `ke_jobs` 错误详情或专门的 rejected 记录（含原始输出截断+失败原因）——供后续质量分析，而非静默丢弃
- grow 的实体补丁查询扩展 / roots 的社区命名：同理过确定性校验（查询词长度/数量上限、命名格式）
- 实现落点建议：packages/knowledge-engine 抽取 parse 层包一层 `validateExtractionProposal`，失败进 rejected 通道。OpenDDE 另有一条值得抄：LLM 系提案**最多 3 次带纠错重试**（把校验错误反馈给模型修一次再判）

### ③ grow 周期结构化反思 → directives（增强 4 信号收敛循环）

OpenDDE 的 reflection 模式：每 N 周期产出**强结构化**反思（成功/失败 pattern 带 reusable_lesson + future_constraints、下轮带优先级建议），再压缩成 directives 注入下轮。映射到 SD grow：每个 grow cycle 结束后，基于本周期的确定性数据（frontier 各状态计数、4 信号值、来源分布、去重丢弃率）生成一份 directives 块（可纯确定性模板，零 LLM），注入下一周期的查询扩展 prompt——例如"上周期 X 源命中率低/某方向去重丢弃率高→本轮降低其权重"。这是低成本（模板化）的"循环驱动器"雏形，也为未来 Kosmos 式世界模型驱动循环探路。

### nonce 不可信围栏（C3②）由我在 agent 运行时侧实施中

DA/SD 大量吃网页/PDF 文本；OpenDDE 做法：所有不可信内容用**带随机 nonce 的边界标记**包裹（`[BEGIN UNTRUSTED web #a1b2…]`），注入内容无法伪造闭合标记。我正在勘察 SD 工具结果进模型上下文的注入点，落定时另发交接。

## 其他

- 你 W9 交接件的 evidence_ledger 并发问题已解：`isConcurrencySafe` 非 true → registry 标 exclusive → tool-scheduler 串行执行。ledger 如需同等保证改一行 flag 即可（我的 research_state 已用此机制）。
- C4 评估文档（锦标赛+树搜索承载）用户已裁决 **A 路线**（技能+task 编排先行，evolve 引擎化后置）；C5 即按此落地。

## 追加（2026-09-11 03:0x）：C3② nonce 围栏已落地（commit 78684ed）

- `packages/tools/src/sanitize.ts`：UNTRUSTED_FENCED_TOOL_NAMES = 远程内容四工具 + **task**（子代理回流此前完全无消毒——勘察确认的洞）；`fenceUntrustedResult` 用每 run 随机 nonce（12 hex）包裹 `[BEGIN UNTRUSTED <category> #nonce]`；围栏形态的内部伪造文本中和（**80 字符有界**——防流浪开标记吞噬远处正文，评审实测抓出）。
- `registry.ts`：围栏在 execute() 最后一步（recordResult/outputGuard/onResult 之后、createResultMessage 之前）——存储/观测/限幅全见原文，只有模型可见文本带标记；**错误结果不围栏**（框架生成的错误文本不该被标为不可信）。
- `durable-state.ts`：hydrate 回放时剥一层完好外围栏再 parseJson（否则历史 task 结果的围栏会让 delegation 记录退化成带标记字符串——评审 P1-3）。
- `prompt.ts`：系统提示加一行围栏语义（m8.1.7）；server.test.ts 4 处 task 结果 JSON.parse 改为剥围栏+形状断言的 helper。
- 评审 1 个砸门 P1 + 3 个修正全落地。测试：tools 46/46、context 42/42、workspace 87/87、native-agent 29/29、server.test 按 subagent 过滤 17/17（全文件本机挂=已记录的既有环境问题）。
- **已记录的后续缺口**（本提交不含）：KE 工具返回的论文逐字文本（kb_search/deep_dive 等）未围栏——被投毒 PDF 可注入；MCP 连接器工具（动态名）未围栏。两者建议按工具 category 字段而非名字清单扩面。
- dev 栈已用最新构建重部署（4310/4311/4313/17674 全绿，KE 数据完好）；隔离栈未动。

## 追加（2026-09-11 04:0x）：C6 citation-eval 已落地（commit 292eedc）

- `packages/knowledge-engine/src/eval/citation.ts`（纯模块，IO-free）：ALCE 三指标——quote 逐字预检（exact/normalized/missing/no-quote/no-source；归一化只折叠 Unicode 连字符+空白+大小写，**连字符合并不算排版差异**）/ citation_recall（全部引用段落联合蕴含）/ citation_precision（留一法冗余检测；判定失败=不冗余；单引用不进分母）。
- 与 discoverer.ts 的重复实现已去重（quote-verbatim 原语从 discoverer 导入再别名导出——注意 index.ts 的 `export *` 重名会双双静默丢弃，这是我们踩过的坑）。
- `scripts/ke-citation-eval.mjs`：judge 走 env 配置的 OpenAI 兼容端点（SCIENCE_AGENT_EVAL_JUDGE_BASE_URL/_API_KEY/_MODEL，无硬编码凭据），无 env 自动降级纯预检；报告带诚实 caveats。
- 测试 8/8 + KE 包 153/153 + 离线 runner 冒烟（编造 quote 被 missing 抓出）。
- 用途衔接：systematic-review 类技能的"逐 claim 溯源契约"（DA 技能里引用的评测器就是这个）——它落地后报告引用质量可机器评测；real 层跑一次只需配 judge env。
