<!-- SPDX-License-Identifier: Apache-2.0
Adapted and substantially rewritten for ScienceDiscovery, 2026-10-15.
Selected sources, retained notices, and changes: ../NOTICE.md and ../sources.json.
No upstream installer, detector, hook, or branding policy is imported. -->

# Deterministic Actions checks: explicit hard constraints

This allowlist limits the new frontend visual/layout **rule checks in GitHub
Actions**, not AI review. An AI developer or reviewer should also inspect and
improve aesthetics, hierarchy, interaction, accessibility and any other relevant
UI quality issue, including problems absent from this table. Calling this
helper locally does not narrow that responsibility. A passing helper result
is not a conclusion that the UI is good. This package does not add an Actions
workflow or replace the repository's other CI checks.

For these deterministic checks, only a declared expectation in the current UI
state should become an assertion.
Do not scan every pair of DOM rectangles or mark every hidden node as a bug.
Keep the rule identifiers stable so a report says precisely what failed.

| ID | Objective contract | Appropriate evidence |
| --- | --- | --- |
| FQ-01 | The ordinary page shell does not require horizontal scrolling | Document scroll width exceeds its client width beyond a 1 CSS px tolerance |
| FQ-02 | A specified current-state element is present and visible | Unique selector, painted box, nonzero opacity, visible intersection after clipping |
| FQ-03 | A specified full-text label/message fits and is not clipped | Rendered text rectangles and clipping ancestors; full text is explicitly required |
| FQ-04 | A specified currently enabled action can receive input | Playwright actionability with `click({ trial: true })`, plus painted visibility |
| FQ-05 | Two specified independent content regions do not overlap | Intersection exceeds tolerance on both axes; not arbitrary DOM pair scanning |

The optional helper implements a conservative subset of these contracts. It
reports measurements and selectors, not a beauty score. It reads DOM geometry
and computed styles; it does not read application stores or issue business API
calls. **PASS means only the selected contracts passed at that state/time.**

## Declare intent rather than global exceptions

`visible` means currently on screen, not somewhere reachable after scrolling.
Scroll normally and use the relevant state before asserting a long document.
`fullText` is for small, ordinary labels/messages that must be fully readable
now. Do not select the entire conversation, a scrollable code block, a native
input, a table, SVG/Canvas, rich formula, or a full virtualized list.
`actions` means expected enabled now; a deliberately disabled Submit before
required input is entered is not in that state's list.

Intentional truncation is verified by a user flow: open/expand the item and
assert that its full identity becomes readable. Do not waive a full-text
assertion just because `text-overflow: ellipsis` exists. Do not treat `title`
alone as evidence of usable full-text access on phones. Normal hidden tabs,
collapsed details, screen-reader-only labels and virtualized off-screen items
are not selected until their relevant visible state exists.

A table, code block or graph may scroll horizontally inside a bounded area.
Do not disable the shell overflow check merely because one such region exists.
A modal is intentionally above its backdrop; never put that pair in `disjoint`.
In an open modal state, check its own labels/actions; check background actions
after closing it. Declare known overlay/header collisions explicitly.

## Limits that must stay visible

DOM bounds do not fully describe painting. Complex transforms, clip paths,
filters, masks, Canvas/SVG, pseudo-elements and overlapping transparent layers
need screenshot/interaction evidence. The helper marks unsupported full-text
geometry as BLOCKED rather than silently declaring it correct. It does not
prove general contrast, focus order, every glyph's visibility, chart semantics,
or correct business behavior after a click.

Playwright's `toBeVisible()` alone does not reject `opacity: 0` and does not
prove that a click can reach the element. Conversely, intersecting rectangles
do not prove unexpected occlusion. Use painted visibility, actionability and
state-specific geometry together, and confirm a regression in the actual UI.

## Stability and results

Wait for application readiness (for example the expected dialog/Run state) and
fonts before measuring. Do not use an arbitrary long sleep as the readiness
contract. Font/animation changes and streaming responses can change geometry;
use bounded retries for the selected invariant and capture evidence after it
settles. Do not suppress real streaming content or remove difficult data to
make the result stable. An action trial may scroll but never submits a click;
record/re-establish scroll position when that is part of the scenario.

The helper returns PASS, FAIL or BLOCKED. FAIL means a measured violation.
BLOCKED includes invalid/ambiguous selectors and unsupported geometry. Missing
expected elements are failures, not an empty successful scan. Empty contracts
and unknown configuration keys are rejected. Do not auto-update baselines or
add global ignore flags to make failures disappear.

## Outside the Actions rule allowlist, not outside AI review

Font-family preference; use of cards, gradients or shadows; exact spacing scale;
fixed minimum font sizes; a subjective density or alignment score; screenshot
pixel differences; the choice of desktop-first versus mobile-first CSS; a lack
of a newly imported library. These are not automatic Actions failure criteria.
AI must still assess readability, visual consistency, density, aesthetics and
the user experience, and proactively fix relevant problems. Record genuine
AI-assessed defects with evidence and impact; lack of a hard-rule identifier
does not downgrade them to optional decoration. Keep personal style preferences
separate from defects. Do not feed either directly into an automatic gate.

Use the [Playwright actionability documentation](https://playwright.dev/docs/actionability)
for the scope of native browser-action checks.
