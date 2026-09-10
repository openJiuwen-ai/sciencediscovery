# ZCode 开发轮 W7-W9 落地交接（接线 + 文档检索工具 + 运行时反幻觉）

日期：2026-09-11 · 分支 feature/knowledge-engine · 作者：ZCode（GLM-5.3）

## 提交清单（按序，全部在本分支）

| commit | 内容 |
|---|---|
| `3bbde0c` | W7 接线：文档行/证据卡 → KeDocumentReader + ke.doc.* i18n + KaTeX + J-KE4 启用 |
| `5597cc9` | W8 尾：`kb_expand`（锚点上下文展开）+ `doc_grep`（正文正则检索） |
| `aaf7925` | J-KE5 旅程（kb_search→kb_expand 链路，stub 从请求历史解析真实锚点） |
| `4c6a1e8` | review 修复 P1/P2/P3（高亮 effect 守卫顺序、gate 对称定位、货币守卫） |
| `d51bb0d` | W9 运行时反幻觉：三级注入 + novelty_check + verify_citation + evidence_ledger + J-KE6 |
| `f3eb72a` | 修复 ke-stub 弯引号（test/ 不在 tsc 范围，曾致全部旅程无法发现） |

## 各波要点

### W7 接线（对齐 DA 三级预览）
- **入口两处**：文档列表行 `ke-document-<docId>` 按钮；实体证据卡 `ke-evidence-source` 按钮（带逐字引文跳转）。reader 覆盖主区（absolute inset 0, z30），KB 切换/关闭全量复位。
- **KaTeX**：formula 块 displayMode；段内 `$..$` 行内（守卫：边缘空白/无字母拒绝，`$5-$10` 不误渲染）；L2 全文直接走共享 MarkdownRenderer（markdown+math+表格）。CSS 已在 main.tsx 全局引入。
- **证据高亮 gate 对称**（重要设计决策）：`blockForQuote` = 逐字子串 OR ≥85% 词重叠最优块——与抽取溯源门同臂。溯源门放行的引文**必然**能定位到块；近似命中显示琥珀色提示（`ke-doc-highlight-fuzzy`）。
- **高亮 effect 是 arm-then-resolve**：reset effect（doc/kb/quote 变更）武装 pending；resolver 先判 level 切 L1（blocks 只在 L1 payload 里，顺序反了就是死路——review #1 的 P1），定位一次后消费意图，用户手动切层不回弹。

### W8 尾（kb_expand / doc_grep）
- `kb_expand(kbId, anchorId)`：docId 从锚点**右侧**解析（防 docId 含冒号）；结构化 miss（document-not-found/not-parsed/anchor-not-found），跨 KB 拒读。
- `doc_grep(kbId, pattern)`：大小写不敏感正则扫 ready 全文，行粒度（docId+1-based 行号+截断行文本）；非法正则结构化报错可重试；限 200 文档/50 命中。
- 纯层零迁移；`kbScope` 会话绑定**显式延后**（resident summary 已注入全部 KB id/name，工具要求显式 kbId 符合失败哲学；真正绑定需要 settings 层设计——留给你评估）。

### W9 反幻觉
- **三级注入**：resident-summary contributor 追加 `knowledge-engine.anti-hallucination` section——VERIFIED（指向驻留摘要，不重复）/ UNCERTAIN（contradicts+contrasts_with 开放冲突、单源实体）/ FORBIDDEN（禁止编造、未知即未知、断言前三查）。fail-soft。
- **novelty_check**：实体/关系/段落三探针纯 KB 离线；collision/partial/no-collision；no-collision 明确声明"仅指库内，非文献全局"（Robin ABCA1 教训）。
- **verify_citation**：三态（verbatim/fuzzy/not-found）+ 每文档证据列表；fuzzy 注明"是改写不是原文"。
- **evidence_ledger**：会话工作区 `.ke/evidence-ledger.json`；add/query/verify/detect-conflicts；冲突检测（同声明不同源、否定翻转）；坏文件降级空账本不崩轮次。注意：keTool 家族 isConcurrencySafe=true，同轮次并发调用有读改写竞争（单 agent 串行调用场景安全；review #2 结论待确认）。
- **finish gate 未迁**（按差距分析决策点）：依赖 SD subagent 机制（evolve vs workflow-runner 评估）——等你侧机制评估。

## 旅程与校准（重要）

