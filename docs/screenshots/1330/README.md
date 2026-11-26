# Mid-run permission-mode switch — review captures

Evidence for #1330 / PR #1332. These are renders of the real `Composer`,
`Conversation`, `PermissionFlyout` and `PermissionCard` components with
`apps/desktop/src/styles/index.css`, captured from this branch.

They are component-level, not a product journey: the mocked desktop entry cannot
keep an SSE run open, so it cannot hold the composer in the running state for a
browser journey. The harness lives under `apps/desktop/.tmp/` and is not part of
this branch. The question, the run's thinking line and the model name are
fixture data written for these captures; no API, model or Electron shell is
involved.

## How they were captured

- Pinned Chromium (`Chromium 156.0.8078.108`), viewport 1440×900,
  `deviceScaleFactor: 2` (each PNG is 2880×1800), per locale (`zh-CN` / `en`),
  through the app's own stylesheet.
- Motion is disabled for the still captures (`transition`/`animation` off in the
  capture page), so the dropdown is photographed fully open instead of mid-fade.
  Appearance is otherwise the app's own stylesheet, untouched.
- The composer is mounted with `running` set and a live run above it
  (`status: "running"`, `terminal: false`, one turn so its fold line is drawn
  with 正在规划下一步 / Planning the next step and its elapsed time).
- 01–02 click the real footer permission pill **while the run is running**, so
  the flyout is the one a reader gets mid-run and the note under the two choices
  is the feature.
- 03–04 click 完全访问 / Full access in that open flyout. The frame shows what
  the switch leaves behind: the flyout closes, the pill reads 完全访问 / Full
  access in the warning colour, and the run is still going (its line and elapsed
  time are unchanged).

## Captures

| File | Locale | State |
| --- | --- | --- |
| `01-zh-permission-flyout.png` | zh-CN | Permission pill opened mid-run: both modes, and the note 本轮仍在运行… stating later tool calls only, the kernel/shell teardown with its in-memory state, an executing tool finishing first, settlement limited to what the new policy covers, the direct-on-machine exception, and 仅允许一次 for just this request |
| `02-en-permission-flyout.png` | en | The same flyout in English |
| `03-zh-after-switch.png` | zh-CN | After choosing 完全访问 mid-run: the flyout closes, the pill shows the new mode, the run continues |
| `04-en-after-switch.png` | en | The same post-switch state in English |

These images are review evidence, not product assets. They stay on the branch
so the pull request's image URLs, pinned to this commit's SHA, keep resolving.
