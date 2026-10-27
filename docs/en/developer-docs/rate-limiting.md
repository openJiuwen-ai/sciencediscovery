# External Data-Source Rate Limiting

## 1. Background and goal

Scientific providers impose different request pacing, concurrency, queue, and 429 rules. `ResourceRateLimiter` in the Node control plane supplies keyed admission. The MCP broker adds bounded queue defaults and shared source health within one service process.

## 2. Relationship to MCP Sources and call flow

### 2.1 Boundary

Source manifests declare governance; `McpGovernanceBroker` applies permission, cache, rate limiting, gateway invocation, retry feedback, CAS, and audit. The Node MCP client performs protocol calls. Each broker invocation permits one upstream attempt; subsequent calls re-enter admission. The limiter does not parse provider responses or own Session permission.

### 2.2 End-to-end path

```text
Agent mcp__source__tool → Node broker
  → permission/input/cache
  → acquire(source/tool key)
  → one Node MCP client attempt
  → report shared 429/attributed 406 health, reject affected waiters
  → release slot
  → validate/CAS/audit/result
```

### 2.3 Code anchors

- `packages/data-source/src/resource-rate-limiter.ts`: generic keyed admission.
- `packages/data-source/src/broker.ts`: MCP integration and audit mapping.
- `packages/schema/src/mcp-source.ts`: governance schema.
- `packages/mcp-sources`: explicit built-in values.
- Gateway MCP modules: Retry-After preservation/classification.

### 2.4 Broker behavior

The resource key scopes concurrency, pacing, FIFO waiting, and cooldown. Cache hits do not consume an upstream slot. Permission/input failures occur before admission. A successful acquire returns a release handle that is idempotent and always released after execution/cancellation. Queue wait is recorded in `McpInvocation.queueWaitMs`.

### 2.5 Gateway retry versus Node limiting

The broker sets `maxAttempts: 1` for governed calls. This prevents internal retries from bypassing source pacing while holding a slot. Later agent rounds and sibling agents share health, and every new attempt re-enters the existing concurrency and interval controls. Direct uses of the Node client retain its bounded retry policy.

### 2.6 Outbound paths outside this chain

Web Search/Fetch, Artifact byte downloads, model APIs, and direct network activity in skill code do not pass through the MCP limiter. Their boundaries are documented explicitly rather than implied to be covered.

## 3. Semantics

At the generic `ResourceRateLimiter` level, supplied dimensions are enforced and omitted dimensions remain unlimited:

- `maxConcurrentRequests`: active slots; omitted means unlimited.
- `minIntervalMs` or derived `rateLimitPerSecond`: minimum release/start pacing; omitted means no pacing.
- `maxQueueDepth`: maximum waiters; omitted means waiting is allowed without that depth guard. `0` rejects queueing.
- `queueTimeoutMs`: maximum wait; omitted waits for release or Abort; explicit values must be positive.
- `signal`: abort removes a waiter; execution cancellation is released by the caller.

The broker preserves omitted concurrency and pacing. To bound research admission, it defaults an omitted queue depth to 8 and an omitted queue timeout to 20 seconds, capped at the tool execution timeout. Existing explicit concurrency, interval and queue policies remain effective.

Queue timeout is distinct from execution timeout. Broker instances share an in-memory limiter and health state within one service process; independent workers do not share them. Keys combine the declared upstream group with an opaque digest of the effective endpoint and authentication configuration, including OAuth and tool-supplied credentials. No raw credentials enter diagnostics.

A 429 uses Retry-After (seconds or HTTP-date from bundled providers), or exponential cooldown from one second capped at 30 seconds. Affected waiters exit immediately. Later calls receive `retryAt`/`retryAfterMs` instead of sleeping independently. Existing interval and concurrency checks still apply after cooldown.

A provider-owned HTTP envelope distinguishes request-specific, unknown and endpoint 406 refusals. Only recognized generic edge rejection, without request/query error signals, is eligible. Three distinct requests consecutively rejected within one minute suppress that source/tool endpoint; repeated identical inputs do not reach the threshold. Its cooldown starts at 30 seconds and doubles to at most two minutes. Unattributed 406 remains local to the request.

