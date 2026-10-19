# Create and use custom Specialists

This guide creates a cohort-data checking role to turn team requirements into reusable configuration. Complete the [quick start](../getting-started/quick-start.md) and prepare a working model and scientific environment first.

## 1. Define responsibilities and delivery

Specify the role's input, judgments, and output. This example checks data rather than interpreting treatment effects. It does not need external literature connectors.

## 2. Create the role

Open **System settings → Specialists**, choose the new-role action, and enter:

| Field | Example |
| --- | --- |
| Name | `cohort-data-checker` |
| Description | Inspect cohort columns, missingness, duplicates, and filtering counts; deliver reproducible checks. |
| Instructions | Adapt the example below to your laboratory's data conventions. |

```text
Check the cohort data supplied by the user.
Read the actual columns and data scope. Explain ambiguity if the patient identifier is unclear.
Record row counts, patient counts only when identifiable, duplicates, and missingness.
Justify any filtering and record before/after counts. Never fabricate missing data.
Save the executed script and checking results, register them as artifacts, and link them in the final reply.
Record limitations when information is insufficient. Do not infer treatment effects from these checks.
```

Select only needed connectors. For a private data interface, follow the [custom MCP guide](configure-custom-mcp.md), test it, then return to select it for the role.

Where the editor supports per-role skill selection, select `code-engineer`. With the JiuwenSwarm backend, the editor instead explains that Swarm manages skills; it does not provide the same checkboxes. Check availability in the JiuwenSwarm view under **Skills**. Do not assume hidden settings have taken effect.

Save the role. Built-in roles offer enable/disable controls; create a custom role to change a preset responsibility rather than editing a built-in entry.

## 3. Verify it in a session

Create a Session, upload a small CSV you are authorized to use, select the role in the Session's Specialist selector, and ask: “Check this file's data quality and deliver the checking script and results.”

Confirm that execution records show actual file reading, then open the script and results in the artifacts area. If no code ran, inspect model tool support, environment readiness, and approvals. If a source is unavailable, inspect connector configuration. A role label alone does not establish successful work.

Selecting a Specialist for a session differs from having the main Agent delegate a child task to it. For coordinated work, retain the coordinator, describe the desired division of work, and inspect actual child-task records.

## 4. Refine the configuration

Use the trial to improve the description, instructions, and resource scope, then verify with a new task. Models, credentials, and environments remain configured through their respective platform settings, not independently in this role form.

- [Specialists](../core/specialists.md): built-in roles and use cases.
- [Import and manage Skills](configure-skills.md): add your own methods and scripts.

## Codex Specialist runtime

Create a custom Specialist through `POST /api/specialists` (there is no runtime
picker yet):

```json
{
  "name": "Codex coder",
  "description": "Delegate coding work to Codex",
  "instructions": "Implement and verify the request. Explicitly declare deliverables.",
  "runtime": { "kind": "codex", "fallback": true }
}
```

Omit `runtime`, or use `{"kind":"native"}`, for native behavior. Codex options
are `model`, `reasoningEffort` (`minimal`, `low`, `medium`, `high`, `xhigh`),
`timeoutSeconds` (1–86400), `fallback` (default true), and `execution` (default
`sandbox`; `direct` requires separate `direct_code` consent). Credentials,
commands, argv and arbitrary environment variables are rejected. Non-native
runtime options participate in `specialistConfigHash`; native hashes are unchanged.

Ask the lead to delegate explicitly with `task(specialistId=…)`. The Specialist
uses the same conversation channel for messages, permission requests and config.
Ask it in chat to adjust advanced settings; `configure_specialist_runtime`
validates and applies model/reasoning to the next decision, the total wall-clock
budget to the current task, and fallback to runtime recovery. Settings survive
platform continuations in `runtimeOptions`; the frozen profile hash is retained.
A reduced deadline already in the past expires immediately. Stop cancels both
credential waits and provider streaming. Cancellation, deadlines, exhausted
turns and ordinary task failures do not trigger fallback.

The **Connect Codex to continue** card is the fallback configuration surface.
Enter the API key only there; never put secrets in chat or Specialist instructions.
The card also lets you disable native fallback before Codex starts. Keys use the
authenticated secret endpoint, encrypted separately and scoped to the Session;
Always-allow cannot supply a key. API-key authentication is supported; host
ChatGPT OAuth state is never imported. Setup waits count toward the deadline.

The pinned Codex CLI runs inside the Runner's Bubblewrap/seccomp launch profile,
with inner `danger-full-access` to avoid nested user namespaces. Each task has
an independent Workspace and private `CODEX_HOME` within it, removed on exit.
The model-only transport has API network access; native Codex shell, web search,
MCP and subagents are disabled/rejected. Workspace `.codex` configuration is masked
so project MCP/plugin settings cannot start unapproved processes. Commands use platform tools on separate
Runner executions with the normal offline/allowlist network policy and the same
permission channel. `request_sandbox_network` can request scoped tool egress;
`request_direct_execution` / `run_direct_shell` remain explicit consent paths.
A deployment can set `SCIENCE_AGENT_CODEX_BASE_URL` for a compatible Responses
endpoint; it is never read from Specialist metadata. The outer model-process
sandbox currently requires Linux and a local API-host Bubblewrap installation.
Remote tool Runners remain independent. No shared sandbox is introduced.

