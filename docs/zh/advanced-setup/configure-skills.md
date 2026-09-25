# 导入与管理科研 Skill

当同一套数据检查、文献整理或交付要求反复使用时，可以把它写成 Skill。本教程以一个 CSV 质量检查技能为例，介绍本地导入、Git 导入和生效验证。它不需要新增 MCP 服务。

## 1. 准备技能包

在本机创建 `csv-quality-check/SKILL.md`，内容如下。目录名与 `name` 一致，使用小写字母和连字符，`description` 不为空。

```markdown
---
name: csv-quality-check
description: Inspect an uploaded CSV for missing values and duplicate rows, and deliver reproducible quality-check results.
---

# CSV quality check

1. Locate the user-supplied CSV and inspect its actual columns and dimensions.
2. Report missing values and duplicate rows. Do not silently delete or impute data.
3. Save the executed code and a concise result table in the workspace.
4. Register the outputs as artifacts and identify limitations in the final reply.
```

需要配套脚本和参考资料时，可以加入 `scripts/`、`references/` 等目录，并在说明中引用相对路径。导入整个目录或 ZIP 才能一并包含这些资源；单独导入 `SKILL.md` 不会带上相邻文件。技能包内不要存放令牌或私密研究数据。

## 2. 从本地或 Git 导入

打开 **系统配置 → Skills** 的技能库管理视图，在导入菜单中选择文件、文件夹或 Git：

- **本地文件**：选择 `SKILL.md` 或包含技能包的 ZIP。
- **本地文件夹**：选择技能目录，保留脚本与资料的相对路径。
- **Git**：填写 HTTPS/SSH 仓库地址，按需要指定 ref 与子目录，检查识别出的技能后导入。私有仓库的认证由后端机器上的 Git 凭据或 SSH 配置提供，不要把令牌写进 URL。

导入后打开技能，检查名称、正文和配套文件。仅把脚本放进技能包不会自动执行脚本或安装 Python/R 依赖；运行所需依赖仍由科学计算环境管理。

## 3. 确认当前后端能够使用

技能库中存在一个条目，与实际运行时启用它是两件事：

- **JiuwenSwarm 后端**：在 Skills 的 JiuwenSwarm 视图检查运行端技能与开关。ScienceDiscovery 技能会在运行前导入；这里的开关作用于所有会话，不是单个 Specialist 的白名单。运行端不可达时先恢复连接。
- **支持 Project / Session 技能选择的后端**：`all` 模式允许已安装技能，`selected` 模式需要将新技能加入生效白名单。检查会话是否覆盖了 Project 设置。

安装成功也不证明 Agent 已读取技能。新建测试会话，上传小 CSV，明确要求使用 `csv-quality-check` 完成核查；若输入框提供技能候选，可选择对应条目。检查执行记录和产物，而不只看回复中是否提到技能名称。

## 4. 修改或让 Agent 起草

在技能管理器中编辑自己的托管技能，并查看保存的版本与差异。内置技能只读；需要自己的变体时，使用独立名称导入，避免覆盖内置条目。

也可以在对话中明确请求：“请把这套 CSV 核查流程做成一个可复用技能。”Agent 生成的是待审草稿；在 Skills 中审阅文件并确认后才会安装生效。后续 Git 更新也应先查看变更，不要把导入理解为无人审核的自动更新。

- [科研 MCP 与 Skill](../core/mcp-skills.md)：随产品提供的科研能力。
- [创建 Specialist](configure-specialists.md)：将方法用于专业角色。
- [技能库设计](../developer-docs/skill-library-management.md)：包校验、版本与审核机制。
