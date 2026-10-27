# 通过 MCP 连接领域数据库

[English](../../en/advanced-setup/domain-databases.md)

ScienceDiscovery 内置 GEO、ChEMBL、ClinVar、RCSB PDB 和 AlphaFold DB 连接器，获取表达数据、分子活性、变异提交记录与蛋白结构。它们独立于文献库，由随产品提供的 `biomed` MCP 服务器调用官方 HTTPS 接口。公共查询无需数据库 API Key；后端需要访问 `config/external-urls.json` 中对应的提供方域名。

## 配置与检查

1. 正常启动产品，在系统设置的插件管理中保留并启用所需连接器。
2. 在目标 Session 选择对应连接器，或继承 Project/全局选择。仅启用插件不会自动为 Agent 选中数据源。
3. 打开“系统设置 → MCP 服务器 → 内置数据源”，展开数据库并进入 **MCP Inspector**。选择工具，填写 JSON 参数。调用需要 Session，以便记录审计链路。
4. 查看原始返回、标准化结果和审计 ID。Inspector 手动执行只授权当前调用，不修改 Session 的 Agent 连接器选择。
5. 让 Agent 使用选中的数据库，并引用返回的记录编号；实际下载任务完成后，再让分析工具读取文件。

接入外部服务器见[自定义 MCP 配置](configure-custom-mcp.md)。通用自定义 MCP 会保留原始或结构化返回，任意服务器连接成功后不会自动形成内置数据库的标准证据记录。

## 可复用的调用示例

Inspector 显示服务器端工具名，例如 `geo_get_samples`；Agent 工具名为 `mcp__<source>__<tool>`。

| 数据源 | 工具与 JSON 参数 | 返回及后续步骤 |
|---|---|---|
| GEO | `geo_lookup_accession`：`{"accession":"GSE1000"}` | 研究及样本/平台引用；也支持单独查询 GSM、GPL。 |
| GEO | `geo_get_samples`：`{"accession":"GSE1000","limit":5,"offset":0}` | 样本条件、物种、处理流程与平台注释；按 `data.pagination.nextOffset` 翻页。 |
| GEO | `geo_list_files`：`{"accession":"GSE1000","limit":25,"offset":0}` | 从实际目录发现 matrix、SOFT 和补充文件。 |
| GEO | `geo_prepare_dataset_download`：`{"accession":"GSE1000","format":"series-matrix"}` | 准备唯一的实际矩阵候选；多文件时指定列表中的 `file_name`，补充文件用 `format:"supplementary"`。 |
| ChEMBL | `chembl_search_activities`：`{"target_chembl_id":"CHEMBL203","standard_type":"IC50","standard_units":"nM","standard_relation":"=","standard_value_max":100,"assay_type":"B","target_organism":"Homo sapiens","confidence_score_min":8,"limit":5,"offset":0}` | 测量值、单位、关系、文献引用与 `assay_metadata`；按返回位置继续翻页。 |
| ClinVar | `clinvar_get_assertions`：`{"accession":"VCV000014206"}` | 带版本的变异记录，保留各 SCV 提交及分类、审查状态、条件；也支持 RCV 和数字 Variation ID。 |
| PDB | `pdb_lookup_structure`：`{"pdb_id":"1CRN"}` | 实验结构条目、方法、分辨率及实体编号。 |
| PDB | `pdb_prepare_structure_download`：`{"pdb_id":"1CRN","format":"cif"}` | 准备 CIF 文件候选；提供方存在 PDB 格式时也可选择。 |
| AlphaFold DB | `alphafold_lookup_prediction`：`{"accession":"P69905"}` | 已有预测模型、版本、蛋白编号及置信度元数据。 |
| AlphaFold DB | `alphafold_prepare_prediction_download`：`{"accession":"P69905","format":"cif"}` | 准备模型文件；格式还支持 `pdb`、`plddt`、`pae`，可用 `model_id` 指定片段。 |

ChEMBL 分子、靶点和 SMILES 相似性搜索都支持 `limit`、`offset`。PDB 文本搜索支持分页，限定实验结构。GEO 研究搜索、ClinVar 变异搜索是有数量上限的发现查询，需要调整检索条件获取其他匹配结果。

## 数据解释与范围

- **GEO：** 发现 Series 归档中 `matrix`、`soft`、`suppl` 的直接文件，包括多平台矩阵，不展开外部仓库或归档内部内容。样本注释保留源字段，不自动猜测实验分组。元数据上限为 4 MB，大研究应下载 family SOFT；样本元数据仅查询当前页、不附带表达数据表，每页最多 5 个样本；文件每页最多 25 项。分析前检查维度、样本 ID、缺失值、处理流程与平台。仅数值为非负整数不足以确认原始计数；微阵列归一化强度不应作为 RNA-seq 原始计数输入 DESeq2。
- **ChEMBL：** 至少指定分子或靶点 ID。设置测量值上限时必须同时指定类型、单位和关系。置信度使用实际 assay 元数据在每个提供方页面内过滤；即使返回空页，`hasMore` 仍可能为真，应按 `nextOffset` 继续，位置按已扫描条目推进。比较活性时保留测定类型、物种、关系、单位、置信度与来源，不能将一页当作全集。
- **ClinVar：** assertion 查询保留指定的 VCV/RCV 版本，各 SCV 提交独立保留，包含冲突分类、日期、提交者与条件。`record` 和 `submission` 保存 XML 属性及重复元素。超限明确报错，不静默截断。分类是提交的证据，需要结合上下文解释。
- **PDB：** 数据代表实验测定的结构。下载的 CIF/PDB 文件含链、实体和配体细节，可供后续解析；使用前检查实验方法及可用分辨率。
- **AlphaFold DB：** 获取已有预测，明确标记 `structureType:"predicted"`，不运行新的 AlphaFold 预测或 GPU 任务。模型与置信度 URL 来自官方 API，并保留版本。分别解释逐残基 pLDDT 与 PAE；置信度文件缺失时提示，指定的模型不存在时明确失败。

## 下载与来源追踪

`prepare_*` 只返回 **ArtifactCandidate**，不代表文件已下载。使用现有下载流程选择候选及工作区目标、批准计划，再等待 ArtifactJob 完成并检查校验和。大文件不应塞入模型上下文，后续工具应读取已完成的工作区产物。计算前实际解析矩阵或结构文件。

标准化记录保留数据库编号、来源 URL、查询时间，以及提供方返回的版本。下载计划关联候选、源记录与 MCP 调用，完成任务保留校验和与最终路径；分析输出应继续保留这些关联。提供方没有返回的 release 信息不会被编造。

提供方错误、文件缺失及大小限制会明确反馈；连接成功不代表所有操作和文件都可用。网络配置见[配置网络代理](configure-network-proxy.md)。
