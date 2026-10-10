# 业界调研：知识引擎 UX 模式 + AI Scientist SOTA（2026-09）

日期：2026-09-10 · 作者：ZCode · 方法：两路并行 web 调研代理（文献工具 UX / AI scientist 产品线），与 DA 内部 2026-09-01 landscape 研究交叉校验 · 用途：为"SD 体验对标 Science Agent + 业界 SOTA"的 W7-W11 路线图提供模式输入

---

## 1. 文献知识工具的 12 个值得采纳的 UX 模式

按采纳优先级（TS=不做会被认为不合格；DF=差异化）：

| # | 模式 | 典范 | 映射到 W7-W11 | TS/DF |
|---|---|---|---|---|
| 1 | 聊天每句声明带编号引用芯片，点击**侧栏源查看器滚动+高亮原文段落**（绝不跳走） | NotebookLM | W7 前端阅读视图+证据下钻 | **TS** |
| 2 | **声明/单元格级证据 quote**：每个抽取事实/筛选决定/图边断言点击可看支持原文 | Elicit、Scite | 已有（边级 quote）→ W7 扩展到单元格级 | **DF** |
| 3 | **Smart Citation 意图徽章**：绿/红/蓝 支持/反对/提及计数，可下钻到具体引用句 | Scite（1.6B 引用语句） | W10 citation-intent | **DF** |
| 4 | **引用位置徽章**：引用出现在引用方哪个章节（Intro/Methods/Results）；S2 的 Background/Methodology/Result 分类可作第二视角 | Scite、Semantic Scholar | W10（章节信息我们的解析器免费提供） | **DF** |
| 5 | **TLDR 无处不在 + Goal/Method/Result 标注式速读高亮**（摘要与全文之间的结构化中层） | Semantic Reader (Scim) | W7 L0 + 未来 L1 高亮 | **DF** |
| 6 | 图谱下钻惯例：节点大小=引用数、颜色=年份、簇=子主题、选中节点高亮回种子路径、时间轴滑杆 | Connected Papers、Litmaps、ResearchRabbit | W4 已有骨架 → 增强项 | **TS** |
| 7 | 每篇论文 **Similar / References / Cited-By 三键**，各开新探索标签页 | ResearchRabbit | W10 引用链落地后 | **TS** |
| 8 | **Prior Works / Derivative Works 分栏**（被引祖先 vs 引用后代两个专用视图） | Connected Papers | W10 后的图谱增强（本地可算，少有人抄） | **DF** |
| 9 | **多种子交集图 + 两论文最短路径连接器**（"X 和 Y 怎么联系起来？"） | Inciteful | 图谱增强 | **DF** |
| 10 | **共识计量条**：某实体证据集的 支持/反对/混合 分布彩条 | Consensus Meter | W10 意图 + 反幻觉呈现 | **DF** |
| 11 | **选区作用域阅读助手**（先选文本/图表再提问）+ 引用 hover 卡 + 术语点读定义 | SciSpace、Semantic Reader | W7+/W11 | **DF** |
| 12 | **透明可操纵**：排行榜附"查看生成此列表的查询"按钮、Ignore/Avoid 负反馈、语料增长监控提醒 | Inciteful SQL 按钮、Litmaps Monitor | 增长/检索层 | **DF** |

**本地可行性**：1/2/5/11 纯本地 LLM+span 偏移即可（Local Deep Research/SurfSense 已证明开源可做）；3/4 只需已摄入的全文（意图分类=本地 LLM，章节=解析器元数据）——Scite 的护城河是语料规模，**展示语言**（徽章+语句下钻+过滤）可抄；6-9 全部跑在自有引用索引上（Inciteful 小团队免费产品证明算法可行）。**无人组合"本地实体图 KB+逐字证据+社区检测+辩论排名"——SD 的生态位是开的**。

## 2. AI Scientist 产品线：2025-09 以来的新事实

**格局巨变：从 agent 演示转向出货的工作台产品**，三大厂同年收敛到 SD 的产品形态（工作台+连接器+KB+验证层）：

