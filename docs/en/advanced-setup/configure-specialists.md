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

## Codex runtime MVP

Custom specialists can opt into Codex through `POST /api/specialists` (there
is no runtime picker yet):

```json
{
  "name": "Codex coder",
  "description": "Delegate coding work to Codex",
  "instructions": "Implement and verify the requested change. Declare output artifacts.",
  "runtime": { "kind": "codex" }
}
```

An optional `runtime.model` selects the Codex model. Omit `runtime`, or use
`{"kind":"native"}`, for the existing native behavior. Credentials, commands,
argv and environment variables are rejected in runtime metadata. Supply no
secrets in specialist instructions. Update and read APIs retain the runtime.
Only non-native runtime metadata participates in `specialistConfigHash`;
native and omitted runtime preserve the legacy hash.

Ask the lead to delegate explicitly with `task(specialistId=…)`. Selecting a
specialist for the lead does not switch the lead runtime. The child retains
its own Workspace, selected input handoff, Brief, timeout, cancellation,
timeline and platform Artifact registration. Codex requests a small set of
platform tools through structured decisions; commands run through the same
platform execution bindings and permission checks as native children. Codex
has no enabled native shell, uses read-only permissions, and runs in a fresh
private scratch directory rather than the product Workspace.

If the Session has no Codex credential, an interactive **Connect Codex to
continue** card appears in the conversation, including when the child card
is collapsed. Enter an OpenAI API key there; the pending task continues. The
key travels through the authenticated config endpoint and is encrypted in a
separate platform secret table, scoped to the Session and removed on Session
or Project deletion. It never enters chat messages, specialist metadata,
argv, or the model prompt. Always-allow does not supply credentials. Setup
waits count toward the task's wall-clock timeout; stop cancels the wait.
The MVP supports API-key authentication, not ChatGPT browser/device login.
A rejected key produces a child failure; fix the credential with a new Session
or use `builtin-code-engineer`. Credential management beyond this focused
card belongs to the later configuration work.

Developer contract: `services/api/src/specialist-runtime/adapter.ts` defines
`SpecialistRuntimeAdapter.invoke(request, sink)` and the normalized
`started | progress | tool_call | file_change | need_input | done` events.
The compatibility factory maps these onto the existing Subagent stream and
returns `SpecialistResult` with summary, platform artifact receipts, usage
and Codex thread ID. Artifact receipts originate only in `declare_artifact`;
provider file paths are never adopted as artifacts. The pinned official
TypeScript SDK runs on the API host with an explicit environment and a fresh
Codex HOME. Host process confinement, durable Codex thread continuation,
ACP, additional SDKs, runtime selection UI, and full Skills/MCP bridging are
later phases. See [Issue #385](https://github.com/openJiuwen-ai/sciencediscovery/issues/385),
[configuration follow-up #278](https://github.com/openJiuwen-ai/sciencediscovery/issues/278),
and the separate [ACP Agent work #64](https://github.com/openJiuwen-ai/sciencediscovery/issues/64).
