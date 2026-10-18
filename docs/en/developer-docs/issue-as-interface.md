# Issue as Interface — automation skill family

Companion skills for an **Issue-as-Interface** delivery loop: `agent-ready` issues
as the product input, developer patrol + autonomous workers, Magpie-style review,
and optional OSS ops sweeps. Chinese overview:
[Issue as Interface](../../zh/developer-docs/issue-as-interface.md).

Core skills (under `.agents/skills/`):

- [issue-as-interface-contract](../../../.agents/skills/issue-as-interface-contract/SKILL.md) — labels, state machine, ledgers, Magpie principles
- [issue-review-agent-ready](../../../.agents/skills/issue-review-agent-ready/SKILL.md) — issue gate before `agent-ready`
- [iai-developer-patrol](../../../.agents/skills/iai-developer-patrol/SKILL.md) / [iai-worker-implement](../../../.agents/skills/iai-worker-implement/SKILL.md)
- [iai-reviewer-patrol](../../../.agents/skills/iai-reviewer-patrol/SKILL.md) / [iai-reviewer-execute](../../../.agents/skills/iai-reviewer-execute/SKILL.md)
- [magpie-pr-review-pipeline](../../../.agents/skills/magpie-pr-review-pipeline/SKILL.md) — pairing + PR↔issue closure

OSS ops (parallel, draft/read-only by default):
`oss-ops-newcomer-gfi`, `oss-ops-stale-sweep`, `oss-ops-maintainer-stats`, `oss-ops-repo-health`.

## Cold start

On **first boot** (or when ledgers are empty / badly out of sync with GitHub), every bot must take a **full inventory** of all open issues and PRs and their states (labels, draft, CI, links, `human-need` / `agent-claimed`) and rebuild or reconcile both ledgers before starting the ~10-minute incremental patrol. See `iai-developer-patrol` and `iai-reviewer-patrol`.

## Branch sync

Workers catching up a PR with `main` must **rebase** onto the base (`git fetch` + `git rebase origin/<base>`), never merge the base branch into the feature branch—merge-sync commits can keep the PR out of the merge queue. See `iai-worker-implement`.

Related: the existing opt-in [Issue-to-PR pipeline](issue-pipeline.md)
(`repo-issue-pipeline`). Installing these skills does **not** start bots or change
the application backend. Merging, closing issues, and `human-need` escalation
follow the skill text and require the host's configured authority.
