---
name: iai-reviewer-execute
description: >-
  Use for Issue-as-Interface review-bot (default high-authority path): after PR
  triage + Magpie review, execute continue, merge-close, merge-keep-open, or
  human-need when uncertain. No per-PR chat authorize required. Authority comes
  from the host wiring this skill (or iai.reviewer.mode=execute), not from the
  bot knowing a phase number.
---
# Issue-as-Interface — Reviewer (execute mode, IAI default)

**IAI review-bot default.** Same brain as Magpie + patrol triage, with authority to **execute** all four outcomes in [issue-as-interface-contract](../issue-as-interface-contract/SKILL.md): `continue`, `merge-close`, `merge-keep-open`, `human-need`.

**A running review-bot has no phase identity.** High merge/close authority comes from the **host/routine** wiring this skill (or `iai.reviewer.mode=execute` / `allow_merge=true`). Loading this skill ≡ execute mode. Do **not** wait for per-PR chat “exact authorize” — Magpie’s standalone-chat conservatism does not apply here.

On cold start, run the same full open-PR/issue inventory as [iai-reviewer-patrol](../iai-reviewer-patrol/SKILL.md) before executing merges.

Historical alias: “Phase 4” meant this execute path — upgrade note only, not runtime identity.

## Authority

| Outcome | Execute |
|---------|---------|
| `continue` | Yes — PR comments |
| `merge-close` | Yes — merge + close issue |
| `merge-keep-open` | Yes — merge; leave issue open; gap comment on issue |
| `human-need` | Yes — issue comment (question + options) + label; stop workers/auto-merge |

GitHub review `APPROVE` is **not** required to merge. Magpie may post `COMMENT`-style reviews; this path may merge without an APPROVE event.

For safer staging without merge/close, wire [iai-reviewer-patrol](../iai-reviewer-patrol/SKILL.md) (`mode: suggest`) instead.

## Gates before deep review / merge

1. **PR triage (P4)** — no draft/stale junk.
2. Pairing + deep review on current head SHA ([magpie-pr-review-pipeline](../magpie-pr-review-pipeline/SKILL.md)).
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

Tool-guard allowlist overrides are **not** `human-need` unless they change product/closure outcomes. Never force-push protected branches.

## Merge mechanics

```bash
gh pr merge <n> --merge   # or repo default
# close-with-pr: Fixes/Closes on PR, or gh issue close with comment
# keep-open: merge only + gap comment; leave issue open
```

## After human-need clears

Human removes label / records decision → next patrol re-reviews and may merge.
