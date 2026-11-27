# Failed bundled skill — review captures

Evidence for #1313 / PR #1314: a bundled Skill package that fails validation at
startup must stay visible as a non-actionable failed card in 设置 › 技能, and
must not be offered by the `/` palette or by the specialist 添加技能 picker,
while the skills that did load keep working. The Chinese frames use the app's
default locale; the English frames set `sciencediscovery-desktop:locale` to
`en` before the page loads.

## Instance

- The mocked desktop entry (`apps/desktop/e2e`, the same Playwright project CI
  runs), viewport 1440×900 with the default device scale factor 1.
- `/api/**` is answered by `apps/desktop/e2e/fixtures.ts`; the spec answers
  `GET /api/skills` per case, so no service, model or credential is involved.
- The catalog is one skipped built-in, `idea-tree-team`, plus three healthy
  built-ins: `literature-searcher`, `report-writer` and
  `structure-pocket-inspection`. The failed entry is exactly what
  `SkillCatalog.list()` reports — empty `hash`, no resources, `readOnly`, and
  the validator's own sentence under `loadFailure`:

  > `SKILL.md frontmatter is invalid YAML: Nested mappings are not allowed in compact mappings at line 3, column 16`

  Skill names and descriptions are the packages' own English text, so they do
  not change with the interface language; only the copy the app owns does.

## How the frames were taken

- `apps/desktop/e2e/failed-skill-cards.spec.ts` holds one test per surface, run
  once per language, and asserts the user-visible state before each capture:
  the failed card's localized reason, the validator sentence and the 内置 /
  Built-in source tag, no switch and no button at all on that card, a healthy
  card keeping its switch, the `/` palette holding exactly the three healthy
  rows and not the failed id, and the picker holding exactly the three healthy
  options and no checkbox for the failed id. Each of those assertions fails on
  the behaviour before the fix, where the skipped package was drawn as an
  ordinary card and offered by both pickers.
- Command, from the repository root with the pinned environment:

  ```bash
  PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" \
    apps/desktop/e2e/node_modules/.bin/playwright test \
    --config apps/desktop/e2e/playwright.config.ts \
    apps/desktop/e2e/failed-skill-cards.spec.ts
  ```

  It reports `6 passed` in about 7 s.
- Each frame is a full-viewport screenshot (`page.screenshot`, 1440×900, DPR 1)
  written with `testInfo.outputPath` and copied here unchanged.

## Captures

| File | Language | State | What it shows |
| --- | --- | --- | --- |
| `01-skills-failed-card-zh.png` | zh-CN | 设置 › 技能, 全部技能 (4) | The `idea-tree-team` card leads with 内置技能加载失败 in red, then the validator sentence, with the 内置 tag and no switch or row menu; the three healthy cards beside it keep their switches and descriptions |
| `01-skills-failed-card-en.png` | en | Settings › Skills, All skills (4) | The same card reads "This bundled skill failed to load" with the same validator sentence and the Built-in tag, and the healthy cards are unchanged |
| `02-slash-palette-zh.png` | zh-CN | composer draft `/` | The palette lists exactly `literature-searcher`, `report-writer` and `structure-pocket-inspection`; `idea-tree-team` is not offered |
| `02-slash-palette-en.png` | en | composer draft `/` | Same three rows in the English interface |
| `03-specialist-picker-zh.png` | zh-CN | 专家 › 新增专家 › 添加技能 | The 技能 tab lists the three healthy packages only, each with a checkbox, and 技能 0 / 添加 as the unselected draft |
| `03-specialist-picker-en.png` | en | Specialists › Add specialist › Add skill | The same three options under the English copy |

The two languages differ only in copy: same viewport, same catalog, same
elements in the same places. The palette frame sits over the empty-session
landing page, so the product wordmark behind it is the app's own background,
not an overlay added for the capture.