Only `declare_artifact(path=…)` / `declare_artifact(paths=…)` is a handoff API.
Only successful declared receipts enter `artifacts[]`. Undeclared new/modified
files stay physical Workspace state: no automatic Artifact, file-change timeline
entry, generated-file provenance, or execution Workspace snapshot/diff. Execution
status, stdout/stderr and code remain auditable. Explicit declaration copies the
selected file through the normal Artifact boundary. Do not declare private
Codex runtime state. The parent reads Artifact IDs/versions, not child-local paths.

If process startup, provider authentication or unavailable platform tools prevent
Codex from running, recovery defaults to `builtin-code-engineer`, with a visible
status step. Set `runtime.fallback=false`, ask the Specialist to disable it, or
uncheck fallback on the config card. A provider failure after platform work was
dispatched stays a failure so potentially completed work is not replayed.
Missing credentials first wait for the config card; cancelling or timing out that
wait does not launch native work. A denied direct-execution request also stays denied.

Developer contract: `services/api/src/specialist-runtime/adapter.ts` defines the
adapter and normalized `started | progress | tool_call | need_input | fallback |
done` events. A continuation carries its closed conversation and frozen Brief
into a fresh private Codex thread. Durable provider-thread resume, shared
sandboxes, additional SDKs/ACP, full observability and full Skills/MCP bridging
remain outside Phase 2. See [Issue #385](https://github.com/openJiuwen-ai/sciencediscovery/issues/385),
[configuration follow-up #278](https://github.com/openJiuwen-ai/sciencediscovery/issues/278),
and the separate [ACP Agent work #64](https://github.com/openJiuwen-ai/sciencediscovery/issues/64).

### Phase 3: Claude Code and ACP

`runtime.kind` also accepts `claude-code` and `acp`, with the same platform
options, explicit delegation, permission requests and declared-artifact handoff.
Ask the **main agent** to use `configure_specialist_runtime(specialistId, settings)`
before delegation. This changes future tasks; active tasks retain their snapshot.
Enter credentials in the private runtime card in the same conversation. The
runtime-neutral endpoint is `POST /api/subagents/:id/runtime-config` with
`inputId`, `apiKey`, and optional `fallback`; `codex-config` remains compatible.
Keys are encrypted and scoped independently by Session **and runtime**. Never
copy tokens from chat into Specialist instructions, model IDs, command arguments
or configuration metadata. The main-agent tool intentionally has no secret field.

Server operators configure executables outside the Specialist catalog:

- `SCIENCE_AGENT_CLAUDE_BINARY`: absolute path to a standalone Claude Code binary
  supporting `--bare`, `--tools`, `--strict-mcp-config` and `--json-schema`.
  Use a release with the documented bare-mode isolation fixes (v2.1.286 or later).
- `SCIENCE_AGENT_ACP_BINARY`: absolute path to an unattended ACP v1 executable.
  `SCIENCE_AGENT_ACP_ARGS` is an optional JSON string array of non-secret arguments.
  A standalone binary or self-contained executable wrapper must work in the
  Runner's minimal filesystem; arbitrary host package directories are not mounted.

Claude receives `ANTHROPIC_API_KEY`; ACP receives `SD_ACP_TOKEN`. The ACP
executable/wrapper must consume that environment variable for unattended auth;
interactive OAuth and agent-specific login flows are not implemented. For an
unauthenticated local ACP agent, submit `none` on the card. Host HOME, user MCP
configuration and ambient provider secrets are not inherited. Claude's native
tools are disabled. ACP advertises no filesystem/terminal capabilities, denies
native permission requests and rejects native tool-call updates. ACP agents must
support JSON decisions in text messages; requested model/reasoning values must be
advertised through session config options or the task fails with configuration
feedback. Claude maps `minimal` reasoning effort to `low`.

Each concurrent child uses its own Workspace, Runner execution identity and
private model-process directory. This reuses existing concurrent task scheduling;
there is no shared sandbox or session pool. Provider processes only exchange
model decisions. Commands, file operations and artifact declaration go through
validated platform tools, including `run_shell` and the main permission bus.
Transport API networking remains separate from tool egress policy.

`Subagent.runtimeDiagnostics` exposes structured failure categories
(`unavailable`, `policy_or_task`, `cancelled`, `timeout`), the task's
`fallbackCount`, and `sandboxProbe` (`ok`, `mode`). The probe records whether the
model transport bootstrapped inside the selected outer execution mode; it does
not claim successful provider authentication, sandbox escape coverage or nested
user-namespace support. No inner sandbox is requested. Failed bootstrap records
`ok=false`; no SDK stderr, credentials or raw provider errors are persisted.

Validation uses protocol fixtures with real API/Runner execution. Live successful
Claude/ACP authentication still requires approved credentials and installed
compatible executables; a fixture pass does not certify live provider support.
iCode is deferred because its packaging/auth/tool isolation need separate adapter
validation. Orchestration priority/quotas/task graphs, shared sandboxes/pools,
full metrics/cluster/multi-tenant monitoring, UX polish and the expanded stress/
escape acceptance matrix remain follow-up work.

Protocol references: [Claude Code CLI](https://code.claude.com/docs/en/headless),
[ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[ACP configuration](https://agentclientprotocol.com/protocol/v1/session-config-options).
