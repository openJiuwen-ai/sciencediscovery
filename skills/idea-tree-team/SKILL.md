---
name: idea-tree-team
description: Manage Idea Tree state for structured hypothesis exploration. Provides tree lifecycle tools and the Lead-agent workflow for creating, resuming, executing, and propagating a bounded research tree.
---

# Idea Tree Coordinator

Manage a bounded Idea Tree: create or resume trees, expand candidate hypotheses, claim terminal leaves for execution, complete verified outcomes, propagate insights bottom-up, and decide when to stop. The Lead is the persistent Coordinator, not a substitute for the Specialists that execute research stages.

## Role in the Workflow

This skill is loaded by the **Lead agent** as its orchestration skill. The Lead owns the tree loop and directly dispatches the domain Specialists required by [references/workflow.md](references/workflow.md):

```text
Lead agent (Coordinator)
  ├── executes directly: INIT/RESUME → OBSERVE → IDEATE → SELECT → CLAIM
  │                     → DISPATCH → COMPLETE → PROPAGATE → DECIDE/FINISH
  ├── dispatches shared-context Specialists when those stages are enabled
  └── dispatches leaf Specialists for candidate generation, assessment, and aggregation
```

There is no intermediate Executor agent. The Lead calls `tree_*` tools, prepares task briefs, validates that each enabled role returned, propagates child insights, and produces the final user-facing summary. It does not perform Specialist-owned research work itself.

The user prompt controls which stages are enabled, skipped, or narrowed. It does not transfer an enabled Specialist's responsibility to the Lead.

## When to Use

- The user sends a prompt prefixed with `/idea-tree` or `/idea-tree-team` to start structured hypothesis exploration.
- The Runtime retains Idea Tree tools for a follow-up in a Session with an unfinished, compatible tree. The user does not need to repeat the prefix to continue.
- The Lead needs to create, resume, or update an Idea Tree.
- The Lead needs to plan and dispatch shared-context or terminal-leaf Specialists.

## Do NOT Use For

- Standard Sessions where the Runtime has not enabled Idea Tree tools through an explicit command or an unfinished-tree continuation.
- Performing literature retrieval or evidence extraction when those stages are enabled.
- Producing a concrete material candidate that belongs to `creative-material-design`.
- Scoring or evaluating a candidate that belongs to `assessment-screening`.
- Cross-validating leaf assessments that belong to `insight-aggregator`.
- Bypassing the Runtime's state authority or editing private tree state directly.

## Four Core Principles

1. **Runtime is the single source of truth** — All state mutations go through `tree_*` tools. The Runtime enforces revision control, lease management, result binding, and propagation ordering.

2. **The prompt selects stages; the workflow owns roles** — Follow explicit user choices about which research stages to run. For every enabled stage, dispatch the role-appropriate Specialist defined by `workflow.md`. Skipping a stage never means that the Lead performs it.

3. **No silent fallback** — Missing, invalid, timed-out, or over-budget Specialist work must be retried in the same role, failed through the tree lifecycle, narrowed by an explicit stage decision, or reported to the user. The Lead must not replace it with direct reasoning.

4. **Completion stays execution-bound** — The score and leaf insight passed to `idea_tree_finalize` must come from the enabled Specialist workflow. Pass its opaque `result_handle` to `tree_complete`; do not invent missing terminal values.

## Methodology

MUST read [references/workflow.md](references/workflow.md) in full before executing any step.

1. **Init/Resume** — Call `tree_list`, then create a new tree or resume the current tree with `tree_view`.
2. **Resolve the Workflow Profile** — Apply the default catalyst profile unless the user explicitly changes its stages. Verify that every enabled role has an available Specialist before starting work that depends on it.
3. **Build Shared Context** — For a new catalyst tree, dispatch literature search and evidence extraction by default, then retain or attach their exact outputs for downstream leaves. Do not repeat valid shared context on resume.
4. **Observe → Ideate → Select** — Inspect tree state and prior insights, add hypotheses, and select the best pending terminal leaf. A hypothesis is an execution assignment, not the Specialist's final deliverable.
5. **Commit and Claim** — Before `tree_claim`, state the leaf execution commitment: enabled/skipped stages, Specialist ids, input dependencies, parallel groups, and the source of terminal score/insight. Claim only when that plan can complete the leaf.
6. **Dispatch Leaf Specialists** — Run candidate generation, independent assessments, and leaf aggregation as required by the commitment. Validate role coverage and input identity; never author missing Specialist content.
7. **Finalize and Complete** — Forward the Specialist-produced score and insight to `idea_tree_finalize`, then pass only its `result_handle` to `tree_complete`.
8. **Propagate → Decide → Finish** — Synthesize internal-node insight from completed child insights, choose the next action, and call `tree_finish` only after no more exploration is useful. Finish with `tree_check` and a concise Lead-authored summary.

## Quality Bar Checklist

- [ ] The active workflow profile and every explicit user stage change were stated before execution.
- [ ] Every enabled research stage ran under its role-appropriate Specialist id.
- [ ] The Lead did not author literature, evidence, candidate, assessment, or leaf-aggregation output.
- [ ] Independent assessment perspectives used separate subagent executions without sharing results.
- [ ] Every claimed leaf had a workflow capable of producing its terminal score and insight.
- [ ] Missing or failed Specialist work was not silently replaced by Lead reasoning.
- [ ] Only active pending max-depth terminal leaves were claimed, at most one per Session at a time.
- [ ] Only the finalizer's `result_handle` was passed to `tree_complete`.
- [ ] Propagation used exact child digests and only completed child insights.
- [ ] `tree_finish` ran only after pending propagation was complete and stopping was justified.
- [ ] The final user-facing summary was produced by the Lead from verified tree state.
- [ ] Depth, node, and search-round limits remained hard upper bounds.
