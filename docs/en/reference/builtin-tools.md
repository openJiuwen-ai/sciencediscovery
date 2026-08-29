# Built-in Tools Visible to the Model

This page lists tools visible inside the agent loop. `createWorkspaceTools` in `packages/workspace` builds them, while `packages/tools` owns registration and dispatch policy; implementations live in the Node control plane while the gateway receives only names, descriptions, and JSON Schema. Except for tools marked always available, Session configuration controls visibility, and `toolPolicy` can further restrict a subagent to a whitelist.

## Base tools (always available)

| Tool | Parameters | Behavior and boundary |
|---|---|---|
| `list_files` | none | Recursively lists workspace paths, sizes, and mtimes; skips symlinks; at most 500 |
| `read_file` | `path`; optional `offset`, `limit` | Reads one page of workspace text after escape validation: at most 2000 lines or 40 KiB, continued with `offset`. Binary files return media type and size only — never a body or base64 |
| `get_file_provenance` | `path` | Returns the backend-recorded file identity, current source, revision history, execution context, parent lineage, and linked Artifact versions. `origin: unknown` is explicit and must not be replaced with a model inference |
| `list_artifacts` | none | Lists user-visible Project Artifacts across Sessions, including origin, creation snapshot, and latest version |
| `read_artifact` | `artifact_id` or `name`; optional `version`, `offset`, `limit` | Reads one page of a Project Artifact version: UTF-8 text at most 2000 lines or 40 KiB, with the line range and next offset. Binary versions return `binary: true` with media type and size, never a body or base64 |
| `declare_artifact` | `path` or `paths` (1–50); optional `name`, `description` | Declares writable workspace files as Project Artifacts. Batch entries succeed/fail independently. Logical names can form virtual sidebar directories without moving files; the server infers preview kind |
| `run_shell` | exactly one of `command`, `scriptPath`; optional `arguments`, `runner_id`, `environment_id`, `wait_ms`, `background` | Fresh sandboxed process in the Agent × Runner Workspace; latest environment, no persistent interpreter/cd/export state. Waiting expires without stopping the command |
| `execution_status` / `execution_logs` / `execution_cancel` | Execution ID; status may list or wait, logs accept a cursor | Manage owned execution through a separate channel, not another Shell |
| `workspace_transfer` | `operation`: workspaces/start/list/status/cancel; explicit source/target IDs and file mappings | Copies committed snapshots, records partial success, never implicitly declares an Artifact |
| `timer_create` / `timer_list` / `timer_cancel` | Exactly one of `after_ms` or `at`, message, optional `execution_id`; cancel uses `timer_id` | One-time reminders to the owning Agent; stop/archive suppress automatic wake and cancel pending timers |
| `read_tool_output` | `ref`; one of optional line range (`offset`, `limit`), character range (`charOffset`, `charLimit`), or literal search (`query`, `contextChars`, `maxMatches`, `caseSensitive`) | Recovers one missing fact from a stored tool result; repeated/excessive reads emit advisory guidance but remain allowed |

Every tool result crosses one bound before model input. Ordinary non-self-bounded results above 8 KiB are stored and receive structured ref metadata so later compaction is recoverable; results above 2000 lines or 50 KiB are immediately rendered as a head/tail preview plus that ref. Full text remains verbatim per Session under `<dataDir>/tool-outputs/<sessionId>/`. `read_tool_output` should use literal `query` search first, line ranges for normal text, and character ranges only when one line is too wide. All modes remain bounded to about 40 KiB. It tracks each ref within the AgentRun and advises the model after duplicate ranges/queries or roughly 64/96 KiB of cumulative reads; it never blocks a justified read. Thresholds use the `SCIENCE_AGENT_TOOL_OUTPUT_*` environment variables documented in `.env.example`.

Shell execution requests `code` permission. Generated files retain diff and derivation audit but become Artifacts only after `declare_artifact`; remote files must first be explicitly copied to local storage. Uploads and governed MCP downloads retain their existing Artifact registration flow.

## Web tools (always available)

| Tool | Parameters | Behavior and boundary |
|---|---|---|
| `web_search` | `query` (1–2000 characters) | Aggregates search engines — keyed paid providers first, then the enabled free engines — and returns the first that answers; snippets and URLs do not prove the page was read |
| `web_fetch` | full public HTTP(S) `url` | Extracts one page; rejects credential URLs and private/loopback targets; no cross-provider fallback |

Node performs permission, CAS, and `WebInvocation` audit, and calls the vendors in-process. See [Web tools](web-tools.md).

## Orchestration tools

| Tool | Condition | Key parameters |
|---|---|---|
| `update_plan` | Always available during an Agent run | complete replacement `plan` snapshot (0–20 items with `step` and status), plus optional `explanation`; an empty list clears it |
| `task` | main run; unavailable inside subagents | `description` ≤80, `prompt` ≤20000, optional Brief v1, up to 50 `inputPaths`, `max_turns` ≤300, `timeout_seconds` ≤3600, `specialistId`, and up to 32 whitelisted `tools`; same-turn calls may run in parallel |
| `query_graph` | ScienceMemory enabled | case-insensitive cross-Session substring `query`; returns `{hits,total,truncated}` |

`update_plan` is a lightweight run-scoped progress snapshot, not an approval gate or a governed entity. Every call replaces the complete plan, so insertion, deletion, reordering, and status changes use the same interface. If a model declares several `update_plan` calls in one LLM step, only the last declared call is committed; earlier calls complete successfully as superseded. The committed `plan.updated` event is retained in the run event stream and folded into the next model step. Main and subagents keep independent snapshots.

## Scientific environment tools

