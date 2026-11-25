# #1398 review captures — English and Chinese fallbacks

Review evidence for #1398 / PR #1410, captured from this branch's build.

## Provenance

All four frames come from one product code: this branch as it now stands, rebased
onto `main`. The rebase merged one unrelated desktop commit (the account service
default plus the unconfigured-build notice); its only conflict was in
`LoginPage.tsx`, where main's `accountsConfigured` guard now sits beside this
change's `defaultAccountName()`, and no string, mock or flow the frames show
changed.

- `account-default-name-en.png` was re-captured from the rebased build: `main`
  had also landed the account-time formatting change, so the older frame showed
  `Signed in 2026/10/1 08:00:00` while this build renders
  `Signed in 10/1/2026, 08:00:00` (`formatAccountTime` with the active
  `languageTag`).
- `account-default-name-zh-CN.png` is pixel-identical on the rebased build (the
  Chinese date format is the same either way), so it was kept as captured.
- The two export frames were kept: the frame's own content is unchanged on the
  rebased build. Re-running the capture produced differences only inside the
  blurred backdrop behind the modal (at most 5/255 in English, 25/255 in Chinese,
  where the sidebar's relative-age labels depend on the capture date); no element
  of the dialog or of the failed row changed.

Each language pair was captured with the same capture spec, viewport, mocked
services and flow, so locale is the only difference between the pairs.

## Instance

- `apps/desktop` served by its own Vite dev server on `127.0.0.1:4277`
  (`apps/desktop/e2e/playwright.config.ts` equivalent, separate port so an
  unrelated dev server on 4175 could not be reused), with
  `VITE_ACCOUNTS_API=http://127.0.0.1:4277/accounts` pinned so the mocked account
  service answers the sign-in.
- Every `/api/**` answer comes from the desktop mocked harness
  (`apps/desktop/e2e/fixtures.ts`); the account service (`/v1/**`) is mocked in
  the capture spec. No control plane, no credentials, no model calls.
- Browser: the pinned Playwright Chromium, full-page capture at 1320x860,
  `deviceScaleFactor: 2`, animations disabled.
- Locale is the only variable: `sciencediscovery-desktop:locale=en` for the
  English pair, `sciencediscovery-desktop:locale=zh-CN` for the Chinese pair.

## How the frames were taken

A throwaway Playwright spec drove the real app for both locales (one file, the
language selected by an environment variable) and was deleted before this
commit; nothing in `apps/desktop/e2e/` changed.

- **Default account name:** a HUAWEI callback sign-in whose account profile has
  `displayName: null`, so the app resolves the fallback name from the text
  table. The account page then shows `HUAWEI ID user` (en) or `华为账号用户`
  (zh-CN), with the same avatar, cards, rows and buttons in the same places.
- **Save-failed export row:** conversation menu → export conversation → start
  export, with the archive transfer route aborted. The download retries are
  exhausted, so the failed package appears under the saved-packages list with
  `The evidence package could not be downloaded. Try again.` (en) or
  `证据包下载失败，请重试。` (zh-CN), and `Technical details` / `技术细节` is
  expanded to show the raw transport wording (`Failed to fetch`), which stays
  out of the visible sentence in both languages. The error toast sits behind the
  modal backdrop in both frames, so it is not readable there and is not used as
  evidence: the row's sentence, the details block, and the row/toast equality
  are pinned by the component test in
  `apps/desktop/tests/user-facing-fallbacks.test.ts`.

## Files

| File | Visible evidence |
| --- | --- |
| `account-default-name-en.png` | English account page with the default name `HUAWEI ID user`, `Signed in 10/1/2026, 08:00:00` |
| `account-default-name-zh-CN.png` | The same page and state in Chinese: `华为账号用户`, `登录时间 2026/10/1 08:00:00`. Only the language differs; the heading's own text width follows the name. |
| `export-save-failed-en.png` | English save-failed export row with its localized sentence and the raw wording in the details block |
| `export-save-failed-zh-CN.png` | The same dialog and row in Chinese: `证据包下载失败，请重试。`, `技术细节` expanded. Only the language differs: the Chinese sentence fits one line, so the row is shorter than the English one, which shifts the centred dialog and the columns after the text. |

`sha256` of the committed files: `account-default-name-en.png` 98f2b40f…,
`account-default-name-zh-CN.png` fe7d30ab…, `export-save-failed-en.png`
87f2d4ba…, `export-save-failed-zh-CN.png` f1542fe2….

## Consistency check

A geometry probe of the live page at the same moment as each capture measured
the same boxes for the parts that do not depend on text: `.account-page`
64,0,1256x860, `.account-hero` 132,42,1120x56 and `.account-metrics`
132,122,1120x105 in both locales; for the export frame the dialog's x and width
(380, 560), the saved-packages block (409, 502 wide) and the row's x and width
(409, 502 wide) match too. What differs is text-driven: the account heading's
width (185 px English, 148 px Chinese), and in the export dialog the English
sentence wraps to two lines (row height 82 px) while the Chinese one fits on one
(45 px), so the centred dialog is 746 px tall in English and 669 px in Chinese;
the details column then follows the width of the sentence beside it and the
footer button follows its own label. No element changes place for a reason other
than its text.

Re-running the capture on the rebased build confirmed this: the Chinese account
frame is pixel-identical, and the only pixel differences in the other three sit
inside the element the frame is about (`account-default-name-en.png`: the
signed-in date text) or inside the blurred backdrop behind the dialog (the two
export frames).

These images are review evidence, not product assets: they can be dropped from
the branch before merge, as `docs/screenshots/1266/` was.
