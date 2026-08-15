# 配置网络代理

本操作指南说明如何在设置页注册代理，并让 LLM、Web 工具或 MCP server 继承默认值、强制直连或使用指定记录。策略解析和出站接入原理见[网络代理机制](../explanation/network-proxy.md)，接口字段见 [REST API 参考](../reference/rest-api.md#代理配置)。

## 配置模型

代理记录支持三种来源：

| 类型 | 行为 | 适用场景 |
|---|---|---|
| `custom_url` | 使用加密保存的 `http://`、`https://` 或 `socks5://` URL | 企业提供固定代理地址或带凭据 URL |
| `environment` | 读取服务进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY`（含小写形式） | 容器、systemd 或启动脚本统一注入代理 |
| `system` | 读取 GNOME `gsettings` 的手工 HTTP/HTTPS 代理 | 带桌面配置的 Linux 工作站 |

模块策略统一使用以下值：

- `inherit`：继承全局默认值；这是 LLM、Web 和未单独配置 MCP server 的默认策略。
- `none`：明确直连，并忽略进程代理环境变量。
- `proxy:<id>`：选择注册表中的一条代理。

全局默认值只能是 `none` 或 `proxy:<id>`，避免形成递归继承。仍被全局默认、模型、Web 或 MCP 引用的代理记录不能删除，必须先修改引用方。

## Web 配置

打开 **System configuration**：

1. 在 **Network proxies** 中先选择 **Global default**，再查看代理服务器列表；需要新增时点击 **Add proxy server** 展开表单。
2. 在同一页面为 WebSearch 和每个 MCP server 选择策略。多个论文源可能共享同一个 Python MCP server，因此会在一行中列出共享该 server 的来源。
3. 在 **Model registry** 中为每个模型配置 **LLM proxy**。

`custom_url` 的完整 URL 会在登录后的代理设置页面和受 Bearer 认证的代理 settings API 中明文显示，编辑时会预填现值。把记录改为 `environment` 或 `system` 会删除旧密文。

`environment` 记录显示服务进程实际解析的变量名、`configured` / `unconfigured` / `invalid` 状态与当前生效值。空字符串按未配置处理；有效 URL（包括用户名、密码、路径和 query）会在该认证设置面完整显示。无效 URL 只返回原因，不回显无效原值。该投影反映 Node 控制面进程的环境解析，由 LLM、Node fetch 与 Web 出站消费。

### URL 协议与认证格式

- 普通 HTTP 代理：`http://host:port`，例如 `http://proxy.example.test:8080`。
- 代理服务器端自身使用 TLS 时：`https://host:port`，例如 `https://proxy.example.test:8443`。目标网站是 HTTPS 并不表示代理 URL 必须使用 `https://`。
- SOCKS5 代理：`socks5://host:port`，例如 `socks5://proxy.example.test:1080`。项目当前使用的 Undici 8.7 对 SOCKS5 的支持是实验性的；不承诺 `socks5h://` 或其他未验证协议。
- 用户名/密码认证：`scheme://username:password@host:port`。

用户名或密码包含 `@`、`:`、`/`、`#`、`%`、空格等 URL 保留字符时，必须先进行 percent-encode。例如用户名 `research@team`、密码 `p@ss:word` 可以写成：

```text
http://research%40team:p%40ss%3Aword@proxy.example.test:8080
```

上例仅为合成格式示例。不要在文档、命令历史、日志或截图中记录真实凭据。
