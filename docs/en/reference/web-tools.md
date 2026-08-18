# Web Search and Web Fetch

## Boundary

Web is a global base capability, not an MCP Source, and has no Session-level provider override. The model always sees `web_search` and `web_fetch`. Node owns permission, credentials, cache, CAS, and audit, **and now also calls the vendors itself**.

```text
Agent tool → WebBroker ──────────────→ NativeWebProviderClient ──outbound HTTPS──▶ vendor API
             permission/credentials     argument validation + dispatch + 1 MB cap
             cache/CAS/audit            web_fetch additionally validates a public URL (with DNS)
```

There is no Python sidecar hop: `POST /internal/web/invoke` and the gateway web router were removed with this change, and the `deerflow` dependency is gone from the gateway environment. Node remains the product-configuration source of truth, and every vendor host is declared under `web.*` in `config/external-urls.json` so mirrored or restricted networks can retarget them.

## Search as one aggregated capability

Search is no longer a provider the user picks. `web_search` walks a fixed list of engines and returns the first one that produces results:

1. **Paid tier**, in order: Tavily → Exa → Brave Search API. A provider is attempted only if it is switched on *and* has a stored API key; an unkeyed provider is skipped without a request.
2. **Free tier**, in order: DuckDuckGo → Bing → Brave (public result page). Each engine has its own switch; a switched-off engine is never requested.

Paid before free is deliberate: a keyed vendor gives a stable API contract and better results, and the free engines are there so search still works when no key is configured, a key is exhausted, or one engine starts rate-limiting.

The free engines read the vendors' public result pages, so all three share one failure mode — a layout change yields zero rows. That is treated as a failed attempt, and the aggregation moves to the next engine; only when every candidate fails does the call fail. Bing's organic links are wrapped in `bing.com/ck/a` redirects, which the client decodes back to the destination so that citations and `web_fetch` see the real page rather than a tracker.

If no engine is available at all — no paid key and every free engine off — the call fails as `INVALID_INPUT` pointing at Web settings, without contacting anyone.

## Providers and configuration

**System configuration → Web providers** offers:

- Paid search providers: Tavily, Exa, Brave Search API — each with a switch, and a key entered below.
- Free search engines: DuckDuckGo, Bing, Brave (free) — switches only, no key.
- Fetch: Jina Reader (default), Tavily, and Exa. Fetch is still a single configured provider, not an aggregation. Jina tries `https://r.jinaai.cn`, then `https://r.jina.ai` only after network errors, timeout, 429, 5xx, or empty response; 401/403 and other 4xx fail directly.
- Jina key is optional. Jina/Tavily/Exa/Brave keys are encrypted with AES-256-GCM, and APIs return only `hasApiKey`.
- Web-only proxy modes are `environment` (standard proxy variables), `custom` (HTTP/HTTPS/SOCKS5 URL), and `direct`. A custom URL is encrypted and write-only and does not affect models, MCP, downloaders, or other processes.
- Default cache durations are one hour for search and 24 hours for fetch.

Each engine caches under its own route, and a cached answer from any candidate satisfies the query, so a successful free result is not re-fetched through a paid provider on the next call. Every attempt — paid and free, including cache hits — is recorded in one `WebInvocation` with its engine, tier (`paid`/`free`), Jina endpoint, proxy mode, and whether proxying was used, but never a key or proxy URL.

Every provider consumes the proxy policy the broker resolved, applied through the shared `proxyDispatcher` (which keeps `NO_PROXY` and protocol selection semantics). With no subprocess left, custom/direct mode needs no process isolation and proxy scope is inherently per-request.

## Upgrading from the single-provider settings

Installs configured before aggregation stored one `searchProvider` (plus `ddgsBackend` and an optional `searchFallbackProvider`). Those records are translated on load so spending does not change:

- a paid `searchProvider` becomes the only enabled paid provider;
- the free engines are enabled only if the old route could reach the free tier (`searchProvider: "ddgs"` or `searchFallbackProvider: "ddgs"`);
- `ddgsBackend` is dropped — the aggregation tries every enabled engine, so there is nothing left to select.

"DDGS" is no longer a user-facing name. The Python `ddgs` library it referred to was a multi-engine aggregator (its `bing` backend was disabled upstream in 9.x and silently fell back to `auto`); the aggregation described above replaces that behaviour with engines this repository owns.

## Permission, security, and citation

- `web_search` requests `connector:web:search` permission.
- `web_fetch` requests `host` permission for the target hostname.
- Always-allow uses shared main/subagent `PermissionAuthorization` without a card.
- Fetch accepts only public HTTP(S) URLs without embedded credentials; after DNS resolution Node rejects loopback, private, link-local, reserved, and multicast addresses — including a public hostname that resolves into private space.
- Raw provider results are stored in CAS; results include invocation ID and CAS hash.
- Search snippets are not full pages, and ordinary web content does not automatically become scientific Evidence.

The Node-native loop neutralizes framework tags in remote tool results before they reach history or the UI (see agent-backend.md). Outbound sensitive information is an authorization concern before the call; scientific quality still needs later review.

## Slash commands

- `/web-refresh <request>` removes its prefix and runs the request with cache bypass for all main/subagent Web calls in that run; fresh results update the cache.
- `/web-usage` calls no model and reports local search/fetch, cache-hit, fallback, and failure counts; it does not estimate provider quota or cost.

The first version does not support JavaScript browser rendering, authenticated pages, Browserless/Crawl4AI, SearXNG, or automatic MemoryGraph writes.
