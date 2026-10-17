# 分析一份数据

上传一个小 CSV，提出一个统计问题，批准第一次代码执行，然后在产物列表里找到图和报告。

- **用时：**约 15 分钟。任务本身通常几分钟内完成。
- **你需要：**按[快速开始](quick-start.md)配置好可用的任务模型。
- **输入：**仓库自带的合成样例 [`plant-growth.csv`](../../examples/plant-growth.csv)：三种施肥处理下的 45 株植物，记录每株每天的光照时长和干重。
- **Skill 与连接器：**不需要。任务使用托管 Python 环境，其中已有 pandas、SciPy 和 Matplotlib。
- **完成后得到：**产物列表中的 `growth-report.md` 和 `treatment-boxplot.png`。

这是学习路径的第二课，第一课是[快速开始](quick-start.md)。

## 1. 获取样例文件

如果你克隆了仓库，文件已经在 `docs/examples/plant-growth.csv`。如果你使用预编译二进制，先下载它：

```bash
curl -LO https://raw.githubusercontent.com/openJiuwen-ai/sciencediscovery/main/docs/examples/plant-growth.csv
```

这些数值是为教程生成的合成数据，说明见[样例数据说明](../../examples/README.md)。

## 2. 确认 Python 环境

打开 **系统设置 → 本地 Runner → 科学环境**，Python 基础环境应显示 **就绪**。新的数据目录会在首次启动后于后台准备这个环境；显示 **安装中** 时，先等它完成再发送任务。

## 3. 上传文件

新建一个 Project，例如 `plant-growth`，打开其中的 Session。在右侧 **工作区** 面板中，把 `plant-growth.csv` 拖到 **拖放文件** 区域，或点击该区域选择文件。页面会提示上传成功，文件出现在 **文件** 下，同时作为用户上传出现在 **产物** 中。

## 4. 发送任务

把下面的提示完整粘贴到消息框并发送：

```text
请分析已上传的文件 plant-growth.csv。它记录了三种施肥处理下 45 株植物的干重。

1. 用 pandas 读取文件，报告每种处理各有多少株植物。
2. 按处理汇总 dry_mass_g（n、均值、标准差），以表格给出。
3. 用单因素方差分析（scipy.stats.f_oneway）检验各处理的 dry_mass_g 均值是否不同，再用 Tukey HSD（scipy.stats.tukey_hsd）做两两比较。报告统计量和 p 值。
4. 画出按处理分组的 dry_mass_g 箱线图，并叠加每株植物的数据点，保存为 treatment-boxplot.png。
5. 各株植物的 light_hours 也不同。检查它在各处理之间是否均衡，并说明它能否解释处理间的差异。
6. 把表格、检验结果、图和简短的局限性说明写入 growth-report.md。
7. 把 growth-report.md 和 treatment-boxplot.png 登记为产物，并在最终回复中写出它们的文件名。

使用已经装有 pandas、SciPy 和 Matplotlib 的托管 Python 环境，所有计算都要实际运行，不要在回复中估算数字。
```

## 5. 批准第一次代码执行

在默认审批模式 **危险操作时询问** 下，第一条命令会停在 **需要权限** 卡片上，动作是 **运行本地代码**。卡片上会显示 Agent 想运行的命令。

- **仅允许一次**：只批准这一条命令，下一条仍会询问。
- **允许同类操作**：批准这一条以及之后的代码执行，分析可以不再中断地跑完。
- **拒绝**：拒绝执行，Agent 只能在不运行代码的情况下继续。

本课选择 **允许同类操作**。代码仍在沙箱中运行，只能访问工作区，也不能联网。之后可以在 **系统设置 → 权限** 中撤销这项授权，[最后一课](trace-a-result.md)会带你操作。

## 6. 你应该看到什么

不同模型写出的代码和文字不同，所以请对照下面的结果形态，而不是具体措辞或数字：

- 时间线先显示 Agent 列出并读取文件，然后是若干次代码执行。展开任意一次可以看到命令和输出。先失败一次、再修正重跑是正常现象。
- **产物** 中出现 `growth-report.md` 和 `treatment-boxplot.png`，旁边通常还有分析脚本和结果文件。
- 打开 `growth-report.md`，可以看到每组 15 株的汇总表、方差分析的统计量和 p 值、三种处理之间的两两比较、图或对图的引用，以及一段局限性说明。
- 报告会说明 `light_hours` 在各处理之间是否均衡。这份样例并不完全均衡，认真的报告会讨论它，而不是忽略它。
- 报告登记为产物约一分钟后，Reviewer 可能会自动添加一张评审卡片。它的发现是[最后一课](trace-a-result.md)的起点。

## 7. 确认结果

- [ ] 任务已结束，不再显示为运行中。
- [ ] 时间线中有你批准过的代码执行。
- [ ] 产物中有 `growth-report.md` 和 `treatment-boxplot.png`。
- [ ] 报告中的数字来自实际运行的代码，图能在预览中打开。

如果任务无法导入 pandas，确认 Python 环境为 **就绪**，并要求 Agent 使用托管环境。如果没有出现产物，要求它把这两个文件登记为产物。

## 下一课

保留这个 Session，后面的课程还会用到它的报告。继续学习[检索文献并写出带引用的摘要](literature-search-and-report.md)。
