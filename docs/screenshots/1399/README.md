# 沙箱网络 allowlist retention — review captures

Evidence for #1399 / PR #1417: 无网络 must keep the domain allowlist the
service stores, and only 开放网络 clears it. Both interface languages are
captured, because the two dictionaries are separate strings.

## Instance

- The mocked desktop entry (`apps/desktop/e2e`, the same Playwright project CI
  runs), page above the dialog at viewport 1440×900 with the default device
  scale factor 1.
- The fixture starts on 域名白名单 / Domain allowlist with two saved hosts,
  `pypi.org` and `*.pythonhosted.org:443`; `/api/**` is answered by
  `apps/desktop/e2e/fixtures.ts`.
- The Chinese run uses the app's default locale; the English run sets
  `sciencediscovery-desktop:locale` to `en` before the page loads.

## How the frames were taken

- `apps/desktop/e2e/network-allowlist.spec.ts` holds one test per language and
  both drive the same journey: 设置 › 网络 / Settings › Sandbox network, then
  无网络 / No network, then 域名白名单 / Domain allowlist and 保存 / Save,
  asserting the pill state, the recorded `PUT /api/sandbox-network-settings`
  bodies and the absent `至少填写一个允许的域名` / `Add at least one allowed
  domain.` hint at each step.
- Command, from the repository root with the pinned environment:

  ```bash
  CI=1 PLAYWRIGHT_BROWSERS_PATH=.e2e/browsers \
    .e2e/node_modules/.bin/playwright test \
    --config apps/desktop/e2e/playwright.config.ts \
    apps/desktop/e2e/network-allowlist.spec.ts
  ```

  It reports `2 passed`; a run with `--repeat-each=2 --retries=0` reports
  `4 passed`.
- Each frame is an element capture of the settings pane
  (`dialog.locator(".settings-group-detail").screenshot({ animations: "disabled" })`,
  1074×888 at DPR 1), written with `testInfo.outputPath` and copied here
  unchanged.

## Captures

| File | Language | State | What it shows |
| --- | --- | --- | --- |
| `01-allowlist-saved.png` | zh-CN | 域名白名单, before the toggle | The two saved hosts in the editable box |
| `02-none-inert-no-hint.png` | zh-CN | 无网络, after the press | The pill on 无网络, the box disabled and empty, no empty-list error — and the write that landed still carries both hosts |
| `03-allowlist-restored.png` | zh-CN | 域名白名单 again | The same two hosts in the box after the round trip, ready for 保存 |
| `01-allowlist-saved-en.png` | en | Domain allowlist, before the toggle | The same two hosts in the editable box |
| `02-none-inert-no-hint-en.png` | en | No network, after the press | The pill on No network, the box disabled and empty, no empty-list error |
| `03-allowlist-restored-en.png` | en | Domain allowlist again | The same two hosts after the round trip, Save enabled |

The English frames differ from the Chinese ones only in copy: same viewport,
same pane, same states, same elements in the same places, and each pair comes
from the same spec file in the same run.

The grey text in the `02` frames is the field's placeholder (`example.org`,
`*.example.org:443`), which is deliberately not the saved list, so the frame
cannot be mistaken for the hosts still being on screen.

These images are review evidence, not product assets: they can be dropped from
the branch before merge, as `docs/screenshots/1266/` was.
