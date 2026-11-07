# 配置网络代理

本操作指南说明如何在设置页注册代理，并让 LLM、Web 工具或 MCP server 继承默认值、强制直连或使用指定记录。策略解析和出站接入原理见[网络代理机制](../developer-docs/network-proxy.md)，接口字段见 [REST API 参考](../reference/rest-api.md#代理配置)。

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

1. 打开**网络与代理**，选择环境配置（默认）、指定 HTTP/SOCKS5 代理或直接连接。通常让各模块保持**继承全局默认**即可。
2. 点击底部**保存**或**保存并关闭**才生效。切换设置项保留草稿，包括未完成的代理表单；**取消并关闭**或右上角叉号丢弃未保存修改。表单内添加/更新仅暂存条目，底部保存可直接提交新表单。
3. **测试连接（不保存）**测试当前草稿到下载源的连接，不写入配置，也不代表模型认证或所有目标均可用。新条目暂存后即可测试。
4. 高级区域保留已命名代理、WebSearch/MCP 覆盖和逗号分隔的排除地址。模型注册表中已有的专属覆盖继续兼容。删除代理前需解除对它的引用。

代理摘要卡片隐藏凭据；登录后的管理员仍可编辑完整地址。认证 settings API 为编辑器提供自定义完整地址，存储保持加密，请勿分享原始响应。把记录改为 `environment` 或 `system` 会删除旧密文。

环境配置显示实际生效变量名与已配置/未配置/无效状态，凭据和查询参数脱敏。小写变量优先，包括显式空值。HTTP 使用 HTTP_PROXY，再回退 ALL_PROXY；HTTPS 使用 HTTPS_PROXY，再回退 ALL_PROXY。平台本地回环 HTTP/WebSocket 通信自动直连，不受外网代理故障影响。

## 安装、Runner 环境与失败恢复

UI 尚未启动时，在实际执行安装的终端或服务中导出 `HTTP_PROXY`、`HTTPS_PROXY`，或 `ALL_PROXY`。浏览器使用系统代理不代表终端继承了代理。构建时 micromamba 下载使用这些变量，本地 Runner 的新环境准备和安装操作使用已保存的全局路由。版本固定、SHA-256 和 TLS 校验不变。

保存不打断在途请求。另一个终端修改环境变量不能更新已有进程，需要重启相关服务。远程 Runner 环境操作同样接收全局策略；环境模式在远程解析其自身变量，不复制 API 宿主机环境。指定代理若使用 localhost，会被远程环境操作拒绝，请使用远程可达地址或远程进程的环境配置。代理凭据不写入环境产物、不注入沙箱代码。

指定代理失败不会静默回退直连。根据失败组件、阶段和底层网络错误修正配置，再重试环境准备；已验证工具与缓存继续复用，无需重装应用或清空数据。不新增外网启动预检门禁；代理配置也不会授予沙箱联网权限。

### URL 协议与认证格式

- 普通 HTTP 代理：`http://host:port`，例如 `http://proxy.example.test:8080`。
- 代理服务器端自身使用 TLS 时：`https://host:port`，例如 `https://proxy.example.test:8443`。目标网站是 HTTPS 并不表示代理 URL 必须使用 `https://`。
- SOCKS5 代理：`socks5://host:port`，例如 `socks5://proxy.example.test:1080`。项目当前使用的 Undici 8.9 对 SOCKS5 的支持是实验性的；不承诺 `socks5h://` 或其他未验证协议。
- 用户名/密码认证：`scheme://username:password@host:port`。

用户名或密码包含 `@`、`:`、`/`、`#`、`%`、空格等 URL 保留字符时，必须先进行 percent-encode。例如用户名 `research@team`、密码 `p@ss:word` 可以写成：

```text
http://research%40team:p%40ss%3Aword@proxy.example.test:8080
```

上例仅为合成格式示例。不要在文档、命令历史、日志或截图中记录真实凭据。
