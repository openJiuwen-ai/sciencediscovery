# 连接一个工具

添加一个外部 MCP 服务器，确认它的工具有响应，为一个 Session 开启它，并在任务中使用。任何 MCP 服务器的流程都一样；本课使用一个不需要安装、账号或密钥的服务器。

- **用时：**约 15 分钟，任务本身通常几分钟内完成。
- **你需要：**可用的任务模型；运行 ScienceDiscovery 的机器能访问 `mcp.deepwiki.com`。
- **输入：**不需要文件。提示询问公开仓库 `scipy/scipy`，你在[分析一份数据](analyze-a-dataset.md)中用过其中的 `tukey_hsd`。
- **连接器：**DeepWiki，一个免费的公开 MCP 服务器，通过 Streamable HTTP 回答关于公开 GitHub 仓库的问题。
- **完成后得到：****MCP 服务器** 中的 DeepWiki 条目，以及产物中的 `tukey-hsd-notes.md`。

DeepWiki 是第三方服务：Agent 发出的问题会发送给它，它的回答是对代码的生成式摘要。不要向它发送任何私密内容。需要凭据、OAuth 或本地命令的服务器，见[配置自定义 MCP、OAuth 与 Inspector](../advanced-setup/configure-custom-mcp.md)。

## 1. 添加服务器

打开 **系统设置 → MCP 服务器 → 自定义**，选择 **添加服务器**：

| 字段 | 值 |
| --- | --- |
| 名称 | `DeepWiki` |
| 连接方式 | Streamable HTTP |
| URL | `https://mcp.deepwiki.com/mcp` |
| 认证 | 无认证 / 请求头，不添加任何请求头 |

勾选表单顶部的 **启用此 MCP 服务器**，然后点击 **保存**。新服务器在启用之前处于禁用状态。

也可以不填表单，选择 **导入 JSON** 并粘贴下面的片段；导入的服务器默认禁用，导入后在列表中启用它。

```json
{
  "mcpServers": {
    "DeepWiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp"
    }
  }
}
```

## 2. 测试连接

点击服务器名称展开详情，选择 **测试连接**。状态变为 **已连接**，并列出三个用于阅读仓库 Wiki 和就仓库提问的工具。打开某个工具可以查看它的描述和输入参数结构。

如果测试失败，先阅读错误信息：主机无法访问是运行 ScienceDiscovery 的机器的网络或代理问题，与模型无关。代理配置见[配置网络代理](../advanced-setup/configure-network-proxy.md)。

## 3. 为 Session 开启

在设置中启用服务器，并不会让每个 Session 都获得它的工具。新建一个 Project，例如 `connect-a-tool`，打开其中的 Session，在消息框下方的工具栏中打开 **数据连接器**，在 **自定义 MCP** 下开启 **DeepWiki**。

## 4. 发送任务

```text
请用 DeepWiki 连接器查看 GitHub 上的 scipy/scipy 仓库。

1. 找到 scipy.stats.tukey_hsd 的实现位置，以及它用哪种分布计算 p 值和置信区间。
2. 记录它对各组的假设，例如方差相等或样本量相等。
3. 写出 tukey-hsd-notes.md，包含简短说明、DeepWiki 报告的源文件路径，并提醒 DeepWiki 的回答是生成式摘要，需要对照代码核实。

把 tukey-hsd-notes.md 登记为产物，并在最终回复中写出文件名。
```

每个 DeepWiki 工具第一次调用时都会停在 **需要权限** 卡片上，卡片会写出工具名，例如以 `ask_question` 结尾的工具。对每个工具选择 **允许同类操作**，并批准写文件的代码执行。

## 5. 你应该看到什么

- 时间线中有对 DeepWiki 工具的调用。展开任意一次，可以看到 Agent 发出的问题和 DeepWiki 返回的回答。
- 产物中出现 `tukey-hsd-notes.md`，其中有 DeepWiki 报告的实现文件和分布、关于假设的说明，以及你要求的提醒。
- 其他 Session 不受影响：只有在那里开启 DeepWiki 后，它们才能看到它。

不同运行提出的问题和笔记措辞可能不同。重要的是回答来自连接器，并且笔记写明了来源。

## 6. 确认结果

- [ ] **MCP 服务器 → 自定义** 中 DeepWiki 显示为 **已连接**。
- [ ] 时间线中有你批准过的 DeepWiki 工具调用。
- [ ] 产物中有 `tukey-hsd-notes.md`，并写出了它依据的源文件。

要绕过 Agent 手动试用某个工具，展开服务器并打开 **MCP Inspector**；它会进行真实调用，并记录到你选择的 Session 中。见[用 Inspector 验证工具](../advanced-setup/configure-custom-mcp.md#用-inspector-验证工具)。

## 下一课

继续学习[追溯一个结果](trace-a-result.md)。
