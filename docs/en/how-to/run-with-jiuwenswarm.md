# Run agent turns on JiuwenSwarm

ScienceDiscovery runs its agent loop on [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm). This page covers installing it and starting the stack on it; it is the backend this project documents, builds, and tests against. (The stack also contains an older built-in loop, not covered here — see [JiuwenSwarm migration: status and hand-over](../reference/jiuwenswarm-migration-status.md) if you need it for comparison or rollback.)

What stays the same: the web UI, sessions, messages, run events, artifacts and provenance. What moves: the model loop, the conversation context (JiuwenSwarm keeps and compresses it), the system prompt (JiuwenSwarm's own, with ScienceDiscovery's added) and, by default, **the tools**: the model gets JiuwenSwarm's own (bash, file read/write/edit, grep, web fetch, sub-agents, todo, memory, skills, schedules) plus the ScienceDiscovery tools JiuwenSwarm has no equivalent for (`run_shell` on the Runner, artifacts, evidence and claims, papers, idea tree, evolve, `task`).

**Tools, sandbox and approvals:** JiuwenSwarm's tools that act on the host (`bash`, `read_file`, `write_file`, `edit_file`, `glob`, `list_files`, `grep`, `read_pdf`) are hidden from the model: commands, scripts and file writes go through ScienceDiscovery's `run_shell`, in its sandbox or on a Runner, with its provenance; reads through its file tools. A call to a hidden tool is turned away and runs nothing. The rest of JiuwenSwarm's tools (web search and fetch, todo, memory, skills, sub-agents, schedules) stay. ScienceDiscovery's tools reach JiuwenSwarm through one MCP server, `sci`, so their names are stable (`mcp_sci_run_shell`). **Approvals are JiuwenSwarm's**: its permission engine is switched on and decides before every call. Each of our tools gets a level the first time a run brings it: *ask* for those that execute, reach a host or Runner, or download, and for custom MCP connector tools; *allow* for the rest. A question shows as a ScienceDiscovery approval card (the session's approval mode and standing grants apply) and the answer goes back to JiuwenSwarm (once / this session / always / deny). ScienceDiscovery's own approval layer then allows the call and records it with source `jiuwenswarm`. `SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours` gives the model ScienceDiscovery's tools only.

