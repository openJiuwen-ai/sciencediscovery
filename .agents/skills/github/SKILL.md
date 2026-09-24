---
name: github
description: >
  Use the gh CLI for GitHub issues and pull requests on
  openJiuwen-ai/sciencediscovery. Issue and pull request titles and bodies are
  English. Use when filing or editing an issue, opening or updating a pull
  request, or when an agent or a person asks how to talk to this repository
  on GitHub. For the test gates, fork push, and release label, continue in
  the create-github-pr skill. gitcode.com is a read-only mirror.
---

# GitHub (`gh`)

Project-local skill for **ScienceDiscovery**.

New issues and pull requests go to
[openJiuwen-ai/sciencediscovery](https://github.com/openJiuwen-ai/sciencediscovery)
with **`gh`**. Do not open them in the browser, and do not use the `gitcode`
CLI for a new issue or pull request. GitCode
(`openJiuwen/sciencediscovery`) is a read-only mirror. The
[gitcode](../gitcode/SKILL.md) skill is only for an existing mirror item that
still has to be read or commented on.

The full pull-request procedure — local UT/ST/E2E, pushing the branch to your
own fork, the release label, reading Actions back — is
[create-github-pr](../create-github-pr/SKILL.md). This page is the usage
guide those steps assume.

## Language

**Issue and pull request titles and bodies are English.**

That includes the explanation under any template heading, the validation
numbers, and the E2E conclusion. Write Chinese only when the person who asked
explicitly wants Chinese. If a GitHub issue or pull request was filed in
Chinese by mistake, fix it with `gh issue edit` or `gh pr edit` before calling
it done.

Edit only items you created. On someone else's issue or pull request, add a
comment. Do not rewrite their title or body.

## Setup

```bash
gh auth status          # retry once if it fails, then ask the operator
gh api user --jq .login # current login; do not hard-code a person; never print a token
```

Always pass `--repo openJiuwen-ai/sciencediscovery` so a checkout whose
`origin` is something else still hits this repository.

`origin` on a current clone of this repo is
`openJiuwen-ai/sciencediscovery`. Do not `git push origin` a task branch.
Push the branch to the operator's own fork, then open the pull request with
`--head <login>:<branch>`.

## Issues

Search before creating. A duplicate title is not a new issue.

```bash
gh issue list --repo openJiuwen-ai/sciencediscovery --state open --limit 50 \
  --search "keywords"
gh issue create --repo openJiuwen-ai/sciencediscovery \
  --title "[Feature]: Short English summary" \
  --body-file .tmp/issue.md
gh issue view <n> --repo openJiuwen-ai/sciencediscovery
gh issue edit <n> --repo openJiuwen-ai/sciencediscovery --body-file .tmp/issue.md
gh issue comment <n> --repo openJiuwen-ai/sciencediscovery --body-file .tmp/comment.md
```

Read the issue back after create or edit and confirm the number, the English
title, and that the body is the text you wrote.

To put a screenshot in the body, reference a local image in the Markdown and
pass the same path to `--attach`. `gh` rewrites the reference to a
`user-attachments` URL. `--attach` needs write access on this repository. A
person can also drop the file into the issue on the website; that upload does
not require a git push, but agents should use `--attach` rather than asking
someone to paste by hand.

```bash
gh issue edit <n> --repo openJiuwen-ai/sciencediscovery \
  --body-file .tmp/issue.md \
  --attach '.tmp/screen.png#What the screen shows'
```

## Pull requests

Follow [create-github-pr](../create-github-pr/SKILL.md). The commands that
file the request:

```bash
login=$(gh api user --jq .login)
git push -u <fork-remote> HEAD:<branch>
gh pr create --repo openJiuwen-ai/sciencediscovery \
  --base main --head "$login:<branch>" \
  --title "type(scope): what changes, in English" \
  --body-file .tmp/pr.md
gh pr view <n> --repo openJiuwen-ai/sciencediscovery \
  --json number,title,state,baseRefName,headRefName,url
```

The title is an English sentence a reader can understand without the diff.
`update`, `fix bug`, and a raw file name are not titles. The body states what
changed, why, what was run (with numbers), and the E2E conclusion. A change
with no user-observable path may say the E2E is not applicable and why.
Backend-only is not that reason.

## What not to do

- Do not file a new issue or pull request on gitcode.com.
- Do not write the GitHub title or body in Chinese unless asked.
- Do not put tokens, local absolute paths, or private notes in the body.
- Do not `git push origin` a task branch.
