---
name: create-github-pr
description: >
  Open or update a pull request on GitHub's openJiuwen-ai/sciencediscovery:
  run the UT/ST/E2E layers locally, push the branch to the operator's own
  GitHub fork, write a body that says what was verified with numbers, apply
  exactly one release:* label so the release note can classify it, then read
  the pull request and its Actions run back. Use when asked for a GitHub PR,
  when a change is being proposed on the mirror rather than on GitCode, when
  labelling a pull request for the release note, or when reading a GitHub
  Actions result on a pull request. For a merge request on gitcode.com use the
  create-pr skill instead.
---

# Open a pull request (GitHub)

Project-local skill for **ScienceDiscovery**.

Most change reaches GitHub by being merged on GitCode and synced — that path is
[create-pr](../create-pr/SKILL.md), and it stays the default. This skill is for
the case where the pull request is opened on GitHub directly, which is what
happens when the work is about GitHub itself (the Actions workflows, the
release pipeline, `.github/`) or when a maintainer asks for it there.

Pipeline internals — which platform runs which layer, the workflow files, run
logs, failure attribution: [ci](../ci/SKILL.md). Journey design and reporting:
[e2e-testing](../e2e-testing/SKILL.md).

## Rules

1. **The layers are a gate, not a suggestion.** CONTRIBUTING says run all
   three locally. GitHub Actions runs them too, but on a pull request that is
   feedback arriving twenty minutes later, not permission to skip them.
2. **Push the branch to the operator's own fork, never to the upstream.**
   Resolve the login from `gh api user --jq .login`; do not hard-code a person
   and do not assume a remote named `origin` is a personal fork — in this
   repository `origin` is GitCode. Open the pull request with
   `--repo openJiuwen-ai/sciencediscovery --head <login>:<branch> --base main`.
3. **Exactly one `release:*` label**, from the whitelist below. The release
   note is grouped by it.
4. **Read the pull request back after creating it**, and read its Actions run
   before saying anything about CI.
5. **Say what was verified, with the actual numbers.** "Tests pass" is not
   reviewable; "UT 382 API + 100 runner, ST smoke ok, mocked E2E 42 passed /
   2 skipped / 0 failed" is.
6. **This skill stops at the pull request.** It does not merge, tag, or
   publish a release.

