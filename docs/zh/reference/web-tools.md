# Web Search 与 Web Fetch

## 边界

Web 是全局基础能力，不是 MCP Source，也没有 Session 级 Provider 覆盖。
模型始终看到 `web_search` 与 `web_fetch`；Node 负责权限、凭证、缓存、CAS
和审计，Gateway 只负责解析通用 Provider 请求、调用内部实现并净化返回内容。

> **注意**：agent 循环本身已经原生化到 Node 进程内（见
> [agent-backend.md](../explanation/agent-backend.md)），但 **web provider 的实际执行
> 仍暂留在 Gateway 侧车**，仍依赖 vendor 实现。本页描述的就是这条残留路径。

```text
Agent tool → Node WebBroker → Gateway /internal/web/invoke
           permission/cache     resolve provider + validate generic options
           CAS/WebInvocation    internal adapter / built-in provider
```

Node 是产品配置的唯一事实来源：每次调用只发送 `operation`、`provider`、
`arguments`、`options` 和 `timeoutMs`。Gateway 内部 adapter 负责把这些通用
字段映射成具体实现路径和请求级配置。Gateway 不读取磁盘 `config.yaml`，
Node、Browser 和 wire 都不依赖供应商配置类型。

## Provider 与配置

在 **System configuration → Web providers** 设置：

- Search：DDGS（默认、免费）、Tavily、Exa、Brave；DDGS 默认使用 Bing
  backend，也可切换为 auto 或 DuckDuckGo；
- Fetch：Jina Reader（默认）、Tavily、Exa；Jina 先请求国内入口
  `https://r.jinaai.cn`，仅在网络错误、超时、429、5xx 或空响应时顺序
  尝试 `https://r.jina.ai`，401/403 和其他 4xx 直接失败；
- Jina key 可选，匿名调用可用；Jina/Tavily/Exa/Brave 的 key 由后端
  AES-256-GCM 加密，API 只返回
  `hasApiKey`；
- Web 专用代理支持 `environment`（默认，读取标准 HTTP(S)/ALL proxy
  环境变量）、`custom`（http/https/socks5 URL）与 `direct`。自定义地址
  同样加密且只写，不会修改模型、MCP、下载器或其他进程流量；
- 默认 search cache 为 1 小时，fetch cache 为 24 小时。

Search 仅在 timeout、网络错误、429、5xx 时降级到 DDGS。401/403、缺少
key、输入错误、取消和“无结果”不降级。Fetch 不自动跨 Provider 重试。
每次尝试及回退都会进入同一个 `WebInvocation`，审计记录 Provider、DDGS
backend、Jina endpoint、proxy mode 和是否使用代理，但不记录 key 或代理
地址。Fetch 不跨不同 Provider 自动切换；上述 Jina 双入口属于同一
Provider 内的路由恢复。

DDGS 与 Jina 直接消费请求级代理配置。DeerFlow 的 Tavily/Exa/Brave
社区工具在 custom/direct 模式下运行于单次调用的隔离子进程，以便继续
复用原工具，同时把代理环境限制在该次 Web 请求内；environment 模式不
增加此进程开销。

## 权限、安全与引用

- `web_search` 请求 `connector:web:search` 权限；
- `web_fetch` 按目标 hostname 请求 `host` 权限；
- always-allow 模式沿用主 Agent 与子 Agent 共享的
  `PermissionAuthorization`，不会弹卡；
- fetch 仅接受无内嵌凭证的公开 http(s) URL，并在 Gateway 解析 DNS 后
  拒绝环回、私网、链路本地、保留和组播地址；
- Provider 原始结果保存为 CAS；工具结果带 invocation ID 与 CAS hash；
- search 片段不等于全文，只有 fetch 后才能声称读过网页；普通网页不会
  自动转换成科研 Evidence。

外部结果由 DeerFlow `ToolResultSanitizationMiddleware` 作为不可信内容
净化。未公开或敏感信息是否可以出站属于调用前授权问题；网页内容本身的
科研质量仍由后续 Review 判断。

## 斜杠命令

- `/web-refresh <request>`：去掉命令前缀后运行该请求，本轮主 Agent 和
  子 Agent 的所有 Web 调用绕过缓存；新结果仍会更新缓存。
- `/web-usage`：不调用模型，显示本地 search/fetch、cache hit、fallback
  和 failure 计数；不估算 Provider 额度或费用。

首版不支持 JS 浏览器渲染、登录态网页、Browserless/Crawl4AI、SearXNG
或自动写入 MemoryGraph。
