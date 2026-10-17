# 检索文献并写出带引用的摘要

把一个范围很窄的问题变成一份简短的证据摘要：通过内置文献连接器找到研究，提取每项研究报告的内容，得到一份参考文献可以逐条打开的报告。

- **用时：**约 15–25 分钟，大部分是任务运行时间；检索速度取决于数据源和网络。
- **你需要：**可用的任务模型；运行 ScienceDiscovery 的机器能访问 PubMed 和 Europe PMC。
- **输入：**不需要文件，问题写在提示里。
- **Skill 与连接器：**内置 Skill `literature-searcher`、`evidence-extractor` 和 `report-writer`；PubMed 与 Europe PMC 连接器。
- **完成后得到：**产物中的 `biochar-yield-summary.md`，以及它所依据的文献列表和证据表。

本课接在[分析一份数据](analyze-a-dataset.md)之后。需要一两个小时的完整综述，见[候鸟导航案例](../domains/literature-research.md)。

## 1. 开启文献连接器

新建一个 Project，例如 `biochar-evidence`，打开其中的 Session。在消息框下方的工具栏中打开 **数据连接器**，在 **数据源** 下开启 **PubMed** 和 **Europe PMC**。

新 Session 默认只开启 Web 访问，所以这一步决定了 Agent 能否查询这两个文献库。该选择只作用于当前 Session；Project 和全局默认值见[运行时行为](../reference/runtime-behavior.md#运行时设置与继承)。

## 2. 附加三个 Skill

所有内置 Skill 默认都可用。要让 Agent 明确使用本课练习的三个 Skill，在消息框中输入 `/`，选择 `literature-searcher`，再对 `evidence-extractor` 和 `report-writer` 重复一次。它们会以标签形式出现在消息框中。像下面的提示那样在文字中写出 Skill 名称，同样有效。

## 3. 发送任务

```text
请就下面的问题写一份简短、带引用的证据摘要：
向土壤中添加生物炭能否提高作物产量？这种效果是否取决于土壤 pH？

分三步完成：
1. 用 literature-searcher 在 PubMed 和 Europe PMC 中找到 6 到 10 项相关研究，优先选择荟萃分析和田间试验，并记录你运行过的检索式。
2. 用 evidence-extractor 为每项研究记录研究设计、作物、土壤 pH 范围和报告的产量效应，每一行都注明来源。
3. 用 report-writer 写出 biochar-yield-summary.md：一段话的回答、证据表、研究之间的分歧和局限性。每个事实性句子都要有行内引用，指向带 DOI 或 URL 的参考文献。

保持简短：这是证据摘要，不是完整综述。把 biochar-yield-summary.md 登记为产物，并在最终回复中写出文件名。
```

## 4. 批准连接器检索

每一类新动作都会停在 **需要权限** 卡片上。这里的卡片会写出连接器工具和检索词，例如 `mcp__pubmed__search` 加上检索内容，之后还有第一次代码执行。由于检索是并行的，可能同时出现多张卡片。**允许同类操作** 会在本 Session 剩余时间内批准同一个工具；每个连接器工具批准一次即可。

## 5. 你应该看到什么

具体的研究、数字和措辞取决于模型以及数据库当天的返回结果。请对照下面的结果形态：

- 先出现计划或待办列表，然后工作被拆成若干 **Subagent** 卡片：检索、提取和写作各一步，分别由与 Skill 同名的内置 Specialist 执行。打开卡片可以看到它自己的工具调用。
- 时间线中有对 PubMed 和 Europe PMC 的检索调用。某个检索式没有结果是正常的，Agent 通常会改写后重试。
- 中间产物，例如文献列表和证据表，然后是 `biochar-yield-summary.md`。
- 报告包含简短回答、每项研究一行的表格、关于分歧的部分、局限性，以及带编号的参考文献列表，每条都有 DOI 或 PubMed、Europe PMC 链接。
- 通常会说明部分证据只来自摘要。检索结果和摘要不是全文；摘要不应声称读过它没有获取的内容。
- 报告登记约一分钟后出现 Reviewer 卡片，常会列出尚未关联证据的论断。[最后一课](trace-a-result.md)介绍如何处理这类发现。

## 6. 确认结果

- [ ] 时间线中有你批准过的 PubMed 或 Europe PMC 检索。
- [ ] 产物中有 `biochar-yield-summary.md`。
- [ ] 证据表的每一行都写明来源，参考文献能打开到真实记录。
- [ ] 打开两三条参考文献，确认它们确实支持摘要中归于它们的说法。

最后一项最重要。格式正确的引用并不证明来源支持该句子；见 [记忆图谱与 Reviewer](../core/science-memory-reviewer.md)。

如果 Agent 报告某个连接器不可用，检查 **数据连接器** 的选择，以及运行 ScienceDiscovery 的机器的网络。无法访问的数据源是覆盖缺口，并不说明不存在相关研究。

## 下一课

继续学习[使用和编写 Skill](use-and-write-skills.md)。
