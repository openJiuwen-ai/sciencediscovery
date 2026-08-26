# Execution modes

Execution modes are run-scoped capability plugins. They let an Agent choose a workflow without adding mode-specific branches to `runtime-core` or weakening Governance.

## Runtime flow

1. The composition root builds the ordinary governed tool implementations.
2. It registers those tools with one or more execution-mode plugins.
3. At the first model turn, only `activate_execution_mode` is exposed. Its schema lists the registered modes.
4. The Agent activates one mode. Mode-specific tools become visible on the next model turn.
5. The existing Tool Registry dispatches calls and the existing Governance layer still decides whether dangerous operations require approval.
6. Dynamic Context Assembly collects the active mode state and any contributors owned by that mode on every turn.

Activation and a newly exposed tool cannot be combined in one model response. The Agent must observe the activation result before using that mode's capabilities. A run may activate one primary mode; switching modes in place is deliberately unsupported in v1.

## Package responsibilities

| Package | Responsibility |
| --- | --- |
| `packages/execution-modes` | Plugin contract, run-scoped Registry, activation tool, mode-state context bridge |
| `packages/direct-mode` | Direct execution descriptor and the pre-existing execution capability set |
| `packages/plan-mode` | Plan lifecycle tools, persistence port, Plan context contributor |
| `packages/tools` | Applies the active mode's dynamic visibility policy before schema exposure and dispatch |
| `packages/context` | Collects registered contributors; it does not know about Plan Mode |
| `services/api` | Composes built-ins, adapts SessionStore to the Plan repository port, and projects events to HTTP/SSE |
| `apps/web` | Renders persisted Plan state as a live Todo card in the conversation timeline |

`runtime-core` remains provider- and product-neutral. It sees only a Context Assembler, Model Client, and Tool Dispatcher.

## Built-in modes

### Direct Mode

Direct Mode exposes the pre-existing governed tools and keeps the former unstructured execution behavior. It does not maintain a formal task plan.

### Plan Mode

Plan Mode exposes the ordinary execution tools plus:

- `propose_plan`: create the one plan associated with the current run.
- `revise_plan`: replace its scope, caveats, confidence, and steps using optimistic version checking.
- `update_plan_step`: set a step to `pending`, `in_progress`, `blocked`, or `completed`.
- `abandon_plan`: record that the plan no longer applies without undoing completed work.

When every step becomes `completed`, the repository derives the plan's `completed` state. Plan Mode is not a permission or approval mode: ordinary tools remain usable, and a missing `propose_plan` call does not make an execution tool illegal. The model-facing prompt asks the Agent to maintain plan state; it does not hard-gate execution.

Plan state is persisted by SessionStore and scoped by `runId`. Updates retain the existing `plan.proposed` SSE compatibility event so current clients upsert the same card, while execution-mode activation has its own `execution_mode.changed` event.

## Context behavior

With the default dynamic assembler, the Registry contributes either the mode catalog or the active mode on every model turn. Plan Mode additionally contributes the latest plan in the protected `task_state` slot. Other modes can register their own contributor factories without editing the assembler.

Legacy and shadow context modes are debugging paths. Tool visibility still follows the selected execution mode, but only dynamic assembly guarantees fresh structured mode state outside ordinary tool-result history.

## Extension example

A package adds a mode by exporting an `ExecutionModePlugin` with a stable descriptor, its tool objects, and optional Context Contributor factories. The application composition root registers it before the run starts. No `if (modeId === ...)` branch belongs in `runtime-core`, Context Assembler, or the HTTP transport.

Arbitrary user-uploaded executable plugins, multiple simultaneous primary modes, strict plan approval, and hot switching are outside v1.

## Read APIs

- `GET /api/execution-modes` lists built-in mode descriptors.
- `GET /api/sessions/{sessionId}/runs/{runId}/mode` returns the persisted active mode for a run.

The model activates modes through `activate_execution_mode`; the HTTP API does not bypass the Agent loop to mutate a live run.
