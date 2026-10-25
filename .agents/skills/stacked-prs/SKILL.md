---
name: stacked-prs
description: >
  Split one large change into a stack of pull requests on GitHub's
  openJiuwen-ai/sciencediscovery, then carry each layer through review and
  merge: rebase the next branch onto main after the one below lands, answer and
  resolve review threads, and keep every body's numbers true. Use when the
  operator asks to split a feature into several pull requests, when a lower
  layer of an existing stack has merged and the next one reports CONFLICTING,
  when review comments need fixes, or when git transport to github.com is
  unavailable and a branch has to be pushed through the API.
---

# Stacked pull requests

Project-local skill for **ScienceDiscovery**. Read
[create-github-pr](../create-github-pr/SKILL.md) first — it owns the single-PR
procedure, the body format, the labels and the local gates. This file adds only
what a stack changes: how the change was cut, how the branches stay linear, and
what to do each time a lower layer merges.

## Shape of a stack

- One branch per layer, named `pr/NN-<slug>`, each branched from the layer
  below rather than from `main`. The top branch is cumulative on `main`; each
  PR's compare view against its predecessor shows only its own diff.
- Merge **bottom-up with a rebase-merge, never squash**: squash collapses two
  layers into one commit and the next branch loses the parent it was built on.
- Every body carries a stack section: `Part N of M, built on #<previous>` plus
  the compare link between the two branches
  (`compare/pr/NN-…pr/MM-…`). It tells the reviewer which diff to read and
  makes the merge order unambiguous.
- A layer is a **vertical slice**: it builds and tests on its own and delivers
  one reviewable capability. Lower layers never import from higher ones, and
  no layer references a symbol that only exists above it.
- Scope is the current layer's own code. A review comment that points at
  something an earlier layer introduced is answered as out of scope; if it is
  worth fixing, it gets its own PR. **A later PR does not repair an earlier
  PR's bug** — that rule comes from the operator and keeps the stack's history
  honest.

## Cut the change

1. List the layers bottom-up and give each one a title of the form
   `<type>(<scope>): <the change and its effect>` — it becomes a release-note
   line.
2. Create the first branch from the current `main`, commit the first slice,
   then branch the next layer from the previous branch's head. Repeat upward.
   A linear stack is what makes the per-PR diff and the rebase procedure work.
3. Write each body file **before** opening the PRs and keep them outside the
   repository (a scratch directory such as `/tmp/pr-bodies/<number>.md`).
   Opening six PRs with six half-written bodies guarantees drift later.
4. Run the local gates on each layer's head before pushing it, and record the
   numbers for that head. Do not copy the top layer's numbers down into lower
   bodies: the code they cover is different.

## Push without git transport

`github.com` can be unreachable for git transport while `api.github.com`
works, so `git push` times out. Push through the Git Data API instead, using
`gh` for auth (no token handling):

For each branch, from its head commit:

1. `git cat-file commit <sha>` → tree, first parent, author, committer, message.
2. Upload every blob that differs from the parent (`git diff-tree -r --raw
   <parent> <commit>`), base64 through `POST git/blobs`; deletions are entries
   with `sha: null`.
3. `POST git/trees` with `base_tree` = the parent's tree and those entries.
4. `POST git/commits` with the exact message, tree, parent and identities.
5. Move the ref: `PATCH git/refs/heads/<branch>` with `force: true` (or
   `POST git/refs` the first time).

**Check every server-side SHA against the local one** — blob, tree, commit —
and abort on a mismatch. That check is what makes the pushed branch
byte-identical to the one that was tested; without it a silent normalization
would invalidate the local gate results. `git rev-parse <branch>^{tree}` on the
local side and the created tree's SHA are the comparison that matters most.

A ready-made script may exist in the session scratch directory; if it does,
reuse it, but read it before trusting it. If it does not, the algorithm above
is the whole of it. Two environment notes:

- Run it with `python3 -I` when the working directory may contain files that
  shadow the standard library (`types.py`, `re.py`, …); the crash looks like a
  circular import in `re`.
- The PR's `head.sha` can lag a few seconds behind the ref. Read it back with
  `gh pr view <n> --json headRefOid` after the push; do not conclude the push
  failed from the first read.

## After a lower layer merges: rebase the next

A rebase-merge **rewrites** the layer's commit: same tree, new committer and
new SHA. `main`'s head is therefore no longer the parent of the next branch,
and GitHub reports that PR `CONFLICTING` even though the files are identical.
The fix is to make the local repository aware of the new upstream commit and
replay the next layer onto it.

1. Find the new head and its metadata:
   `gh api 'repos/<owner>/<repo>/commits?sha=main&per_page=8'`, then
   `gh api repos/<owner>/<repo>/commits/<head>` for `.commit.tree.sha`,
   author/committer and the full message.
2. Compare trees. `git cat-file -p <old-local-parent>` shows the old parent's
   tree; if it equals the new head's tree, only the commit object is missing
   locally and the rebase will apply cleanly.
