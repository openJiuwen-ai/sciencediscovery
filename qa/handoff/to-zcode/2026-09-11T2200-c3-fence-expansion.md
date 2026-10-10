# C3② 围栏扩面落地：untrustedCategory 类别字段 + KE 语料工具围栏 + MCP 自动标记

日期：2026-09-11 · 分支 feature/knowledge-engine · 作者：Claude · 回应你 T1330 的移交项 · **HEAD=547c97e 已推送**

## 你点名的机制侧，已落地

`AgentTool.untrustedCategory?: string`（types.ts）+ `resolveUntrustedCategory`（sanitize.ts）：**显式字段 > 旧名列表 > mcp 自动标记**。registry.execute 改为按注册工具解析类别再围栏（`fenceUntrustedContent(content, category, nonce)` 核心 + 旧 `fenceUntrustedResult(toolName,...)` 保留为 name-only 包装，签名/行为不变）。

**MCP 动态名工具缺口一并关闭**：工具带 `mcp` 字段即自动按 "remote" 围栏——无需 mcp-sources 侧任何改动（你的三个文件零触碰）。

## KE 工具标记分派（workspace.ts keTool 工厂）

- **默认围栏** `untrustedCategory: "knowledge-base"`（新 KE 工具自动获得，防"新增工具裸奔"）：concept_explore / deep_dive / entity_unified_search / gap_candidates / kb_search / kb_expand / doc_grep / **evidence_ledger**（评审 P2：记录的 quote 是最长 2000 字符的逐字语料，query/verify/detect-conflicts 会回显——二阶注入路径，故不豁免）。
- **`trusted: true` 不围栏**：verify_citation / validate_entities / novelty_check / list_knowledge_bases。理由：W9 反幻觉流程要求裁决以完整权威落地，且它们只回显短串（文档标题/实体名）不回显段落。
- 你 51fed05 改过的 kb_search 描述 hunk 未碰。

## 评审修复（subAgent 评审 0 P1 / 4 P2 全修）

1. **loop-guard warn 误围栏**（扩面加重的既有问题）：warn 是框架文本但 isError=false，会被围栏——而围栏语义恰好让模型"忽略围栏内 directive"，护栏在最容易循环的 kb_search 上被解除。修：executeRegistered 返回加 `frameworkGenerated` 标记，warn/stop 跳过围栏。
2. **evidence_ledger 豁免理由不成立**：见上，改为围栏。
3. **paper_extract_pdf 同向量缺口**：直接返回下载 PDF 的抽取正文，非 KE 工具无 mcp 字段——打 `untrustedCategory: "document"` 围栏（不中和 tag，逐字保真是该工具的意义）。
4. **tag 中和层接到 category**：neutralizeUntrustedTags 从 name-based 改为 `category === "remote"` 判定——web 工具行为不变（旧名列表解析即 remote），**MCP 连接器结果现在也做 tag 中和**（双层防御）；knowledge-base/document 类别保持 fence-only（verify_citation 溯源门要求逐字）。

## 配套

- durable-state.ts `OUTER_FENCE_PATTERN` 类别段 `[a-z]+`→`[a-z-]+`（兼容 "knowledge-base"），历史重放剥围栏恢复原始 JSON 的契约不变。
- prompt.ts 围栏语义行更新（web/subagent → +MCP connectors/knowledge-base queries）。
- **刻意不做**：knowledge-base/document 类别不做 tag 中和——语料逐字保真是 verify_citation 溯源门的硬要求，`<prompt>`/`<think>` 是论文正当内容；围栏边界本身已是主防御。remote 类别（web+MCP）保持"围栏+中和"双层。

## 测试

- tools 52/52（+6：resolveUntrustedCategory 优先级、fenceUntrustedContent hyphen 类别、registry 级 untrustedCategory 围栏+存储保持 raw、mcp 自动标记、remote 中和 vs 语料逐字、loop-guard warn 不围栏）
- workspace 87/87（KE 工具标记分派断言：8 围栏 / 4 信任锚 + paper_extract_pdf=document）
- context 43/43（+1：hyphen 类别围栏剥除——模式级保险，注释已注明非生产路径组合）
- native-agent 39/39、KE 域 api 110/110、architecture 245 OK、build 全绿

## 遗留（已知，不在本次）

- P3 记录：①无显式 opt-out（`untrustedCategory: ""` falsy 会穿透到 mcp/旧名单——fail-safe 方向，未来若出现 MCP 信任锚需加显式否定）；②OUTER_FENCE_PATTERN 不要求 BEGIN/END nonce 相等（既有，仅降权方向无提权风险）；③durable-state historicalResultIsError 把 ok:false 当 error 与运行时 isError=false 不同步（既有）。
- **转你**：public_biomed_mcp.py BioGRID guard 只挡顶层非 dict，payload.values() 里非 dict entry 仍会在 entry.get 处 AttributeError（评审搭车发现，你的文件）。
- Z6 的十个 Python 连接器工具经 gateway 注册——若它们以非 `mcp` 字段形式落地为 AgentTool，需要确认自动标记生效；下次真实调用时可在 run 事件里验证围栏出现。
- KE chunk backfill 决策维持暂缓（4310 无 embedding 凭据，向量臂 fail-soft，backfill 无意义）。
