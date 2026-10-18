---
name: iai-reviewer-patrol
description: >-
  Use for Issue-as-Interface review-bot in opt-in suggest/staging mode: PR
  triage then Magpie review; execute continue + human-need; only propose
  merge/close. Prefer iai-reviewer-execute for the default high-authority
  review-bot. Authority comes from host wiring, not a phase number.
---
# Issue-as-Interface — Reviewer (suggest mode, opt-in staging)

Safer staging path for open worker PRs when the host **intentionally** withholds merge/close. Read [issue-as-interface-contract](../issue-as-interface-contract/SKILL.md). Run [magpie-pr-review-pipeline](../magpie-pr-review-pipeline/SKILL.md) after the triage gate.

**IAI review-bot default is execute** — wire [iai-reviewer-execute](../iai-reviewer-execute/SKILL.md) unless you explicitly want propose-only. This skill is **opt-in** safer staging.

**A running review-bot has no phase identity.** Suggest vs execute is decided by the **host/routine** that wires this skill (or `iai.reviewer.mode=suggest` / `allow_merge=false`). Loading this skill ≡ suggest mode.

**Suggest-mode authority:** execute `continue` and `human-need`. **Propose only** `merge-close` / `merge-keep-open` (report/draft; do not merge or close).

## When to use

- Host/routine explicitly loads this skill for staging / dry-run
- Scheduled patrol without merge authority (`allow_merge=false`)
- After worker marks `pr-ready` / `pr-updated` when merge is deferred

## Cold start (full inventory)

On **first boot**, after restart, empty/missing ledgers, or host `cold_start=true`:

1. List **all open issues** and **all open PRs** in the configured repo (paginate; do not stop at the first page).
2. Record for each: number, title, labels, assignees, updatedAt, and for PRs: draft, mergeable, CI rollup, linked issues.
3. Reconcile into ledgers: rebuild or repair `active-tasks` from `agent-claimed` / open worker PRs; note orphans; never invent claimed work.
4. Classify into buckets: `agent-ready` (claimable), in-flight IAI, `human-need`, needs-clarification, other open, draft PRs, reviewable PRs, stale candidates.
5. Only after the inventory is written may normal incremental patrol (deep Magpie review) run.

Subsequent patrols may be incremental; re-run cold start when ledgers and GitHub diverge badly.

## Each patrol

1. If cold start just ran, use that PR inventory; else find PRs in active ledger with `pr-open` or `in-review` (and any open non-draft PRs linked to agent-ready/claimed issues missing from the ledger).
2. **PR triage (P4):** skip drafts (unless asked), obviously stale/unreviewable, or missing linked issue when closure is claimed.
3. Skip issues labeled `human-need`.
4. Run magpie-pr-review-pipeline on survivors.
5. Map verdict → outcome; act per table.
6. Update ledgers / report.

## Outcome mapping

| Magpie / matrix | Outcome | Suggest-mode action |
|-----------------|---------|---------------------|
| Blocking findings | `continue` | Post PR comments; set blocked_by |
| `close-with-pr` + no blocking | `merge-close` | Propose only |
| `keep-open` + no blocking | `merge-keep-open` | Propose merge; post/draft issue gap comment |
| `human-decide` / unclear / unsafe bet | `human-need` | Issue comment with options + `human-need` label; stop automation |

Uncertainty always lands on the **issue** (not only chat).

## Report

```text
Reviewer patrol <timestamp> mode=suggest
Skipped (triage): …
Reviewed: PR#… Issue#…
Outcome: continue|merge-close(proposed)|merge-keep-open(proposed)|human-need
```

## Default path

For production IAI review-bot (merge/close when gates pass), wire [iai-reviewer-execute](../iai-reviewer-execute/SKILL.md). Historical alias: “Phase 3” meant suggest staging; “Phase 4” meant execute — do not introspect a phase number at runtime.
