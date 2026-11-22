# Pending permission card — review captures

Evidence for #1305 / PR #1310, captured from the build of head
`17a72927083a3d7d4fde4d2160c5eeb8abf0c08e`, the commit the frames belong to.

## Instance

- Local stack: the API from that head on `http://127.0.0.1:4310`, serving the
  matching `apps/web/dist`, with one live Run. No local Runner was connected, so
  its "Runner unavailable" banner is visible in the context frame; the
  permission card does not depend on it.
- The Run's model is a hanging local stub registered through `POST /api/models`
  (it never answers the agent turn), so the Run stays active and the pending
  cards keep their decision buttons.

## How the cards were mounted

- Playwright (the pinned `.e2e` Chromium 1228) opens the real Session page and
  replays `permission.required` events by intercepting
  `GET /api/sessions/*/runs/*/events?after=*` with `page.route`; server-sent
  event requests are allowed through. Nothing in the product is mocked beyond
  those replayed events.
- Each locale is a separate browser context: viewport 1180×1500,
  `deviceScaleFactor: 2`, `locale` set to `zh-CN` or `en-US`, and
  `sciencediscovery-locale` in localStorage. The card screenshots are element
  captures (860 px wide at DPR 2); the context frame is a full-page capture
  (2360×3000 at DPR 2).
- Five requests are replayed: direct-host, network, shell, a tool call carrying
  `detail`, and a legacy row with only `summary` (no description) to show the
  localized fallback.

## Captures

| File | Locale | Card |
| --- | --- | --- |
| `permission-direct-host-zh-CN.png` | zh-CN | Direct host: rebuilt sentence, no-isolation warning, command on its own lines |
| `permission-direct-host-en.png` | en | The same direct-host request in English |
| `permission-network-zh-CN.png` | zh-CN | Sandbox network: hosts and purpose |
| `permission-network-en.png` | en | The same network request in English |
| `permission-shell-zh-CN.png` | zh-CN | Shell script on `gpu-node-01`, resource `workspace-code` |
| `permission-shell-en.png` | en | The same shell request in English |
| `permission-tool-call-detail-zh-CN.png` | zh-CN | Tool call `run_shell` with `rm -rf out` on the line below the sentence |
| `permission-tool-call-detail-en.png` | en | The same tool call in English |
| `permission-summary-fallback-zh-CN.png` | zh-CN | Legacy row without a description: localized action fallback (`请求：运行本地代码`) |
| `permission-summary-fallback-en.png` | en | The same legacy row in English (`Request: Run local code`) |
| `permission-timeline-context-zh-CN.png` | zh-CN | The cards in the running Session's timeline, with the composer and sidebar |

These images are review evidence, not product assets: they can be dropped from
the branch before merge, as `docs/screenshots/1266/` was.
