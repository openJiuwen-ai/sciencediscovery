# DA 学科知识引擎 → SD 迁移差距深度分析

日期：2026-09-10 · 作者：ZCode（QA）· 方法：双侧代码级勘察（DA 5542c831 / SD a236ace+未提交 W6）+ Claude 计划落盘与项目记忆三方交叉验证

> 用户问题："功能缺失很多，例如论文的解析、三级展示管线、构图、Agent 消费使用环节、反幻觉系统等都没有开发进去……目标是 SD 跟 DA 一样好用。"

---

## 0. 一句话结论

**五个域中四个确有实质差距，但性质各不相同**：构图域已高度对齐（~85%，算法核全部直搬）；论文解析与 Agent 消费是"骨架通、深度浅"（~30-40%）；三级展示管线是**整域缺失（0%）**；反幻觉系统是**只剩入口门、缺全链路执法（~25%）**。差距的第一根因不是执行遗漏，而是 2026-09-08 确认的"薄切片端到端打通"迁移战略——但**三级展示管线、文档检索工具、运行时反幻觉、辩论系统四块从未进入任何波次计划，属于计划盲区**（当时以 scholarly/ 图谱侧 37 文件为中心，src/wiki/ 文档编译侧被当作 DA 宿主通用能力排除在外）。要达到"跟 DA 一样好用"，需要追加约 5 个波次（W7-W11，见 §4）。

## 0.1 名词澄清：什么是"三级展示管线"

DA 的"三级"= **文档知识金字塔 L0/L1/L2**（`src/wiki/three-layer-contract.ts`）：

| 层 | 含义 | DA 实现 |
|---|---|---|
| **L0 摘要** | 四行官方契约（一句话摘要/标签/类型/日期），LLM 生成但过 grounding 门（数字日期必须来自 L1 证据，否则确定性回退） | `compiler.ts compileAbstract` |
| **L1 结构** | 解析器产出的章节/表格/公式/图片 Markdown（或 DocTags），带**稳定锚点** `{docId}:{elementType}:{index}` | `compiler.ts compileStructure` + `anchor-generator.ts` |
| **L2 原文** | 全文页 / 原始解析 JSON 投影 | `compileFulltext` |

另有两条正交的"三级"：engine-explore 技能的渐进披露梯（摘要层→邻域层→证据层→原文层）与图谱 UI 的下钻（社区→成员→实体——SD W4 已搬）。用户感知缺失的是**文档金字塔这条**。

---

## 1. 五域逐项对照

### 1.1 论文解析 —— SD ~30%，差距：解析深度与资产化

**SD 已有**（`services/api/src/knowledge-engine/`）：
- 6 连接器链 arxiv→unpaywall→europepmc→openalex→pubmed→S2（`connectors/`，SSRF 守卫+DNS 私网拒绝+每主机令牌桶限流+80MB 上限——这部分工程质量高于 DA）
- 双解析路径：EuropePMC **JATS XML→markdown**（`packages/knowledge-engine/src/text/jats.ts`，自研零依赖 XML 解析器：章节/标题/段落/公式 LaTeX `$..$`/参考文献 `[@rid]` 锚点/图注/表格）+ **PDF→pdfplumber**（`services/paper/paper_worker.py`）
- 单遍 LLM 抽取（≤30 实体/≤40 关系，中文 prompt，top-50 规范名复用）+ 确定性溯源门

