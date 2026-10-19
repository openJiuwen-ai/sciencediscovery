<!-- SPDX-License-Identifier: Apache-2.0
Adapted and substantially rewritten for ScienceDiscovery, 2026-10-15.
Selected sources, retained notices, and changes: ../NOTICE.md and ../sources.json.
No upstream installer, detector, hook, or branding policy is imported. -->

# Responsive layout

AI should judge whether the experience remains clear, attractive and efficient
across contexts, not only whether elements fit. The Actions hard-constraint
allowlist is a limit on deterministic rules, not on this design review.

## Units and the existing implementation

Use layout viewport width/height and component container space in CSS pixels.
Physical resolution, screen diagonal and DPR are not layout breakpoints. The
browser maps CSS pixels to device pixels; do not divide CSS viewport values
by DPR again. Desktop page zoom and mobile pinch zoom are not equivalent.

`apps/web/src/styles/responsive.css` at the inspected baseline contains global
`max-width` queries at 1180, 900 and 600px. It also contains composer container
queries at 1024, 900, 720 and 620px. Individual features have other breakpoints.
Read the cascade and the component's own stylesheet before changing it.
Keep the existing max-width direction unless the task explicitly migrates it.
Do not introduce a competing 640/768/1024/1280/1536 scale by default.

The long-term design target is continuous usability from 320 to 3840 CSS px,
with most visual attention on 360–2560px. This is a target and test selection
range, not a claim about current product support. A component's practical
minimum, short viewport and available input method all affect its behavior.

## Implement a sizing chain, not a screenshot

Start with the shell, then the main area, panel and leaf. Every shrinking
Grid/Flex ancestor matters. Use `minmax(0, 1fr)`, `min-width: 0` and, for bounded
vertical panes, `min-height: 0` where appropriate. Let controls wrap or regroup.
Assign scrolling to the content region that needs it, not to arbitrary nested
wrappers. Do not apply `overflow: hidden` to the root to conceal a failure.

A typical *pattern*, to adapt to the current component rather than paste as
new global selectors:

```css
.preview-slot {
  min-width: 0;
  min-height: 0;
  container-type: inline-size;
}
.preview-body { min-width: 0; min-height: 0; overflow: auto; }
.preview-toolbar { display: flex; flex-wrap: wrap; gap: 12px; }
/* Reuse the actual component's established spacing value or token. */
```

Use viewport queries for shell topology and container queries for a component
that also appears in a narrow side panel. Do not infer that a preview has ample
space merely because the browser is 1920px wide. Decide which details collapse,
which content scrolls, and how it is revealed. The same component must work
when its splitter is dragged, not just when the window changes size.

## Text and overlays

Ordinary paragraphs, filenames in detail views, URLs and error text can wrap;
`overflow-wrap: anywhere` is useful for unbroken strings when semantics permit.
Do not apply word breaking to all code, formulas or scientific tables.
Scrollable data regions and editable inputs have legitimate internal overflow.

A dialog should fit the available viewport, own a sensible internal scroll
region, and retain an accessible close/control path. Reflow action groups
instead of clipping their labels. Modals and backdrops intentionally overlap;
inspect the active modal, not the obscured background, as the current contract.
When closed, overlays must stop intercepting the underlying interaction.

Use dynamic viewport units and safe-area insets where appropriate, with the
project's fallback policy. They do not prove that a phone's software keyboard
will leave the composer visible. Exercise focus, keyboard, rotation and browser
chrome on a real device when that scenario matters.

## Wide screens, high-DPI and input

A 1920 CSS px viewport at DPR 2 and a 3840 CSS px viewport at DPR 1 are different
layout tests even if both produce a 3840-pixel-wide bitmap. Record both metrics.
Use DPR for raster/Canvas clarity as needed, not for selecting column counts.
Resize chart/3D renderers through the existing integration's supported lifecycle
when their container changes; do not blindly transform-scale the canvas.

Use spare width for useful comparisons/previews, not unbounded prose or
stretched form fields. A wall display viewed at a distance is a separate
explicit product mode, not `width >= 3840`. Do not add that mode unless requested.

Width does not identify input. Keep core actions usable with touch and
keyboard, and preserve hover affordances for mouse users. Approximately 44px
hit areas are a useful touch design target, not an imported automated size gate.
Hybrid touch/mouse devices need both paths. Respect user zoom settings.

## References, not imported code

[MDN: devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio),
[container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries),
[VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API),
and [W3C reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
These are external technical references; their content is not vendored here.
