---
name: create-pr
description: >
  Open a merge request on GitCode: run the UT/ST/E2E layers locally first,
  write a body that says what was verified with numbers, target
  openJiuwen/sciencediscovery, then read the bot comments and the CodeArts
  result the merge request receives. Use when asked to create a PR or MR,
  submit a change for review, when a branch is ready to propose, or when
  interpreting a merge request's CI result comment or ci-* labels.
---

# Create a merge request (GitCode)

Project-local skill for **ScienceDiscovery**.

**Read [CONTRIBUTING.md](../../../CONTRIBUTING.md) first** — *Opening a merge
request* and *Repositories* carry the process and the reason changes are
proposed on GitCode rather than GitHub. Command surface:
[.agents/skills/gitcode/SKILL.md](../gitcode/SKILL.md). Pipeline internals —
which platform runs which layer, the workflow files, run logs, and failure
attribution: [.agents/skills/ci/SKILL.md](../ci/SKILL.md).

## Rules

1. **The layers are a gate, not a suggestion.** CONTRIBUTING says run all
   three; do not open a merge request without them.
2. **Target `openJiuwen/sciencediscovery` on gitcode.com.** GitHub is a synced
   mirror with its own SHAs; a merge request opened there is in the wrong place.
3. **Read the merge request back after creating it.** The create response is
   thin and will not tell you whether it landed as intended.
4. **Say what was verified in the body**, with the actual numbers. "Tests pass"
   is not reviewable; "382 API tests, 100 runner tests, mocked E2E 5 passed /
   2 skipped" is.

## Run the layers first

No pipeline runs the full set — CodeArts runs `ci:ut:core` and `ci:st` on the
merge request, GitHub runs the rest on the mirror (see the ci skill) — so the
local run is the only complete check a reviewer gets.

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok      # ci:ut and ci:e2e need it
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:ut   # not ci:ut:core
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:st
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:e2e
```

- Run them on the commit you will push. When the working tree carries anything
  else, use a clean worktree of that commit (`git worktree add --detach
  .worktrees/<name> <sha>`); the layers install and build there themselves.
- Each layer leaves `run.log` and a summary under `CI_RESULTS_DIR/<layer>/`.
  With a relative `CI_RESULTS_DIR`, `ci:e2e` writes its journey reports below
  `.e2e/.tmp/…` instead, because Playwright runs from `.e2e/`.
- Collect the numbers for the body: the per-package `# pass` / `# skipped`
  lines in the UT `run.log`, the paper, gateway, binary, and memory-graph
  totals, the ST smoke line, and the E2E discovered / passed / failed /
  skipped split. A skipped or BLOCKED E2E case is not a pass; the
  [e2e-testing skill](../e2e-testing/SKILL.md) owns that reporting.
- When a layer fails, attribute it before touching anything: run the same
  layer on unmodified `origin/main` in a separate detached worktree. An
  identical failure is pre-existing — state it in the body with the step, the
  error, and the baseline run, and leave the fix to its own merge request. A
  failure only on your commit is yours: fix it and rerun that layer on the new
  commit.
- Never weaken an assertion or skip a layer to get green. If a layer cannot
  run on this host (no sandbox), say which and why in the body; `ci:ut:core`
  is not a substitute for `ci:ut`.

## The process

[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns it — the branch and push
commands and the `pr create` invocation. Follow it. A branch on the upstream
repository and a branch on a personal fork both trigger CodeArts; for a fork
pass `--head <fork-owner>:<branch>`. This skill covers what the CLI does not
make obvious once you get there.

## Body shape

```markdown
<One paragraph: what changes and why. Lead with the problem, not the patch.>

## <Each substantive change>
<What it does, and the reasoning a reviewer cannot reconstruct from the diff.>

## Validation
<Layer results with numbers. Name anything not covered and why.>
```

Mark a merge request that must not land — a CI experiment, a spike — in both
the title and the body, and say what to delete before it could be merged.

## After it opens

Two bots respond within a minute or two:

- **`openJiuwen-bot`** — a welcome comment, the CLA result (`CLA 签署成功`,
  label `openJiuwen-cla/yes`), then `The pipeline(pipeline number:<n>) is
  running` with the label `ci-running`. When the parent workflow in
  `.codearts/workflow/codearts-pipeline.yml` finishes, the bot posts the
  result that workflow rendered (see below) and adds `ci-successful` or
  `ci-failed`.
- **`atomgit-bot`** — a change summary, `AI 代码检视正在进行中`, a command
  guide, and the review verdict (`代码审查 ✅ 未发现问题` or findings).
  `/ai review` and `/ai summary` re-trigger it from a comment.

The 流水线 tab on the PR page shows the same CodeArts run; there is no separate
`.gitcode/workflows/` Actions pipeline. To run CI again without pushing,
comment `rerun` on the PR.

## Reading the result

The result comment is rendered by the parent workflow, and the bot posts it
unchanged: `✅ 流水线 <run_id> 执行成功` or `❌ … 执行失败`, the
`/pull/<n>/check` link, then one table — 代码检查 (SCA / Anti-poison /
CodeCheck / Blacklist, each with its own status), `UT`, `ST`, and the x86_64 /
aarch64 binary jobs, each `PASSED` or `FAILED` — and the `rerun` hint.
The `UT` and `ST` rows are the workflow's `ut` and `st` jobs, the same
`ci:ut:core` and `ci:st` entry points run locally. Judge each code-check child
from its own row; do not treat one successful sibling or the parent summary as
evidence that every child passed.

- `公开日志` in a UT/ST row links the OBS `run.log` of that job. A cell that
  says `查看构建日志（公开测试日志未生成）` means the job died before its
  upload step (checkout, provisioning), so no test ran; open the Checks page.
  Log locations and CodeArts internals: the ci skill's CodeArts reference.
- Labels: `ci-running` while the run is in progress, then `ci-successful` or
  `ci-failed`. Judge a run by its latest result comment, not by the label set.
- Read it back before responding. `gitcode pr view --comments --json` nests
  the PR under `.pull_request` (see the gitcode skill); for label and state
  history use the REST API:

```bash
gitcode pr view <n> -R openJiuwen/sciencediscovery --comments --json
gitcode api repos/openJiuwen/sciencediscovery/pulls/<n>              # labels, state, head/base SHAs
gitcode api repos/openJiuwen/sciencediscovery/pulls/<n>/operate_logs # add/delete label, force-push, close events
```

If a check fails, find out whether the change caused it. Compare against other
open merge requests before assuming ownership — a step that fails identically
on every open request is pre-existing, and saying so with evidence is more
useful than a speculative fix.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `create` returns a number but no `html_url` | Normal. Read it back with `pr view`. |
| 409, "same source branch already has an open MR" | Read that merge request first; it may be this attempt, an earlier one, or someone else's. Never rename the branch to dodge it. |
| A GitHub remote looks diverged with identical files | The two hosts have separate histories. Compare trees, not SHAs. |
| CI red immediately, 1s, empty log | Nothing ran — infrastructure, not the change. See the ci skill. |
| A UT/ST cell says `查看构建日志（公开测试日志未生成）` | The job died before its upload step (checkout, provisioning); open the Checks page, the test itself never ran. |
| `ci-running` is still on the PR after the result comment | The publisher adds the final label but has not removed `ci-running`; the latest result comment is authoritative. |
| `The PR commit(s) can not be got` after a push | The PR's head is already contained in its base (empty diff), so the bots cannot read commits or a diff; no result is published for that run. |
