# Built-in Tools Visible to the Model

This page lists tools visible inside the agent loop. `createWorkspaceTools` in `packages/workspace` builds them, while `packages/tools` owns registration and dispatch policy; implementations live in the Node control plane while the gateway receives only names, descriptions, and JSON Schema. Except for tools marked always available, Session configuration controls visibility, and `toolPolicy` can further restrict a subagent to a whitelist.

## Base tools (always available)

| Tool | Parameters | Behavior and boundary |
|---|---|---|
| `list_files` | none | Recursively lists workspace paths, sizes, and mtimes; skips symlinks; at most 500 |
| `read_file` | `path` | Reads UTF-8 text within the workspace, at most 1 MiB, after escape validation |
| `list_artifacts` | none | Lists user-visible Project Artifacts across Sessions, including origin, creation snapshot, and latest version |
| `read_artifact` | `artifact_id` or `name`; optional `version` | Reads a Project Artifact version; UTF-8 for text, base64 for binary, at most 1 MiB |
| `declare_artifact` | `path` or `paths` (1–50); optional `name`, `description` | Declares writable workspace files as Project Artifacts. Batch entries succeed/fail independently. Logical names can form virtual sidebar directories without moving files; the server infers preview kind |
| `run_python` | `code`; optional `environmentRevisionId`, `kernelMode` | Runs Python in Bubblewrap; default ephemeral process, optional managed environment and persistent kernel; non-zero exit is a tool error |
| `run_shell` | exactly one of `command`, `scriptPath`; optional `arguments`, `kernelMode` | Bounded workspace shell; network follows the sandbox network access policy (no network by default). Default persistent Session shell carries `cd`, allowed environment changes, and `source` into later shell/Python/R calls; `ephemeral` is clean |

First Python/shell execution requests `code` permission. Generated files retain diff and derivation audit but become Artifacts only after `declare_artifact`; uploaded files, MCP downloads, and collected job outputs are registered at their control-plane entry point.

## Web tools (always available)

| Tool | Parameters | Behavior and boundary |
|---|---|---|
| `web_search` | `query` (1–2000 characters) | Aggregates search engines — keyed paid providers first, then the enabled free engines — and returns the first that answers; snippets and URLs do not prove the page was read |
| `web_fetch` | full public HTTP(S) `url` | Extracts one page; rejects credential URLs and private/loopback targets; no cross-provider fallback |

Node performs permission, CAS, and `WebInvocation` audit, and calls the vendors in-process. See [Web tools](web-tools.md).

## Orchestration tools

| Tool | Condition | Key parameters |
|---|---|---|
| `propose_plan` | main run | `scope` ≤2000, 1–20 `steps`, `feasibilityConfidence`, optional `caveats`; records progress without gating work |
| `task` | main run; unavailable inside subagents | `description` ≤80, `prompt` ≤20000, optional Brief v1, up to 50 `inputPaths`, `max_turns` ≤300, `timeout_seconds` ≤3600, `specialistId`, and up to 32 whitelisted `tools`; same-turn calls may run in parallel |
| `query_graph` | Science Memory enabled | case-insensitive cross-Session substring `query`; returns `{hits,total,truncated}` |

## Scientific environment tools

These appear after managed scientific-environment setup and capability injection.

| Tool | Parameters | Behavior |
|---|---|---|
| `run_r` | like `run_python` | Runs in a managed R revision and reports revision/kernel mode |
| `environment_list` | none | Lists global read-only bases, named environments, and current immutable revisions |
| `environment_create` | `name`, `language`; optional `baseEnvironmentId` | Clones a named Python/R environment; prepares R base on first explicit R creation |
| `environment_delete` | `environmentId` | Deletes a named environment; bases are protected |
| `environment_install` | `environmentId`, `packages[]`; optional `manager`, `channels[]`, `indexUrl` | Defaults to conda; Python also supports PyPI specs or a Session-relative `.whl` through pip; validates HTTPS index and channel policies and creates a revision |
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
| `run_npu_job` | Runner has `SCIENCE_AGENT_NPU_BROKER=1` and an NPU workload allowlist loaded | `operation=list_workloads\|submit\|status\|logs\|result\|cancel`; `workload_id` must be allowlisted and `config_path` must be relative to the current Session workspace. Python workloads select a managed scientific environment with `environment_revision_id`, or use the Session revision when omitted. Built-in workload IDs are `npu.smoke_test` and `antibody.protenix.v1` |
| `describe_skill` | at least one selected skill | Searches metadata and resource summaries; does not return full instructions |
| `read_skill` | at least one selected skill | Reads full instructions from the frozen selected revision |
| `read_skill_resource` | a selected skill has text resources | Reads bounded UTF-8 supporting content after the skill; never executes or installs it |

`run_npu_job` is not a general host shell. It turns Agent requests into Host NPU Broker job operations inside Runner. The Broker starts only fixed entry points from the JSON allowlist and checks the current Session for status, logs, result, and cancel operations. Default Python workloads resolve `environment_revision_id` through Runner's `.sciencediscovery-data/scientific-envs/` store, so the Agent cannot submit an arbitrary interpreter path. A skill should inspect environments with `environment.list`, probe a candidate revision with `run_python`, and use `environment.create` / `environment.install` when dependencies are missing before submitting the returned revision ID. The built-in antibody workload uses the Protenix path, `antibody.protenix.v1`; other model backends require explicit custom allowlist entries or a future extension.

## Consistency notes

- Tool descriptions in `packages/workspace/src/workspace.ts` are authoritative; this page is the reference overview.
- Disabled sources/capabilities are absent from `tools[]`; invisibility, not runtime rejection, is the governance boundary.
- Permission and quota failures return structured `{ok:false,error:{code,message,retryable}}` results the model can explain or route around.

## Related documentation

- [Agent backend](../explanation/agent-backend.md)
- [Control plane](../explanation/control-plane.md)
- [Sandbox execution](../explanation/sandbox-execution.md)
- [Ascend NPU Host Broker](../explanation/ascend-npu-runner.md)