**DA 有而 SD 无**（按重要性排序）：
1. **LaTeX-first arXiv 路径**：优先下 e-print tarball 而非 PDF（`eprint.ts` tar.gz 解包+\input 递归内联），公式/引用锚点逐字保真——DA 判断这是公式保真的关键路径
2. **公式提取与检索**：`formula-extractor.ts`（`$$..$$`→LaTeX+上下文+label→formulae 表→`GET /scholarly/formulae?q=` 语义检索）
3. **引用上下文三件套**：`citation-extractor.ts`（[@key]→句子+章节）+ `citation-resolver.ts`（姓+年→库内文档链接）+ `citation-intent.ts`（LLM 六标签 uses/extends/contrasts_with/baseline_for/motivated_by/mentions）——SD 的 `entity_unified_search` citations 段是**显式 error stub**（`graph/explore.ts:345-349` 注明"not ported in this wave"）
4. **深度解析管线**（`document-processors/` 33 文件）：MinerU/Docling CPU/NPU 多策略+降级链、PDF 分类器（scanned/table_heavy/formula_heavy）、大 PDF 分块并行解析、质量评分器、OCR-only 崩溃回退、解析契约门（L1/L2 字符覆盖率≥95%）
5. **手动上传**（~30 种文件类型：office/图片/音视频/tex 进 KB→自动增量构图）——SD 的 KB 只能靠连接器播种
6. Sci-Hub（opt-in 自门控）+ CORE 两连接器（SD 注明 later port）

**归因**：docling/MinerU 微服务与 SD"部署简单"战略冲突，是**用户确认的战略取舍**（迁移战略记忆决策 5："不迁 docling"）；公式/citation-intent 是 W5 通知**记录在案的延后项**；LaTeX 路径与上传入口属计划盲区。注意 SD 的 JATS 路径是 DA 没有的自研增强（DA 无 JATS 解析器），且 SD jats.ts 已产出 `[@rid]` 锚点与 LaTeX 公式文本——**引用三件套和公式提取在 SD 有现成的输入格式，移植成本远低于 DA 当初**。

### 1.2 三级展示管线 —— SD 0%，整域缺失

**SD 现状**：文档列表只有"标题+状态 glyph"（✓/✗/…）；14 条 KE API **没有任何文档详情/全文路由**；JATS→markdown 只作为抽取 haystack 存 `ke_documents`，用户不可见；无阅读视图、无锚点、无证据点击下钻。进行中的 W6（界面中文化+DA 风格）计划"不做"栏明确写着"**不做 DA 的文档管理套件（SD 文档列表已够用）**"——该判断与你的期望不符，需要纠正。

**DA**：L0/L1/L2 三层页 + `expandToLevel(pageId,"L0"|"L1"|"L2"|"raw")` + 分层检索 `searchLeveled()`（LevelSwitcher 三档 tab）+ DocumentCard 三级按钮/L1 双格式/L0 再生 + **证据链接协议**（agent 输出 `[text](da-evidence://kbId/docId?anchor=...)` → 前端严格锚点校验（"No anchor is ever invented"）→ 点击/hover 打开 workbench 预览并高亮原文位置）+ 导出（raw-json/doctags/markdown/structure-bundle）+ 质量报告 UI。

**归因**：**计划盲区**（W0-W5 围绕 scholarly 图谱侧，src/wiki/ 文档编译侧从未入计划）+ W6 范围判断失误。这是用户观感"缺很多"的最大单一来源。

### 1.3 构图 —— SD ~85%，核心已对齐

**SD 已有（直搬质量高，逐行对照过）**：实体/边模型（逐字 evidence_quote+doc_id、support=distinct-doc、trust_level）、确定性 Louvain+roots 指纹缓存+SWR+批量 LLM 命名、在线消解 L0→L4（精确/别名/Schwartz-Hearst 缩写/embedding≥0.95/短名熵门/LLM 裁决，全层 fail-open）+ 离线批量（双通道召回+连通分量+簇裁决+≥10% 迭代）+ 物理合并全量快照/unmerge、gap_candidates（holes≥3 共邻/conflicts/transfers+crossCommunity）、增长闭环全量（MMR λ0.7/AA α0.6/深度地板/前向雪球/实体补丁查询/Chao1+L-P 四信号/doom-loop 防护）。

