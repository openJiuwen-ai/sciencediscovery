# Export preview states — review captures

Evidence for #1440 / PR #1447: the desktop export dialog must not authorize an
export from a preview that no longer describes the current selection, must
explain a revision-change failure in the interface language, and must ask again
after an over-cap selection changes. Every state is captured in both interface
languages, from the same fixture, viewport and selection, so a zh/en pair
differs only in copy.

## Instance

- The mocked desktop entry (`apps/desktop/e2e`, the same Playwright project CI
  runs), viewport 1440×900 with the default device scale factor 1.
- `/api/**` is answered by `apps/desktop/e2e/fixtures.ts`; the spec overrides
  `**/research-package/**` per state, so no service, model or credential is
  involved.
- The fixture session is `晶体结构分析` with two workspace files, `results.csv`
  and `notes.md`, so the export dialog has a real file list to change. The
  English runs set `sciencediscovery-desktop:locale` to `en` before the page
  loads and change nothing else.

## The size the over-cap frame shows

The over-cap state has to print a cap a real deployment can produce, so the
mock answers with the numbers the service itself computes instead of a
fixture-only limit:

- `maxBytes` is `RESEARCH_PACKAGE_MAX_BYTES`
  (`packages/research-package/src/index.ts:103`), which is
  `RESEARCH_PACKAGE_DEFAULT_MAX_BYTES` = 5 GiB
  (`packages/research-package/src/index.ts:39`) unless
  `SCIENCE_AGENT_RESEARCH_PACKAGE_MAX_BYTES` sets it, and that override is
  refused outside `RESEARCH_PACKAGE_MIN_MAX_BYTES` (64 MiB) …
  `RESEARCH_PACKAGE_MAX_MAX_BYTES` (8 GiB − 1). The preview reports this value
  as `maxBytes` (`services/api/src/research-snapshots.ts:975`).
- The selection is 6 GiB uncompressed — above the 5 GiB default and inside the
  range those two workspace files could really grow to.

The spec supplies only those byte counts; the dialog renders both through its
own `formatBytes` (`apps/desktop/src/app/format-bytes.ts`, KB/MB/GB with one
decimal), so the frame reads `未压缩上限：5.0 GB` / `Uncompressed limit: 5.0 GB`
for the cap and `当前选择未压缩为 6.0 GB` / `This selection is 6.0 GB` for the
selection. Those strings are asserted from the rendered dialog before the
screenshot, not written by the spec, and the earlier frame's `1.0 MB` — a value
the product never computes — is gone with the fixture that produced it.

## How the frames were taken

- `apps/desktop/e2e/export-preview-states.spec.ts` runs one test per state and
  language (six in all) and asserts the user-visible outcome before each
  capture: the Start export button is disabled, the stalled notice and last
  estimate are on screen, the failed row leads with the localized sentence, the
  server sentence is inside 技术细节 / Technical details, and the over-limit
  warning returns after the file set changes.
- Command, from the repository root with the pinned environment:

  ```bash
  PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" CI=1 \
    apps/desktop/e2e/node_modules/.bin/playwright test \
    --config apps/desktop/e2e/playwright.config.ts \
    apps/desktop/e2e/export-preview-states.spec.ts
  ```

  It reports `6 passed`. The stalled-recalculation runs take about 10 s each
  because the dialog waits out six `EXPORT_PREVIEW_PENDING` answers at 1.5 s
  before it stops; the other four finish in a few seconds.
