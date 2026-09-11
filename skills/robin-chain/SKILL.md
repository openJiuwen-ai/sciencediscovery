---
name: robin-chain
description: Use this skill when the user's task decomposes into stages with explicit sequential dependencies (a retrieve → screen → analyze → synthesize pipeline) where each stage must be independently auditable and individually re-runnable on failure. Provides the Robin-style minimal orchestration — 2-4 single-responsibility atomic agents chained explicitly, contract-first JSON handoffs between legs, per-leg persistence for auditability, and single-leg failure isolation. For open-ended multi-round deliberation see virtual-lab; for multi-candidate generate-and-rank see hypothesis-tournament; for graph-whitespace debates see idea-debate (when available).
---

# Atomic Agent Chain (Robin-style minimal orchestration)

After Robin (2025): a few **atomic agents** (each does ONE kind of thing) +
explicit chaining beats a complex orchestrator. Core disciplines: **atomicity
(one leg, one action type), contract first (write the handoff schema before
running any leg), failure isolation (a failed leg re-runs alone), and short
chains (two legs beat three).**

> Every step should involve tool calls. Chain structure, per-leg status, and
> handoff contracts live in the `research_state` world model — resume from
> the broken leg after compaction or interruption.

## Stage 0: Leg decomposition and contract definition

- Split the task into **2-4 atomic legs**. Each leg defines three things:
  - **Responsibility** (one sentence, a single action type: retrieve /
    screen & evaluate / analyze / synthesize)
  - **Input contract** (what fields it receives from the previous leg)
  - **Output contract** (what fields it hands on — written as a JSON Schema)
- If a leg's responsibility mixes two action types ("retrieve AND
  conclude"), split it into two legs. Atomicity is the prerequisite for all
  later audit and re-run capability.
- `research_state(set-goal)` pins the task goal; `plan-add` records the
  chain structure (legs, contracts, status).

## Stage 1: Per-leg execution

Dispatch each leg **individually** with the `task` tool, in dependency
order:
- Put the leg's output contract into `brief.outputJsonSchema` — the runtime
  validates the subagent's final JSON against it (fail-open: a validation
  failure is reported, not blocked). On failure, inspect the leg's output
  manually and decide: fix-and-rerun or patch the contract fields by hand —
  off-contract output must never reach the next leg silently.
- Independent legs (no dependency between them) may be dispatched in the
  same turn to run concurrently.

## Stage 2: Handoffs between legs

- Each leg's output is persisted to a workspace file (the path is the audit
  anchor; write with `run_python` if the content did not arrive as a file)
  and the contract-specified structured fields are injected into the next
  leg's `brief`.
- **Hand off only the contract fields** — do not stuff the previous leg's
  entire intermediate process into the next one. Context isolation is the
  atomic chain's core payoff (each leg's context stays clean of upstream
  noise).
- Track handoffs (which leg, what was delivered, contract validation
  outcome) with `research_state(plan-update)`.

## Stage 3: Audit and single-leg re-runs

- Any leg whose output is unacceptable (empty, off-contract, visibly
  distorted): **re-run only that leg** — fix the input or prompt and
  re-dispatch it alone; downstream legs re-run only if the contract output
  actually changed.
- No "re-run the whole chain" fallback. No hard retry cap, but when the same
  leg fails repeatedly, stop and report the failure honestly to the user
  instead of retrying forever.
- The final answer lists every leg's output file path so the user can
  inspect leg by leg.

## Stage 4: Synthesis

- Final leg's output + **chain provenance**: each key conclusion is labeled
  with which leg produced it and which upstream delivery it built on.
- The final answer includes the leg structure and per-leg status; the full
  process and intermediate outputs are persisted for review. Register the
  final deliverable with `declare_artifact`.
- Key factual conclusions are registered in `evidence_ledger(add)` with
  their evidence anchors (missing sources marked honestly, never
  back-filled).

## Rules

- Atomicity: one leg, one kind of action; mixed responsibility → split.
- Contract first: handoff schemas are written before any leg starts, never
  retrofitted.
- Failure isolation: a failed leg re-runs alone; its half-baked output never
  flows downstream.
- Chain-length discipline: 2-4 legs; if you are drafting 5+, re-check
  whether mergeable same-type actions were shredded.
- Do not hardcode leg counts or per-leg turn budgets — scale to task
  complexity.