## Run the layers first

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok      # ci:ut and ci:e2e need it
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:ut   # not ci:ut:host
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:st
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:e2e
```

Run them on the commit you will push, collect the per-layer numbers for the
body, and attribute any failure against unmodified `main` in a separate
detached worktree before touching anything. The create-pr skill's *Run the
layers first* section covers this in full and applies here unchanged; nothing
about the layers differs by which host receives the proposal.

`pnpm ci:e2e` is the mocked **browser subset** only. Changed user-observable
behaviour also needs the relevant API, CLI or local-stack journey.

## The two hosts are different repositories

GitHub is a mirror of GitCode with its own history. Two consequences bite here:

- **Never compare SHAs across hosts.** The same change has a different commit
  id on each. Compare trees: `git rev-parse <a>^{tree}` on both.
- **Never push a GitCode-based branch to GitHub, or the reverse.** Rebase onto
  the host's own main first (`git rebase --onto github/main <old-base>`), and
  check the result does not contain the other host's base:
  `git merge-base --is-ancestor <other-base> HEAD` must fail.

## Choose exactly one release category

| Label | For |
| --- | --- |
| `release:breaking` | The user must change configuration, call sites or environment |
| `release:feature` | A new or extended user-facing capability |
| `release:fix` | Wrong behaviour in something that already existed |
| `release:performance` | Speed or resource use is the point of the change |
| `release:docs` | Documentation and usage guidance |
| `release:dependency` | A dependency update is the substance of the change |
| `release:internal` | Tests, CI, developer tooling, refactors with no external behaviour change |
| `release:skip` | Not worth a line in the release note — say why |

These are mutually exclusive: the label answers "which one section of the
release note does this belong under", not "which properties does this change
have".

- A breaking change is `release:breaking` and nothing else. That it is also a
  feature is already in the title, and an upgrading reader needs it in one
  place.
- A fix that also adds tests is `release:fix`. The tests are how it was
  proved, not what it is.
- A dependency bump whose purpose is fixing a user-visible bug is
  `release:fix`; a routine update is `release:dependency`.
- A new product capability is `release:feature` even when it is delivered as a
  Skill; maintaining a developer-facing agent skill is `release:internal`.
- **Never choose `release:skip` because the author is a bot, because the change
  arrived by sync, or because the diff is small.** Category follows content. If
  there is any user impact, or the category is unclear, ask rather than
  silently skipping — a skipped pull request leaves no trace in the note.

The categories and their order live in
[.github/release.yml](../../../.github/release.yml). An unlabelled pull
request is not dropped, it lands in *Other Changes* — which is a backstop to
read and fix, not a default to rely on.

**Applying a label needs write access to the upstream repository.** An outside
contributor can open the pull request and cannot label it. When the label
cannot be applied, put the intended category in the body, say plainly that the
GitHub label is pending a maintainer, and do not report it as applied. Do not
invent a category outside the whitelist, and do not touch the `ci-*`,
`priority/*`, `sync-managed` or general classification labels — they serve
other purposes and this skill has no business rewriting them.

## Title and body

Title: `<type>(<scope>): <the change and its effect>`, scope optional. It
becomes the release note entry, so it has to read as a sentence to somebody who
has not seen the diff. `update`, `fix bug`, `修改 App.tsx` and `同步代码` are
not titles. A pull request paired from a GitCode merge request keeps the
original meaning of its title — never flatten it to `Sync from GitCode`.

```markdown
<One paragraph: what changes and why. Lead with the problem, not the patch.>

## <Each substantive change>
<What it does, and the reasoning a reviewer cannot reconstruct from the diff.>

## Validation
<Layer results with numbers. Name anything not covered and why.>

## E2E user journeys
<PASS / FAIL / BLOCKED; tested SHA; browser / API / CLI / local stack;
scenario → expected outcome → actual outcome; commands; passed / failed /
blocked / skipped counts and failure attribution.>

## Release
Release category: <one release:* label>
User impact: <what a user notices; or the internal scope if none>
Compatibility and migration: <none; or the incompatibility and the steps>
```

The body's `Release category:` is this project's own convention for carrying
the intent — it is not a GitHub instruction and it does not label anything. The
label on the pull request is what the release note reads.

Only a change with no user-observable product path (a comment, a pure doc edit)
may write **not applicable** in the E2E section, with a concrete reason.
Backend-only is not an exemption; missing credentials or absent coverage are
BLOCKED or a coverage gap, not not-applicable. Evidence must be public-safe: no
credentials, no local paths, no links a repository reader cannot open. A pull
request that must not be merged — a CI experiment, a spike — says so in both
the title and the body, and says what would have to be deleted first.

## Open it, then read it back

```bash
login=$(gh api user --jq .login)
git push -u <fork-remote> HEAD:<branch>
gh pr create --repo openJiuwen-ai/sciencediscovery \
  --base main --head "$login:<branch>" \
  --title '<type>(<scope>): …' --body-file <file>

gh pr view <n> --repo openJiuwen-ai/sciencediscovery \
  --json number,state,baseRefName,headRefName,headRefOid,labels,url
gh pr edit <n> --repo openJiuwen-ai/sciencediscovery --add-label release:<category>
```

Reading it back is not ceremony. It is how you find out that the head is a
branch GitHub deleted when an earlier pull request merged, that the base is not
what you meant, or that the diff is empty because the head is already contained
in the base.

## Its Actions run

The pull request starts the six jobs in `.github/workflows/ci.yml`: UT, ST,
E2E (mocked), Binary release ×2, Docker image.

```bash
gh run list --repo openJiuwen-ai/sciencediscovery --branch <branch> --limit 5
gh run view <run-id> --repo openJiuwen-ai/sciencediscovery \
  --json status,conclusion,jobs --jq '.jobs[] | "\(.conclusion // .status)\t\(.name)"'
gh run view <run-id> --repo openJiuwen-ai/sciencediscovery --log-failed
```

Judge every job, not the aggregate. For E2E read the run summary's counts:
Playwright exits 0 on skips, and a BLOCKED journey is reported as skipped, so a
green check alone does not mean the journeys ran.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `No commits between <base> and <head>` and `Head ref must be a branch` | The head branch does not exist. GitHub deletes it automatically when a pull request from it merges; confirm with `git ls-remote <fork> 'refs/heads/<branch>'` before believing the message's claim about the base. |
| The fork's `main` is hundreds of commits behind | It is a fork nobody syncs. Do not use it as a base and do not push upstream's main to it — `on: push: branches: [main]` would spend a full CI run on nothing. Base the pull request on a `ci/*` branch pushed at the upstream commit instead. |
| A GitHub remote looks diverged with identical files | Separate histories. Compare trees, not SHAs. |
| The Docker or E2E job fails only on GitHub | Read the job log and the uploaded artifact (`docker-compose-logs`, `e2e-results`) before theorising; the product's own startup probe usually already said what was wrong. |
| A tag push produced no release | The tag did not match `.github/workflows/release.yml`'s filter, which is a glob and not a regex. A non-matching tag fails silently — nothing runs and nothing reports. |
| The release note's *Other Changes* is long | Pull requests in the range have no `release:*` label. Label them before publishing; the section exists to make that visible. |
