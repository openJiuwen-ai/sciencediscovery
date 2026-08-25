---
name: create-pr
description: >
  Open a merge request on GitCode after running the test layers locally. Use
  when asked to create a PR or MR, submit a change for review, or when a branch
  is ready to propose. Covers which repository to target, what must pass first,
  and what happens after it opens.
---

# Create a merge request (GitCode)

Project-local skill for **ScienceDiscovery**.

**Read [CONTRIBUTING.md](../../../CONTRIBUTING.md) first** — *Opening a merge
request* and *Repositories* carry the process and the reason changes are
proposed on GitCode rather than GitHub. Command surface:
[.agents/skills/gitcode/SKILL.md](../gitcode/SKILL.md). Diagnosing a failed
check: [.agents/skills/ci/SKILL.md](../ci/SKILL.md).

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

## The process

[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns it — *Opening a merge request*
gives the gate (all three layers locally), the sandbox precheck, the branch and
push commands, and the `pr create` invocation. Follow it. This skill covers what
the CLI does not make obvious once you get there.

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

Three bots respond within a minute or two:

- **`openJiuwen-bot`** — CLA check, then a table of the console pipeline's
  steps (静态检查 / 禁用词扫描 / 防投毒检查 / 开源合规检查 / UT测试 / build).
  Those checks are CodeArts CloudBuild tasks; its `UT测试` is **not** the `ut`
  job in `.codearts/workflow/codearts-pipeline.yml`.
- **`atomgit-bot`** — a change summary and an AI review. `/ai review` and
  `/ai summary` re-trigger it from a comment.
- The repository's CodeArts CI, on the 流水线 tab. There is no separate
  `.gitcode/workflows/` Actions pipeline.

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
