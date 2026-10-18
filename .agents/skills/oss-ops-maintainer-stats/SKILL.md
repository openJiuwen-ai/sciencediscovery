---
name: oss-ops-maintainer-stats
description: >-
  Use for read-only open-source maintainer dashboards: issue/PR backlog health,
  age, staleness, and triage funnel summaries.
---
# OSS Ops — Maintainer Stats

Read-only backlog and PR-queue dashboard (Magpie `issue-backlog-stats` / `pr-management-stats` style). No mutations.

## When to use

- Weekly/monthly health check
- Before planning community sprints

## Collect

```bash
gh issue list --state open --limit 200 --json number,title,labels,createdAt,updatedAt,author
gh pr list --state open --limit 200 --json number,title,isDraft,createdAt,updatedAt,author,reviewDecision
```

Also note IAI labels if present: `agent-ready`, `agent-claimed`, `human-need`.

## Report shape

```text
As of <timestamp tz>
Open issues: N | median age | % stale
Open PRs: N | drafts | awaiting review
IAI funnel: agent-ready / claimed / human-need
Hot areas: <label or path hints>
Risks: ...
```

Propose actions (run stale sweep, GFI sweep, clear human-need) — do not execute merges.
