# 使用和编写 Skill

Skill 是可复用的方法：一份说明，必要时附带脚本和参考资料，Agent 在任务需要时加载它。本课先让 Agent 使用一个内置 Skill，再把[分析一份数据](analyze-a-dataset.md)中的分析做成你自己的 Skill，并在同一份文件上运行它。

- **用时：**约 25 分钟，大部分是三次各需几分钟的运行。
- **你需要：**[分析一份数据](analyze-a-dataset.md)中的 Session，其产物中有 `growth-report.md`；以及 `plant-growth.csv`。
- **Skill：**内置的 `computation-reviewer` 和 `skill-creator`，以及你创建的 `group-comparison`。
- **完成后得到：**`computation-check.md`、一个已发布的 `group-comparison` Skill，以及它在新 Session 中生成的报告。

全部 17 个内置 Skill 及其用途，见[预置科研能力参考](../reference/builtin-research-capabilities.md#预置-skill)。

## 1. 使用内置 Skill

回到数据分析课的 Session。在消息框中输入 `/`，选择 `computation-reviewer`，让它以标签形式出现，然后发送：

```text
请对照本 Session 中记录的代码执行检查 growth-report.md。对报告表格和检验结果中的每个数字，说明它由哪一次执行产生，并列出无法追溯到任何执行的数字。不要修改报告。把检查结果写入 computation-check.md，并登记为产物。
```

你应该看到：时间线中 Agent 加载 `computation-reviewer`，读取报告，查询之前的执行及其日志，通常还会重新运行一些小检查。产物中出现 `computation-check.md`，它用表格把报告中的每个数字和产生它的执行对应起来，并列出无法匹配的数字。`growth-report.md` 本身不变。

Skill 可用并不证明模型用了它。时间线中加载该 Skill 的记录才是证据。

## 2. 用 skill-creator 创建 Skill

在同一个 Session 中，以 `/skill-creator` 开头输入消息，输入框会把它显示为 **Skill 编写** 命令。发送：

```text
/skill-creator 根据本 Session 中的分析创建一个名为 group-comparison 的 Skill。它要在上传的 CSV 中按某一列的分组比较另一列数值：报告每组的 n、均值和标准差，在托管 Python 环境中用 SciPy 做单因素方差分析和 Tukey HSD，画出叠加每个数据点的箱线图，并写出一份 Markdown 报告，与图一起登记为产物。由用户指定 CSV 文件和这两列。
```

你应该看到：Agent 加载 `skill-creator`，写出一个包含 `SKILL.md`、脚本、常常还有报告模板的软件包，并在沙箱中用 `plant-growth.csv` 测试脚本。最后它会创建一份 **待处理草稿**，此时还没有安装任何东西。

## 3. 审核并发布草稿

打开 **系统设置 → Skills**。Skill 管理器会显示 `group-comparison` 有一个待审核项；对话中也会提供跳转到这里的入口。

1. 打开草稿，阅读 **查看变更**：`SKILL.md` 中的说明、脚本以及其他文件。不同意的地方可以直接修改，这正是审核的意义。
2. **发布到** 保持为项目 Skill 库，点击 **发布 Skill**。

发布会在 Project Skills 库中生成一个不可变版本。**丢弃草稿** 则会移除这份提案。

## 4. 让 Project 使用这个库

已发布的库中 Skill 只在开启了该库的范围内进入运行。在左侧栏打开数据分析课所在 Project 的菜单，选择 **设置**，在 **Skill 库** 中开启 **Project Skills**，然后保存项目设置。

## 5. 运行你的 Skill

在这个 Project 中新建一个 Session，按[分析一份数据](analyze-a-dataset.md#3-上传文件)再次上传 `plant-growth.csv`，然后发送：

```text
用 group-comparison 分析 plant-growth.csv，比较不同 treatment 分组之间的 light_hours。
```

和之前一样批准第一次代码执行。你应该看到：时间线中 Agent 读取 `group-comparison` Skill，并在文件上运行它自带的脚本，分组列为 `treatment`，数值列为 `light_hours`。产物中出现以所比较列命名的报告、箱线图，通常还有结果文件。

## 6. 确认结果

- [ ] 第 1 步的时间线中有加载 `computation-reviewer` 的记录，`computation-check.md` 是产物。
- [ ] 草稿不再处于待处理状态，Project 的 **Skill 库** 设置中显示 **Project Skills** 及其已发布版本。
- [ ] 在新 Session 中，时间线显示读取了该 Skill 并运行了它的脚本，报告比较的是 `light_hours` 而不是 `dry_mass_g`。

如果新 Session 找不到 `group-comparison`，检查该 Project 或 Session 的设置中是否开启了 **Project Skills**。如果要导入已有的 Skill 而不是新写一个，见[导入与管理科研 Skill](../advanced-setup/configure-skills.md)。

## 下一课

继续学习[连接一个工具](connect-a-tool.md)。
