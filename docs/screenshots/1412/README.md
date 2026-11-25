# Idea Tree budget-exhausted panel — review capture

Evidence for #1412 / PR #1423, captured on head `0a0ca03f34` (the commit before
these evidence files were added) so the finished-research state can be confirmed
from the rendered panel rather than from markup.

## How it was captured

- A local Vite harness in `apps/desktop/.tmp/shot` mounts the real
  `apps/desktop/src/views/idea/IdeaResearchPanel.tsx` with the full stylesheet
  (`apps/desktop/src/styles/index.css`).
- Environment Chromium headless at 1280×700, `deviceScaleFactor: 1`.
- The panel's API client is mocked in the harness: it returns one fixed
  `IdeaResearchView` and an empty SSE stream. No Python service, model call or
  Electron shell is involved.

## What is mocked

The research view is fixture data written for this capture: objective
`高熵合金涂层筛选`, `status: "budget_exhausted"`, `tokens: 180000`,
`usageKnown: true`, `settings.maxTokens: 200000`, and a small three-node tree
with two scored candidates. The reason string mirrors the engine's reported-usage
form so the panel's own localized budget note is exercised.

## What the frame shows

The panel header reads `已结束（预算用尽）`, the note below it reads
`token 预算已用尽，研究已结束（已用 180000 tokens，上限 200000 tokens）。如需继续，请提高 token 上限后新建研究。`,
and the footer has no `继续` button. This is review evidence, not a real research
journey, and the code is unchanged since `0a0ca03f34`; only this image and README
are added.
