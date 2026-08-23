---
name: create-pr
description: >
  Open a merge request on GitCode after running the test layers locally. Use
  when asked to create a PR or MR, submit a change for review, or when a branch
  is ready to propose. Covers which repository to target, what must pass first,
  and what happens after it opens.
---

# Create a merge request (GitCode)

Project-local skill for **ScienceDiscovery**. Changes are proposed on GitCode;
GitHub receives them through a periodic sync and is not where review happens.

Command surface: [.agents/skills/gitcode/SKILL.md](../gitcode/SKILL.md).
What CI does and does not cover: [.agents/skills/ci/SKILL.md](../ci/SKILL.md).

## Rules

1. **Run the three layers locally before opening.** No pipeline runs the full
   set, so review starts from an unverified change otherwise. Step 1 is a gate,
   not a suggestion.
2. **Target `openJiuwen/sciencediscovery` on gitcode.com.** GitHub is a synced
   mirror with its own SHAs; a merge request opened there is in the wrong place.
3. **Never push to `main`.** Branch, push the branch, open a merge request.
4. **Branch from an up-to-date `origin/main`**, and rebase rather than merge
   when it moves — a merge commit makes the diff unreadable.
5. **Say what was verified in the body**, with the actual numbers. "Tests pass"
   is not reviewable; "382 API tests, 100 runner tests, mocked E2E 5 passed /
   2 skipped" is.
6. If the change cannot pass a layer, say so in the body and why. Do not weaken
   an assertion to get a green run.

## Step 1 — Run the layers (gate)

```bash
pnpm ci:ut     # not ci:ut:core — the sandbox tests only run here and on GitHub
pnpm ci:st
pnpm ci:e2e
```

`ci:ut` and `ci:e2e` need a working sandbox. Check before blaming the change:

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok
```

Outside the `.ci` image, redirect the layer directories and keep the runtime
one outside the checkout:

```bash
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=~/ci-runtime pnpm ci:st
```

Record what each layer reported. Those numbers go in the body.

## Step 2 — Branch and commit

```bash
git fetch origin
git checkout -b <type>/<short-topic> origin/main
```

Check `git status` before committing: no `.tmp/`, no local agent or editor
config, no private notes. Commit messages state what changed and why, not the
process that produced them.

## Step 3 — Push the branch

```bash
git push -u origin <branch>
```

Write to `openJiuwen/sciencediscovery` directly if you have access; otherwise
push to a personal GitCode fork and open the merge request from there.

## Step 4 — Open the merge request

Long bodies go in a file — the CLI's inline `--body` mangles multi-line text.

```bash
gitcode pr create -R openJiuwen/sciencediscovery \
  --head <branch> --base main \
  --title "<type>: <what changed>" \
  --body-file .tmp/pr.md --json
```

**The create response is thin** — `html_url` comes back empty and some fields
are null. Always read the merge request back to confirm what was actually
created:

```bash
gitcode pr view <n> -R openJiuwen/sciencediscovery --json
```

Check `head.sha` matches what you pushed, `base.ref` is `main`, and
`changed_files` is what you expect. A 409 means a merge request already exists
for that branch — read it before retrying; the gitcode skill covers the cases.

### Body shape

```markdown
<One paragraph: what changes and why. Lead with the problem, not the patch.>

## <Each substantive change>
<What it does, and the reasoning a reviewer cannot reconstruct from the diff.>

## Validation
<Layer results with numbers. Name anything not covered and why.>
```

Mark a merge request that must not land — a CI experiment, a spike — in both
the title and the body, and say what to delete before it could be merged.

## Step 5 — After it opens

Three bots respond within a minute or two:

- **`openJiuwen-bot`** — CLA check, then a table of the console pipeline's
  steps (静态检查 / 禁用词扫描 / 防投毒检查 / 开源合规检查 / UT测试 / build).
  That pipeline is configured outside this repository; its `UT测试` is **not**
  the `ut` job in `.gitcode/workflows/ci.yml`.
- **`atomgit-bot`** — a change summary and an AI review. `/ai review` and
  `/ai summary` re-trigger it from a comment.
- The repository's own CI, on the 流水线 tab.

Read a result before responding to it:

```bash
gitcode pr view <n> -R openJiuwen/sciencediscovery --comments --json
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
| The bot's `UT测试` fails but the repository CI passes | Different pipelines. Check whether it fails on other open merge requests too. |