Python and R execute through `run_shell`; separate `run_python` / `run_r` tools are removed. Managed updates occur in place without cloning each revision. See [execution and Workspace lifecycle](../explanation/execution-workspaces.md).

These appear after managed scientific-environment setup and capability injection.

| Tool | Parameters | Behavior |
|---|---|---|
| `environment_list` | optional `runner_id` | Lists the selected Runner's bases and named environments; revisions are audit-only |
| `environment_create` | `name`, `language`; optional `baseEnvironmentId` | Clones a named Python/R environment; prepares R base on first explicit R creation |
| `environment_delete` | `environmentId` | Deletes a named environment; bases are protected |
| `environment_install` | `environmentId`, `packages[]`; optional `manager`, `channels[]`, `indexUrl` | In-place update through conda, pip, CRAN or Bioconductor, depending on installed tools; validates source policies and records actual package state and available provenance |
| `environment_uninstall` | `environmentId`, `packages[]` | Removes conda package specs and creates a revision |

Mutation uses the separate `code / scientific-environments` permission resource. Supported management goes through these tools, not direct package-manager calls in `run_shell`. Pip source presets are Official, Tsinghua TUNA, USTC, and Huawei Cloud; conda presets omit Huawei Cloud. Precedence is per-call source, global source, official upstream. An `indexUrl` is pip-only, HTTPS, at most 2048 characters, and must contain no credentials, query, fragment, whitespace, or control characters. Offline cache mode still validates it but uses `--no-index --find-links`.

```json
{
  "environmentId": "<named-python-env-id>",
  "manager": "pip",
  "packages": ["torch", "torchvision"],
  "indexUrl": "https://download.pytorch.org/whl/cpu"
}
```

## Scientific MCP tools (dynamic)

Enabled sources expose `mcp__<source>__<tool>` with manifest descriptions and schemas. They are deferred: the model first sees names and promotes schemas through `tool_search`. Results are untrusted external data.

| Tool | Condition | Boundary |
|---|---|---|
| `artifact_download` | any MCP source enabled | Uses a prior `mcpInvocationId` and `candidateId`, optional `destinationPath`; waits for permission and terminal download state; never parses PDF |
| `paper_extract_pdf` | paper extraction wired | Accepts a completed `artifactJobId` and performs bounded extraction |

Download and extraction require different model turns because same-turn calls are independent and there is no `dependsOn` mechanism.

## Other conditional tools

| Tool | Condition | Boundary |
|---|---|---|
| `run_npu_job` | Runner has `SCIENCE_AGENT_NPU_BROKER=1` and an NPU workload allowlist loaded | `operation=list_workloads\|submit\|status\|logs\|result\|cancel`; `workload_id` must be allowlisted and `config_path` must be Workspace-relative. `environment_id` resolves the selected environment's latest Revision; omission uses the Session-selected environment. Built-in workloads include `npu.smoke_test` and `antibody.protenix.v1` |
| `read_skill` | at least one selected skill | Compatibility channel that reads full instructions from the frozen selected revision and reports the sandbox package path |
| `read_skill_resource` | a selected skill has text resources | Reads bounded UTF-8 supporting content after the skill; never executes or installs it |
| `create_skill` | the main Agent selected and loaded `skill-creator` with `read_skill` | Creates an inactive, persistent Skill draft from an explicit user description, with optional version and bounded UTF-8 resources. Revisions to the same pending name update one review item and diff against the previous Agent proposal; the conversation provides a review shortcut, and user confirmation publishes the reviewed package as a new immutable Skill Library version |

Skill loading is described in [skill-progressive-disclosure.md](../explanation/skill-progressive-disclosure.md). The complete frozen package of every selected skill is already staged read-only at `$SCIENCEDISCOVERY_SKILLS_DIR/<skillId>` before the sandbox starts, and the prompt lists each package path and package hash. Address a package through that variable rather than its expanded value, which is `/skills` only under bubblewrap. `read_file` and `list_files` page through those package files directly and accept `$SCIENCEDISCOVERY_SKILLS_DIR/...`, `${SCIENCEDISCOVERY_SKILLS_DIR}/...`, or the bare bind path; `run_shell` accepts a `scriptPath` inside a package with explicit `arguments`, without copying anything into the workspace first. `$SCIENCEDISCOVERY_SKILL_EXTENSIONS_DIR` is a writable area reserved for later self-evolution and is empty by default. Staging a package is not the same as auto-executing or installing its `scripts/`; execution requires an explicit Agent call. `read_skill` and `read_skill_resource` remain as compatibility channels.

`run_npu_job` is a separate, opt-in Host NPU Broker, not a general host Shell. The Broker starts fixed allowlisted entry points and checks Session ownership. The Agent selects `environment_id`; the API resolves its latest Revision for the Broker's internal audit field. An old Revision ID is not an environment selector, and submit rejects `environment_revision_id`. Use `environment_list` and managed package tools to prepare dependencies, then pass the environment ID. NPU hardware availability and workload-specific validation remain separate from ordinary sandboxed Shell execution.

## Consistency notes

- Tool descriptions in `packages/workspace/src/workspace.ts` are authoritative; this page is the reference overview.
- Disabled sources/capabilities are absent from `tools[]`; invisibility, not runtime rejection, is the governance boundary.
- Permission and quota failures return structured `{ok:false,error:{code,message,retryable}}` results the model can explain or route around.

## Related documentation

- [Agent backend](../explanation/agent-backend.md)
- [Control plane](../explanation/control-plane.md)
- [Sandbox execution](../explanation/sandbox-execution.md)
- [Ascend NPU Host Broker](../explanation/ascend-npu-runner.md)
