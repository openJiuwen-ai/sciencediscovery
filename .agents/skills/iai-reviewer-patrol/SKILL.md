---
name: iai-reviewer-patrol
description: >-
  Use for Issue-as-Interface reviewer-bot patrol in suggest mode: PR triage then
  Magpie review; execute continue + human-need on the issue; only propose
  merge/close.
---
# Issue-as-Interface — Reviewer Patrol (Phase 3: suggest)

Periodic reviewer for open worker PRs. Read [issue-as-interface-contract](../issue-as-interface-contract/SKILL.md) (P4 PR triage, human-need). Run [magpie-pr-review-pipeline](../magpie-pr-review-pipeline/SKILL.md) after the triage gate.

**Phase 3 authority:** execute `continue` and `human-need`. **Propose only** `merge-close` / `merge-keep-open`.

## When to use

- Scheduled reviewer patrol
- Manual review of a pipeline PR
- After worker marks `pr-ready` / `pr-updated`

## Each patrol

1. Find PRs in active ledger with `pr-open` or `in-review`.
2. **PR triage (P4):** skip drafts (unless asked), obviously stale/unreviewable, or missing linked issue when closure is claimed.
3. Skip issues labeled `human-need`.
4. Run magpie-pr-review-pipeline on survivors.
5. Map verdict → outcome; act per table.
6. Update ledgers / report.

## Outcome mapping

| Magpie / matrix | Outcome | Phase 3 action |
|-----------------|---------|----------------|
| Blocking findings | `continue` | Post PR comments; set blocked_by |
| `close-with-pr` + no blocking | `merge-close` | Propose only |
| `keep-open` + no blocking | `merge-keep-open` | Propose merge; post/draft issue gap comment |
| `human-decide` / unclear / unsafe bet | `human-need` | Issue comment with options + `human-need` label; stop automation |

Uncertainty always lands on the **issue** (not only chat).

## Report

```text
Reviewer patrol <timestamp>
Skipped (triage): …
Reviewed: PR#… Issue#…
Outcome: continue|merge-close(proposed)|merge-keep-open(proposed)|human-need
```

## Upgrade path

Phase 4: [iai-reviewer-execute](../iai-reviewer-execute/SKILL.md).
