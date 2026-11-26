# Skill import activation and stale Git pages — review captures

Evidence for #1442 / PR #1452: an installed Skill whose switch was refused must
say so where the user is looking and keep the way to fix it, and a Git import's
inspection must stop being importable the moment the repository field names
another repository. Both interface languages are captured, because the two
dictionaries are separate strings.

## Instance

- The mocked desktop entry (`apps/desktop/e2e`, the same Playwright project CI
  runs), viewport 1440×900 with the default device scale factor 1.
- `/api/**` is answered by `apps/desktop/e2e/fixtures.ts`. Nothing outside the
  mock is contacted.
- The Chinese run uses the app's default locale; the English run sets
  `sciencediscovery-desktop:locale` to `en` before the page loads.

## How the frames were taken

`apps/desktop/e2e/skill-import-activation.spec.ts` holds one test per language,
and both drive the same journey:

1. 设置 › 技能 › 添加技能 › 上传技能 / Settings › Skills › Add skill › Upload
   skills, choose `cif-reader.md`, press 确定 / OK. JiuwenSwarm refuses the
   switch once (502 `Skill switch failed`), so the dialog must keep the sentence,
   the reason, 启用 / Switch on and its own dismissal — frame 01 — and the pane
   behind it must not carry a second copy of the same sentence. The picker and
   确定 are inert in that state; the spec asserts that a file arriving anyway
   neither clears the notice nor starts a second upload.
2. Press 启用 / Switch on. The same switch is sent again (the upload is not
   repeated: the spec asserts exactly one `POST /api/skills/import`), the dialog
   closes and the pane shows the success notice — frame 02.
3. 添加技能 › 从 GitHub 导入 / Add skill › Import from GitHub, inspect the
   mocked repository and import its two packages. The job ends, its dialog
   closes, and JiuwenSwarm refuses the switch of the package it created, so the
   pane carries two notices at once: the job's result and the package that is
   installed but off — frame 03.
4. Dismiss the job's own notice. The activation notice stays, with its 点击重试 /
   Retry still on it — frame 04.
5. Inspect the repository again — two rows, both ticked, 导入选中的 2 项 /
   Import 2 selected ready — frame 05, then put another URL in 仓库地址 /
   Repository URL. The rows read from the first repository are gone and the
   import button is disabled — frame 06.
6. Import a second repository (`lab/two-skills`) that creates two packages,
   both of whose switches JiuwenSwarm refuses, so one notice has to name both.
   Dismiss the import's own notice: the sentence that is left is the one frame
   07 shows, with the names separated the way the current dictionary separates
   them.

Command, from the repository root with the pinned environment:

```bash
CI=1 .e2e/node_modules/.bin/playwright test \
  --config apps/desktop/e2e/playwright.config.ts \
  apps/desktop/e2e/skill-import-activation.spec.ts
```

It reports `2 passed`; a run with `--repeat-each=2 --retries=0` also reports
`4 passed`.

Each frame is an element capture (`screenshot({ animations: "disabled" })`,
DPR 1): the Skill dialog for frames 01, 05 and 06 (550 px wide), and the
settings pane `.settings-group-detail` for frames 02–04 and 07 (1074×888), which
is the element that also holds the toast column. They were written with
`testInfo.outputPath` and copied here unchanged.

## Captures

| File | Language | State | What it shows |
| --- | --- | --- | --- |
| `01-upload-switch-refused.png` | zh-CN | Upload dialog after 确定 | The install succeeded and the switch did not: `已安装，但未启用：cif-reader。`, the reason under it, and 启用 |
| `02-upload-switched-on.png` | zh-CN | After 启用 | The dialog is gone, the pane shows `「cif-reader」上传成功！`, and the row is on |
| `03-activation-toast-retained.png` | zh-CN | Import finished | `已安装，但未启用：band-plot。` with its 点击重试 beside the job's own `GitHub 技能导入成功！已导入 1 个技能。`; the band-plot row is listed with its switch off |
| `04-activation-toast-after-dismiss.png` | zh-CN | After dismissing the job's notice | Only the activation notice is left, still with 点击重试 |
| `05-git-inspected.png` | zh-CN | After 检查 | Two rows read from `lab/skills`, both ticked, 导入选中的 2 项 enabled |
| `06-git-rows-dropped-after-edit.png` | zh-CN | After editing 仓库地址 | The rows and the commit line are gone, the field holds the new URL, 导入 is disabled, and a neutral grey line says why: `仓库地址、Ref 或子目录在检查后已改变。请重新检查后再导入。` |
| `07-activation-two-refusals.png` | zh-CN | Second import, its own notice dismissed | `已安装，但未启用：alpha-skill、beta-skill。` — two names in one sentence, joined with `、` |
| `01-upload-switch-refused-en.png` | en | Upload dialog after OK | `Installed, but not switched on: cif-reader.` with `Skill switch failed` and Switch on |
| `02-upload-switched-on-en.png` | en | After Switch on | The dialog is gone and the pane shows `"cif-reader" uploaded.` |
| `03-activation-toast-retained-en.png` | en | Import finished | `Installed, but not switched on: band-plot.` beside `GitHub import done.` / `Imported 1 skills.` |
| `04-activation-toast-after-dismiss-en.png` | en | After dismissing the job's notice | Only the activation notice is left, with Retry |
| `05-git-inspected-en.png` | en | After Inspect | Two rows from `lab/skills`, both ticked, Import 2 selected enabled |
| `06-git-rows-dropped-after-edit-en.png` | en | After editing Repository URL | Rows gone, Import disabled, and the same explanation in the note under the field |
| `07-activation-two-refusals-en.png` | en | Second import, its own notice dismissed | `Installed, but not switched on: alpha-skill, beta-skill.` — the same two names joined with `, ` |

The English frames differ from the Chinese ones only in copy: same viewport,
same mock, same presses, same elements in the same places, and each pair comes
from the same spec file in the same run. Frames 07 are the pair that shows the
separator: the same two refused packages read `alpha-skill、beta-skill` in
Chinese and `alpha-skill, beta-skill` in English, because the separator belongs
to the dictionary rather than to the caller.

Frame 06 shows the state the fix produces: nothing from the first repository
stays selectable or importable, and the dialog no longer drops the rows in
silence. The line under the field is the same sentence the import guard uses,
`The repository, ref or subdirectory changed after this inspection. Inspect
again before importing.`, rendered in the neutral note colour rather than the
error colour — editing the source is a normal thing to do, and only its
consequence needs saying. The guard itself is unchanged and still refuses an
import whose source no longer matches the rows.

Frame 01 is also where the notice's layout shows: the sentence and the reason
take the full width, and 启用 with its dismissal sit on a row of their own below
them, so a long backend message cannot squeeze the recovery into a sliver.

The same two refused packages in frame 07 carry one reason line, not two: the
notice repeats a reason only when the backend gave a different one.

These images are review evidence, not product assets: they can be dropped from
the branch before merge, as `docs/screenshots/1266/` was.