**Language:** JiuwenSwarm's language follows the UI's (Settings, English / 中文): its own prompt, rails and tools, and the language it asks the model to answer in. It is one setting for every session (`preferred_language` in JiuwenSwarm's config); a session picks up a switch at its next run.

```text
browser ─▶ adapter (public port) ─▶ API (port + 100)
              │                        │
              └─▶ JiuwenSwarm ◀────────┘   tools run in the API, called back over a per-run bridge
                       │
                       └─▶ model, through a loopback gateway in the API (any protocol the UI can configure)
```

What exists and what does not: [JiuwenSwarm migration: status and hand-over](../reference/jiuwenswarm-migration-status.md).

## Start the stack on JiuwenSwarm

```bash
scripts/jiuwenswarm.sh setup                            # once: clone the pinned tag, install it, create the instance
./scripts/start-stack.sh --mode local --jiuwenswarm     # starts JiuwenSwarm if it is not running, then the stack
```

The same thing by variables: `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`. Browser journeys:
`CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked` (JiuwenSwarm must already be running). Public port: the adapter on
4310, with the API behind it on 4410.

The single-file binary carries the same JiuwenSwarm and adapter, installed at build time
(`scripts/binary-release/build-payload.sh`), so there is nothing to clone or install at run time, and `./ScienceDiscovery
serve` runs on it **by default** — `--jiuwenswarm` is accepted but redundant. Pass `--no-jiuwenswarm` (or
`SCIENCE_AGENT_EXECUTOR=native`) for the native loop instead. The Docker image bakes them in the same way (see
[Deployment → Run agent turns on JiuwenSwarm](../getting-started/deployment.md#run-agent-turns-on-jiuwenswarm)), but
runs on it **by default** too — `--jiuwenswarm` is accepted but redundant there as well. Pass
`--no-jiuwenswarm` to the container's command (or `SCIENCE_AGENT_EXECUTOR=native`) for the native loop instead.

Data (sessions, projects, models, settings, messages on screen) lives in the usual data directory either way, but the
**model's conversation context is JiuwenSwarm's own**: it keeps and compresses it itself, and a fresh instance starts
empty. A session that was run against the stack's older built-in loop therefore shows its earlier turns on screen but
JiuwenSwarm does not remember them as conversation context — start a new session if that matters. The other way round
is fine: the built-in loop can read the record of what JiuwenSwarm did.

**Check which backend is running:**

```bash
curl -s -H "Authorization: Bearer $SCIENCE_AGENT_AUTH_TOKEN" http://127.0.0.1:4310/agent/info
# {"adapter":true,"executor":"jiuwenswarm","jiuwenswarm":{"gatewayUrl":"ws://...","managementUrl":"ws://...","reachable":true},"toolTimeoutSeconds":3600}
```

A stack on the built-in loop, or one that was never started with the adapter, has no `/agent/info`. In the log of a JiuwenSwarm stack every chat shows `POST /agent/runs`, `POST /llm/…` and `POST /mcp/…` from the adapter.

## Requirements

Three paths carry JiuwenSwarm.

**Single-file binary**: `./ScienceDiscovery serve` — JiuwenSwarm and the adapter are already inside the executable
(see [Deployment → what the binary contains](../getting-started/deployment.md#what-the-binary-contains)) and this is
the default backend, so no flag is needed (`--no-jiuwenswarm` for the native loop instead). The only host requirement
beyond the usual [bubblewrap](../getting-started/deployment.md#host-dependency-bubblewrap) is disk for the extracted
payload, which this adds roughly 1.5 GB to. Nothing is cloned or installed at run time, so this path needs no access to
`gitcode.com` or a PyPI index.

**Docker**: `docker compose build` bakes them into the image the same way, from a plain PyPI install — no cloning, no
extra host requirement beyond the usual Docker one. Like the binary, this is the image's default too; pass
`--no-jiuwenswarm` in the container's command (or `SCIENCE_AGENT_EXECUTOR=native`) for the native loop instead (see
[Deployment → Run agent turns on JiuwenSwarm](../getting-started/deployment.md#run-agent-turns-on-jiuwenswarm)). First
start still creates the instance, under the bind-mounted data directory so it survives a container recreation, adding
roughly 1.6 GB to the image build.

**Source mode** (see [Deployment](../getting-started/deployment.md#local-mode-host-processes)):

- `git` and `uv` on the host. JiuwenSwarm installs into its own directory and virtualenv, never into ScienceDiscovery's environments.
- Access to `gitcode.com` (to clone the pinned tag) and to a PyPI index. On a slow link or in mainland China, set `SCIENCE_AGENT_PYPI_INDEX` to a mirror and, if downloads time out, `UV_HTTP_TIMEOUT` (the script defaults to 300 seconds).
- About 1.5 GB of disk for the JiuwenSwarm install.

Any path: any model the UI can configure: OpenAI chat completions, OpenAI Responses or Anthropic Messages, with their provider variants. You configure the model in ScienceDiscovery as usual; JiuwenSwarm needs no model setup of its own.

## Install and start

```bash
scripts/jiuwenswarm.sh setup     # once: clone the pinned tag (workswarm0.2.6), install it, create the instance
./scripts/start-stack.sh --mode local --jiuwenswarm    # starts JiuwenSwarm if it is not running, then the stack
```

`setup` is idempotent and applies the one JiuwenSwarm setting ScienceDiscovery depends on: `progressive_tool_enabled: false` in the instance's `config/config.yaml`. With JiuwenSwarm's default (`true`) the tools of a run are hidden behind a search step and the model would no longer see them by the names ScienceDiscovery defined. `--jiuwenswarm` refuses to start, with a message, if JiuwenSwarm is not installed.

To manage JiuwenSwarm yourself: `scripts/jiuwenswarm.sh start | stop | status | env`. JiuwenSwarm creates its instance workspace under `~/.jiuwenswarm-instances/<name>` (it has no option to move it). The instance is named `sciencediscovery` and gets its own ports, so it does not collide with a default JiuwenSwarm on the same host. To use a JiuwenSwarm that this script does not manage, set `JIUWENSWARM_GATEWAY_URL` and `JIUWENSWARM_MGMT_URL` yourself.

## Configuration

Everything is environment variables on the stack (in `.env`, or exported before `start-stack.sh`). Only the first block is needed to use JiuwenSwarm.

| Variable | Default | Meaning |
|---|---|---|
| **Choosing** | | |
| `--jiuwenswarm` (flag) | off | Sets the next two variables and starts JiuwenSwarm if needed |
| `SCIENCE_AGENT_ADAPTER` | unset | `1` puts the adapter on the public port in front of the API |
| `SCIENCE_AGENT_EXECUTOR` | unset | `jiuwenswarm` runs agent turns on JiuwenSwarm (needs the adapter) |
| **JiuwenSwarm instance** | | |
| `JIUWENSWARM_ROOT` | `.sciencediscovery-data/jiuwenswarm` | Install directory |
| `JIUWENSWARM_INSTANCE` | `sciencediscovery` | Instance name |
| `JIUWENSWARM_TAG` | `workswarm0.2.6` | Version to install. Only 0.2.6 has been validated |
| `JIUWENSWARM_GIT_URL` | `https://gitcode.com/openJiuwen/jiuwenswarm.git` | Clone source |
| `JIUWENSWARM_GATEWAY_URL` | read from the instance | Chat route of the gateway, e.g. `ws://127.0.0.1:20001/tui` |
| `JIUWENSWARM_MGMT_URL` | read from the instance | Web channel used for `mcp.*` and `models.*`, e.g. `ws://127.0.0.1:20000/ws` |
| `JIUWENSWARM_CONTEXT_WINDOW_TOKENS` | unset (JiuwenSwarm's 200000) | Window JiuwenSwarm compresses conversations against; written into its config when the instance starts |
| `SCIENCE_AGENT_PYPI_INDEX`, `UV_HTTP_TIMEOUT` | unset, `300` | PyPI mirror and download timeout for the install |
| **Ports and addresses** | | |
| `SCIENCE_AGENT_PORT` | `4310` | Public port (the adapter's) |
| `SCIENCE_AGENT_LEGACY_PORT` / `SCIENCE_AGENT_LEGACY_URL` | port + 100 | Where the API listens behind the adapter |
| `SCIENCE_AGENT_ADAPTER_URL` | `http://127.0.0.1:<port>` | How the API reaches the adapter |
| `SCIENCE_AGENT_ADAPTER_PUBLIC_URL` | `http://127.0.0.1:<port>` | How JiuwenSwarm reaches the adapter (its per-run MCP and model routes) |
| `SCIENCE_AGENT_HOST` | `127.0.0.1` | Interface the adapter binds |
| `SCIENCE_AGENT_ADAPTER_TOKEN` | unset | Bearer token the API presents on `/agent/*`; set it if the adapter listens beyond loopback |
| **How a run behaves** | | |
| `SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S` | `3600` | Longest one tool call may take (JiuwenSwarm's own limit is 30 s; the API passes the run's timeout when it has one) |
| `SCIENCE_AGENT_JIUWENSWARM_PLANNING` | `todo` | Who keeps the plan. `todo`: the model uses JiuwenSwarm's own todo tools and its list becomes the plan. `update_plan`: ScienceDiscovery's own tool instead (what the mocked browser journeys script) |
| `SCIENCE_AGENT_JIUWENSWARM_TOOLS` | `jiuwenswarm` | `jiuwenswarm`: JiuwenSwarm's own tools plus ScienceDiscovery's where it has none (on a name clash JiuwenSwarm's wins). `ours`: ScienceDiscovery's only, every call through its permissions and Runner (what the mocked browser journeys use) |
| `SCIENCE_AGENT_JIUWENSWARM_SKILLS` | `jiuwenswarm` | `jiuwenswarm`: the session's enabled skills are installed in JiuwenSwarm (`skills.import_local`) and used its way: its prompt lists them, the model loads one with `skill_tool`; ScienceDiscovery's skills catalog and `read_skill` are left out. A skill whose name JiuwenSwarm already uses (`skill-creator`) is installed as `sciencediscovery-<id>`. `ours`: ScienceDiscovery's catalog and `read_skill` (also used with `PROMPT=replace` or `TOOLS=ours`) |
| `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` | `jiuwenswarm` | `jiuwenswarm`: the model delegates with JiuwenSwarm's own `subagent_spawn`/`subagent_wait`; ScienceDiscovery's `task` is not offered. Those sub-agents run inside JiuwenSwarm with its own built-in tools only — no ScienceDiscovery tool, sandbox, workspace handoff or provenance reaches them. `task`: ScienceDiscovery's own tool, as before (also used with `TOOLS=ours`) |
| `SCIENCE_AGENT_JIUWENSWARM_PROMPT` | `prepend` | `prepend`: ScienceDiscovery's product prompt, then JiuwenSwarm's whole prompt, then the run contract. `replace`: only ScienceDiscovery's reaches the model |
| `SCIENCE_AGENT_LLM_MAX_TOKENS` | `16384` | Output budget per model call (shared with the built-in loop); raise it for reasoning models |
| `SCIENCE_AGENT_LLM_MAX_RETRIES`, `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | `2`, `600` | Retries (429 and other transient errors) and per-call timeout (shared) |
| **Diagnostics** | | |
| `SCIENCE_AGENT_ADAPTER_DEBUG` | unset | `1` prints every tool event and the last messages of every model request (adapter) |
| `SCIENCE_AGENT_JIUWENSWARM_DEBUG` | unset | `1` logs every bridge tool call (API) |

Set per model in the UI, as usual: provider, protocol and variant, API key, thinking mode, network proxy. The one thing that is **not** per model is the size JiuwenSwarm compresses conversations against: JiuwenSwarm 0.2.6 takes a single global value (its default is 200000 tokens) and ignores a model's own window. Set `JIUWENSWARM_CONTEXT_WINDOW_TOKENS` to the window of the models you use (it compresses at 80% of it); with a smaller model and the default, a conversation can overflow before it is compressed.

## What to expect

- The same conversations, tool cards, permission prompts, plans, subagents and artifacts as with the built-in loop; the milestone-0 journeys pass on this backend.
- JiuwenSwarm keeps each agent's conversation (main agent, and each subagent) in its own session, and compresses it when it reaches 80% of `JIUWENSWARM_CONTEXT_WINDOW_TOKENS`. JiuwenSwarm's own model calls (the summaries it writes when compressing, titles for sessions) use its *default model*: the adapter makes that entry point at itself (`sd-default`), and it sends those calls to the model of the run in progress. The JiuwenSwarm instance is therefore ScienceDiscovery's own; do not share it with other work. The system prompt is JiuwenSwarm's own, whole (identity, task strategy, safety, tool rules, memory, input and output rules, sub-agent rules, runtime, directory boundaries, context compression, installed skills), with ScienceDiscovery's product prompt **before** it (the science workspace, its tools and governance, specialists) and the run contract **after** it. JiuwenSwarm has no setting for a custom prompt per run, so the adapter's model proxy does the placing; the contract goes last because it changes every turn, which keeps the rest a stable prefix for the provider's cache. `SCIENCE_AGENT_JIUWENSWARM_PROMPT=replace` swaps JiuwenSwarm's out for ScienceDiscovery's instead. Skills are JiuwenSwarm's: before a run the adapter imports the run's frozen skill packages into JiuwenSwarm's skills directory (unchanged ones are skipped by content hash), and loading one with `skill_tool` counts as loading it in ScienceDiscovery (so `create_skill` works after `skill_tool` on skill-creator). JiuwenSwarm has one set of skills for every session, so with this backend there is no skill selection per project, session or specialist: every run imports the whole catalog (at its latest revision), and the settings pages say so instead of offering the choice (stored selections are kept for the built-in backend). **Settings › Skills › In JiuwenSwarm** lists everything installed there, ScienceDiscovery's and JiuwenSwarm's own (xlsx, docx-pro, pptx-generator …), each with an on/off switch (`skills.toggle`) that applies to every session started afterwards. ScienceDiscovery's per-step context (plan snapshot, durable state) is **not** injected, and JiuwenSwarm adds its own per-turn wrapper and dynamic context (runtime state) as user messages.
- Conversation, plan and event data stay in ScienceDiscovery's own stores.
- No trajectory or evidence records for JiuwenSwarm runs, and images are not sent to the model.
- Adding a model makes JiuwenSwarm send one small probe request to it (to detect image input); the gateway refuses the picture, so you may see a `400` for it in the log. That is expected.
- Token usage is reported per model call, including reasoning tokens.
- If the connection to JiuwenSwarm drops during a run, the adapter takes the run up again (`chat.resume`); what was sent while it was down is lost.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `start-stack.sh` says JiuwenSwarm is not installed or not reachable | Run `scripts/jiuwenswarm.sh setup` once, then use `--jiuwenswarm`, or `scripts/jiuwenswarm.sh start` and `status`. Logs: `.sciencediscovery-data/jiuwenswarm/jiuwenswarm.log` and `~/.jiuwenswarm-instances/<name>/agent/.logs/`. |
| `/agent/info` shows `"reachable": false` | JiuwenSwarm is down or the URLs are wrong. Check `scripts/jiuwenswarm.sh status`; set `JIUWENSWARM_GATEWAY_URL`/`JIUWENSWARM_MGMT_URL` for an instance the script does not manage. |
| The model never calls a tool | Check `progressive_tool_enabled: false` in the instance config; `scripts/jiuwenswarm.sh setup` restores it. |
| A subagent or a long command ends with an empty error after 30 s | JiuwenSwarm's own limit for one MCP call. The adapter raises it per run (`SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S`); if you see it, the adapter is older than this fix. |
| A run ends in the middle of a thought, or fails with "cut off at its output limit" | A reasoning model spent the whole per-call output budget (`max_tokens`, 16384 by default) on thinking. Raise `SCIENCE_AGENT_LLM_MAX_TOKENS` on the stack and retry. The built-in loop has the same limit. |
| A model returns `429` | The provider is rate limiting. The run retries with back-off as the built-in loop does, and fails with the provider's message when the retries run out. |
| A provider answers `403` only through this backend | Some gateways filter by `User-Agent`. Test the endpoint with `curl` and the same key; report the response body. |
| To see what a run did | `SCIENCE_AGENT_ADAPTER_DEBUG=1` and `SCIENCE_AGENT_JIUWENSWARM_DEBUG=1` print it to the stack log. |

Design notes and the protocol facts measured against JiuwenSwarm 0.2.6 are in [`services/adapter/README.md`](../../../services/adapter/README.md).
