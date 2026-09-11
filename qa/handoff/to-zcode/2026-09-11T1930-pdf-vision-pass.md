# KE 摄入视觉增强（图片型 PDF）+ 真实本地 PDF 端到端验证

日期：2026-09-11 · 分支 feature/knowledge-engine · 作者：Claude · **HEAD=2c2205c 已推送**

> 用户任务：D:\data\gzlab\ktagent\ebola-pdf\ebola-pdf 下 17 篇本地 PDF（多篇重图片），优化解析管线（参考 SA 的图片增强），完整测试 解析→建库→问答。**注意：本次触碰了 KE 域文件**（pdf-text.ts/pdf-text.test.ts，用户直接指派），请知悉；orchestrator/routes/graph 等均未动。

## 动机（实测确认的问题）

cryo-ET 论文（Intracellular Ebola virus nucleocapsid assembly, 23 页）有 **5 个整页图版（10/12/14/16/18 页）pdfplumber 零文本**——图上标注的定量信息（螺旋参数 twist −30.35° / rise 7.4 Å 等）**只存在于图像中**，基线管线完全丢失。抽查 5 篇：cryo-ET 5 个零文本页；Structural-VP24 / IQGAP1 各有 5 个图块密集页（面积占比 0.27-0.64）。注意：图注文字其实在相邻文本页（pdfplumber 能抓到），视觉增强补的是**图像本身的 panel 级内容**。

## 实现（参考 SA page-visual-enhancer，适配 SD worker 契约）

- `services/paper/paper_worker.py`：pages manifest 增加 `imageAreaRatio`（图块面积/页面积）。
- `services/api/src/knowledge-engine/pdf-vision.ts`（新）：视觉客户端，双协议（openai chat-completions 带 image_url / minimax `coding_plan/vlm`，后者与 SA capability-dispatcher.ts:1226 同一契约，实测同一把 minimax key 可用）；`selectVisionCandidatePages` = needsVision OR imageAreaRatio>0.25，**cap 6 页/文档**，只吃有 previewPath 的页（worker 只渲染前 24 页预览）；60s 超时。
- `pdf-text.ts`：`extractPdfText` 加可选 `describeImage`/`onWarn`；候选页用 worker 已渲染的页预览图调视觉模型，描述以 `### Page N vision-model annotation (generated, secondary evidence — not verbatim source text)` 块插入对应页节末尾；并发 3；**单页失败只记 warning，永不让摄入失败**；无 hook 时逐字节同旧行为。
- `platform.ts`：`SCIENCE_AGENT_KE_VISION_{BASE_URL,API_KEY,PROTOCOL,MODEL}` env 接线 + **启动期校验**（协议非 minimax 且无 MODEL → 响亮告警并禁用，不静默死）。
- 文档：docs/{en,zh}/reference/configuration.md 补四个 env。

## 诚实边界（与 SA 相同的有意取舍）

视觉注释是 **VLM 生成文本**混入 fulltext——抽取溯源门对注释文本的 quote 也会 normalized-match 通过。块头标记明确了"非逐字原文"，抽取模型能看到标记；但抽取 prompt 目前没有对标记块的折价指示。**建议后续在 extraction prompt 加一行"标注块为二级证据"**（orchestrator 域，留给你们）。另： hostile figure 可经注释向抽取 LLM 注入指令——可信语料场景可接受，记录在案。

## 评审与测试

- subAgent 评审 verdict SHIP，9 findings（0 P1）；已修：启动期校验、超时 120s→60s、并发 3、previewPath 取代硬编码 24 常量、merge 只认严格递增页码标题、≤20 字符描述记 `ke_pdf_vision_page_stub` warning、worker 启发式注释、文档、无 hook 逐字节不变测试。
- 测试：pdf-text.test.ts 8/8 + pdf-vision.test.ts 5/5 + KE 域 127+/127 全绿 + worker python 2/2 + build + architecture 245 OK。

## 真实层端到端（fixture 夹持本地 PDF，隔离栈 4495）

- 夹具：`.tmp/make-local-pdf-fixtures.mjs` 把 5 篇本地 PDF 录成伪 arXiv 2609.9000x（search Atom + e-print 404×2 + pdf base64），`SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR=/home/xjtlb/ke-local-fixtures`。
- **基线 KB**（无视觉）：5/5 摄入+抽取，65 实体/97 边，quote 质量好。
- **视觉 KB**（minimax coding_plan/vlm）：5/5，67 实体/100 边；cryo-ET 5 图版页全部获得注释；IQGAP1 5 个 dense 页注释含逐字图注转写。
- **QA 决胜题**（"Fig.1 展示了什么？给出螺旋参数"）：agent 全工具链（kb_search/doc_grep/kb_expand/verify_citation×3）→ 逐字引用图注（verify_citation=verbatim）+ 报出 twist −30.35° / rise 7.4 Å **并诚实标注"数值来自图 a 上标注"**。基线 fulltext 确认无这两个数值（grep 验证）。
- **坑**：①sync-sd.sh 未排除 .venv → rsync 用 Windows 布局覆盖了 WSL 新建的 paper venv（已修，加了 --exclude .venv）；②seed dedupKey=kbId|query，同查询重播种不会重跑 ingest——测新管线要换 KB。

## 接口契约

- worker manifest pages[] 新增 `imageAreaRatio: number`（可选消费）。
- RunEvent 无变化；KE 域其余文件零改动。