- Each frame is a full-viewport screenshot (`page.screenshot`, 1440×900, DPR 1)
  written with `testInfo.outputPath` and copied here unchanged, named
  `<state>-<language>-<commit>.png`. The suffix is a commit a reader can
  resolve, `2be03a75`: the one that carries these six images together with the
  spec, the fixture and the product code that produced them. The files were
  renamed to it without touching a byte of image data; [Provenance](#provenance)
  shows both.

## Captures

| File | Language | State | What it shows |
| --- | --- | --- | --- |
| `01-stalled-recalculation-zh-2be03a75.png` | zh-CN | 导出会话 › 必要导出, one file unticked, recalculation pending | The stalled-preview notice and 重新计算大小, the previous 30.0 KB estimate still visible, the unticked file marked as an omission, and 开始导出 disabled |
| `01-stalled-recalculation-en-2be03a75.png` | en | Same state, same file and selection | The English stalled notice and Recalculate size, the same 30.0 KB estimate, `Not included: 1 workspace file`, and Start export disabled |
| `02-revision-change-failure-zh-2be03a75.png` | zh-CN | 导出任务失败 with `会话内容已更新，请使用最新大小预览重新导出。` | The failed row leads with 会话内容已更新，请先重新计算大小预览，再重新导出。 and 技术细节 holds the server sentence |
| `02-revision-change-failure-en-2be03a75.png` | en | Export task failed with the same server sentence | The failed row leads with "The conversation has changed. Recalculate the size preview, then export again." and Technical details holds the server sentence |
| `03-over-limit-reacknowledged-zh-2be03a75.png` | zh-CN | 超限选择已确认 仍要导出, then the file set changes | The over-limit warning is shown again for the changed selection against the product's 5.0 GB cap with a 6.0 GB selection, the confirmation line is gone, and 开始导出 is disabled |
| `03-over-limit-reacknowledged-en-2be03a75.png` | en | Same state, same bytes and selection | `Uncompressed limit: 5.0 GB`, `This selection is 6.0 GB uncompressed, over the 5.0 GB limit.`, no confirmation line, and Start export disabled |

Every name carries `2be03a75`, the commit these frames belong to and the same
one their code lives in. The toast behind the modal backdrop in the failure
frames is the same message the failed row carries; the row is the readable
record because the dialog is open over it.

## Provenance

The six files are named after `2be03a75`
(`fix(desktop): bind export to the previewed selection and stop stale retries`),
the squash commit of this branch. That commit adds the six images together with
`apps/desktop/e2e/export-preview-states.spec.ts`, the fixture in
`apps/desktop/e2e/fixtures.ts` and the product code each frame shows, so the
suffix names the commit the images belong to and it resolves from any clone.

A commit cannot contain a file named after itself: `2be03a75` added the frames,
and this directory's own commit renamed them to carry it. The rename moves no
image data, and nothing behind the frames changed afterwards:

```bash
git show --stat 2be03a75     # the six images, the spec, the fixture, the code
git diff -M 2be03a75 origin/bot/issue-1440 -- docs/screenshots/1440
git diff 2be03a75 origin/bot/issue-1440 -- apps/desktop packages
```

The first line shows the commit that owns the images; the second lists six pure
renames plus this README; the third prints nothing, so the product code, the
spec and the fixture that produced the frames are still the ones at
`2be03a75`.

The pixels were captured before the branch was squashed. The tree that rendered
them differs from `2be03a75` only in these images and this README, so the spec,
the fixture and the product code the run used are the ones `2be03a75` carries,
and the six tests that produced the frames are the tests there (the mocked spec
is reported passing at `2be03a75` as `6 passed`). That interim revision is not
in the published history, and no name or sentence in this directory cites it.

## One difference between the two languages, stated

An English sentence wraps to more lines than its Chinese counterpart, so the
`03` dialog is taller in `en` than in `zh` at the same 1440×900 viewport. The
over-limit copy pushes the closing `Not included: 1 workspace file` sentence to
top y≈800, while the dialog body's visible area ends at y≈792 (measured in the
same run: the body's content is 738 px in a 683 px box). The sentence is
rendered and counted in the layout, and it is visible in the Chinese frame; it
falls just below the English frame's scroll fold. The changed selection it
summarises — `results.csv` unticked, `notes.md` kept — is visible in both
frames, and the numbers, the warning and the disabled 开始导出 are identical. No
frame was scrolled or cropped to hide it.
