# 超时 sub-second input — review captures

Evidence for #1396 / PR #1411: a timeout field must let the reader type `0.5`
and `0.001`, and a typed `0` must not silently become 不限. Both interface
languages are captured because the two dictionaries are separate strings.

## Surface

- The real `TimeoutSettings` page (`apps/desktop/src/views/settings/system/Timeouts.tsx`)
  in the desktop app served by Vite, with `/api/**` answered by
  `apps/desktop/e2e/fixtures.ts` (`installMockApi`). Nothing else is mocked.
- Fixture timeouts: gateway idle 240 s (the shipped value), the other four 60 s,
  so no row starts on 不限.
- Window 1280×860 CSS px, device scale factor 2 (2432×1720 PNG), settings dialog
  opened by its own rail: 设置 › 超时 or Settings › Timeouts.
- The Chinese pass uses the app's default locale; the English pass sets
  `sciencediscovery-desktop:locale` to `en` before the page loads.

## How the frames were taken

A temporary Playwright spec (`zz-capture-1396.spec.ts`, not part of this
commit) drove the same journey in both languages:

1. focus 网关空闲超时 / Gateway idle timeout, select the value, type `0`;
2. before frames: assert the field is now disabled and empty with 不限 on, then
   capture;
3. after frames: assert the field is still enabled showing `0` with the switch
   off and no `PUT`, leave the field, assert the refusal note under the row,
   capture; then type `0.5`, leave the field, assert the recorded
   `PUT /api/timeout-settings` carries `gatewayIdleTimeoutMs: 500` and the
   saved line, and capture.

The before frames use the pane as `main` ships it (`e30956d`, i.e. the merged
base without this branch's commit), restored for that pass and replaced by the
branch's file for the after pass; the file's sha256 was checked on both sides
of the swap. Command, from the repository root with the pinned `.e2e` browser:

```bash
CAPTURE_MODE=before CI=1 node .e2e/node_modules/playwright/cli.js test \
  --config apps/desktop/e2e/zz-capture-1396.config.ts   # 2 passed
CAPTURE_MODE=after  CI=1 node .e2e/node_modules/playwright/cli.js test \
  --config apps/desktop/e2e/zz-capture-1396.config.ts   # 2 passed
```

The config moved the Vite server to 4421 because the shared desktop config's
port was held by another process on the capture host.

## Captures

| File | Language | State | What it shows |
| --- | --- | --- | --- |
| `00-before-zh-typing-zero.png` | zh-CN | after typing `0` | The defect: 网关空闲超时 empty and disabled, 不限 switched on by the keystroke |
| `01-after-zh-typed-zero-note.png` | zh-CN | `0` left the field | The box keeps `0` and stays editable, red border, `请输入有效的数值。` under the row, switch still off |
| `02-after-zh-half-second-saved.png` | zh-CN | `0.5` left the field | `0.5` kept in the box and `已保存` — the write carried 500 ms |
| `00-before-en-typing-zero.png` | en | after typing `0` | The same defect in English: empty disabled box, Unlimited on |
| `01-after-en-typed-zero-note.png` | en | `0` left the field | `0` kept, `Enter a valid number.` under the row, switch off |
| `02-after-en-half-second-saved.png` | en | `0.5` left the field | `0.5` kept and `Saved` after the 500 ms write |

Each pair differs only in copy: same viewport, same rows in the same
positions, same state. The saved line prints in the locale's own clock
(`已保存 · 14:47`, `Saved · 02:47 PM`), which is the app's existing formatting.

These images are review evidence, not product assets: they can be dropped from
the branch before merge, as `docs/screenshots/1266/` was.
