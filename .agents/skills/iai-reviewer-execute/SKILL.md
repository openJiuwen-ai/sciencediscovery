---
name: iai-reviewer-execute
description: >-
  Use for Issue-as-Interface reviewer-bot Phase 4: after PR triage + Magpie
  review, execute continue, merge-close, merge-keep-open, or human-need (issue
  comment + label) when uncertain.
---
# Issue-as-Interface — Reviewer Execute (Phase 4)

Same brain as [iai-reviewer-patrol](../iai-reviewer-patrol/SKILL.md) + [magpie-pr-review-pipeline](../magpie-pr-review-pipeline/SKILL.md), with authority to **execute** all four outcomes in [issue-as-interface-contract](../issue-as-interface-contract/SKILL.md).

Enable only when the host/routine turns on Phase 4 for the repo; otherwise fall back to suggest mode.

On cold start, run the same full open-PR/issue inventory as [iai-reviewer-patrol](../iai-reviewer-patrol/SKILL.md) before executing merges.

## Authority

| Outcome | Execute |
|---------|---------|
| `continue` | Yes — PR comments |
| `merge-close` | Yes — merge + close issue |
| `merge-keep-open` | Yes — merge; leave issue open; gap comment on issue |
| `human-need` | Yes — issue comment (question + options) + label; stop workers/auto-merge |

## Gates before deep review / merge

1. **PR triage (P4)** — no draft/stale junk.
2. Pairing + deep review on current head SHA.
3. No blocking findings for any merge path.
4. Closure verdict `close-with-pr` or `keep-open` (never merge on `human-decide`).
5. CI green or host-waived with recorded reason.
6. Ledger active → completed with correct `result`.

## Uncertainty → human-need (must)

- Acceptance `unclear`
- Correctness/security coin-flip after pairing
- Authz / secrets / payments / release / irreversible data
- Claims Fixes #N but acceptance missing
- CI red / conflicts unresolved
- Failed or contradictory repro with no safe default

Write the decision request on the **issue**, apply `human-need`, stop automation. Do not ask humans for code — only for decisions.

Tool-guard allowlist overrides are **not** `human-need` unless they change product/closure outcomes.

## Merge mechanics

```bash
gh pr merge <n> --merge   # or repo default
# close-with-pr: Fixes/Closes on PR, or gh issue close with comment
# keep-open: merge only + gap comment; leave issue open
```

Never force-push protected branches.

## After human-need clears

Human removes label / records decision → next patrol re-reviews and may merge.
