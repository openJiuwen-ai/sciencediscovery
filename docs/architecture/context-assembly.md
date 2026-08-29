# Dynamic context assembly

ScienceDiscovery assembles model context entirely inside the Node process.
`packages/runtime-core` depends only on the stable `ContextAssembler` port;
prompt policy, dynamic contributors, budgets, history windows, and validation
remain implementations in `packages/context`.

No Python process or external agent framework is required for context
assembly.

## Assembly modes

Set `SCIENCE_AGENT_CONTEXT_MODE` before starting the service:

```bash
# Production default: send the Node-assembled dynamic context to the model.
SCIENCE_AGENT_CONTEXT_MODE=dynamic

# Debug comparison: build and trace the dynamic candidate, but send legacy
# input to the model.
SCIENCE_AGENT_CONTEXT_MODE=shadow

# Debug regression: bypass dynamic assembly and reproduce the former path.
SCIENCE_AGENT_CONTEXT_MODE=legacy
```

When `SCIENCE_AGENT_CONTEXT_MODE` is unset, the runtime selects `dynamic`.
`legacy` and `shadow` are retained as debugging and regression-comparison
paths, not normal production modes. `shadow` exercises every dynamic stage and
records its candidate result, while the Agent's actual behavior still uses the
legacy `ModelInput`.

## Node assembly pipeline

Each model turn follows the same sequence:

```text
canonical history
  -> compatibility message-count compaction
  -> ContextContributorRegistry.collectDetailed
  -> applyContextBudget
  -> DeterministicSystemPromptRenderer
  -> token-pressure calculation
  -> HistoryCompactor (old tool bodies, then old closed steps)
  -> re-collect only if model-visible history changed
  -> DefaultContextMessageComposer
  -> AtomicHistoryWindowPolicy
  -> ContextValidator
  -> ModelInput
```

The compacted Node transcript remains canonical. Contributor messages and
attachments are invocation-local and are never written back to Session
history.

| Component | Responsibility |
| --- | --- |
| `ContextContributorRegistry` | Scope filtering, concurrent collection, stable ordering, validation, and required/optional failure policy |
| `DurableContextStore` | Run-scoped structured goal, Plan, Skill, Delegation, Artifact, Review, and Memory state captured at the tool-result boundary |
| `ContextBudgetPolicy` | Protected-section admission and deterministic section/data/message truncation |
| `HistoryCompactor` | Model-aware pressure handling: prune old tool bodies, then summarize old closed LLM steps while retaining a recent token tail |
| `SystemPromptRenderer` | Deterministic section ordering and prompt rendering |
| `ContextMessageComposer` | Invocation-local contributed messages and trust-labelled attachment envelopes |
| `HistoryWindowPolicy` | Recent round/message/token selection without splitting tool call/result pairs |
| `TokenEstimator` | Replaceable token estimation; the default is a conservative provider-neutral estimate |
| `ContextValidator` | Protected authority, governed tool set, and tool-result integrity checks |
| `ContextTraceWriter` | Explicitly enabled, private per-turn assembly and final-input export |

## Contributor model

Each AgentRun freezes its Contributor registry before turn one. Contributors
are scoped to `main`, `subagent`, or `reviewer` and may provide:

- structured System Prompt sections;
- bounded, invocation-local user context messages;
- trusted or untrusted data attachments;
- diagnostics.

Current built-in contributors cover identity, governance, RunContract, current
tool/MCP capabilities, Skill discovery, and structured Plan, Skill,
Delegation, Artifact, Review, and Memory runtime state. Identity, Governance,
and RunContract sections are protected and cannot be silently truncated.

Skill bodies continue to use progressive disclosure. The stable System Prompt
contains only the selected Skill catalog. The complete body enters context
once through the canonical `read_skill` result; dynamic assembly does not copy
it into the System Prompt. A durable Skill reference records the frozen
revision. If compaction removes the original result, the runtime data channel
marks the instructions unavailable so the Agent can call `read_skill` again.
Deferred MCP tools remain absent until ToolRegistry promotion and appear in
the next model turn.

## Durable state and authority

Successful tool results update run-scoped structured channels at the
ToolRegistry result boundary. Concurrent tools may finish in any order, but
their state sequence follows the order declared by the model. On a run created
from canonical gateway history, the store hydrates from structured assistant
tool calls and their matching tool results before compaction.

