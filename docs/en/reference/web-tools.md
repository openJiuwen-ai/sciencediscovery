# Web Search and Web Fetch

This page documents the **product-owned** `web_search` and `web_fetch` tools. They are visible by default in the native executor. The default JiuwenSwarm backend exposes its own `free_search`/`paid_search` and `fetch_webpage` instead; set `SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` to use the product tools. The permission, provider, cache, audit, and slash-command details below describe product Web calls; do not assume they apply to Swarm's Web tools. See [Agent backends](agent-backends.md).

## Boundary

Product Web is a global base capability, not an MCP Source, and has no Session-level provider override. When the product tools are selected, the model sees `web_search` and `web_fetch`. Node owns permission, credentials, cache, CAS, and audit, and calls the vendors itself.

```text
Agent tool → WebBroker ──────────────→ NativeWebProviderClient ──outbound HTTPS──▶ vendor API
             permission/credentials     argument validation + dispatch + 1 MB cap
             cache/CAS/audit            web_fetch additionally validates a public URL (with DNS)
```

There is no Python sidecar hop: `POST /internal/web/invoke` and the gateway web router were removed with this change, and the `deerflow` dependency is gone from the gateway environment. Node remains the product-configuration source of truth, and every vendor host is declared under `web.*` in `config/external-urls.json` so mirrored or restricted networks can retarget them.

## Search as one aggregated capability

Search is no longer a provider the user picks. `web_search` walks a fixed list of engines and returns the first one that produces results:

1. **Paid tier**, in order: Tavily → Exa → Brave Search API → DeepSeek. A provider is attempted only if it is switched on *and* has a stored API key; an unkeyed provider is skipped without a request.
2. **Free tier**, in order: DuckDuckGo → Bing → Brave (public result page). Each engine has its own switch; a switched-off engine is never requested.

Paid before free is deliberate: a keyed vendor gives a stable API contract and better results, and the free engines are there so search still works when no key is configured, a key is exhausted, or one engine starts rate-limiting.

The free engines read the vendors' public result pages, so all three share one failure mode — a layout change yields zero rows. That is treated as a failed attempt, and the aggregation moves to the next engine; only when every candidate fails does the call fail. Bing's organic links are wrapped in `bing.com/ck/a` redirects, which the client decodes back to the destination so that citations and `web_fetch` see the real page rather than a tracker.

If no engine is available at all — no paid key and every free engine off — the call fails as `INVALID_INPUT` pointing at Web settings, without contacting anyone.

## Providers and configuration

**System configuration → Web providers** offers:

- Paid search providers: Tavily, Exa, Brave Search API, DeepSeek — each with a switch, and a key entered below.
- Free search engines: DuckDuckGo, Bing, Brave (free) — switches only, no key.
- Fetch: Jina Reader (default), Tavily, Exa, and DeepSeek. Fetch is still a single configured provider, not an aggregation. Jina tries `https://r.jinaai.cn`, then `https://r.jina.ai` only after network errors, timeout, 429, 5xx, or empty response; 401/403 and other 4xx fail directly.
- Jina key is optional. Jina/Tavily/Exa/Brave/DeepSeek keys are encrypted with AES-256-GCM, and APIs return only `hasApiKey`.
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

The native Node loop neutralizes framework tags in remote tool results before they reach history or the UI (see [Agent backend](../developer-docs/agent-backend.md)). JiuwenSwarm has a separate tool/result path; the native-loop statement is not a guarantee for its Web tools. Outbound sensitive information is an authorization concern before the call; scientific quality still needs later review.

## Slash commands

- `/web-refresh <request>` removes its prefix and runs the request with cache bypass for all main/subagent Web calls in that run; fresh results update the cache.
- `/web-usage` calls no model and reports local search/fetch, cache-hit, fallback, and failure counts; it does not estimate provider quota or cost.

The first version does not support JavaScript browser rendering, authenticated pages, Browserless/Crawl4AI, SearXNG, or automatic MemoryGraph writes.

## DeepSeek on both backends

In **System configuration → Web providers**, save a **DeepSeek API key** and switch on **Enable DeepSeek Search and Fetch** (off by default). Include DeepSeek in the paid search selection to use Search, and select **DeepSeek** as the Fetch provider to retrieve Markdown. Saving a key alone never enables DeepSeek. The master switch controls both uses; removing the key or switching it off prevents all DeepSeek requests. A different Fetch selection never sends DeepSeek Fetch requests.

For example, send this partial update to `PUT /api/web/settings` with your instance's normal authorization header. Replace the placeholder locally; do not put a real key in source control:

```json
{
  "deepseekEnabled": true,
  "paidSearchProviders": ["deepseek"],
  "fetchProvider": "deepseek",
  "providerApiKeys": { "deepseek": "<YOUR_DEEPSEEK_API_KEY>" }
}
```

Keep `["tavily", "exa", "brave", "deepseek"]` to retain all native paid providers in their existing order. Free engines remain available as configured. Set `"deepseekEnabled": false` to disable both DeepSeek operations while retaining the encrypted key. Select `"fetchProvider": "jina"` to keep the previous default fetching behavior.

| Backend | Search and Fetch integration |
| --- | --- |
| Native product tools | `WebBroker` calls the native DeepSeek provider; existing permissions, resolved proxy policy, cache, CAS and `web_invocations` audit apply. Search maps `summary` (falling back to `snippet`) to the existing `content` field alongside `title` and `url`. Fetch returns the title and Markdown body. |
| Default JiuwenSwarm tools | The same saved settings pass through `jiuwenSwarmWebConfig` and the adapter's `config.set` to `DEEPSEEK_API_KEY`, `DEEPSEEK_SEARCH_ENABLED` and `DEEPSEEK_FETCH_ENABLED`. The shipped `workswarm0.2.6` compatibility patch extends the actual default Agent's `paid_search`/`fetch_webpage` and the MCP equivalents. `auto` tries Bocha → Perplexity → Serper → Jina first, then DeepSeek. With only DeepSeek configured, it is used directly. Product cache/audit behavior is not added to Swarm's independent transport. |

No `SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` override is needed for the default backend. After upgrading, rerun `scripts/jiuwenswarm.sh setup` and restart Swarm; Docker and binary packages build the patched wheel automatically. Existing Bocha/Perplexity/Serper/Jina execution stays intact; default Fetch remains direct page retrieval with its existing Jina fallback unless DeepSeek is selected. Tavily/Exa fetch selection remains native-only.

Both routes use Bearer authentication with the [official Search and Fetch APIs](https://api-docs.deepseek.com/guides/search): `POST https://api.deepseek.com/v1/tools/search` with `query` and `count`, and `POST https://api.deepseek.com/v1/tools/fetch` with only `url`. Search queries support up to 128 Unicode characters. A successful search with empty `results` proceeds to the existing free fallback (Swarm reports no matches and suggests `free_search`); it is not a provider outage.

Errors identify the action to take: `MISSING_CREDENTIALS` asks for a key; `UNAUTHORIZED` (401) asks for a valid key; `INSUFFICIENT_BALANCE` (402) asks for an account top-up; `RATE_LIMITED` (429) asks for a cooldown; `TIMEOUT` covers 408/504 and transport deadlines; `FETCH_FAILED` (404 or missing Markdown) means the target page could not be retrieved. A disabled native Fetch reports `PROVIDER_DISABLED`. Search may recover through another enabled provider; individual attempts remain visible in native audit records. Keys and upstream error bodies are never included in tool errors.