- **evidence_quote 已逐字校准**：`localized on the virus spike glycoprotein leading to neutralization of viral infection`——出自第一篇种子命中 arXiv 1901.02624 的 pdfplumber 解析文本（用栈同款 paper worker 实跑解析得到）。三个旧旅程（J-KE1/2/3）+ 新旅程全部换用。
- **该 quote 会在两篇文档过门**：1901.02624 逐字 + 2003.08447 走 85% 词重叠臂 → 两条边、`.first()` 随机取——因 gate 对称设计两卡都能高亮，J-KE4 强断言稳定。
- **stub 革新**（J-KE5/6）：从请求体解析工具结果（runtime 发完整消息历史）——turn3 取**真实 anchorId** 再 expand；J-KE6 最终答案由解析出的 verdict/state **推导**（collision+verbatim 被种子图确定性强制），断言的是真依赖不是罐头文本。
- J-KE4 的节点点击走 `window.__keGraphCy` 钩子（W6 先例），roots 视图先兜底下钻。

## 给 Claude+K3 的精细化建议

1. **LLM L0**（当前 L0 是确定性抽取式摘要）：加 grounding 门（LLM 摘要的每句须被原文覆盖）后才可替换，失败回退确定性。
2. **锚点→证据卡反查**：实体详情卡的 quote 反查锚点（当前用词重叠定位；W10 citation 链落地后可升级为显式锚点存储）。
3. **evidence_ledger 并发**：若多工具同轮并发调用，考虑写锁或 append-only。
4. **kbScope**：runtime-settings 层加 kbId 覆盖 + UI 绑定芯片；注入"本会话绑定 KB X"。
5. **novelty_check 外部探针**：S2→OpenAlex 降级链（连接器已有，走 orchestrator 离线任务而非 agent 同步调用）。
6. **finish gate**：subagent 机制评估后以审计技能拦截 pre-finish 消息（evidence_ledger 为其数据源）。

## E2E 终局：六条全绿（2026-09-11 05:3x）

J-KE1 1.9m ✓ / J-KE2 58s ✓ / J-KE3-J-KE6 ✓（4.0m）。第五-六轮共修六个问题，其中三个值得你关注：

1. **产品 P2（已修 c5c2ab9）**：点击已激活 KB 行会清空全部 per-KB 状态，而轮询链只在 activeKbId 变化时重臂、无活跃任务时已死——面板永久空白（API 数据完好）。现在同库重点击=手动刷新。**同类隐患**：任何"清空后依赖轮询链恢复"的路径，只要链已死就会永久空白——建议审一遍 KE 页所有清空点。
2. **产品改进项（未修，留给你）**：页面开机拉一次 /api/models，之后不刷新；通过 API/其他端注册的模型对长活页面不可见（设置页内注册会就地更新）。建议 picker 打开时或定期 refetch。
3. **产品改进项（未修）**：离线部署上 runner 科学环境 provisioner 不可用 → 工作台周期轮询 /api/environments 恒 503（console 噪音）。建议未配置时静默降级（或 200 空列表）。

另：reader 高亮定位加了 60% 词重叠兜底档（61fc4bc）——溯源门按全文比对，pdfplumber 分页可能把引文的词拆进两个块（观测于 arXiv 2003.08447），单块 85% 不达但门已放行；兜底取最高重叠块并显示"近似命中"提示，保证门放行的引文必落块。

## 验证状态（更新）

- 单测：KE 包 134/134、workspace 67/67、api KE 域 84/84 + tools/contributor 12/12、apps/web tsc 0、architecture 232 文件 OK、api 全套（最终回归见 STATE）。
- E2E：六条 KE 旅程全绿（第 5-6 轮；历轮失败根因与修复清单见 STATE.e2e_mocked）。
- MCP 视觉验收（Windows Edge 实访 4390）：图谱 → 节点证据卡（校准 quote）→ 查看原文 → L1 自动切换+逐字高亮 → L0/L2 全部通过。
- 两轮 subAgent review 的 P1/P2 全部修复（详见 STATE dev_round_status.commits）。

## 给 review #2 结论的补充（重要更正）

review #2 判 NO-GO 的 P1-1（弯引号）在我提交 review 前 4 小时已由 f3eb72a 修复（review 基于 d51bb0d 快照）；P1-2（stub 匹配不到转义 JSON）为真问题，e1dd935 已修（JSON.parse 后在解码消息内容上匹配）。P2 三项（ReDoS 扫描预算、ledger 并发独占+原子写、50→200 文档上限+诚实 note）同笔修复。P3 七项全部处理。

## 协作提示

- 我注意到你在同分支并行提交（bacb3bd/0a45001）——无冲突，分文件纪律保持良好。
- **~/sciencediscovery（WSL 侧）我会避开**：E2E 已改走我的私有检出场 ~/sd-e2e-checkout。你若重启 4390 隔离栈会打断我的旅程，2026-09-11 上午请勿动 4390/4391 和 ~/sd-e2e-mocked-data6。
- evidence_ledger 现为独占工具（isConcurrencySafe=false）+原子写——若你做工具调度相关改动请注意这个例外。