**DA 有而 SD 无**：
1. **引文关系维度**：citation_contexts 表支撑的 `GET /scholarly/citations?intent=` 查询与 entity_unified_search 的 citations 面——图上只有实体边，缺"谁引用谁、以什么意图"这第三种边
2. 公式维度（formulae 表+语义检索）
3. 手动上传→自动增量入图（DA 修复过此断链；SD 无上传入口）
4. 大图分页 API（node/:id/children 聚合分页，SD 全量下发 lean graph）
5. living review（收敛后新实体率>0.5/天+14 天窗口自动重开增长）与负种子修剪（admissionRate 回写）

**归因**：引文/公式=记录在案的延后（依赖 1.1 的三件套）；上传入口与 living review=计划盲区/低优先级。

### 1.4 Agent 消费 —— SD ~40%，图消费层对齐、文档层与高阶层缺失

**SD 已有**：6 工具（list_knowledge_bases / concept_explore / deep_dive / entity_unified_search(citations stub) / validate_entities / gap_candidates，均带逐字证据与"不猜"语义）+ resident-summary 注入（early/mid/converged 三档、≤2400 字符/KB、机器可读 JSON 切片）+ 2 skills（engine-explore/engine-grow，含反幻觉条款）。

**DA 有而 SD 无**：
1. **文档消费工具族（关键缺口）**：`kb_search`（chunk 级混合检索 RRF：向量+BM25，anchorId 命中）、`wiki_browse`（文档清单+L0 摘要）、`expand`（L0/L1/L2+锚点）、`doc_grep`（正则全文，"覆盖度最高的搜索工具"）、`reprocess_document`。**SD 的 agent 对论文文本是盲的**——只能通过图的 evidence_quote 看到只言片语，问"某方法的实验设置是什么"这类问题无工具可答
2. **确定性核验工具**：`verify_citation`（三态，S2+OpenAlex，宁漏勿误）、`novelty_check`（三态查新：KB 三探针+外部反证，阈值 claim 词覆盖 0.5/实体名覆盖 0.6）
3. **研究过程工具**：`evidence_ledger`（会话级证据账本：add/query/summary/verify/detect-conflicts，claims 三态 supported/partially_supported/refuted）、`research_state`（研究世界模型：计划/已试/已排除持久化）、`run_sql`、`push_content/push_file`（结构化卡片）、`scholar_search`、`tournament_rank`（Elo）、`workflow_run`（多 agent council）
4. **会话 KB 绑定机制**：kbScope（ScopeSelector 选库→工具硬门控 filterKbIdsToScope）——SD 靠 agent 每轮自己 list_knowledge_bases 选库
5. **技能包差距**：DA 有 systematic-review（BFRS/DFRS 两阶段+preFinishVerification 审计）、evidence-notes、idea-debate（5 视角 council+Elo 锦标赛+联网核证）、audit skills、engine-create；SD 只有 2 个基础技能
6. **证据链接渲染**：da-evidence:// 协议 + 前端锚点校验 + hover/点击下钻（依赖 1.2 三级管线）

**归因**：文档工具族=1.2/1.1 的下游；核验与研究过程工具=计划盲区（属 DA 宿主 agent 侧而非 scholarly 侧）；辩论=战略记忆明确"待议"至今未决。

### 1.5 反幻觉系统 —— SD ~25%，只剩入口门，缺全链路执法

**SD 已有（运行时）**：抽取写入门（evidence_quote 逐字或 ≥85% 词集覆盖，不过门不进图）+ validate_entities（引用前查名）+ 歧义返回候选不猜 + skills 文案（"Never invent entities"/"Cite evidence"）。
**SD 仅有评测层**：W5 移植了 DA 的评测量尺（夸大词表 23 词/引用预检 exact-normalized-missing/拒答校准）——但 `eval/discoverer.ts` **零服务引用**，聊天答案在运行时从不被扫描。

