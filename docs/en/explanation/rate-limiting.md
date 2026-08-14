# External Data-Source Rate Limiting

## 1. Background and goal

Scientific providers impose different request pacing, concurrency, queue, and 429 rules. `ResourceRateLimiter` in the Node control plane supplies one keyed admission layer without inventing implicit limits when a Source manifest omits a dimension.

## 2. Relationship to MCP Sources and call flow

### 2.1 Boundary

Source manifests declare governance; `McpGovernanceBroker` applies permission, cache, rate limiting, gateway invocation, retry feedback, CAS, and audit. Gateway performs provider protocol calls and bounded retry. The limiter does not parse provider responses or own Session permission.

### 2.2 End-to-end path

```text
Agent mcp__source__tool → Node broker
  → permission/input/cache
  → acquire(source/tool key)
  → gateway MCP call and retry
  → report upstream 429 cooldown
  → release slot
  → validate/CAS/audit/result
```

### 2.3 Code anchors

- `services/api/src/rate-limit/resource-rate-limiter.ts`: generic keyed admission.
- `services/api/src/mcp/broker.ts`: MCP integration and audit mapping.
- `packages/schema/src/mcp-source.ts`: governance schema.
- `packages/mcp-sources`: explicit built-in values.
- Gateway MCP modules: Retry-After preservation/classification.

### 2.4 Broker behavior

The resource key scopes concurrency, pacing, FIFO waiting, and cooldown. Cache hits do not consume an upstream slot. Permission/input failures occur before admission. A successful acquire returns a release handle that is idempotent and always released after execution/cancellation. Queue wait is recorded in `McpInvocation.queueWaitMs`.

### 2.5 Gateway retry versus Node limiting

Node shapes calls before they reach a provider and cools later requests after 429. Gateway retries the already admitted call for transient provider errors under the manifest retry policy. These layers are complementary; retry delay never grants additional concurrency.

### 2.6 Outbound paths outside this chain

Web Search/Fetch, Artifact byte downloads, model APIs, and direct network activity in skill code do not pass through the MCP limiter. Their boundaries are documented explicitly rather than implied to be covered.

## 3. Semantics

Each supplied dimension is enforced; omitted dimensions remain unlimited:

- `maxConcurrentRequests`: active slots; omitted means unlimited.
- `minIntervalMs` or derived `rateLimitPerSecond`: minimum release/start pacing; omitted means no pacing.
- `maxQueueDepth`: maximum waiters; omitted means waiting is allowed without that depth guard. `0` rejects queueing.
- `queueTimeoutMs`: maximum wait; omitted/zero does not time out and waits for release or Abort.
- `signal`: abort removes a waiter; execution cancellation is released by the caller.

Validation applies only to fields that are present. The broker does not silently replace absence with concurrency 1, queue 8, or 20 seconds.

Queue timeout is distinct from gateway execution timeout. A 429 attempt triggers `reportUpstreamRateLimit(key,retryAfterMs)`. Later admissions wait until cooldown ends; absent Retry-After uses at least one second and respects any longer pacing already pending. Cooldown works even without pacing configuration.

## 4. Error semantics

| Situation | `McpError.code` | Retryable |
|---|---|---|
| Queue full | `RATE_LIMIT_QUEUE_FULL` | true |
| Queue wait expired | `RATE_LIMIT_QUEUE_TIMEOUT` | true |
| Provider 429 after retries | `RATE_LIMITED` | true |
| Execution deadline | `TIMEOUT` | true |
| User cancellation | `CANCELLED` | false |

Python MCP HTTP wrappers preserve Retry-After in a parseable error instead of losing headers through a bare `raise_for_status()`. Gateway classification extracts it for retry and Node cooldown.

## 5. Manifest configuration and built-in values

| Parameter | Built-in value | arXiv | Basis |
|---|---|---|---|
| `minIntervalMs` | derived from requests/second | 3000 | arXiv approximately one request per three seconds |
| `rateLimitPerSecond` | NCBI 3, others 5 | 5 but pacing wins | NCBI no-key limit |
| `maxConcurrentRequests` | 2 | 1 | arXiv single connection |
| `maxQueueDepth` | 8 explicitly | 8 | typical same-turn burst at most six |
| `queueTimeoutMs` | 20000 explicitly | 20000 | admits a six-call burst within its window |
| retry initial delay | 500 ms | 3000 ms | no faster than source pacing |

These are manifest choices, not broker defaults. Future/custom Sources may omit a dimension. Audit exposes `queueWaitMs` and detailed attempts through the MCP invocation routes.

## 6. LLM API boundary

Main model requests originate in gateway and use SDK 429/5xx retry. Node has a few auxiliary model calls. LLM requests are not queued by this admission layer because provider quotas commonly include tokens per minute and request queueing directly increases first-token latency. Gateway exposes `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` (SDK default 600) and `SCIENCE_AGENT_LLM_MAX_RETRIES` (default 2). A future host-keyed asyncio semaphore/pacing layer belongs in gateway; global run concurrency is a separate Node concern.

## 7. Coverage and known gaps

Covered: every Source through `McpGovernanceBroker`, including the 12 built-ins. Not covered: Web broker, Artifact byte download, and direct outbound requests from sandbox skill scripts.

## 8. Tests

The API limiter suite covers concurrency, pacing, FIFO, full queue, timeout, cancellation, idempotent release, cooldown, and omitted-field infinity. Broker tests cover absent governance, error mapping, queue audit, and 429 feedback. MCP Source tests lock built-in/arXiv values, and gateway tests cover Retry-After propagation.
