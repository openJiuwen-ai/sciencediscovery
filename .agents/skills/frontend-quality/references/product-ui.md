<!-- SPDX-License-Identifier: Apache-2.0
Adapted and substantially rewritten for ScienceDiscovery, 2026-10-15.
Selected sources, retained notices, and changes: ../NOTICE.md and ../sources.json.
No upstream installer, detector, hook, or branding policy is imported. -->

# Product UI: a research workbench

## Preserve the product, not an upstream aesthetic

The inspected `apps/web/package.json` uses React, Vite, native CSS, Lucide,
Markdown/KaTeX, CSV, Plotly, Molstar and graph packages. These imply different
content needs; inspect the actual component before choosing its layout.
The following guide active AI design review and implementation, not numerical
Actions rules. Review all relevant frontend quality dimensions; this reference
and FQ-01 through FQ-05 are not exhaustive limits. A design or UX problem may
need fixing even when every deterministic check passes.

Use the existing CSS custom properties and component patterns. Look up token
names in the source rather than inventing an adjacent colour palette. Keep
system fonts, repeated cards or compact tables when they serve the workflow.
No blanket ban on fonts, gradients, rounded corners, card repetition, or
particular colours is imported from upstream design tools.

## Priority by work area

| Area | Keep understandable and reachable | Adaptation guidance |
| --- | --- | --- |
| Project / Session navigation | Current context and a way to switch it | Narrow: disclosure with the current item visible; wide: bounded navigation |
| Conversation / composer | Readable response, draft, send or stop in its valid state | Let messages own space; keep input and primary Run actions reachable |
| Run / tool timeline | Running / waiting / failed state and next action | Group related events; collapse detail without concealing failure or approvals |
| Permission decision | Exact operation/scope and allow/deny controls | Wrap details and allow local scrolling; never truncate an important scope silently |
| Files / artifacts | Identity, version/provenance and open/download actions | File tree and preview may separate; preserve selection and full-name access |
| Scientific outputs | Units, precision, labels, legends and controls | Local pan/zoom/scroll is acceptable; keep external toolbar usable |
| Model / MCP / environment / Skill settings | Field identity, validation and save/cancel | Stack fields when needed; preserve input after errors; bound dialog height |

Loading, empty, partial, disconnected and failed states need an understandable
next action. Do not invent Run progress percentages or completion estimates.
Keep terminology consistent across an action, its progress and its result.
Do not expose API keys or tokens in errors, screenshots or diagnostic reports.

## Hierarchy and density

Give the primary task a clear leading region. Put controls near what they
affect. Prefer proximity, headings and a coherent spacing scale before adding
more nested cards. Use existing scale values first; 4/8px-based spacing is a
reasonable design vocabulary, not a rule that every gap must be divisible by 4.

Ordinary prose generally benefits from a bounded reading measure. A roughly
40–48rem text column is a starting suggestion, not a limit for tables, charts,
code, or the whole application shell. Chinese and scientific notation need
rendered review; a character-count heuristic is not a reliable failure rule.

Reuse the product's text sizes. Around 16px for reading and 14px for secondary
information are starting suggestions, not a requirement to enlarge every dense
control. Do not fix overflow by shrinking the whole interface, reducing font
size until it fits, or removing descriptive labels everywhere.

Use state colours with a label or icon, not as the only status signal. Keep
visible keyboard focus and semantic controls. Handle reduced motion. These
remain part of AI's design and accessibility review, not extra deterministic
Actions rules. Do not ignore a problem because this package does not automate it.

## Content that must survive layout changes

Keep drafts, file selection, scroll intent and the active Run when panels open
or close. Resizing is not a new conversation. During streaming, a reader who
has scrolled upward should not be dragged to the latest token on every update;
an explicit way to return to the latest output is preferable.

Long scientific code, formulas, CSV and terminal output can keep their natural
structure in a bounded scroll region. Do not reformat precise values or turn
all scientific tables into cards automatically. Preserve copy/export access.
A filename may use ellipsis only if a usable detail/expand path reveals its
full identity; a hover-only `title` is not sufficient for touch users.

## Scope of proactive work

Inspect the affected experience broadly: appearance, typography, colour,
spacing, hierarchy, information density, interaction feedback, navigation,
accessibility, performance as perceived by the user, and all relevant states.
Proactively fix task-related design and usability defects, not only alignment
or wrapping errors. Explain larger opportunities and issues in unrelated
screens separately instead of treating broad review as permission to redesign
them. A missing deterministic rule is not a reason to stop inspecting. Do not install an upstream CLI, browser extension, Rust engine,
post-edit Hook, or new component library as a side effect of using this guide.