**DA 的运行时全链路（SD 全缺）**：
1. **三级反幻觉注入**（`anti-hallucination.ts`）：basic/standard/strict 按 agent 类型分层注入系统提示（搜索先行/输出前自校验/[来源:][推理:][待确认:][矛盾:] 标注纪律/禁假工具调用文本/禁心算）
2. **L0 grounding 门**：摘要数字/日期必须来自 L1 证据，违者确定性回退（extractive-only fallback）
3. **确定性核验器**：verify_citation / novelty_check / evidence_ledger verify+detect-conflicts（启发式：否定不对称/方向对撞/数值分歧）
4. **finish gate 硬执法**：技能声明 preFinishVerification → finish 时审计子代理拦截（pass/block/有界放行 max2/fail-open），audit 技能做 claim 级溯源+quote 逐字抽查（quote-mismatch=critical）
5. **锚点零捏造**：证据链接严格校验 docId:type:index
6. 评测层（citation-eval ALCE 三指标——SD W5 已搬其一部分）

**归因**：W5 搬了"尺子"没搬"执法器"。运行时系统分属 DA 宿主 agent 侧（anti-hallucination/finish-gate/evidence-ledger 都在 `src/services/agent/`），从未列入 scholarly 中心主义的迁移计划——**计划盲区**。

---

## 2. 差距根因分类汇总

| 类别 | 项目 | 处置建议 |
|---|---|---|
| **A. 战略取舍（用户已确认）** | docling/MinerU 不迁；cytoscape 不引 G6；sqlite-vec 不做 | 维持，但需替代路线（见 §4 W7 LaTeX 优先） |
| **B. 记录在案的延后** | 公式/citation-intent 抽取；Sci-Hub/CORE；novelty live 采集；convergedAt latch；rate-limit 跨周期结转 | 直接排入后续波次 |
| **C. 计划盲区（从未入计划）** | **三级展示管线（L0/L1/L2+锚点+阅读视图+证据链接）**；**文档消费工具族（kb_search/expand/doc_grep）**；**运行时反幻觉（注入/核验器/finish gate/账本）**；辩论锦标赛；手动上传入图；知识复利（agent 产出回写） | 本报告 §4 路线图主体 |
| **D. 边界判断分歧** | W6 认为"SD 文档列表已够用"（不做文档管理套件）；"先建设后消费"顺序下消费层只到图 | 需用户明示纠正/扩展目标 |

另注：DA 工作区 `agent-runner.ts:2372` 仍有未解决的 upstream merge conflict marker，DA 基线在移动中——**移植时以稳定 commit 为准并记录 DA 侧 commit hash**。

## 3. SD 反超 DA 的点（保持别丢）

- JATS XML 解析路径（DA 没有）——开放获取文献的结构化保真入口，且已产出 [@rid]/LaTeX，是补齐引用/公式三件套的现成地基
- 连接器安全工程：SSRF 守卫+DNS 私网拒绝+PDF 魔数校验（DA 后期才从 SD 借鉴"宁漏勿误"等纪律）
- 测试/部署架构：FixtureScholarlyTransport 录制回放、SQLite 单文件域、零微服务依赖
- 失败哲学文档化（W5 §8：概率层全部可选、故障降级确定性、唯一破坏性操作带快照回滚）

---

## 4. 补齐路线图建议（W7-W11，按用户价值排序）

> 原则：保持 SD 部署简单优势；每波可独立验收；QA 旅程测试先行（白盒期我就可写）。

### W7 · 文档三级管线 MVP（最高优先——"看得到"）
- `ke_documents` 已存 markdown（JATS/pdfplumber 产物）→ 补 L1 锚点生成（`{docId}:{elementType}:{index}`，纯确定性，jats.ts 章节结构现成）+ 确定性 L0（首段+标签抽取，无 LLM 也成立；LLM L0+grounding 门可后置）
- API：`GET /kbs/:id/documents/:docId?level=L0|L1|L2`（+锚点解析 `GET /anchor/:id`）
- UI：文档点击→阅读视图（L0/L1/L2 三档切换）+ 实体证据卡 quote→**点击打开原文并高亮锚点**（补 W6 明确不做的部分）
- 验收：J-KE4 旅程（种子→点开文档→三级切换→从实体证据卡跳转原文高亮）
- 工作量估：中（锚点+路由+阅读视图；无新解析器）

