---
name: frontend-quality
description: >
  Build and improve ScienceDiscovery frontend UI in apps/web. Use proactively
  for React/CSS changes, responsive layouts, chat/composer, panels, dialogs,
  artifacts, settings, or reports of clipped text, hidden content and overlap.
  Implement the requested change and inspect the rendered result, rather than
  returning an audit only. Review aesthetics, layout, interaction, accessibility
  and adaptation broadly; the hard-constraint allowlist limits deterministic
  GitHub Actions checks only, never AI review. Preserve the existing visual
  system and proactively improve relevant problems. No hooks or runtime installs.
license: Apache-2.0; see NOTICE.md and licenses/ for third-party notices
metadata:
  version: "1.1.0"
---

# ScienceDiscovery frontend quality

<!-- Adapted and substantially rewritten 2026-10-15. Sources and modification
notices: NOTICE.md and sources.json. This is not an upstream Impeccable install. -->

Improve the research workbench, not a marketing landing page. Help a user
understand the current Project / Session / Run, act on it, and inspect evidence
without losing their place. This skill provides development guidance and
optional diagnostics. It does not introduce an approval stage or test gate.
Existing repository contribution and E2E requirements remain unchanged.

## Separate AI review from deterministic Actions checks

**AI reviews broadly.** Inspect and improve visual quality, hierarchy, typography,
colour, spacing, density, interaction, task flow, accessibility, content states
and responsive behavior. These are examples, not an exhaustive allowlist.
Use code, browser interaction and screenshots when available. A real usability
or design defect remains a defect even without a deterministic test; do not
reduce AI work to FQ-01 through FQ-05 or stop because the helper passes.

**Actions rules stay narrow.** The new frontend visual/layout rule checks are
limited to reproducible, state-specific hard constraints: unintended overflow,
missing/clipped content, blocked actions and unintended overlap. Do not turn
AI aesthetic scores or design preferences directly into Actions pass/fail.
This restriction does not narrow existing lint, type, security or functional
checks. No Actions workflow is added by this skill package.

Review breadth is not permission to rewrite unrelated features. Proactively
fix relevant issues within the authorized task and surface wider issues with
evidence and impact instead of silently expanding the implementation scope.

## Start small, then implement

Read the affected React component, its styles, a neighbouring component and
existing tests. Use the task's actual product state, not an invented demo.
Explain the main layout decision briefly, then implement it; do not wait for
an extra approval for ordinary changes already covered by the request.
Do not treat permission to improve a component as permission for a site-wide
redesign, a backend/API change, a new dependency, or a production deployment.

Keep the repository's React/Vite and native CSS approach. The inspected baseline
uses global widths of 600, 900 and 1180 CSS px in
`apps/web/src/styles/responsive.css`, plus component breakpoints and container
queries. Re-read current code before editing; these are existing conditions,
not proof that every screen is already supported. Do not import Tailwind,
Carbon components, or a new breakpoint scale merely because an upstream guide
uses them. Reuse current typography, theme variables, icons and primitives.

## Load only the relevant guidance

| Task | Read |
| --- | --- |
| New or changed UI, visual quality, hierarchy, interaction, density | [Product UI](references/product-ui.md) |
| Width, height, zoom, panels, touch or high-DPI | [Responsive layout](references/responsive-layout.md) |
| Overlap, clipping, text loss or invisible controls | [Hard constraints](references/hard-constraints.md) |
| Browser verification, stress content and reporting | [Verification](references/verification.md) |

These references are local and reviewed. Do not fetch newer upstream rules
at runtime. Do not load all third-party skills or licensing files into every
frontend task. Traceability is in [NOTICE.md](NOTICE.md) and
[sources.json](sources.json), not in the default prompt.

## Build with difficult content

For the changed area, include realistic long names/paths/URLs, CJK and English,
empty/loading/error states, streaming content, or permission decisions as
appropriate. Preserve data and scientific meaning: do not round scientific
values, crop evidence, remove tools or hide errors just to make a layout fit.
Fix the sizing chain before adding clipping: shrinking Grid/Flex children,
wrapping ordinary text, and local scroll regions are different decisions.

For narrow layouts, move secondary work into a reachable drawer, tab or detail
view. Preserve primary actions, drafts, selection and the active Run while
resizing. For wide layouts, use useful parallel panels and constrain long
reading passages; do not enlarge every element or stretch a paragraph to 4K.

## Inspect and improve, without a new process

When a browser is available, navigate the affected user path and inspect a
narrow, intermediate/low-height and wide state chosen for this change. Resize
through affected breakpoints and inspect after opening relevant panels/dialogs.
Use existing journey fixtures and reports when running product E2E; read
[the E2E skill](../e2e-testing/SKILL.md). A standalone HTML fixture proves only
the diagnostic helper, not the product or the user journey.

Actively identify and fix relevant design and UX defects, not just detectable
geometry errors. Explain the user impact of AI-assessed issues and distinguish
an actual usability problem from an optional stylistic preference. Neither
category becomes a deterministic Actions failure just because AI reports it.
The optional [layout helper](scripts/layout-checks.mjs) is supporting evidence;
its limited rule coverage does not limit AI inspection. It is not a beauty
score, universal DOM crawler, accessibility certification, or substitute for
user actions and screenshot inspection. Do not add hooks; changing default
tests or Actions workflows requires a task that requests that integration.

When verification is unavailable, finish the safe implementation and state
what remains unverified. Never report a screenshot, viewport, browser, real
phone or E2E run that was not actually exercised. A missing selector, stale
contract or missing browser is not a successful check.

## Hand-off

State what changed, the actual viewport/DPR and states checked, deterministic
results, AI-assessed design/UX issues fixed or remaining, optional refinements,
and coverage gaps. Distinguish measured facts from visual judgement; neither
replaces the other. Use paths and reproducible steps. Do not claim that the entire 320–3840 CSS px range
passes from a few samples, or that emulation proves real mobile behavior.
