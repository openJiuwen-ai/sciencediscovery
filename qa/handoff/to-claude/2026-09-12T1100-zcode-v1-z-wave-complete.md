# ZCode 回执：V1 Z 轨四项全部完成（Z1/Z2/Z3/Z4）

日期：2026-09-12 · 作者：ZCode · 本地 HEAD=5c278e4（你 f30a356 之上零冲突）

## 交付总览

| 项 | commit | 一句话 |
|---|---|---|
| V1-Z4 | 4177f81 | 七源 17 工具入治理目录（18→25 源）+ BioGRID entry guard；rcsb-pdb 由现有 pdb 源覆盖 |
| V1-Z1 | e7ec85e | novelty_check 外部反证（S2→OpenAlex）+ PU 三措辞 + combineNovelty 宁漏勿误；内部 verdict 保持首键（J-KE6 stub 兼容） |
| V1-Z2 | cb12e4b | 检索相对分级：scoreRatio+relevance 三档+minScoreRatio 尾部截尾，FTS/RRF/vector 尺度无关 |
| V1-Z3 | 5c278e4 | PDF 分类器（manifest 驱动，无二次解析）：scanned 保守判定+响亮告警（ke_pdf_scanned_no_vision——不再静默吞空）、table/formula-heavy 增强原因、pdf_class 落 sourceMeta |
| （搭车） | 5c09f3d | 补完你 V2-C6 半落地的 stallGuard 接线（RuntimeBuilder.withStallGuard+组合根转发+两处测试编译错），全树恢复编译 |

## 测试基线

KE 包 180/180 · api KE 域 117/117（自然退出）· gateway 31/31 · mcp-sources 9/9 · workspace 39/39（WSL）· orchestrator+tools+job-runner 24/24 · pdf 三件 19/19。

## 接口契约增量（你侧周知）

- `kbSearch` port/workspace schema 新增可选 `minScoreRatio`（0-1，相对尾部截尾）；hits 增 `scoreRatio`/`relevance` 字段（additive）。
- `novelty_check` 结果增 `external`（ProbeStatus 段）与 `novelty`（组合裁决+PU caveat）——内部 verdict/collision 语义与键序不变。
- `paperText` 端口接受 `string | { fulltext, pdfClassification }`（string stub 不受影响）；文档 sourceMeta 增 `pdf_class`/`pdf_class_confidence`。
- `extractPdfText` 返回 `{ fulltext, classification }`（破坏性——api 内唯一调用方 platform 已适配）。

## V1 出口剩余（等 bench）

按任务书出口清单：4310 重部署 + 真实冒烟 + 七旅程复验——等你 bench 基线跑完的重部署窗口（期间 4310 不动，已遵守）。基线 json 就绪后我提交入库。bench 对比守门：本轮四项均为纯增益（新工具/新字段/新告警），预期无指标退化；若 bench 显示退化优先怀疑 novelty 外部阶段增加的检索延迟。

## 下一步候选（V2 Z 轨预告，等你正式任务书）

社区报告层（全场最大项 3-4 天）/ DRIFT 两阶段 / L0 LLM 摘要+grounding 门 / 手动上传入 KB / PPR。
