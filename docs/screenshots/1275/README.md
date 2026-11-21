# Idea Tree cards at the transcript foot — review captures

Evidence for #1275 / PR #1278, captured on head `4f449eb3` (the commit before the
captures were added) so the placement can be confirmed from the rendered page
rather than from the markup.

## How they were captured

- `apps/desktop` on its own Vite dev server (`pnpm --dir apps/desktop dev --port 4188`),
  Playwright 1.61.1 driving the environment's Chromium 156 headless, `deviceScaleFactor: 1`.
- Full window at 1440×900 for every capture except `09-zh-narrow-820.png`
  (820×900, resized from 1440 after the session was open: at ≤820px the sidebar
  is `display: none`, so the session cannot be opened at that width itself).
- `/api` is mocked in the page, as the desktop E2E entry does
  (`apps/desktop/e2e/fixtures.ts`, `installMockApi`), with two extra routes:
  `GET /api/sessions/:id/idea-tree/research` answering `{ items: [...] }` and
  `GET /api/sessions/:id/idea-tree/graph` answering the legacy graph (or
  `503` for the unreadable-list case), plus
  `GET /api/sessions/:id/configuration-requests` answering `{ items: [] }` — the
  fixture does not model that route, and its 404 would put a red
  "configuration could not be refreshed" strip inside the transcript.
- Nothing here is a CI gate: the probe is a local script, not part of the diff.

## What is mocked

Everything the page reads: session list and transcript, project, models,
settings, the Idea Tree research list and the legacy graph, the Evolve run, and
the configuration-request list. The two research objectives, the session title,
the transcript prose and the legacy tree are fixture data written for these
captures. No Python service, no model call, no Electron shell.

## Geometry as measured in the page

`getBoundingClientRect()` per element, same run as the captures.

| State | `.messages` | Idea Tree block | last reply `.message` | Evolve block |
| --- | --- | --- | --- | --- |
| 1440×900, scrolled to the foot | x 495, 816 wide | x 495, 816 wide, y 506 | x 495, 816 wide (text x 495) | x 495, 816 wide, y 642 |
| 1440×900, scrolled to top | x 495, 816 wide | x 495, y 890 (window is 900 tall) | — | y 1026 |
| 820×900, scrolled to the foot | x 94, 702 wide | x 94, 702 wide, y 574 | x 94, 702 wide | — |

- The block carries `margin-top: -18px` inside a `gap: 26px` column, so its first
  row starts 8px below the last turn's margin box, the same step `.evolve-runs`
  uses; the slot-to-Evolve step is 8px too.
- Pixels agree with the boxes: in `01-…`, x 494 is page white and x 495 is the
  card surface, x 1310 is the card's last pixel and x 1311 is white; in
  `09-…` the card spans x 94…795 with white at 93 and 796. At 820px `.messages`
  resolves to 702px inside a 750px column, i.e. `max-width: calc(100% - 48px)`
  is what binds, and the slot inherits exactly that.
- At 1440×900 the transcript is 1040px tall in a 656px scroller, so scrolling is
  real: 384px of scroll moves the block from y 890 to y 506, together with the
  transcript. The before capture (`00-…`) shows the old surface at y 74 in both
  scroll states, 1074px wide at x 366 — pinned above the transcript and wider
  than the 816px column.

## Captures

| File | Locale | State |
| --- | --- | --- |
| `00-before-zh-two-researches-bottom.png` | zh-CN | Before the change: cards pinned at the top, above the transcript, wider than the message column |
| `01-zh-two-researches-bottom.png` | zh-CN | Two researches at the foot of the transcript, plus one Evolve run below them |
| `02-zh-two-researches-crop.png` | zh-CN | The same last turn and block, cropped to the 816px column (848×405) |
| `03-zh-two-researches-top.png` | zh-CN | Scrolled to the top: the block waits at the window's bottom edge instead of staying pinned |
| `04-en-two-researches-bottom.png` | en | Same session in English |
| `05-zh-legacy-card.png` | zh-CN | Legacy hypothesis tree card in the same slot (a session with no research) |
| `06-en-legacy-card.png` | en | The same legacy card in English |
| `07-zh-unreadable-notice.png` | zh-CN | Research list answering 503: the unreadable-list notice at the foot |
| `08-en-unreadable-notice.png` | en | The same notice in English |
| `09-zh-narrow-820.png` | zh-CN | 820×900: the slot inherits `calc(100% - 48px)` and stays aligned with the message column |

These images are review evidence, not product assets: they can be dropped from
the branch before merge, as `docs/screenshots/1266/` was.
