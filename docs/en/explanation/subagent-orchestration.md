# Subagent Orchestration and Governance

## 1. Overall model

ScienceDiscovery runs **one native loop per AgentRun**: the main agent and each child are separate `NativeAgent.execute()` calls inside the same Node control-plane process.

```text
main AgentRun (native loop) → task handler in API → child AgentRun (native loop)
                            ← finalMessages + result summary ← child
```

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

Each child writes only `subagents/<subagentId>/`; runner mounts the parent Session workspace read-only. Explicit `inputPaths`, or paths mentioned in prompt/Brief, are copied to `inputs/<original>` for audit and mirrored at `<original>` for relative access. Count/file/total limits apply; skipped excess files are recorded without aborting initialization.

## 8. Capability boundary

ScienceDiscovery has the Node-executed `task` tool, lead orchestration prompt, API 10/50 limits, structured result contract, repeated-call guard, runtime summary checkpoint, and read-only parent workspace. It deliberately does not share one mutable state across main and child, and child nesting stays disabled. Per-run token hard budgets are also absent; usage, timeout, and turn limits are returned/enforced instead.

Shared state and re-nesting would add orchestration power but require a shared checkpointer and cross-run mutable state. Keeping "Node is the only source of truth, each run is independent" retains the most important prompt, limit, result, summary, and loop protections.

## 9. Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Skill progressive disclosure](skill-progressive-disclosure.md)
- `packages/context/src/workspace-prompt.ts`
- `packages/workspace/src/workspace.ts`
- `packages/orchestration/src/subagents.ts`, `run-profile.ts`
- `services/api/src/runs/index.ts`
- `services/api/src/native-agent/index.ts`, `compaction.ts`
- `services/runner/src/executor.ts`
