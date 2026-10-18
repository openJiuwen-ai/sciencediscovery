# Issue as Interface — automation skill family

Companion skills for an **Issue-as-Interface** delivery loop: `agent-ready` issues
as the product input, developer patrol + autonomous workers, Magpie-style review,
and optional OSS ops sweeps. Chinese overview:
[Issue as Interface](../../zh/developer-docs/issue-as-interface.md).

Core skills (under `.agents/skills/`):

- [issue-as-interface-contract](../../../.agents/skills/issue-as-interface-contract/SKILL.md) — labels, state machine, ledgers, Magpie principles
- [issue-review-agent-ready](../../../.agents/skills/issue-review-agent-ready/SKILL.md) — issue gate before `agent-ready`
- [iai-developer-patrol](../../../.agents/skills/iai-developer-patrol/SKILL.md) / [iai-worker-implement](../../../.agents/skills/iai-worker-implement/SKILL.md)
- [iai-reviewer-execute](../../../.agents/skills/iai-reviewer-execute/SKILL.md) — **execute mode (IAI default)**: may merge-close / merge-keep-open / continue / human-need when gates pass; no per-PR chat authorize
- [iai-reviewer-patrol](../../../.agents/skills/iai-reviewer-patrol/SKILL.md) — **suggest mode (opt-in staging)**: continue + human-need; propose-only merge/close
- [magpie-pr-review-pipeline](../../../.agents/skills/magpie-pr-review-pipeline/SKILL.md) — pairing + PR↔issue verdicts; Approve ≠ merge; standalone-chat draft/COMMENT does **not** block IAI review-bot merges

**A running review-bot has no phase identity.** IAI default is high authority (wire execute / `iai.reviewer.mode=execute`). Suggest is optional safer staging. Historical aliases Phase 3 = suggest, Phase 4 = execute — upgrade notes only.

OSS ops (parallel, draft/read-only by default):
`oss-ops-newcomer-gfi`, `oss-ops-stale-sweep`, `oss-ops-maintainer-stats`, `oss-ops-repo-health`.

## Cold start

On **first boot** (or when ledgers are empty / badly out of sync with GitHub), every bot must take a **full inventory** of all open issues and PRs and their states (labels, draft, CI, links, `human-need` / `agent-claimed`) and rebuild or reconcile both ledgers before starting the ~10-minute incremental patrol. See `iai-developer-patrol` and `iai-reviewer-patrol`.

## Branch sync

Workers catching up a PR with `main` must **rebase** onto the base (`git fetch` + `git rebase origin/<base>`), never merge the base branch into the feature branch—merge-sync commits can keep the PR out of the merge queue. See `iai-worker-implement`.

Related: the existing opt-in [Issue-to-PR pipeline](issue-pipeline.md)
(`repo-issue-pipeline`). Installing these skills does **not** start bots or change
the application backend. **IAI review-bot default:** wire `iai-reviewer-execute`
(or `iai.reviewer.mode=execute`) so merge/close run when gates pass.
Suggest/`iai-reviewer-patrol` is opt-in staging. `human-need` escalation follows
the skill text.
