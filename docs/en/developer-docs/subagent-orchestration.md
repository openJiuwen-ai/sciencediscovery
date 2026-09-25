# Subagent Orchestration and Governance

## 1. Overall model

ScienceDiscovery defaults to platform `task` dispatch: each child receives an independent
AgentRun. Dispatch and execution are separate choices. With the JiuwenSwarm executor,
both the main and platform-dispatched children execute through Swarm; the built-in
executor instead uses the Node agent loop.

```text
main (Swarm) → platform task / child AgentRun → child (Swarm)
             ← finalMessages + result summary ← child
```

With `SCIENCE_AGENT_EXECUTOR=jiuwenswarm`, set
`SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` and restart the service:

| Value | Behavior |
| --- | --- |
| Unset, empty or `task` | Default: platform dispatch with Swarm execution, platform sandbox/permissions/artifact handoff/audit |
| `jiuwenswarm` | Swarm-native `subagent_spawn` / `subagent_wait`, outside the platform task lifecycle |

Unknown values are rejected at startup. Direct API startup and launcher scripts share
the same default. Swarm-native mode also requires its native tools to remain enabled
(`SCIENCE_AGENT_JIUWENSWARM_TOOLS` must not be `ours`). Native children use Swarm's own
tools and lifecycle, without platform task workspace/approval/provenance parity.
This setting does not switch the executor back to the Node loop.

Main and child share **no mutable state**: each AgentRun owns its history, tool table, and time budget, and the handoff points are an explicit `finalMessages` plus the structured `task` result. Node retains authoritative history, permissions, workspace, tools, and audit. A child cannot call `task` again, and cross-run handoff relies on the previous run's `finalMessages` plus Node state.

## 2. Lead-prompt orchestration

When `task` is available, `<subagent_system>` tells the main Agent to decompose independent work, delegate multiple calls in one turn, then synthesize results. API and prompt cap task calls at 10 per model response and 50 child Agents per user request. Small reads/commands/edits/calculations and requests needing clarification stay with the main Agent.

## 3. Child run contract

The main first-user input and each child's delegated prompt/Brief/handoff are injected as `<run_contract>`, not ordinary messages. They therefore are not summarized away and keep goal, scope, constraints, and deliverables fixed across long contexts.

## 4. Result contract

`task` returns status/stop reason, token usage, model name, a short result brief and SHA256, validation, and validated/raw structured results. With `outputJsonSchema`, the server validates the last non-empty assistant output as one JSON object. Failure marks the child failed rather than treating invalid content as normal structured output.

### 4.1 Subagent Brief v1 contract

`brief` requires a 1–2000-character `goal`, 1–20 constraints, 1–20 output requirements, and 1–12 collaboration rules (each 1–1000 characters). An optional JSON Schema 2020-12 is at most 20,000 serialized bytes and depth 64. The server owns `version`, starting at 1 and incrementing on PATCH; a client-supplied value is ignored.

The schema compiles on create and PATCH; invalid, unknown-keyword, or oversized input returns 400. Completion validates the last non-empty assistant step as one JSON object. Failure marks the subagent `failed` and retains `resultValidation` / `rawStructuredResult` without setting `structuredResult`.

`PATCH /api/sessions/:sessionId/subagents/:subagentId/brief` is allowed for `completed` / `failed`, returns 409 for `running` / `cancelled` / `timed_out`, 404 when absent, and 400 for an invalid Brief or schema.

## 5. Tool-loop protection

The native loop's tool dispatch detects the same tool with identical arguments; main and child share the same `executeTool` path, so both are covered. Call 10 returns `REPEATED_TOOL_CALL`; call 20 returns hard-stop `TOOL_LOOP_DETECTED`. This does not depend on prompt compliance.

## 6. History summarization and handoff

Compaction happens inside the native loop (`services/api/src/native-agent/compaction.ts`). Within a run, older messages are summarized into one hidden checkpoint message, and the next compaction merges the previous summary forward rather than stacking layers; see [agent-backend.md](agent-backend.md) §7. There is only one summarization layer, `finalMessages` controls cross-run handoff with no extra pre-summarization, and non-droppable boundaries live in `runContract`.

## 7. Child workspace

Each child has a separate Workspace identity on each Runner. Its local physical root is a sibling of the main Workspace, not a directory inside it; `subagents/<subagentId>/` remains a logical audit/file-reference prefix. New children do not mount the parent Workspace, even read-only. Explicit `inputPaths`, or paths mentioned in prompt/Brief, are copied to `inputs/<original>` for audit and mirrored at `<original>` for relative access. Unselected parent files are not available to the child. Count/file/total limits apply; skipped excess files are recorded without aborting initialization. The Runner retains optional read-only mount support, but child startup does not pass the parent root.

## 8. Capability boundary

ScienceDiscovery has the Node-executed `task` tool, lead orchestration prompt, API 10/50 limits, structured result contract, repeated-call guard, runtime summary checkpoint, and independent child Workspaces with explicit input copying. It deliberately does not share one mutable state across main and child, and child nesting stays disabled. Per-run token hard budgets are also absent; usage, timeout, and turn limits are returned/enforced instead.

Shared state and re-nesting would add orchestration power but require a shared checkpointer and cross-run mutable state. Keeping "Node is the only source of truth, each run is independent" retains the most important prompt, limit, result, summary, and loop protections.

## 9. Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Skill progressive disclosure](skill-progressive-disclosure.md)
- `packages/workspace/src/prompt.ts`
- `packages/workspace/src/workspace.ts`
- `packages/orchestration/src/subagents.ts`, `run-profile.ts`
- `services/api/src/runs/index.ts`
- `services/api/src/native-agent/index.ts`, `compaction.ts`
- `services/runner/src/executor.ts`

## 10. Agent-scoped audit snapshots

Native task dispatch owns the task catalog whether the executor is the native loop or JiuwenSwarm. Snapshot collection receives the session ID, the current request execution ID, and the child task ID when applicable. A child captures its own task record, execution provenance, notification inbox, timers, shell executions, and transfers. It does not capture the sibling task catalog. The main Agent captures the task directory and its own execution authorities; shared permissions, artifacts and environment records remain session resources.

Task directory entries contain immutable `SubagentAuthority` references rather than inline transcripts. Each reference preserves the complete task record at capture time, including its continuation context reference. Unchanged catalog objects reuse their reference; updating a task or its Brief creates a new revision. UI and native task APIs continue to read full records from the catalog. Existing snapshots remain readable; no persisted catalog migration is required.

This isolates snapshot contents, not model prompts or authorization policy. State Pool closure validation still checks referenced objects, including continuation history. Historical closure traversal and duplication of other shared resource snapshots remain separate performance work; this change alone does not establish an end-to-end timeout fix.
