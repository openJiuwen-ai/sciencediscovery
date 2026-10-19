# Frontend development guidance

For frontend work in this directory, read the project-local
[frontend-quality skill](../../.agents/skills/frontend-quality/SKILL.md).
Use it proactively when implementing React/CSS changes, responsive layout,
chat, dialogs, settings or scientific artifact views; do not wait for a
separate request to inspect obvious layout problems in the affected area.

Reuse current components, theme variables and CSS breakpoints. Implement the
requested change, inspect representative rendered states when possible, and
report actual verification. AI review includes aesthetics, typography, colour,
spacing, hierarchy, density, interaction, accessibility and responsive behavior;
these are examples, not limits. Proactively fix relevant design/UX defects,
including ones with no deterministic check. Broad inspection is not permission
to modify unrelated functionality.

Only the new frontend visual/layout **rule checks in GitHub Actions** are
limited to stable hard constraints. The optional helper checks explicit content
visibility, clipping, overlap and reachable actions; it does not bound AI review.
A passing helper is not a completed visual review. Distinguish measured rule
violations, AI-assessed defects and optional style refinements. Do not turn AI
judgement or aesthetic scores directly into Actions pass/fail.

This pointer adds no Hook, dependency, workflow, approval or CI requirement.
Existing repository instructions and the E2E skill still apply. Do not use
upstream skill installers or change product behavior unrelated to the task.

Developer guide: [English](../../docs/en/developer-docs/frontend-quality.md) /
[中文](../../docs/zh/developer-docs/frontend-quality.md).
