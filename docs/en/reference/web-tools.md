# Web Search and Web Fetch

## Boundary

Web is a global base capability, not an MCP Source, and has no Session-level provider override. The model always sees `web_search` and `web_fetch`. Node owns permission, credentials, cache, CAS, and audit; gateway resolves a generic provider request, invokes its internal implementation, and sanitizes results.

> **Note:** the agent loop itself is now native to the Node process (see
> [agent-backend.md](../explanation/agent-backend.md)), but **web-provider execution
> still remains in the gateway sidecar** and still relies on the vendor implementation.
> This page documents that remaining path.

```text
Agent tool → Node WebBroker → Gateway /internal/web/invoke
           permission/cache     resolve provider + validate generic options
           CAS/WebInvocation    internal adapter / built-in provider
```

Node is the product-configuration source of truth. Each call sends only `operation`, `provider`, `arguments`, `options`, and `timeoutMs`. Gateway adapters map them to implementation-specific configuration. Gateway does not read disk `config.yaml`, and Node, Browser, and wire types do not depend on provider configuration types.

## Providers and configuration

**System configuration → Web providers** offers:

- Search: DDGS (default/free), Tavily, Exa, and Brave. DDGS defaults to Bing and can use auto or DuckDuckGo.
- Fetch: Jina Reader (default), Tavily, and Exa. Jina tries `https://r.jinaai.cn`, then `https://r.jina.ai` only after network errors, timeout, 429, 5xx, or empty response; 401/403 and other 4xx fail directly.
- Jina key is optional. Jina/Tavily/Exa/Brave keys are encrypted with AES-256-GCM, and APIs return only `hasApiKey`.
- Web-only proxy modes are `environment` (standard proxy variables), `custom` (HTTP/HTTPS/SOCKS5 URL), and `direct`. A custom URL is encrypted and write-only and does not affect models, MCP, downloaders, or other processes.
- Default cache durations are one hour for search and 24 hours for fetch.

Search falls back to DDGS only after timeout, network error, 429, or 5xx—not 401/403, missing key, invalid input, cancellation, or no results. Fetch does not retry across providers. All attempts and fallback share a `WebInvocation` that records provider, DDGS backend, Jina endpoint, proxy mode, and whether proxying was used, but never a key or proxy URL. Jina's two endpoints are recovery within one provider.

DDGS and Jina consume request-scoped proxy settings directly. DeerFlow Tavily/Exa/Brave community tools use an isolated subprocess in custom/direct mode so proxy environment is scoped to one request; environment mode avoids that process cost.

## Permission, security, and citation

- `web_search` requests `connector:web:search` permission.
- `web_fetch` requests `host` permission for the target hostname.
- Always-allow uses shared main/subagent `PermissionAuthorization` without a card.
- Fetch accepts only public HTTP(S) URLs without embedded credentials; after DNS resolution gateway rejects loopback, private, link-local, reserved, and multicast addresses.
- Raw provider results are stored in CAS; results include invocation ID and CAS hash.
- Search snippets are not full pages, and ordinary web content does not automatically become scientific Evidence.

DeerFlow `ToolResultSanitizationMiddleware` treats external results as untrusted. Outbound sensitive information is an authorization concern before the call; scientific quality still needs later review.

## Slash commands

- `/web-refresh <request>` removes its prefix and runs the request with cache bypass for all main/subagent Web calls in that run; fresh results update the cache.
- `/web-usage` calls no model and reports local search/fetch, cache-hit, fallback, and failure counts; it does not estimate provider quota or cost.

The first version does not support JavaScript browser rendering, authenticated pages, Browserless/Crawl4AI, SearXNG, or automatic MemoryGraph writes.
