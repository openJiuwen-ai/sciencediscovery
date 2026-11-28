---
name: oss-ops-repo-health
description: >-
  Use for open-source repo health checks: dependency/CVE hints, Actions workflow
  security smells, license/compliance flags, and flaky-test triage proposals —
  report only unless asked to open issues.
---
# OSS Ops — Repo Health

Lightweight Magpie repo-health family (dependency / workflow / license / flaky). Default **report-only**; open issues only when the user asks.

## When to use

- Periodic security/hygiene pass
- Before a release train

## Passes (best-effort with repo tooling)

1. **Dependencies** — known vulnerable or abandoned deps (from lockfile + advisory DB / `npm audit` / equivalent).
2. **Workflows** — Actions using unpinned SHAs, overly broad `pull_request_target`, secrets in logs.
3. **License** — unexpected licenses in deps vs project policy if documented.
4. **Flaky tests** — recurring CI failures on main/PRs; propose quarantine or fix owner, not silent ignore.

## Rules

- Do not weaken CI to go green.
- Do not print secrets.
- High-severity findings → draft issue text; if judgment needed, suggest `human-need` on that issue after creation — do not auto-merge fixes via IAI unless separately agent-ready.
- Stay out of IAI worker sessions.

## Output

Severity-ordered findings + evidence commands + suggested next skill (stale, GFI, or IAI issue-review for a fix slice).
