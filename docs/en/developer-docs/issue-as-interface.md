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

Related: the existing opt-in [Issue-to-PR pipeline](issue-pipeline.md)
(`repo-issue-pipeline`). Installing these skills does **not** start bots or change
the application backend. Merging, closing issues, and `human-need` escalation
follow the skill text and require the host's configured authority.
