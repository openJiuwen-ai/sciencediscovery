# AI-assisted frontend development

English | [中文](../../zh/developer-docs/frontend-quality.md)

ScienceDiscovery has a lightweight developer skill at
[`.agents/skills/frontend-quality`](../../../.agents/skills/frontend-quality/SKILL.md).
It adapts selected Impeccable and Vercel Web Interface Guidelines ideas to the
existing research workbench. It does not install
those projects, a detector engine, hooks, or a new UI framework.

The standard skill metadata describes when an agent should use it, and
[`apps/web/AGENTS.md`](../../../apps/web/AGENTS.md) points frontend agents to it.
Tools that discover `.agents/skills` can use that entry; the repository also
has its existing `.claude/skills` alias. Recognition depends on the developer's
agent configuration. If discovery is unavailable, explicitly ask the agent to
read the skill file; no automatic invocation in every tool is promised.
This is a development skill, not a Skill installed into a user's research Run.

## Ask for implementation, not only an audit

```text
Use .agents/skills/frontend-quality/SKILL.md for this frontend change.
Read the existing component and styles, keep the current design system, and
implement the requested change. Review appearance, typography, layout, density,
interaction, accessibility and adaptation broadly; proactively fix relevant
issues within scope. AI review is not limited to the Actions hard-constraint
allowlist, and a passing helper does not complete the review. Use actual browser
interaction and screenshots when available. Distinguish deterministic results,
AI-assessed design/UX defects and optional refinements; report real coverage and
gaps. Limit only deterministic Actions rules to stable hard constraints. Do not
turn AI judgement directly into Actions pass/fail. Do not add hooks or install
Impeccable. Change CI only when the task explicitly requests that integration.
```

State the user goal and affected area after this prompt. The agent should
choose relevant references, make small design decisions and implement them,
not require an additional approval for every styling decision. Major redesign,
new dependencies and unrelated functionality remain outside the request.

## What is included

The entry skill is small. Four on-demand references cover product UI,
responsive layout, objective constraints and verification. A dependency-free
helper accepts an existing Playwright page; a separate opt-in self-test uses
the repository's existing Playwright installation. Neither runs by itself.

The baseline was inspected at `cc974a14468cbdfd66c76f2720ebd751aefb1cdd`.
The guide preserves native CSS, existing 600/900/1180px global breakpoints and
component container queries. It does not promise those layouts already pass
all suggested 320–3840 CSS px viewports. Scientific tables/code/graphs may
scroll locally; modals, collapsed panels and deliberate truncation are handled
by state-specific contracts rather than global prohibitions.

## AI review is broad, proactive and not bounded by the rule list

Inspect all relevant frontend quality dimensions through source, rendered UI
and interaction: appearance, colour, typography, spacing, alignment, hierarchy,
density, task flow, feedback, accessibility, loading/empty/error states,
perceived performance and adaptation. These are examples, not a closed list.
Fix relevant defects, including ones a rule engine cannot detect. Do not stop
at passing FQ-01 through FQ-05, or downgrade a real UX defect to an optional
suggestion merely because it lacks a rule. Keep personal style preferences
separate from observed defects. Broad review does not authorize unrelated
implementation changes or a wholesale redesign.

## Only deterministic Actions rules are limited to hard constraints

This restriction applies to the new frontend visual/layout rule checks in
GitHub Actions, not AI inspection and not existing functional, lint, type or
security checks. Only explicit page overflow, required visibility, full-text
clipping, action reachability and independent-region overlap are automated by
the helper. A check must name the content and current state. Missing required
content cannot be silently skipped; ambiguity and unsupported geometry are
reported as BLOCKED. A passing helper proves only its selected contracts.

Do not directly turn an AI aesthetic score, visual judgement or style preference
into Actions pass/fail. There is no beauty gate for fonts, cards, spacing scales,
typography size or colour, but AI still reviews those areas and improves them.
The helper may also be used locally by an AI developer as supporting evidence;
it never limits that developer's review. This package still adds no Actions
workflow, hook or default test discovery. It defines the boundary for a future
requested integration, not a claim that Actions already runs these checks.
The helper's fixture tests are not ScienceDiscovery E2E results.

See [verification](../../../.agents/skills/frontend-quality/references/verification.md)
for existing-journey integration and the optional local self-test command.
Existing CONTRIBUTING and E2E requirements are not removed or expanded.

## Provenance

[NOTICE.md](../../../.agents/skills/frontend-quality/NOTICE.md) records selected
upstream material and excluded behavior; [sources.json](../../../.agents/skills/frontend-quality/sources.json)
pins the inspected source blobs. Licenses are bundled with the skill. Rules
are maintained locally; no upstream rule fetch occurs during development or CI.