After cooldown, one caller may probe. Other callers return immediately while that probe is active. Success restores access; failure reopens bounded suppression; cancellation releases the probe and slot. Other sources remain available. Tool output suggests available same-kind enabled alternatives, preserves citation/evidence requirements, and explicitly reports blocked research when none are available. It never claims an alternative was called or content was retrieved.

## 4. Error semantics

| Situation | `McpError.code` | Retryable |
|---|---|---|
| Queue full | `RATE_LIMIT_QUEUE_FULL` | true |
| Queue wait expired | `RATE_LIMIT_QUEUE_TIMEOUT` | true |
| Provider 429 | `RATE_LIMITED` | false (shared retry timing) |
| Shared cooldown / active recovery probe | `SOURCE_COOLDOWN` | false (shared retry timing) |
| Execution deadline | `TIMEOUT` | true |
| User cancellation | `CANCELLED` | false |

Bundled Python MCP wrappers retain sanitized origin, HTTP status, failure scope and parsed Retry-After in a JSON envelope. Node passes typed metadata to the broker; transition diagnostics and invocation audits expose status, queue wait, retry decision and correlation IDs without request URLs, response bodies or credentials. User-facing errors remain one short explanation; detailed timing and evidence guidance stay in structured tool details.

## 5. Manifest configuration and built-in values

| Parameter | Built-in value | arXiv | Basis |
|---|---|---|---|
| `minIntervalMs` | derived from requests/second | 3000 | arXiv approximately one request per three seconds |
| `rateLimitPerSecond` | NCBI 3, others 5 | 5 but pacing wins | NCBI no-key limit |
| `maxConcurrentRequests` | 2 | 1 | arXiv single connection |
| `maxQueueDepth` | 8 explicitly | 8 | typical same-turn burst at most six |
| `queueTimeoutMs` | 20000 explicitly | 20000 | admits a six-call burst within its window |
| retry initial delay | 500 ms | 3000 ms | no faster than source pacing |

Built-ins retain these explicit manifest choices. Future/custom sources may omit concurrency or pacing, while the broker always bounds queue admission. Audit exposes `queueWaitMs` and detailed attempts through the MCP invocation routes.

## 6. LLM API boundary (separate from data-source admission)

LLM requests do not pass through the data-source queue described here. Current model transport lives in `packages/model` and uses Node/undici for requests and bounded pre-stream retries.

The native executor uses the product model layer directly. JiuwenSwarm model traffic returns through the adapter per-run LLM proxy into the ScienceDiscovery model gateway, preserving product provider, proxy, retry, and usage semantics.

`packages/model/src/client.ts` currently supports:

- request header timeout;
- bounded pre-stream retry for connect errors, 429, and 5xx;
- numeric `Retry-After` parsing;
- exponential backoff when Retry-After is absent;
- no transparent retry after the response stream has begun.

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | 600 | request header timeout |
| `SCIENCE_AGENT_LLM_MAX_RETRIES` | 2 | max pre-stream connect/429/5xx retries |

Provider TPM/RPM admission is not currently implemented by `ResourceRateLimiter`. Future global model admission belongs in model/control-plane semantics rather than restoring the retired Python Gateway path.

## 7. Coverage and known gaps

Covered: every Source through `McpGovernanceBroker`, including the 12 built-ins. Not covered: Web broker, Artifact byte download, and direct outbound requests from sandbox skill scripts.

## 8. Tests

The API limiter suite covers concurrency, pacing, FIFO, full queue, timeout, cancellation, idempotent release, cooldown, and omitted-field infinity. Broker fault injection covers bounded admission, parallel 429, attributed versus request-specific 406, queue exhaustion, cancellation, credential isolation, single-probe recovery, fallback guidance and audit sanitization. `node test/api/source-health-journey.mjs` drives the production API with local MCP failures and verifies user-visible feedback and persisted attempts. MCP Source tests lock built-in/arXiv values, and gateway tests cover Retry-After propagation.
