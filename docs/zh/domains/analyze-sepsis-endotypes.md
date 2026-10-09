# 分析脓毒症分型评分的相关性与聚类

## 问题背景

不同研究会用不同的评分描述脓毒症患者的免疫状态。如果两种评分在同一批患者中一起升高、一起降低，它们可能描述了相似的变化。我们希望回答：**哪些分型评分会根据患者间的相关性聚在一起？**

本教程使用 Phylo 发布的 [BiomniBench-DA](https://huggingface.co/datasets/phylobio/BiomniBench-DA) 中的 `da-14-1` 任务，带你从上传 CSV 开始，完成数据检查、相关性分析、聚类和结果交付。目标是聚类**评分变量**，不是给患者重新分型，也不需要从原始基因表达重新计算这些评分。

教程依据仓库已有的真实 E2E 用例和留存产物编写。任务说明来自 BiomniBench（Qu 等，2026），基准材料采用 CC-BY-4.0；底层数据保留原始发布条款，请遵守数据集中的来源说明。

## 准备工作

先完成[快速开始](../getting-started/quick-start.md)，配置可用的任务模型，确认 Python 科学计算环境和沙箱可用。分析会使用 pandas、NumPy、SciPy 等库，绘图可能需要 Matplotlib；缺少依赖时，按照会话中的环境安装提示处理。这个场景不需要 GPU，科学记忆也不是必需项。

在数据集页面登录 Hugging Face 并接受访问条件，然后下载以下两个文件，保留原有目录结构：

```text
biomnibench-da/
└── da-14-1/
    ├── instruction.md
    └── environment/data/subspace_score_table.csv
```

`instruction.md` 是原始任务，CSV 是约 2.3 MB 的评分表。不要将 `tests/` 中的评分标准或参考轨迹作为任务材料上传。访问令牌只用于本机下载，不要粘贴到对话中。

为首次运行预留约一小时及模型调用预算。下面的历史示例约用了 21 分钟，但这不是耗时保证；普通会话也不会因为本文的建议自动设置一小时上限。

## 任务开始

新建 Project 和 Session，将 `subspace_score_table.csv` 上传到该会话，确认文件出现在工作区中。打开本地 `instruction.md`，将**完整原文**粘贴到消息框。不要只发送其中的研究问题：原文还规定了分析过程、代码、引用和最终答案的交付要求。

在原文后追加以下平台路径说明，再发送。这与真实 E2E 的任务构造一致，只适配文件位置和产物登记，不预先指定分析方法或答案：

```text
<platform_delivery>
The original task above defines the scientific scope and required outputs. The provided data file is in this session workspace: subspace_score_table.csv. Resolve paths using the actual workspace; /app/data in the original instruction maps to the workspace input and /app outputs map to workspace-relative outputs. Save and declare the required trace.md and answer.txt artifacts with those exact logical names.
</platform_delivery>
```

原始任务要求直接根据数据分析，禁止查找或阅读这份数据对应的来源论文、图和补充材料。一般方法和背景知识的引用不等于检索原题答案。

## 确定要求

阅读 Agent 的计划时，先确认它在回答正确的问题：

| 检查项 | 应当明确的内容 |
| --- | --- |
| 分析对象 | 比较评分列，不能把患者 ID、类别标签和所有数值型临床变量都当成分型评分 |
| 数据范围 | 实际行列数、重复患者、队列组成、缺失值，以及筛选前后的数量 |
| 方法 | 为什么选择某种相关系数、如何把相关性转换成距离、采用什么聚类方法 |
| 相关方向 | 正相关与负相关是否分开解释；取绝对值会改变问题含义 |
| 可复现性 | 在分析记录中保留真实执行的代码、参数、中间结果和选择理由 |
| 交付 | `trace.md` 记录过程，`answer.txt` 直接回答哪些评分聚在一起 |

这些内容用于帮助你理解和检查过程，不是往基准提示词里加入额外的标准答案。也不必事先指定必须得到几个簇。

## 分析过程

先观察 Agent 是否读取了真实文件并检查字段。该输入在历史运行中读出 **3,948 行、69 列**；行数不应直接理解为独立患者数，还要检查患者是否有重复记录。仅凭文件描述就宣布完成数据检查，不能代替实际读取。

随后查看评分列的选择和缺失值处理，再看相关矩阵与层次聚类。如果 Agent 生成热图或树状图，注意图中的对象应该是评分名称。负相关的评分可以表示相反方向的变化，不能因为绝对相关很高就解释成“同向变化”。

一次历史运行使用 Spearman 相关、距离 `1 − ρ` 和 average linkage，并检查了其他选择对结果的影响。这是该次分析的方法示例，不是本教程强制要求的唯一方案。

运行期间可能出现代码执行或环境安装审批，按实际操作内容处理。如果缺库、文件路径错误或计算失败，查看后续是否修正并重新执行。最后打开产物区，确认文件可预览、可下载；仅有聊天中的总结不等于文件已经交付。

## 结果分析

先读 `answer.txt`，了解结论；再打开 `trace.md`，沿着 Objective、Data Sources、Approach、Results、References 检查结论的来源。涉及筛选、聚类或统计计算的步骤应包含可复现代码，而不只是自然语言描述。图表和脚本是有用的附加材料，不能替代原题要求的两个文件。

以下是历史三次重复实验中第 3 次的留存结果，使用 DeepSeek Flash；它是模型生成的分析示例，不是官方参考答案：

| 项目 | 本次记录 |
| --- | --- |
| 分析耗时 | 约 20 分 31 秒，不含独立评分 |
| 输入与分析列 | 输入 3,948 × 69；检查了 27 个评分列，去掉一个完全反向重复列后分析 26 列 |
| 方法 | Spearman 相关、带符号距离 `1 − ρ`、average linkage，解释为三个主要组 |
| 一对同组评分 | `cano_SRSq` 与 `davenport_SRSq`，报告相关系数约 0.922 |
| 一对反向评分 | `adaptive_score` 与 `inflammopathic_score`，报告相关系数约 −0.842 |
| 交付检查 | 通过：主任务完成，最终回复引用的非空产物可以读取 |
| 独立质量评分 | 100；使用原始 rubric、本地评分适配器和 DeepSeek Flash Judge |

这个 100 分不是官方验证器的运行结果，也不是科学结论已被独立证实。仓库使用原始专家 rubric，但通过本地兼容接口调用 Judge；评分模型和适配器会影响可比性。

同组历史实验中，第 1 次交付成功但 Judge 返回不完整，第 2 次没有通过交付检查。因此，不能用第 3 次的结果宣称任务稳定必过。重新运行时应分别查看交付状态、评分状态和具体理由；评分不可用不等于零分。

## 注意事项

- **相关性不是因果关系。** 聚在一起只能说明这些评分在所分析样本中的变化有关联，不能直接推出治疗建议或临床有效性。
- **检查结构性重复。** 部分评分由其他评分代数运算得到，高相关可能来自定义本身，不能全部解释成独立生物学发现。
- **筛选会影响结果。** 全部记录、感染患者子集、每位患者仅保留一条记录可能得到不同数字。比较两次分析前，先核对样本范围和方法。
- **完成与质量分别判断。** 现有真实 E2E 要求主任务完成，并引用至少一个可读取的非空最终产物；科学正确性由原始 rubric 单独评分。缺少 `trace.md` 或 `answer.txt` 会影响评分，即使有其他产物也不能代表原题完整交付。
- **不要照抄示例数字。** 本文只帮助阅读结果，不应作为 Agent 的任务输入或评分答案。保留原始指令，依据当次数据和执行记录判断。

## 相关文档

- [快速开始](../getting-started/quick-start.md)：启动服务、配置模型和上传文件。
- [Shell、环境与工作区](../core/execution-workspaces.md)：理解执行、文件和任务状态。
- [BiomniBench-DA 真实 E2E](../../../test/benchmarks/biomnibench-da/README.md)：复现命令、输入校验与评分配置；选择 `BiomniBench-da-14-1`，需要一小时预算时设置 `E2E_BIOMNI_RUN_TIMEOUT_MS=3600000`。
- [English version](../../en/domains/analyze-sepsis-endotypes.md).
