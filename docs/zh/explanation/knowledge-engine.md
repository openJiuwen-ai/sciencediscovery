# 知识引擎：学科知识图谱与增长闭环

## 1. 摘要

- **知识引擎（KE）从文献构建学科知识图谱**并持续增长直至收敛：种子检索 → 下载链 → 溯源门抽取 → 实体消解 → Louvain 社区 → 带收敛信号的增长循环 → 面向 agent 的消费工具。
- **存储是自持的 SQLite 域**（`<data-dir>/knowledge-engine/knowledge-engine.sqlite`，WAL），归 `services/api/src/knowledge-engine/store.ts` 所有，遵循 RefStore 先例：自带 `ke_migrations` 版本表，绝不往 catalog store 加表。
- **纯领域逻辑在 `packages/knowledge-engine`**（零 IO：无 fs/网络/进程）：文本（trigram、余弦扫描、JATS→markdown）、抽取（溯源门、prompt）、增长（MMR/AA 选择、四收敛信号）、图谱（explore、gaps、resident summary、Louvain、roots）、消解（分层门、合并策略、批量助手）、评测 harness 核。
- **组合层在 `services/api/src/knowledge-engine`**：store、job runner（崩溃可恢复的持久队列）、连接器（arXiv / Europe PMC(+JATS) / OpenAlex / PubMed / Semantic Scholar / Unpaywall）、orchestrator（seed/ingest/extract/grow/resolution 作业）、路由、agent 工具端口、上下文 contributor。
- **agent 通过工具与上下文消费图谱**：七个 `knowledgeEngine` 工作区工具（`list_knowledge_bases`、`concept_explore`、`deep_dive`、`entity_unified_search`、`validate_entities`、`gap_candidates`、`kb_search`）、resident-summary 上下文 contributor、两个内置技能包（`knowledge-engine-explore`、`knowledge-engine-grow`）。

## 2. 数据模型

| 表 | 内容 |
| --- | --- |
| `knowledge_bases` | KB 一等实体（名称、描述、engine_state JSON） |
| `ke_documents` | 论文：身份（`dedup_key`）、元数据、全文、`source_meta` 水位（`ingested_at`、`extracted_at`、grow 渠道） |
| `ke_entities` | 实体：`(kb_id, normalized_name, type)` 唯一；表面形式别名、embedding BLOB、support_count、trust_level、first_seen_doc、community_id |
| `ke_edges` | 关系：带逐字 `evidence_quote` + `evidence_doc_id` 溯源 |
| `ke_entity_docs` | 去重文档支持度明细（合并重计的输入；support 绝不是 naive 求和） |
| `ke_entity_merges` | 消解审计：在线 attach、带全量回滚快照的批量合并、裁决拒绝、shadow 预览 |
| `ke_frontier` | 增长前沿：按周期的候选，命中矩阵 `sources`（Chao1 输入）、深度、相关度 |
| `ke_jobs` | 持久作业队列（KE 全部作业类型：seed/ingest/extract/grow/resolution） |
| `ke_settings` | 水位、graph-roots 缓存、消解开关 |
| FTS5 | `ke_entities_fts`、`ke_documents_fts`（触发器维护） |

## 3. 摄取管线

1. **种子**（`POST /kbs/:id/seed`）：源链搜索 → 文档落库 → 逐篇摄取作业。
2. **摄取**：Europe PMC 有 JATS XML 时直通（结构化、免解析）→ 否则 PDF 走下载链 → paper worker（pdfplumber）→ markdown。以 `ingested_at` 水位幂等。
3. **抽取**：单遍 LLM 实体/关系抽取（生医 schema），然后过**溯源门**——每条关系的证据 quote 必须在全文中可验证（归一化子串或 ≥85% 词重叠），否则丢弃。实体按归一化名 upsert；embedding 尽力回填。

## 4. 实体消解（W4）

通过 `SCIENCE_AGENT_KE_ENTITY_RESOLUTION` 或 ke_settings `entity_resolution_mode` 开启：`off`（默认，逐字节旧行为）/ `shadow`（只决策+审计）/ `on`（真合并）。

- **在线（写时）**：分层门 L0 精确 → L1 别名 → L2 文档内 Schwartz–Hearst 缩写对 → L3 embedding（仅 ≥0.95、同类型、非 core 目标才直合并）→ L3.5 低熵短名（≤4 字符）trigram 召回优先 → L4 预算化 LLM 裁决（遍历灰区全部邻居）。**每层 fail-open 到 "new"**；整个 decide+attach 块任何失败都回退普通 upsert。
- **离线（批量作业）**：类型 blocking → 双通道召回（trigram ∪ embedding 余弦）→ 连通分量（超大规模最弱边裁剪）→ 每分量一次 LLM 簇裁决 → 按等价类物理合并，合并率 ≥10% 时迭代。已裁决对（含拒绝）缓存，杀/续跑不重判；shadow 预览不污染缓存。
- **物理合并**在任何变更前快照回滚所需的全部状态；边重定向折叠碰撞、丢弃自环；support 经 `ke_entity_docs` 重计（GREATEST——绝不降低）。`POST /merges/:id/unmerge` 尽力回滚。

## 5. 增长闭环（W2）

`POST /kbs/:id/grow` 启动一个周期：种子水位 → 后向/前向引用扩展 → 候选排序（embedding 余弦 + 引用先验，深度相关度地板 0.55/0.65/0.75，MMR λ=0.7 + Adamic/Adar α=0.6 融合，hub 加成）→ 预算硬约束下载（doom-loop 防护）→ 四信号收敛评估（概念饱和、引用覆盖、前沿枯竭、Chao1 边界含 Lincoln–Petersen 兜底）持久化到 `engine_state`。

## 6. 社区与图谱 UI（W4）

- **确定性多层 Louvain**（无随机性；同图同划分）。
- `GET /kbs/:id/roots` 提供**指纹缓存**的 roots 视图（实体/边计数 + support 总和 + 最新边创建时间）。Stale-while-revalidate：指纹不匹配时立即返回缓存划分、后台重算（per-KB 去重、60 秒限速）。社区名来自一次批量 LLM 调用，失败回退代表实体名。
- 前端渐进下钻：社区气泡 → 成员 → 实体聚焦，带面包屑。

## 7. 评测

| Harness | 命令 | 模式 |
| --- | --- | --- |
| 实体消解 | `node scripts/ke-resolution-eval.mjs [--set pairs.sample\|pairs.realworld] [--trgm]` | in-process；确定性 L0–L2 基线被测试钉住（样例集 P=1.0、R=7/12；P≥0.95/R≥0.60 上线门槛针对有凭据模型的 L3/L4 全层） |
| 增长 delta-recall | `node scripts/ke-growth-eval.mjs --dataDir <dir> --kb <id> --cutoff <ISO> --query <q>...` | 实时源链 + embedding env；gap detection / recall@K / negative share |
| 发现者（诚信） | `node scripts/ke-discoverer-eval.mjs --set gap-hit` | in-process findGaps 跑内联图题集（打包基线：micro 命中 12/18） |
| 发现者（查新三态） | `node scripts/ke-discoverer-eval.mjs --set novelty-triage --answers <file> [--citation]` | 对预采集的 agent 输出判分：三态正确率 + 夸大词表 + 引用预检 + 拒答校准 |

## 8. 失败哲学

每个概率性层（embedding、LLM 抽取/裁决/命名）在运行时都是可选的：故障降级为确定性行为（消解 fail-open 到 "new"，roots 回退代表名，抽取跳过回填），绝不腐坏图谱——合并是唯一的破坏性操作，而它带全量回滚快照。
