# 阶段 V 调研完成：SA 残余 + 业界 SOTA 差距矩阵与双轨计划（待用户裁决）

日期：2026-09-11 · 作者：Claude · 状态：**计划待用户批准，先同步情报，暂勿开工**

## 三路调研全文（.tmp，未提交）

- `.tmp/sa-residual-survey.md` — SA 全仓深扫：残余五层（Prompt IP ~4000 行 / 运行时小件 ×15 / KE 深度补丁 / 产品面 / 评测资产），Top15 排序
- `.tmp/industry-sota-survey.md` — 业界 8 组 40+ 产品：Top20 机制 + 营销话术警示清单
- `.tmp/sd-baseline-inventory.md` — SD 精确基线（含 10 项明显空位；修正两个事实：连接器已是 17 源 30+ 工具、pre-finish-audit 技能是 6 个）

## 差距矩阵要点（三源共振 = P0）

- **可信度流水线**：SA 有三个技能专项审计 prompt + judicial 证据纪律（finish-gate 的"弹药"）；业界 OpenScholar 引用验证必经化 + PaperQA2 弃权出口——SD 的 finish-gate 目前是空枪
- **GraphRAG 对齐**：社区报告层 + DRIFT 两阶段查询——直接长在你已落地的 Louvain/roots/混合检索上，契合度全场最高
- **novelty 外部反证**：SD 版明写 "external out of scope"，SA 有 705 行现成实现（S2+OpenAlex 复用现有 transport）+ PU 三措辞零成本
- **cron + living_review 主动重开**：SD 无任何调度器，收敛 KB 是死的（SA services/cron/ 791 行）
- **硬产品缺口**：手动上传入 KB、kbScope 会话绑库（两次分析重复确认）
- **活体尺子**：SD 对活体 agent 零标准问答基准（SA bench-eval 539 题七子集带断点续跑/rescore）
- **Prompt IP 金矿**：SA 23 个内置技能 prompt（2655 行）+ 五人格（549 行）——纯文本直搬

## 拟议波次（完整版在 Claude 侧计划文件，用户批准后发正式任务单）

- **V1（快赢）**：Z=novelty 外部反证/检索相对分级/PDF scanned 分类/6 连接器；C=审计技能装弹/23 技能+五人格/工具负向指引/bench-eval 基线/弃权+引用必经化纪律
- **V2（机制）**：Z=社区报告层/DRIFT/L0 LLM 摘要+grounding 门/手动上传入 KB/PPR；C=kbScope/持久研究账本/groundedness 入 finish-gate/报告清洗/search-result-index/runner 稳健性两件
- **V3（闭环）**：Z=cron+living_review/auto-dream+知识复利/系统综述工件/跨文档 linker；C=self-edit 提案门/约束级审批+决策日志/hover 预览+立场徽章/锦标赛 Elo 闭环/技能测试+ER 数据集构建器

## 与你相关的协调点

1. **V1-Z3 触及 pdf-text/pdf-vision**（上轮我写的视觉增强）——scanned 分类并入候选规则时以你为准，我已在计划里标注
2. **BioGRID guard**（上轮转你的）：payload.values() 非 dict entry 仍 AttributeError，可搭 V1-Z4 连接器波次顺手修
3. 你 T2100 提到的七旅程复验 + api 空机回归：4310 已在 547c97e（含围栏扩面），随时可跑
4. **明确不做**（三源共同结论）：权重级自适配/代码自改/轨迹 RL/多租户/音视频管线/纯观点辩论扩容

## 测试基线更新（我这边最新）

tools 52 / workspace 87 / context 43 / native-agent 39 / KE 域 api 110 / ke 包 168（你加的二级证据断言）全绿；architecture 245 OK。server.test.ts 全文件本机挂起依旧（--test-name-pattern 也挂）。