| Channel | Producer tools | Dynamic projection |
| --- | --- | --- |
| Goal/constraints | immutable RunContract | protected RunContract section; structured snapshot retained by the store |
| Plan | `update_plan` whole-snapshot replacement | protected `plan_state` system section |
| Skill activation | `read_skill` | hidden `active_skills` reference/reminder; never a second Skill body |
| Delegation | `task` | hidden bounded `delegations` data message |
| Artifact | download, extraction, and `declare_artifact` | hidden bounded `artifacts` data message |
| Review | `review_checkpoint`, `trace_provenance` | hidden bounded `reviews` data message |
| Memory | `query_graph`, `declare_evidence`, `declare_claim` | hidden bounded `memory` data message |

System sections contain only runtime authority and stable capability policy.
Tool/model-derived observations use hidden user messages marked
`authority="data_only"`; their values are data and cannot replace system,
governance, permission, or RunContract instructions. These projections are
invocation-local and never alter canonical Session history.

Contributor messages may only use the `user` role. A Contributor cannot forge
an assistant tool call or tool result. Attachments are wrapped as hidden
invocation-local messages with explicit `source` and `trust` attributes.

### Registering a package Contributor

Capability packages expose a `ContextContributorFactory`; they do not import
or modify `NativeAgent`:

```ts
import type { ContextContributorFactory } from "@sciencediscovery/context";
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";

export const memoryContextFactory: ContextContributorFactory<AgentHistoryMessage> = {
  id: "memory.context",
  create({ scope }) {
    return {
      id: "memory.snapshot",
      scopes: [scope],
      async contribute(request) {
        return {
          attachments: [{
            id: "memory.snapshot",
            source: "memory",
            trust: "trusted_data",
            content: await loadBoundedMemorySnapshot(request.contextId),
          }],
        };
      },
    };
  },
};
```

Factory IDs, Contributor IDs, section IDs, and attachment IDs must be unique.
The run-scoped Registry is frozen after composition, so packages cannot mutate
an active run or bypass scope, budgets, ToolRegistry, or authority checks.

## Budgets and history windows

All configured values are positive integers:

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS` | `300000` | Total Contributor System Prompt characters |
| `SCIENCE_AGENT_CONTEXT_SECTION_MAX_CHARS` | `100000` | Maximum characters for one non-protected section |
| `SCIENCE_AGENT_CONTEXT_DATA_BUDGET_CHARS` | `500000` | Total attachment characters |
| `SCIENCE_AGENT_CONTEXT_ATTACHMENT_MAX_CHARS` | `200000` | Maximum characters for one attachment |
| `SCIENCE_AGENT_CONTEXT_CONTRIBUTED_MESSAGE_BUDGET_CHARS` | `100000` | Total string content in contributed messages |
| `SCIENCE_AGENT_CONTEXT_MAX_CONTRIBUTED_MESSAGES` | `50` | Maximum contributed messages |
| `SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS` | resolved model context; `131072` fallback | Optional override for model context capacity, including reserved output |
| `SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS` | model policy `maxTokens` (`16384` by default) | Capacity kept free for the next model response |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_PRESSURE_PERCENT` | `80` | Start history pressure handling at this percentage of the effective model input limit |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_RETAIN_PERCENT` | `16` | Recent canonical-history suffix retained verbatim during summarization; must be below pressure percent |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_TOOL_PREVIEW_BYTES` | `2048` | Total head/tail bytes retained when a stored tool result is compacted |
| `SCIENCE_AGENT_CONTEXT_COMPACTION_SUMMARY_RETRIES` | `1` | Additional attempts after a summary fails to shrink its source segment |
| `SCIENCE_AGENT_CONTEXT_WINDOW_MESSAGES` | unset | Maximum invocation messages; the task anchor, newest atomic step, checkpoints, and open tool calls are retained |
| `SCIENCE_AGENT_CONTEXT_WINDOW_ROUNDS` | unset | Maximum recent user rounds; takes precedence over the message limit |
| `SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS` | unset | Approximate complete input limit, including Prompt, tools, and history |

Protected sections are admitted first. If they alone exceed the Prompt budget,
assembly fails instead of weakening authority. Other sections are admitted by
slot and order and produce explicit truncation/drop diagnostics.

The effective input limit is the smaller of
`SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS` (when set) and
`MODEL_MAX_TOKENS - OUTPUT_RESERVE_TOKENS`. System Prompt, Tool schemas,
contributed data, and history all consume that same limit.

