---
name: oss-ops-newcomer-gfi
description: >-
  Use for open-source community ops that welcome newcomers and author or sweep
  good-first-issue candidates, without touching Issue-as-Interface merge or
  worker help-seeking.
---
# OSS Ops — Newcomer Welcome & Good First Issue

Community-facing ops inspired by Magpie mentoring / GFI skills. **Parallel to Issue-as-Interface** — does not claim `agent-ready` work, does not merge, and does not ask humans for implementation help on behalf of workers.

Read [issue-as-interface-contract](../issue-as-interface-contract/SKILL.md) only to avoid colliding with `human-need` / `agent-claimed` issues.

## When to use

- Welcome a first-time issue/PR author
- Draft or score a good-first-issue (GFI)
- Sweep the backlog for GFI candidates

## Principles

- Outbound community comments: **draft by default**; post only when asked (safer than IAI Phase 4 merge path).
- Never rewrite requirements on an `agent-claimed` / in-flight IAI issue.
- GFI bar: small scope, clear steps, low risk, links to CONTRIBUTING; not a dump of hard bugs.

## Welcome

1. Detect first-time contributor on issue/PR.
2. Draft a short orientation: thanks, CONTRIBUTING/dev setup link, how review works, what to wait for.
3. Do not assign work or promise merge times.

## Author a GFI

Draft issue body with: background, exact steps, acceptance checklist, files/areas to touch, non-goals, how to test. Propose label `good first issue` (host mapping). Workload should be far below IAI's 1500-line gate (hours, not days).

## Sweep

Scan open issues; score against a simple rubric (size, clarity, safety, docs). Propose GFI label on candidates; skip security, migrations, and anything already `agent-ready`/`agent-claimed` unless a human asks to carve a newbie slice.

## Output

Draft comments + proposed labels; list skipped items with reasons.
