# 网络代理机制

ScienceDiscovery 提供实例级代理注册表和统一代理策略。本页解释策略解析、出站接入与安全边界；具体配置步骤见[配置网络代理](../advanced-setup/configure-network-proxy.md)，接口字段见 [REST API 参考](../reference/rest-api.md#代理配置)。

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

## 出站接入机制

Node 控制面是 registry、策略和密文的事实源。调用方先通过 `SessionStore.resolveProxy(policy)` 得到不依赖存储的结果：

```ts
type ResolvedProxy =
  | { mode: "direct" }
  | { mode: "environment" }
  | { mode: "url"; url: string };
```

Node `fetch` 调用可用 `proxyDispatcher(resolved, targetUrl)` 获得按目标协议和 `NO_PROXY` 解析的 undici dispatcher；子进程可用 `proxyEnvOverlay(resolved, baseEnv)` 生成规范化代理环境覆盖。调用方只能记录 `mode` 和是否使用代理，不能记录完整 URL。

当前接入路径：

- LLM：Node 在每次 run 开始时解析模型策略，并按模型 base URL 把 environment 策略固化为最终 `url` 或 `direct`，再由 `packages/model/src/client.ts` 为该次请求固定 undici dispatcher。native run 直接调用该客户端；JiuwenSwarm 模型调用经 adapter 和 API 模型网关回到同一产品模型层。
- WebSearch/Web fetch：`WebBroker` 每次调用解析一次 Web 策略，把解析结果直接交给进程内的 provider 层，由同一套共享 dispatcher 生效。
- MCP/论文源：Node broker 按 `mcpServerId` 独立解析；内建 stdio MCP server 以进程环境覆盖连接上游。MCP 产物字节下载也复用同一 server 策略和 Node dispatcher。

新增出站路径时，应接收 `ProxyPolicy`，在最靠近请求的位置调用 `resolveProxy`，然后使用统一 dispatcher/环境覆盖；不要自行读取代理密文或复制策略解析逻辑。随包的 Python MCP server 由 Node 传入已解析的环境覆盖，不读取 Node 数据目录。

## 迁移、安全与限制

- 旧 Web `environment/custom/direct` 设置在首次加载时迁移为统一策略；旧 custom URL 会重新加密到 registry，迁移后删除旧密文记录。
- custom URL 使用与模型 token 相同的 AES-256-GCM 密钥文件保护；catalog 与数据库密文字段不保存明文。备份或迁移数据目录时必须连同密钥文件一起保护。
- custom URL 可通过受认证的 settings API 编辑；environment 摘要会隐藏凭据。运行日志、审计数据和诊断错误不得暴露代理凭据；请保护登录 token 与浏览器会话。
- `system` 当前只支持 GNOME 手工代理。headless Linux、PAC/auto 模式或无法读取 `gsettings` 时会明确报错，不会静默直连；服务器部署优先使用 `environment`。解析结果（含失败）会缓存约 60 秒，因此修复 `gsettings` 配置后最多需等待 60 秒才会生效。
- 内建 MCP 当前是 stdio transport，代理通过子进程环境注入。未来 HTTP/SSE MCP transport 需要在对应客户端显式接入 dispatcher/client proxy。
- MCP stdio 的 environment 代理读取 Gateway 进程环境，而非 Node 控制面的 environment 投影；标准 `.env` 部署下两者一致，但 Node 与 Gateway 环境变量不同的非标准部署下，UI 显示与 MCP 出站可能不一致。
- 托管环境初始化、创建和装包按操作接收全局代理策略。Runner 使用异步局部上下文，将策略传给 micromamba 下载与装包子进程，不修改进程级环境变量。environment 模式在 Runner 所在机器解析；远程 Runner 会拒绝指向控制机回环地址的自定义代理。固定版本、校验和、缓存及原有重试机制保留。
- `packages/network` 提供安装脚本与服务共享的路由和下载实现。回环目标直连；Adapter 按需创建读取环境代理的外部 HTTP 客户端，内部回环 HTTP/WebSocket 显式直连。Python HTTP/WebSocket 的 SOCKS 依赖已声明并锁定。
- `POST /api/proxy/test` 使用草稿策略检测下载源，不保存配置。这是用户主动诊断，不是启动门禁，也不代表所有 Provider 均可达。不提供自动故障切换、流量看板或 Project/Session 级 registry 覆盖。
- 设置在底部保存前仅为草稿。多区块保存采用顺序 API 请求，并非跨区块事务；后续失败不会回滚此前成功的写入。沙箱联网授权与代理路由仍然独立。