At the pressure threshold, deterministic projection replaces old stored
tool-result bodies with a small head/tail preview plus their structured
`read_tool_output` reference. Results without a retrievable reference are not
blindly erased; they remain available to the summarizer. If pressure
remains, the model summarizes the oldest closed LLM steps into the standing
checkpoint and retains a recent suffix by token cost. This boundary may fall
inside one long user request: the former policy that protected the entire
newest user round allowed autonomous scientific runs to grow without bound.
Stored results remain recoverable through one bounded interface: literal
`query` search first, ordinary line ranges second, and Unicode character
ranges for minified JSON or another over-wide single line. The model chooses
the query or range; the runtime does not automatically search on its behalf.

An assistant tool call and its immediately following tool results remain one
atomic unit. Open calls are never removed or summarized, and the latest LLM
step always retains its call/result structure (a large result body may become
head/tail + ref). The final window keeps the task anchor, checkpoint, newest step, and open calls; if even those
cannot fit, assembly fails clearly before the Provider call.

The summary request receives the full already-bounded source transcript rather
than a second 16,000-character/600-character-tool clipping layer. It must emit
a scientific checkpoint that separates completed work, evidence, decisions,
failed/abandoned leads, explicit pending requirements, optional leads, and one
next step. A lightweight structural validator normalizes missing/duplicate
sections and reports invalid shape or unknown stored-output refs; it does not
judge evidence sufficiency or force task convergence. A checkpoint that is
not smaller than the source segment is rejected and retried within the
configured bound; failure leaves deterministic pruning in place but does not
replace history with a larger summary.

If a Provider nevertheless rejects the request as a context-window overflow,
its adapter normalizes that error. Runtime Core asks the Assembler for one
forced pressure pass and retries the same LLM turn exactly once. A second
overflow is surfaced; it cannot create an unbounded retry loop.

The built-in `ConservativeTokenEstimator` intentionally overestimates mixed
Chinese/English scientific text. A Model Provider can inject an exact tokenizer
through the `TokenEstimator` interface without changing the Assembler.

## Context trace

Detailed export is disabled by default:

```bash
SCIENCE_AGENT_CONTEXT_TRACE=1
# Optional; default is <data-dir>/context-traces
SCIENCE_AGENT_CONTEXT_TRACE_DIR=/secure/local/context-traces
```

One private JSON file is written per model turn. A forced recovery is written
beside the original attempt rather than overwriting it:

```text
<trace-dir>/<context-id>/turn-0001.json
<trace-dir>/<context-id>/turn-0001-recovery-1.json
```

Trace schema v4 contains:

- mode, Agent scope, selected path, and resolved budgets;
- each Contributor's raw output, duration, status, and error;
- validated collection before budget admission;
- sections, attachments, messages, and diagnostics after admission;
- rendered Prompt, section IDs, invocation history, tools, window statistics,
  and window diagnostics in `renderedContext`;
- compaction reason, estimated tokens before/after, compacted tool-output refs,
  summary source/checkpoint cost, attempt/rejection counts, summarized-message
  count, and recovery reason/attempt;
- the exact `llmInput` passed to `ProviderModelClient`.

In `shadow`, `renderedContext` is the dynamic candidate while `llmInput` is the
legacy input actually selected for the model.

Trace files use mode `0600`, but contain user messages, tool inputs/results,
Skill metadata, retrieved content, and complete prompts. Treat them as
sensitive local debugging data and do not upload them automatically.

## Automated verification and examples

The integration test runs the real in-process path while replacing only the
external LLM transport with a deterministic recorder:

```bash
pnpm --filter @sciencediscovery/api build
pnpm --filter @sciencediscovery/api test
```

It covers all three modes, main/Subagent/Reviewer scopes, dynamic package
registration, Skill loading, deferred MCP promotion, model-aware budgets,
trace phases, exact inputs received by `ProviderModelClient`, and a history
over the compaction threshold that retains Plan and Skill references without
duplicating the Skill body.

Export the three reproducible examples with:

```bash
SCIENCE_AGENT_CONTEXT_EXAMPLE_DIR=.tmp/context-examples \
  node --test services/api/dist/native-agent/context-assembly.integration.test.js
```

See [context assembly examples](./context-assembly-examples.md).

## Delivery boundary

The current run-scoped Artifact, Review, Memory, and Delegation projections are
fed by ordinary governed tool results; they do not bypass the owning domain
packages or query their stores directly. Future richer retrieval Contributors
belong to their owning packages and register through
`ContextContributorFactory`. `packages/context` owns the generic state,
registration, collection, admission, rendering, windowing, validation, and
observation contracts.

A single versioned all-encompassing Context Config and deep equality checks for
tool descriptions/parameter schemas remain possible normalization work, not
requirements for the current implementation.
