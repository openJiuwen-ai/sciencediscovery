# Subagent Orchestration and Governance

## 1. Overall model

ScienceDiscovery uses Node orchestration and an independent gateway `/run` per agent:

```text
main /run → task callback in API → child AgentRun /run
          ← final_messages + result summary ← child
```

Unlike DeerFlow's nested graph/state update, gateway is a stateless sidecar and Node retains history, permission, workspace, tools, and audit. A child cannot call `task` again, and cross-run handoff relies on gateway `final_messages` plus Node state. Existing permission, runner sandbox, provenance, and UI remain in Node.

## 2. Lead-prompt orchestration

When `task` is available, `<subagent_system>` tells the main Agent to decompose independent work, delegate multiple calls in one turn, then synthesize results. API and prompt cap task calls at 10 per model response and 50 child Agents per user request. Small reads/commands/edits/calculations and requests needing clarification stay with the main Agent.

## 3. Child run contract

The main first-user input and each child's delegated prompt/Brief/handoff are injected as `<run_contract>`, not ordinary messages. They therefore are not summarized away and keep goal, scope, constraints, and deliverables fixed across long contexts.

## 4. Result contract

`task` returns status/stop reason, token usage, model name, a short result brief and SHA256, validation, and validated/raw structured results. With `outputJsonSchema`, the server validates the last non-empty assistant output as one JSON object. Failure marks the child failed rather than treating invalid content as normal structured output.

## 5. Tool-loop protection

Node detects the same tool with identical arguments across both main and child callbacks. Call 10 returns `REPEATED_TOOL_CALL`; call 20 returns hard-stop `TOOL_LOOP_DETECTED`. This does not depend on prompt compliance.

## 6. History summarization and handoff

Gateway uses DeerFlow summarization and durable-context middleware. Within a run, old messages can become `summary_text`; at completion it becomes a hidden checkpoint inside `final_messages`. Node does not pre-summarize history again. Gateway controls within-run compression, `final_messages` controls cross-run handoff, and non-droppable boundaries live in `runContract`.

## 7. Child workspace

Each child writes only `subagents/<subagentId>/`; runner mounts the parent Session workspace read-only. Explicit `inputPaths`, or paths mentioned in prompt/Brief, are copied to `inputs/<original>` for audit and mirrored at `<original>` for relative access. Count/file/total limits apply; skipped excess files are recorded without aborting initialization.

## 8. DeerFlow trade-offs

ScienceDiscovery has the Node-executed `task` tool, lead orchestration prompt, API 10/50 limits, structured result contract, repeated-call guard, runtime summary checkpoint, and read-only parent workspace. It deliberately does not integrate same-graph nesting or child nesting. Per-run token hard budgets are also absent; usage, timeout, and turn limits are returned/enforced instead.

Keeping the Node source of truth avoids making gateway stateful while retaining the most important prompt, limit, result, summary, and loop protections.

## 9. Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Skill progressive disclosure](skill-progressive-disclosure.md)
- `packages/agent-runtime/src/runtime.ts`, `workspace.ts`
- `services/api/src/runs/index.ts`, `gateway-agent.ts`
- `services/gateway/src/science_agent_gateway/server.py`
- `services/runner/src/executor.ts`
