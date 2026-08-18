# Web Search 与 Web Fetch

## 边界

Web 是全局基础能力，不是 MCP Source，也没有 Session 级 Provider 覆盖。
模型始终看到 `web_search` 与 `web_fetch`；Node 负责权限、凭证、缓存、CAS
和审计，**各厂商的实际调用也在 Node 进程内完成**。

```text
Agent tool → WebBroker ──────────────→ NativeWebProviderClient ──出站 HTTPS──▶ 厂商 API
             权限/凭证/缓存/CAS/审计     参数校验 + provider 分发 + 1MB 上限
                                        web_fetch 另加公网 URL 校验（含 DNS 解析）
```

不再有 Python 侧车这一跳:`POST /internal/web/invoke` 与 gateway 的 web 路由
已随本次原生化删除,`deerflow` 依赖也已从 gateway 环境中移除。Node 仍是产品
配置的唯一事实来源;各厂商出网地址集中声明在 `config/external-urls.json` 的
`web.*` 键下,便于镜像或受限网络环境改指向。

## Search 是一个自动聚合能力

Search 不再由用户选择某一个 Provider。`web_search` 按固定顺序依次尝试引擎，
取第一个真正出结果的引擎返回：

1. **付费层**，顺序为 Tavily → Exa → Brave Search API。只有「开关打开且已保存
   API key」的 Provider 才会被尝试；没有 key 的 Provider 直接跳过，不发请求。
2. **免费层**，顺序为 DuckDuckGo → Bing → Brave（公开结果页）。每个引擎有独立
   开关；**关掉的引擎不会被请求**。

先付费后免费是有意为之：已配置 key 的厂商有稳定的 API 契约、结果质量也更好；
免费引擎则保证在没有 key、key 用尽或某个引擎开始限流时，搜索仍然可用。

三个免费引擎都解析厂商的公开结果页，因此共享同一种失败方式：页面改版会导致解析
出 0 条结果。这被记为一次失败尝试，聚合继续走下一个引擎；只有全部候选都失败，
这次调用才失败。Bing 的自然结果链接被包在 `bing.com/ck/a` 跳转里，客户端会把它
解回真实地址，避免引用和 `web_fetch` 拿到的是跟踪链接而不是原页面。

如果一个可用引擎都没有（没有付费 key，且免费引擎全部关闭），调用会以
`INVALID_INPUT` 失败并指向 Web 设置，不会对外发起任何请求。

## Provider 与配置

在 **System configuration → Web providers** 设置：

- 付费搜索 Provider：Tavily、Exa、Brave Search API，各有开关，key 在下方输入；
- 免费搜索引擎：DuckDuckGo、Bing、Brave（免费），只有开关，不需要 key；
- Fetch：Jina Reader（默认）、Tavily、Exa。Fetch 仍是单一 Provider，不做聚合。
  Jina 先请求国内入口 `https://r.jinaai.cn`，仅在网络错误、超时、429、5xx 或空
  响应时顺序尝试 `https://r.jina.ai`，401/403 和其他 4xx 直接失败；
- Jina key 可选，匿名调用可用；Jina/Tavily/Exa/Brave 的 key 由后端
  AES-256-GCM 加密，API 只返回 `hasApiKey`；
- Web 专用代理支持 `environment`（默认，读取标准 HTTP(S)/ALL proxy 环境变量）、
  `custom`（http/https/socks5 URL）与 `direct`。自定义地址同样加密且只写，不会
  修改模型、MCP、下载器或其他进程流量；
- 默认 search cache 为 1 小时，fetch cache 为 24 小时。

每个引擎按自己的 route 写缓存，任一候选引擎的缓存命中都算这次查询的有效结果，
因此免费引擎成功过的查询不会在下次调用时再走一遍付费 Provider。付费与免费的
每一次尝试（含缓存命中）都记录在同一个 `WebInvocation` 中，审计包含引擎名、
tier（`paid`/`free`）、Jina endpoint、proxy mode 和是否使用代理，但不记录 key
或代理地址。

所有 Provider 统一消费 Broker 解析出的请求级代理策略，经共享的
`proxyDispatcher` 生效（含 `NO_PROXY` 与协议选择语义）。因为不再有子进程，
custom/direct 模式也不再需要隔离进程，代理作用域天然限制在该次请求内。

## 旧单 Provider 配置的迁移

聚合之前的安装保存的是单个 `searchProvider`（外加 `ddgsBackend` 和可选的
`searchFallbackProvider`）。这些记录在加载时会被翻译成等价的分层选择，以免改变
安装的花钱行为：

- 付费的 `searchProvider` 迁移为「唯一开启的付费 Provider」；
- 免费引擎只在原路径本来就能走到免费层时才开启（`searchProvider: "ddgs"` 或
  `searchFallbackProvider: "ddgs"`）；
- `ddgsBackend` 直接丢弃——聚合会尝试所有开启的引擎，已经没有可选项了。

「DDGS」不再是对外名称。它原本指的 Python `ddgs` 库是一个多引擎聚合器（其
`bing` 后端在 9.x 已被上游停用，实际会静默回退到 `auto`）；现在这套行为由本仓
自己实现的引擎聚合替代。

## 权限、安全与引用

- `web_search` 请求 `connector:web:search` 权限；
- `web_fetch` 按目标 hostname 请求 `host` 权限；
- always-allow 模式沿用主 Agent 与子 Agent 共享的
  `PermissionAuthorization`，不会弹卡；
- fetch 仅接受无内嵌凭证的公开 http(s) URL，并在 Node 解析 DNS 后
  拒绝环回、私网、链路本地、保留和组播地址（公网域名解析到私网同样拒绝）；
- Provider 原始结果保存为 CAS；工具结果带 invocation ID 与 CAS hash；
- search 片段不等于全文，只有 fetch 后才能声称读过网页；普通网页不会
  自动转换成科研 Evidence。

Node 原生 Agent Loop 会在远程工具结果进入历史和 UI 之前净化其中的框架标签
（见 agent-backend.md）。未公开或敏感信息是否可以出站属于调用前授权问题；
网页内容本身的科研质量仍由后续 Review 判断。

## 斜杠命令

- `/web-refresh <request>`：去掉命令前缀后运行该请求，本轮主 Agent 和
  子 Agent 的所有 Web 调用绕过缓存；新结果仍会更新缓存。
- `/web-usage`：不调用模型，显示本地 search/fetch、cache hit、fallback
  和 failure 计数；不估算 Provider 额度或费用。

首版不支持 JS 浏览器渲染、登录态网页、Browserless/Crawl4AI、SearXNG
或自动写入 MemoryGraph。
