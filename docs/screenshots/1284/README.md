# Import dialog omissions — review captures

Captures of the import dialog's `Not included: N items` / `未包含 N 项` block
added for #1024, for the reviewers' zh-CN and en render check. They were
rendered from the source of commit `c974ff66` (the reviewed head of this
branch); the commit that carries these files adds only the PNGs and this note.

| File | Locale | State |
| --- | --- | --- |
| `zh-import-dialog.png` | zh-CN | Whole import dialog after choosing a package that lists 11 omissions |
| `zh-omissions.png` | zh-CN | The chosen-file card, so the block and its rows are readable |
| `en-import-dialog.png` | en | The same dialog in English |
| `en-omissions.png` | en | The English card |
| `zh-zero-omissions.png` | zh-CN | A package whose manifest omits nothing: `未包含 0 项`, no list |
| `en-zero-omissions.png` | en | The same zero case in English |

## How these were rendered

A scratch harness, kept outside this repository, mounted the real
`apps/desktop/src/views/ResearchPackage.tsx` through Vite with the app's own
`src/styles/index.css` cascade (tokens, overlays, research-package), and headless
Chromium 156 captured it through the Chrome DevTools Protocol at 1280 CSS px
wide, 2× device pixel ratio. No HTML or CSS for the dialog was written by hand.

The dialog is opened by the component's own `request` prop, and the package is
chosen through the dialog's own file input with a real `File` and a real
`change` event. The only stub is `ApiClient.request`: it answers
`POST /api/projects/p1/research-package/inspect` with one fixed inspection
object. Its 11 omissions are the fixture entries from
`apps/desktop/tests/research-package-trim.test.tsx` — the six machine tokens
plus the five fixed sentences that `services/api/src/research-snapshots.ts`
writes into a manifest. The file name, project and source title are fixture
data.

Not captured: an Electron window, the native file picker and anything the OS
draws. This container has no display, so only the component tree renders; the
dialog, its scrim and its styles are the application's own.