### W8 · Agent 文档消费工具族（"用得上"）
- `kb_search`：**FTS5 已有（ke_documents_fts）**，补 chunk 化（384 token 切分）+ 混合排序（向量已有 embedding 客户端）；锚点级命中
- `expand`/`doc_grep`（W7 锚点之上薄封装）；会话 kbScope 绑定（选库→工具门控）替代"agent 自己列库"
- 验收：J-KE5 旅程（chat 问实验细节→agent kb_search→expand→答案带文档级引用）

### W9 · 运行时反幻觉（"信得过"）
- 三级反幻觉注入（纯文本逻辑直搬，`anti-hallucination.ts` 零框架依赖）；`validate_entities` 已有
- `novelty_check`（内部三探针纯 KB 可离线；外部 S2→OpenAlex 降级链）+ `verify_citation`（三态）
- `evidence_ledger`（会话级文件账本：add/query/verify/detect-conflicts）
- finish gate（preFinishVerification 审计技能拦截）——依赖 SD 的 subagent 机制，需 Claude 先评估 SD 侧等价物
- 验收：J-KE6（夸大表述被标注/未支持数字被拒）+ 把 W5 评测器从"离线尺子"接到 CI 冒烟

### W10 · 引用链与公式（"深一层"）
- `citation-extractor`（吃 SD jats.ts 已产出的 [@rid]）→ `ke_citations` 表 → resolver（姓+年→库内 doc）→ intent 六标签（LLM 批量 fail-soft）
- 激活 `entity_unified_search` citations 段（现为 stub）+ `GET /citations?intent=`
- `formula-extractor`（`$$..$$` 正则，jats.ts 已产 LaTeX）→ formulae 表 + 语义检索
- DA 源文件直搬即可（formula-extractor.ts / citation-*.ts 均算法核）
- 验收：B7' 重种子 + 引用链抽查（protein KB 样式：intent 覆盖率/链接数）

### W11 · 高阶研究能力（"跟 DA 一样好用"的最后一里）
- 假设辩论：idea-debate 技能 + council（**前置调研：SD 的 evolve/subagent/workflow 机制能否承载 5 视角 council**——战略记忆"待议"项）+ tournament_rank Elo
- systematic-review / evidence-notes 技能包（依赖 W8/W9 工具）
- 手动上传入图（PDF 上传→pdfplumber→抽取，30 类型后置）+ 知识复利（产出回写 report 页）
- living review + 负种子修剪（增长收尾增强）
- 验收：J-KE7 辩论全旅程（council→Elo 卡片→报告落库）

### 决策点（需要用户拍板）
1. **解析深度路线**：A) LaTeX-first arXiv（纯 TS，tar.gz 解包，推荐先行，公式保真且零部署成本）；B) 可插拔重解析服务（docling/MinerU 容器化可选组件，重质量场景 opt-in）；C) 维持 pdfplumber+JATS。建议 A→B（B 作为 opt-in 不破坏默认部署）
2. **辩论系统承载**：先让 Claude 出 SD 侧机制评估（evolve 引擎 vs 新建 workflow runner）再定波次
3. **Sci-Hub**：DA 有 ALTCHA PoW 自动破解实现，法律敏感性由你定夺（默认不迁，维持 later port 记录）

## 5. 协作机制衔接

本报告可直接作为 to-claude 任务书底稿：W7/W8/W10 可立即开工（无决策依赖）；W9 的 finish-gate 与 W11 全部需先过决策点 1/2。QA 侧我可在白盒期预写 J-KE4/5/6/7 旅程骨架与锚点契约测试，沿用现有 ke-stub/fixture 体系。建议把目标从"SKE 特性端到端打通"正式改为"**SKE 与 DA 用户体验对齐**"写进下一份 DEV-BRIEF。
