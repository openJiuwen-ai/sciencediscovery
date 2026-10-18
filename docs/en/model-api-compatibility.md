# Model API compatibility

ScienceDiscovery shares the model adapter between Agent, the Swarm gateway,
session naming, paper vision and the Evolve proxy used by IdeaTree. Supported
upstream families are OpenAI Chat Completions, OpenAI Responses and Anthropic
Messages. Swarm and the Python Evolve sidecar keep their internal Chat
Completions contract; the configured upstream family determines the wire request.
Gemini-native and Bedrock-native are outside this initial scope. Gemini through
an OpenAI-compatible provider variant remains available.

## Choose and check

Save the endpoint, model, credential, proxy and protocol in the provider editor.
The protocol choice is persisted, including manual overrides. A hostname or a
model name cannot prove a protocol; an endpoint may support multiple families.
No runtime protocol fallback or automatic chargeable recheck occurs. After
changing endpoint, model, credentials or protocol, explicitly check again.

The connection wizard requires consent before its single basic model request.
In an expanded provider row, select a saved model, read and check the cost
consent, then run the compatibility check. It sends **up to 12 synthetic requests**:
for each of the three families, one non-streaming basic completion, one streaming
completion, and a two-request tool-call/result round-trip. Tokens may be billed
by the configured provider, even for unsuccessful or truncated responses. No
research task content is used. Checks make no retries and never change the saved
protocol or model. Multiple families can pass simultaneously.

Results report basic completion, streaming text, tool round-trip and usage
independently for each family. A passing basic check does not certify tools or
streaming. A tool check can remain inconclusive when a model elects to answer
without calling the synthetic tool. Usage is available only when usable counts
are actually present; missing/malformed usage is unknown, never a free call or
an exact zero cost. Accounting and benchmark scoring do not require usage to
make progress or score a successful task. IdeaTree keeps measured counts partial and
uses a separately labelled conservative admission reserve (UTF-8 input bytes plus
output ceiling and overhead) for unreported calls. This reserve may pause work
earlier under a token budget; it is never displayed as billed usage or cost.

## Bounds and interpretation

Each basic and streaming attempt has a 10-second ceiling. The two tool turns
share another 10-second ceiling. The entire sequential matrix therefore has a
90-second ceiling, excluding local scheduling overhead. Basic output is limited
to 8 tokens; stream and tool outputs to 64 tokens per request, and response
bodies to 64 KiB per request. Providers can ignore output limits; the byte and
time ceilings still apply. A slow reasoning model may exhaust these small
budgets: the result is inconclusive, not evidence that the model is unusable.
API keys and upstream response/error bodies are not included in probe results.

Authentication/authorization (401/403), rate/quota limits (429), endpoint/model
not found (404), provider errors, network failures and timeouts are distinct
outcomes. Malformed or insufficient response evidence is inconclusive. HTTP 200
alone is insufficient. A check cannot certify the supplier's model identity,
quality, routing or correctness, or fix arbitrary supplier corruption.

The endpoint root retains configured proxy prefixes. A trailing
`/chat/completions`, `/responses` or `/messages` is normalized by the shared
adapter. Messages appends `/v1/messages` unless the root already ends in `/v1`.
Credentials and proxy policy follow the saved configuration. Requests use the
existing protocol-specific authentication headers; no hostname-based header
or endpoint discovery is introduced.

Paper vision translates text and base64 image parts. Messages image input
requires PNG/JPEG/GIF/WebP data URLs; the paper pipeline itself supplies bounded
PNG/JPEG files. A model must explicitly have vision enabled. An unsupported
content part fails precisely instead of dropping the image. Native reasoning
items, Messages thinking signatures, tool IDs and parallel result history stay
attached to assistant history. Truncation remains distinct from completion.

The Evolve/IdeaTree HTTP proxy is a non-streaming completion interface; streaming
requests there return a precise limitation. Streaming Agent/Swarm requests use
the existing gateway. That gateway preserves explicit token ceilings and temperature,
requires requested budgets to fit its configured ceiling, and reports precise
limitations for image input, forced tool choice and unsupported controls. Missing
tool IDs and malformed replay arguments are rejected rather than fabricated.
Unknown model parameters and unsupported tools are rejected
instead of silently discarded. Auxiliary completions have a 4 MiB response
ceiling (paper vision retains its tighter existing limit). Session naming keeps
its existing bounded attempts for provider-specific thinking/temperature
restrictions, within the selected protocol and 30 seconds per attempt; the
default output budget is now bounded at 16,384 tokens. Evolve keeps its 20-minute
wall-clock ceiling and run-scoped credentials. Never place credentials in URLs
or public diagnostics.

Benchmark judge scripts and opt-in real-model test proxies are test tooling,
not additional product protocol routers. They keep their declared Chat
Completions interface and are not run by compatibility checks. No new paid-model
PR gate is introduced.

Responses cache accounting reads the native `input_tokens_details.cached_tokens`
and `cache_write_tokens` fields, retaining legacy compatible aliases as a
fallback. Native counts take precedence over zero-filled aliases. See the
[official OpenAI cache guidance](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).

## HTTP API

`POST /api/models/:id/test` requires normal API authentication and a JSON body:

```json
{"consent": true, "compatibility": true}
```

Omit `compatibility` for only the selected protocol's basic check. Missing
explicit consent returns HTTP 400 without contacting a provider. The result's
`protocols` array contains `apiProtocol`, `basic`, `streaming`, `tools` and
`usage`; the top-level outcome describes the saved selection's basic check.
Results are ephemeral. Saving credentials alone never invokes these requests.