| 产品 | 发布 | 知识 grounding UX 签名 |
|---|---|---|
| **Kosmos**（FutureHouse→Edison Scientific 商业化） | 2025-11 | 结构化世界模型跨 run 持久；每个结论可溯源到论文段落或代码行；可分享审计报告；自曝失败模式（长 run 假显著）；$1/credit ~$200/run |
| **Gemini for Science** | 2026-05-19 I/O | 假设锦标赛（Co-Scientist）声明"深度验证+可点击引用"；Literature Insights 严格限定精选语料+结构化对比表；30+ 科学库技能；同日 Robin/Co-Sci/ERA 三篇 Nature |
| **Claude Science**（Anthropic） | 2026-06-30 | **专职评审 agent**（标记错误引用/不可追溯数字/图-代码冲突）；每个产物=代码+环境+完整消息史的可审计包；本地/HPC 数据不出域；资源访问审批门 |
| **Rosalind Workbench**（OpenAI） | 2026-08-28 | 计划先审批后执行；Explore/Research 双模式；分子查看器把"请求+模型解释+序列+3D 视图"钉在一起 |
| **Elicit Research Agent** | 2026-08-05 | 句级引用+透明方法踪迹；筛选 quote+排除理由；Projects=复利团队 KB；PRISMA 2020 可审计 |

**新基准事实**：LitQA3（LABBench2，2026-04）取代 LitQA2（榜首 ASI Literature 88.6%）；BioDecisionBench（Elicit）；OpenScholar-8B 开源参照（同行评审证明引用准确率=人类专家水平，**本地工作台的精度参照系，PaperQA2 已被其反超 5.5%**）；PaperBench 自报分数 21%→93%（未验证，慎信）。

**对 2026-09-01 内部 landscape 的修正**：①"OpenAI co-scientist 六角色 Elo"是误标——那是 Google DeepMind 的 AI co-scientist（2026-08 已毕业到实验室集成）；②PaperQA2 非 FutureHouse 前进路径；③Robin 的 Nature 论文遭遇新颖性公开质疑（ABCA1 撞车先例）——**假设生成 UX 必须带先验工作碰撞检查，不只 Elo 排名**；④市场把自主性拉回"有人类审批门的 L3+"而非全自主 L4——审批门（W11 辩论系统须配）。

## 3. 对 W7-W11 路线图的具体修订

1. **W7 前端（最优先不变）**：必须做成 NotebookLM 模式——侧栏源查看器+段落高亮，不做页面跳转；L1 块即高亮目标单元。
2. **W8 kb_search**：命中必须**锚点级**（`{docId}:{type}:{index}`），答案引用走锚点芯片——这是 TS 级模式。
3. **W10 引用链**：意图三分类至少 supporting/contrasting/mentioning（DA 六标签是其超集，保留六标签但 UI 徽章聚合为三色）；加"引用位置章节"徽章（免费元数据）。
4. **W9 反幻觉**：新增"**共识计量条**"呈现层（实体证据集的支持/反对分布）+ 参考 Claude Science 的**评审 agent 显性化**（finish-gate 审计结果以 UI 卡片呈现，不只后台拦截）。
5. **W11 辩论**：Elo 锦标赛 UI 参照 Google Hypothesis Generation 排行榜形态；**必须加先验碰撞检查步骤**（Robin 教训）；人类审批门（Rosalind 模式）。
6. **差异化主打**（对外叙事）：本地自托管 × 实体图+逐字证据+社区+辩论 的组合目前无竞品；句级引用+可审计产物是 SOTA 入场券。

来源：两份调研代理原始报告（含全部 URL）存于 ZCode 会话档案；关键源：edisonscientific.com/news/announcing-kosmos、anthropic.com/news/claude-science-ai-workbench、developers.openai.com/blog/rosalind-workbench、blog.google（Gemini for Science I/O 2026）、support.elicit.com changelog、arxiv.org/html/2604.09554v2（LABBench2）、scite.ai/badge、notebooklm 官方文档、connectedpapers.com/about、incitefulmed.com。
