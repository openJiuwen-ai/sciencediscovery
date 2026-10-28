# Frontend quality — attribution and modifications

This developer skill contains selected design guidance adapted and substantially
rewritten for ScienceDiscovery on 2026-10-15. It is not an unmodified upstream
skill or an official product of the upstream authors. No endorsement is implied.

The local guidance is distributed under Apache-2.0, while relevant upstream
copyright and license notices below remain applicable to incorporated material.
The diagnostic JavaScript and its tests were written for this migration; no
Impeccable detector implementation was copied. ScienceDiscovery's repository
license is not changed. Keep this notice, the per-file modification notices,
[sources.json](sources.json), and the bundled licenses when redistributing it.

## Impeccable

Source: https://github.com/pbakaus/impeccable

Copyright 2025 Paul Bakaus. Apache License 2.0.
See [the retained license](licenses/impeccable-Apache-2.0.txt).

Selected source files:

- `.agents/skills/impeccable/reference/adapt.md`
- `.agents/skills/impeccable/reference/harden.md`
- `.agents/skills/impeccable/reference/layout.md`

Retained ideas: adapt structure rather than scale a page; use container space;
prepare long/empty/error content; preserve a product's visual identity; inspect
rendered hierarchy, grouping and density. These were rewritten into the entry
skill and the four reference files, with ScienceDiscovery-specific examples.

Removed or changed: installation, automatic detectors, hooks, hand-offs between
upstream commands, live parameter generation, mandatory secondary-agent passes,
platform routing, native iOS/Android/email/print guidance, blanket typography
floors, default device breakpoints and subjective style restrictions. Existing
ScienceDiscovery CSS and product intent take priority. Mechanical checks are
explicit state contracts, not a port of Impeccable's rule catalogue.

## Vercel Web Interface Guidelines

Source: https://github.com/vercel-labs/web-interface-guidelines

Copyright (c) 2025 Vercel Labs. MIT License.
See [the retained license](licenses/vercel-web-interface-guidelines-MIT.txt).
Selected source: `command.md`.

Retained and rewritten: long-content handling, usable focus/controls, bounded
layout, actionable messages and evidence tied to the affected component.
Removed: fetching latest rules per review, mandatory title/quote punctuation,
aesthetic bans, automatic virtualization thresholds, blanket overflow hiding,
framework-specific classes, URL-state prescriptions and the full audit checklist.
These ideas inform guidance, not additional automatic compliance gates.

## Additional references, not copied assets

MDN, W3C and Playwright documentation are linked as technical references.
No Carbon/Tailwind component implementation, logos,
fonts, screenshots or other design assets are imported. Prior recommendations
to adopt Tailwind defaults were not applied to this existing native-CSS product.

## Local revision 1.1.0

Clarified the separation requested for ScienceDiscovery: only deterministic
frontend visual/layout rule checks in GitHub Actions are restricted to stable
hard constraints. AI design review remains broad and proactive, including
issues not expressible by those rules. Guidance, prompts and reporting wording
were updated accordingly. No upstream source, license, executable helper,
workflow or runtime behavior was changed by this revision.

## Updating sources

The source manifest pins Git blob IDs (file content identifiers), not moving
branch names or claimed repository versions. The manifest includes exact API
blob URLs. Review changes deliberately; do not download newer guidance at skill
execution time. Recheck file-specific licenses, relevant notices and behavior
whenever changing the selected upstream files.
