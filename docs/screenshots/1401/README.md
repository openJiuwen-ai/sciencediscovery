# Timestamp language evidence — #1401

Review evidence for Issue #1401 / PR #1418, captured from the PR head
`bbcc35a7e200d94e3bd70544cd298bc9bd30094f` (the code in this branch).

## Surface

- The real `TimeoutSettings` page from this head, mounted in a temporary
  harness that is not part of the commit: the real component, its
  `useLoaded` read and its save path, plus a stub `ApiClient` whose `request`
  returns the product defaults (`gatewayIdleTimeoutMs: 240000`; the other four
  fields `0`) and echoes a `PUT` back.
- The harness selects the language from `?lang=` with the app's own
  `setLanguage()` and `applyDocumentLanguage()`, wraps the page in the settings
  pane markup (`settings-main` > `settings-group-detail`) that
  `SystemSettingsDialog` uses, and clicks the first switch once. That switch
  press is a real `updateTimeoutSettings` write, so the `已保存 · <time>` /
  `Saved · <time>` line is drawn by the changed producer (`formatClock`).
- A fixed clock is installed at `2026-11-25T22:31:05Z`, and Chromium runs with
  `TZ=UTC`, so both frames format the same instant.
- Both frames: window 1000×760 CSS px, device scale factor 2 (2000×1520 PNG),
  same data, same state — gateway idle timeout flipped to unlimited, which
  leaves all five switches on.

## Captures

| File | Locale | Saved line |
| --- | --- | --- |
| `1401-saved-line-zh-CN.png` | zh-CN | `已保存 · 22:31` |
| `1401-saved-line-en.png` | en | `Saved · 10:31 PM` |

Only the language differs between the frames: same window size, same rows in
the same positions, same switch state, same saved-line position.

## How they were captured

```bash
pnpm --dir apps/desktop exec vite --port 4201 --strictPort
TZ=UTC chromium --headless --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1000,760 \
  --virtual-time-budget=12000 \
  --screenshot=docs/screenshots/1401/1401-saved-line-zh-CN.png \
  'http://127.0.0.1:4201/harness-1401.html?lang=zh-CN'
# the en frame repeats the same command with ?lang=en
```

Playwright was not used: the pinned `.e2e` environment is not available on
this host, while the desktop Vite app and `/usr/bin/chromium` are. The harness
HTML and its `src/harness-1401.tsx` are removed after the capture and are not
part of this commit.

These images are review evidence, not product assets; they can be removed from
the branch before merge.
