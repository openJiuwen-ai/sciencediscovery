<!-- SPDX-License-Identifier: Apache-2.0
Adapted and substantially rewritten for ScienceDiscovery, 2026-10-15.
Selected sources, retained notices, and changes: ../NOTICE.md and ../sources.json.
No upstream installer, detector, hook, or branding policy is imported. -->

# Verification without an extra pipeline

Choose a small set proportional to the change. This document does not register
new test projects, mandatory schedules, tags, hooks or CI jobs. Product journeys
still follow the existing [E2E skill](../../e2e-testing/SKILL.md): isolated stack,
existing helpers, state-driven waits and journey-produced reports. Never drive
a developer's personal instance, call a live model, or create paid external
side effects just to inspect layout without the relevant authorization.

## Two complementary kinds of verification

**AI review is broad and active.** Inspect the changed experience through code,
rendered screenshots and actual interaction when available. Evaluate appearance,
hierarchy, typography, colour, spacing, density, task flow, feedback, readability,
accessibility, error/loading/empty states and adaptation. Investigate other
relevant issues you notice; this is not a closed checklist. Fix task-related
problems rather than returning a scan report only. Do not stop at a clean helper
result or demote a genuine UX defect because no deterministic rule covers it.

**Actions rule checks are deliberately narrow.** Only the stable, explicit
contracts in [hard constraints](hard-constraints.md) belong to this package's
frontend visual/layout rule lane. AI may use the same helper during development,
but it is supporting evidence, not an AI-review allowlist. AI judgements and
screenshot preferences must not directly set the Actions pass/fail status.
Existing functional, lint, type and security checks retain their own scope.
This package does not wire the helper into Actions or introduce a new gate.

## Representative CSS viewports

These are suggested browser **content viewport** sizes, not physical screen
resolutions or a claim that the product already passes them. Select relevant
rows and state the coverage; no full Cartesian product is required.

| Purpose | CSS viewport | Representative DPR |
| --- | --- | --- |
| Narrow reflow | 320×800 | 1 |
| Small / typical phone | 360×640 / 390×844 / 430×932 | 2 or 3 |
| Landscape / low height | 844×390 / 1280×600 | 1 or 3, as relevant |
| Tablet / small window | 768×1024 / 1024×768 | 1 or 2 |
| Desktop split view | 960×720 | 1 or 2 |
| Laptop | 1366×650 / 1440×900 | 1 or 2 |
| Desktop / high-DPI same layout | 1920×1080 | 1 and 2 |
| Large logical desktop | 2560×1440 | 1.5 or 2 |
| Ultra-wide / native 4K viewport | 3440×1440 / 3840×2160 | 1 |

For the changed stylesheet, inspect each actual breakpoint at B−1, B, B+1.
For the baseline global breakpoints that means 599/600/601, 899/900/901 and
1179/1180/1181, **not** an unrelated Tailwind grid. Container-query boundaries
are tested by resizing their actual containers, not merely the whole viewport.
Drag through intermediate widths and repeat with the affected side panels open.

Suggested additional spot checks: browser page zoom 125/150/200%, text resizing,
a reflow check around 320 CSS px, Windows fractional scaling, and one real phone
when the change affects keyboard/touch behavior. Browser viewport resizing is
not real page zoom; DPR 2 is not proof of system zoom 200%; desktop Chromium
emulation is not iOS Safari. Record unavailable cases as gaps.

## State selection for ScienceDiscovery

| Changed area | Candidate user states |
| --- | --- |
| Conversation | Long streaming reply, reader scrolled up, drafted follow-up, running/stop, failed and retry |
| Tools / permissions | Long operation scope, pending approval, decision buttons, expanded stack trace |
| Files / preview | Deep path, selected artifact, wide table/formula/plot, preview open beside conversation |
| Settings / Skill editor | Long field value, validation error, dropdown at viewport edge, save/cancel, narrow dialog |
| Shell / layout | Navigation and preview open, splitters at minimum, narrow window, resize without losing state |

Use deterministic mock content and established product fixtures. Do not assert
that a specific LLM's wording or tool sequence is a layout requirement.

## Optional helper, inside an existing Playwright journey

Import `checkLayout` from the repository root's
`.agents/skills/frontend-quality/scripts/layout-checks.mjs` (from a spec under
`test/`, the relative import starts with `../.agents/`). Use selectors verified
against the checked-out component. The example below assumes an already open,
ready conversation with a draft; it does not create the environment or the
product state, and it is not a standalone E2E spec.

```js
import { checkLayout } from '../.agents/skills/frontend-quality/scripts/layout-checks.mjs';

// After the existing journey's user actions and readiness assertions:
const contract = {
  pageOverflow: true,
  visible: ['.composer', '.composer textarea'],
  // Add only labels/messages that must be fully readable in this state.
  fullText: [],
  // Add the exact enabled action after setting up its valid product state.
  actions: [],
  disjoint: [],
};
await expect.poll(async () => (await checkLayout(page, contract)).status,
  { timeout: 5000 }).toBe('PASS');
```

For a failure, record the full result (`issues`, `measurements`, viewport and
DPR) through the journey's existing report mechanism, not just its status.
Keep selectors small and explicit. Do not add `*`, every text node, or every
button to the contract. Do not add ad-hoc screenshots to journey specs when
the journey fixture already owns them. Protect prompts, paths and credentials
when storing diagnostics. The helper does not send anything to an AI service.

## Optional helper self-test, not a product test

After provisioning the repository's existing `.e2e` environment as documented
in CONTRIBUTING, run from the repository root:

```bash
node .agents/skills/frontend-quality/scripts/selftest.mjs
```

This opens local HTML fixtures, exercises good/bad layouts and prints JSON.
It does not start ScienceDiscovery, add test discovery, contact models, or
modify CI. Missing Playwright/browser prerequisites exit with BLOCKED, not
success. An explicit `SD_LAYOUT_PLAYWRIGHT_MODULE` file path and
`SD_LAYOUT_CHROMIUM_EXECUTABLE` can select an already installed environment;
no package installation occurs automatically.

## Evidence, not a mandatory new document

Use the existing change/verification report. Include the changed user path,
tested SHA when available, CSS viewport, DPR, browser/OS, input/zoom assumptions,
UI state, chosen contracts, results, and untested cases. Distinguish:

- **Deterministic findings:** a measured contract violation, with evidence.
- **AI-assessed design/UX findings:** the observed problem, screenshot or user
  steps where available, impact, reasoning, and whether it was fixed. These
  can be real defects even without an FQ rule; they are not automatic Actions
  failures and are not automatically downgraded to optional suggestions.
- **Optional refinements:** stylistic alternatives without an established defect.

Report what was actually reviewed; do not invent screenshots or imply broad
AI inspection from a helper result. A red rule assertion requires a reproducible
step and specific affected content, not the phrase “the page looks messy.”
Use the existing report format; these distinctions do not add a new approval
stage, required document or aesthetic score.
