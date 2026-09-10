# ZCode 开发交接 — W7 后端：文档三级阅读管线（L0/L1/L2 + 锚点）

日期：2026-09-10 · 分支 feature/knowledge-engine · 作者：ZCode（新任开发主力，见 STATE.dev_mode）
背景：qa/analysis/2026-09-10-da-sd-gap-analysis.md §4 W7；业界对标见 qa/analysis/2026-09-10-industry-research.md（NotebookLM 引用芯片/Elicit 单元格证据模式）

## 已交付（本次提交）

1. **纯函数模块** `packages/knowledge-engine/src/text/levels.ts`
   - `parseDocumentBlocks(markdown)`：行式确定性解析 → 带类型块（heading/paragraph/formula/table/list/figure/reference/code），每块带 per-type 序号、最近章节、1-based lineStart、截断 preview。表格吸收 `[Label] caption` 行；References 节内 `- [rid]` 行独立成 reference 块（为 W10 citation 链预留）；pdfplumber 无标题文本退化为段落不炸。
   - `documentAnchor(docId, block)` → `{docId}:{type}:{index}`（**DA 锚点约定逐字对齐**）。
   - `buildDeterministicL0({title, abstract, blocks})`：无 LLM 的抽取式 L0——abstract 列优先 → 首个 ≥120 字符正文段 → 标题；tags=章节标题（排除 Abstract/References，≤5）；`source` 字段诚实标注来源。DA 三层契约的"summarizer 不可用时保持抽取式"原则的 SD 起步版。
   - `resolveDocumentAnchor(blocks, anchorId)`：从右侧解析 type/index（docId 含冒号也安全），命中返回块+前后邻块。
   - 导出已加 `packages/knowledge-engine/src/index.ts`。

2. **API 两条新路由**（`services/api/src/knowledge-engine/routes.ts` + http/index.ts 注册）
   - `GET /api/knowledge-engine/kbs/:kbId/documents/:docId?level=L0|L1|L2`（默认 L0）：
     - L0 `{summary, tags, source, year, venue, abstract}`；L1 `{blockCount, blocks:[{anchorId,type,text,section,lineStart,preview}]}`；L2 `{fulltext}`。
     - 跨 KB 文档 id → 404 `KE_DOCUMENT_NOT_FOUND`；pending 文档（无 fulltext）L0/L1 返回空体不报错。
   - `GET /api/knowledge-engine/kbs/:kbId/documents/:docId/anchors/:anchorId` → 锚点块+context.before/after（hover 预览/阅读视图滚动高亮用）；未知锚点 404 `KE_ANCHOR_NOT_FOUND`；未解析文档 409 `KE_DOCUMENT_NOT_PARSED`。
   - 文档 rest-api.md 已双语更新。

3. **测试**：包层 122/122（+11 levels）；services/api KE 域 78/78（WSL 跑；**Windows 原生跑 routes.test 会因 SQLite 句柄 EBUSY 清理失败——历史如此，非本次引入**）。

## 数据事实（你做前端/精修时需要）

- `ke_documents.fulltext` 已存 JATS/pdfplumber 的 markdown——L1/L2 即时编译自该列，**零新存储、零迁移**。
- jats.ts 产出的 markdown 形态：`#`标题 / 段落单行 / `$$..$$` 公式 / `[Figure] caption` / `[Label] caption`+`|`表格 / References 节 `- [rid] text`。块解析已全覆盖。

## 给 Claude+K3 的精修建议（按价值排序）

1. **W7 前端阅读视图**（我下一块就做，除非用户改派）：文档点击 → L0/L1/L2 三档（LevelSwitcher 模式）→ L1 块锚点定位 → 实体证据卡 quote 命中 fulltext 时高亮跳转（NotebookLM 模式：侧栏源查看器，不离开图谱页）。i18n 键建议 `ke.doc.*`。
2. **L0 的 LLM 增强**（可选、后置）：在确定性 L0 之上加 LLM 四行摘要，**必须带 grounding 门**（数字/日期须在 L1 块中逐字可查，否则回退确定性版）——DA compiler.ts 的 assessL0Grounding 是参照。
3. **锚点→证据卡反查**：`GET /entities/:id` 的 evidence 目前只有 quote 文本；可加 `anchorId` 提示（quote 在 fulltext 中定位到块）打通"证据→原文"链。简单做法：前端拿 quote 对 L1 块做子串匹配，无需后端改动。
4. review 重点：`parseDocumentBlocks` 的行式状态机边界（未闭合 fence、label-caption 后无表格行）；`requireKbDocument` 的跨 KB 语义。

## 前端进度更新（2026-09-10 10:5x，第二笔提交）

- **`apps/web/src/knowledge-engine/KeDocumentReader.tsx`（新组件，零 W6 文件触碰）**：三级阅读器全功能——L0 摘要+标签+来源诚实标注 / L1 带锚点块+目录跳转 / L2 全文；层级偏好 localStorage（`keDocDefaultLevel`）；**highlightQuote prop → 自动切 L1 + quote 归一化子串定位块 + scrollIntoView 高亮**（NotebookLM 模式内核）；未逐字命中显示琥珀色诚实提示（`ke-doc-highlight-miss`）。testid：`ke-doc-reader/-title/-level-L0|L1|L2/-summary/-tag/-outline/-blocks/-block(data-anchor,data-type)/-highlight/-highlight-miss/-fulltext/-close`。
- **client API**：`getKeDocument(kbId,docId,level)` + `getKeDocumentAnchor(kbId,docId,anchorId)` + 全套类型（api/knowledge-engine.ts）。
- **组件文案暂为组件内双语字典**（STRINGS 常量，键名即未来 `ke.doc.*` 键）——messages.ts 在 W6 未提交清单里，动它会污染你的工作区 diff；W6 落地后迁 i18n。
- **J-KE4 journey**（test/journey-ke-document-reader.spec.ts）已写好并以 `test.fixme` 挂起（E2E-META 校验 0 错误），接线后把 fixme 改回 test 即可。**接线契约（两处，都在 KnowledgeEnginePage.tsx）**：① 文档行加 `data-testid="ke-document-<docId>"` 按钮 → setDocReader({docId}) 渲染 `<KeDocumentReader client kbId docId highlightQuote onClose>`；② 证据卡每条 quote 加 `ke-evidence-source` 按钮 → setDocReader({docId, highlightQuote: quote})。
- apps/web tsc --noEmit 全绿（含你的 W6 未提交改动——它们类型干净）。

## 下一步（ZCode 计划，可被用户改派）

W6 提交后：KnowledgeEnginePage 接线（上文契约）+ ke.doc.* i18n 迁移 + J-KE4 启用与校准 → W8 kb_search（ke_documents_fts 已有，补 chunk 化+锚点命中）→ W9 运行时反幻觉。路线图全文见差距分析 §4。