3. Reconstruct that commit object byte-exactly so the local DAG matches
   upstream:

   ```text
   tree <tree>
   parent <parent>
   author <Name <email>> <epoch> <±HHMM>
   committer <Name <email>> <epoch> <±HHMM>

   <message>
   ```

   Compute `sha1("commit <len>\0" + body)` and write it with
   `git hash-object -t commit -w --stdin`; the result must equal the upstream
   SHA. If it does not: the message may or may not end in a newline, and the
   timezone offset is not always the author's. Brute-force the offset
   (−12:00…+14:00 in 15-minute steps) and both message endings. The committer
   is often the maintainer, not the author — that is expected.
4. Take a backup ref (`git branch backup/prNN-<date> pr/NN`), then
   `git rebase --onto <new-head> <old-parent> pr/NN`. If the range is empty,
   the old-parent argument is wrong: stop, reset to the backup, and re-read
   step 1 rather than guessing. Re-running a rebase after a reset has already
   put one branch on top of the wrong base once in this project's history.
5. Verify before pushing: `git log --oneline -3` shows the layer's commit on
   the new head; `git diff --stat <new-head>..HEAD` is the layer's own diff;
   `git merge-base --is-ancestor <new-head> HEAD` succeeds; typecheck and the
   affected tests pass.
6. Push through the API (above) and read the head back.

If the tree **differs**, `main` changed content as well as history. Fetch the
commit's tree from `gh api repos/<owner>/<repo>/tarball/<sha>`, extract it into
a fresh directory, build the tree object with a temporary index
(`GIT_INDEX_FILE=<file> git --work-tree=<dir> add -A -f .`, then
`git write-tree`), and confirm the SHA before writing the commit.

`git gc` may print `bad tree object …` for these reconstructed commits (the
tree is referenced but not stored). It is harmless; leave it alone.

Rebase one layer at a time, immediately after the layer below merges. A stack
left pointing at old parents collects conflicts on every branch above it.

## Review threads

List them with GitHub GraphQL and look only at `isResolved: false`:

```graphql
pullRequest(number: N) {
  reviewThreads(first: 50) {
    nodes { id isResolved path line
            comments(first: 20) { nodes { databaseId author { login } body } } }
  }
}
```

Reply in the thread (`addPullRequestReviewThreadReply`), then resolve it
(`resolveReviewThread`); resolve only after the reply is posted. Reply in the
language the thread uses, name the new head SHA, and say what changed and what
did not.

Triage, in this order:

1. **Does it describe a defect in this layer's code?** Fix it here.
2. **Does it point at an earlier layer?** It is out of scope for this PR.
   Say so, and propose a separate PR; do not smuggle the fix upward.
3. **Does it ask for something this environment cannot run?** Say exactly
   why, and leave a tested seam behind. Example from this project: a hook's
   effect wiring cannot be tested because the desktop tests have no DOM,
   `renderToStaticMarkup` never runs effects, and `react-test-renderer` does
   not resolve for that package — so the decision was extracted into a pure
   function (`resumeOnBoot`) that the effect only calls, and the tests cover
   the pure function's branches.
4. **Is it a suggestion you are declining?** Explain the constraint (scope,
   harness, an earlier decision) instead of silently resolving.

Re-list the threads after every push: automated reviewers open new ones on the
new head, and a stack's lower PRs still need the same treatment.

## Gates

- `gh pr checks <n>` after every push and wait for it to settle. Read each
  job, not the aggregate: skipped and pending are not pass.
- The GitCode mirror reports back as the `CodeCheck (GitCode)` check on the
  GitHub PR. Map it to the merge request with
  `gitcode pr view <mr> -R openJiuwen/<repo> --json` and compare `.head.sha`
  with the GitHub head — the mirror can lag behind a push.
- A CodeCheck failure is fixed in the code, never argued with. Known shapes:
  a non-null assertion that `tsc` genuinely requires is still flagged, so
  rewrite it as an explicit null check; generic boilerplate (listener
  registration, mapping tables) can trip the similarity scan, so restructure
  it into the form the surrounding code uses.
- Expect roughly: CodeCheck 5–7 min, UT ~10 min, mocked E2E 8–11 min,
  `merge-gate` last. A full stack therefore takes a while; do not report green
  from a partial read.
- After every amend, update the body's numbers (`# pass` counts, layer
  results) and re-read the body for claims that drifted from the code — the
  reviewer reads the body, not the diff.

## Hygiene

- Bodies, scratch scripts and results live outside the repository. Never
  commit an unrelated untracked file that happens to sit in the working tree.
- Titles and bodies are English (see
  [create-github-pr](../create-github-pr/SKILL.md)); review replies follow the
  thread's language.
- Use the operator's git identity; do not add generated-with or
  `Co-Authored-By` trailers — this project's operator does not want them.
- Force-push only branches you own (the stack branches in the operator's
  fork). Never rewrite `main`.

## Worked example

The `apps/desktop` workbench went up in 2026-10 as six layers in this order:
foundation → run stream and permissions → workspace panel → settings →
interface language → launch resume. Each branch was `pr/0N-<slug>`, each PR
was cumulative on `main`, and each body carried the same stack section. When
#499–#503 merged one at a time, #500–#504 each went through the rebase
procedure above before its own review continued; the final PR needed a rebase
as well, because a lower merge had rewritten its parent. That is the shape to
reproduce, not a fixed list of branches.
