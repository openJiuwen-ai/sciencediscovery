---
name: gitcode
description: >
  Operate GitCode issues, PRs, wikis, code/MR refs, and MindSpore cached
  templates. Use for GitCode, gitcode.com, atomgit.com, MindSpore issues/PRs,
  wiki, or /gitcode.
---

# GitCode (Issue / PR)

Project-local skill for **science_agent** on gitcode.com (not under `skills/`).

Use the command table below, `gitcode schema`, or `gitcode <cmd> --help` to
resolve flags. Only if a flag is still unclear, run
`gitcode api repos/gitcode-cli/cli/contents/docs`, select the `download_url` for
`COMMANDS.md`, `AUTH.md`, or `AI-GUIDE.md`, and read that
`raw.gitcode.com` content. Do not scrape GitCode blob-page HTML.

## Rules

1. Run **`gitcode`**, never bare `gc` (often a `git commit` alias).
2. Install/helpers via **`uv`**; never commit CLI binaries or tokens.
3. Never print tokens (`auth token` / `auth status --show-token`).
4. Prefer **`--json`**; if create/edit JSON is thin (missing `html_url` or with the wrong `number`), confirm with `view`/`list`.
5. Destructive ops (`close`/`reopen`/`merge`/`delete`…) need user intent + **`--yes`**.
6. Scope: only repos the user named (or cwd remote when clearly that clone).
7. **Transports**: metadata/API → `gitcode` CLI; code/MR head → **SSH** git. HTTPS git easily fails (hangs without a credential helper; web/HTTPS fetches commonly return **403**), so always use SSH and do not scrape gitcode.com HTML.
8. Follow [Cross-references and issue association](#cross-references-and-issue-association) for visible links and unverified auto-close behavior.

## Hosts

`gitcode.com` and `atomgit.com` are hostnames for the same website/platform: repositories and their issue/PR numbers are identical. Do not treat AtomGit as a separate product. For authored or reported repo, issue, and PR URLs, prefer `https://gitcode.com/...`; rewrite AtomGit hosts and CLI `html_url` paths such as `/merge_requests/N` to these canonical forms:

- Issue: `https://gitcode.com/mindspore/ScienceAgent/issues/9`
- PR list: `https://gitcode.com/mindspore/ScienceAgent/pulls`
- PR detail: `https://gitcode.com/owner/repo/pull/N`
- SSH: `git@gitcode.com:owner/repo.git` and `git@atomgit.com:owner/repo.git` are equivalent; prefer writing/configuring the `gitcode.com` form, even when an existing remote uses AtomGit.

## Install / auth (once)

```bash
uv tool install gitcode-cli
export PATH="$HOME/.local/bin:$PATH"
gitcode version
gitcode auth status --json   # need logged_in + token_valid
```

Token priority: `GC_TOKEN` > `GITCODE_TOKEN` > `~/.config/gc/auth.json`.
No browser on box → user creates classic token at https://gitcode.com/setting/token-classic and runs `gitcode auth login` on a private TTY (do not ask them to paste token into chat).
Fallback install: `uv venv .local/gitcode-venv && uv pip install --python .local/gitcode-venv gitcode-cli`.
Binary resolve: `command -v gitcode` → `$HOME/.local/bin/gitcode` → `.local/gitcode-venv/bin/gitcode`.
PyPI stale: `uv tool install --from 'https://gitcode.com/gitcode-cli/cli/releases/download/<ver>/gitcode_cli-<ver>-py3-none-any.whl' gitcode-cli`.

## Targeting

Always pass **`-R owner/repo`** when not on cwd `origin`. Forms: `owner/repo`, HTTPS URL, SSH URL (CLI API only — not git transport).

| Need | Use |
|------|-----|
| Title/body/state/comments/create/edit/review | `gitcode …` |
| Patch summary | `gitcode pr diff N` (text preferred; binaries have no preview) |
| Full tree / deep review | SSH remote `git@gitcode.com:owner/repo.git`; fetch `refs/merge-requests/N/head` |
| Scratch clone | `.tmp/<repo-name>/` |
| Long bodies | `.tmp/*.md` + `--body-file` |

## Issue / PR commands

```bash
# issues
gitcode issue create -R owner/repo --title "…" --body-file body.md --json
gitcode issue list -R owner/repo --state open --json
gitcode issue view N -R owner/repo --json
gitcode issue view N -R owner/repo --comments --json
gitcode issue edit N -R owner/repo --body-file body.md --json
gitcode issue comment N -R owner/repo --body "…" --json
gitcode issue comments N -R owner/repo --json
gitcode issue comment edit <comment_id> -R owner/repo --body "…"   # may not support --json
gitcode issue close N -R owner/repo --yes --json
gitcode issue reopen N -R owner/repo --yes --json

# PRs
gitcode pr create -R owner/repo --head branch --base main --title "…" --body-file pr.md --json
gitcode pr create -R upstream/repo --head myfork:branch --title "…" --body-file pr.md --json
gitcode pr create -R owner/repo --head branch --fill --json
gitcode pr create -R owner/repo --head branch --title "WIP" --draft --json
gitcode pr list -R owner/repo --state open --json
gitcode pr view N -R owner/repo --json
gitcode pr view N -R owner/repo --comments --json
gitcode pr diff N -R owner/repo
gitcode pr edit N -R owner/repo --body-file pr.md --json
gitcode pr comment N -R owner/repo --body "…" --json
gitcode pr comment N -R owner/repo --body "…" --path path/to/file.py --position 12 --json
gitcode pr comments N -R owner/repo --json
gitcode pr reply N -R owner/repo --discussion <id> --body "…"
gitcode pr review N -R owner/repo --comment "…" --json   # or --comment-file
gitcode pr merge N -R owner/repo --yes --json            # optional --method squash|rebase
gitcode pr close|reopen|ready N -R owner/repo --yes --json
gitcode pr checkout N -R owner/repo
gitcode repo fork owner/repo --json
gitcode repo view owner/repo --json
gitcode schema
gitcode schema "issue create"
```

- Line comments: `--position` = line on the **new** file (right side of diff). Inline comments appear as `comment_type: diff_comment`.
- **`--approve`**: only with explicit user intent + approval permission; own-PR / missing role → **403** — leave a comment review instead.
- **`--request` (request changes)** unsupported; put change requests in `--comment`.
- Merge only with explicit user OK for that PR.
- **`pr create` 409 / "same source branch already has an open MR `!N`"**: `!N` may be the PR this very call just created (observed on this repo), an earlier PR opened from the same branch, or one you should not touch. Never retry blindly and never rename the branch to dodge it. Read it back — `gitcode pr view N -R owner/repo --json` — compare base, head branch, head SHA, title, body, author, created time, and existing review activity against this attempt, then act on what `!N` actually is. Typical outcomes: this attempt landed ⇒ report `!N`; your own re-delivery on the same branch, where the MR already tracks the pushed head but title/body are stale ⇒ bring it up to date with `gitcode pr edit N --body-file …` instead of creating a second PR; head SHA still behind your push ⇒ confirm the push reached the fork before touching the PR; wrong base, another author, or review already under way ⇒ stop and report so the user can choose (edit, close, or a fresh branch). Judge from the read-back, not from the error text.

### Read a PR (review prep)

1. `gitcode pr view N -R owner/repo --json` — title, body, SHAs, state
2. `gitcode pr diff N -R owner/repo` — patch overview; prefer text output, and expect no binary preview
3. `gitcode api repos/owner/repo/pulls/N/files` — structured file list / raw URLs
4. Full tree: SSH `git fetch git@gitcode.com:owner/repo.git refs/merge-requests/N/head` (GitCode MR ref; not HTTPS). Prefer this over scraping the web UI.

### Cross-references and issue association

- Ordinary issue/comment reference: `[#32](https://gitcode.com/mindspore/ScienceAgent/issues/32)`.
- Ordinary PR reference: `[#10](https://gitcode.com/mindspore/ScienceAgent/pull/10)`. Write `/pull/N` in authored links even if CLI `html_url` says `/merge_requests/N`.
- To associate an issue in a PR body, retain the trigger candidate and add a readable link: `Fixes #32 ([#32](https://gitcode.com/mindspore/ScienceAgent/issues/32))`.
- Automatic closing after merge is **not verified**. Never promise that `Fixes #N` or its Markdown link will close the issue; commit messages alone do not auto-close.

## MindSpore org templates

Upstream (do not vendor into git): `mindspore/.gitcode` @ `master`, tree `.gitcode/`.
Local cache (gitignored): `{baseDir}/cache/mindspore-org-templates/`.

```bash
FETCH="{baseDir}/scripts/fetch_mindspore_templates.py"
uv run --no-project "$FETCH"          # ensure cache exists
uv run --no-project "$FETCH" --force  # refresh after upstream changes
```

**Do not rely on any template inventory in this skill** — lists go stale. At filing time:

1. Ensure cache is present (run fetch if needed).
2. List and **read** the actual files under `…/cache/mindspore-org-templates/.gitcode/` (`ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE*`).
3. Pick the matching template for the intent; fill required fields from that file; create with `--body-file`.
4. If the issue template is an issue form (YAML), convert it to Markdown in `body` order: write each `attributes.label` as a `###` heading and put the answer below it; every item with `validations.required: true` is mandatory.

## Images in bodies/comments

```bash
UPLOAD="{baseDir}/scripts/upload_image.py"
uv run --no-project "$UPLOAD" -R owner/repo .tmp/image.png --json
```

1. List the source directory first to confirm the actual filename; do not retype a path from memory. Then copy archived/non-ASCII paths to a simple ASCII name under `.tmp/` before upload.

2. Prefer `--json`; continue only when the command exits 0 and returns non-empty `markdown` and `url` fields. The URL must use `https://raw.gitcode.com/user-images/assets/…`, never bare `/uploads/…`.

3. On non-zero exit or output containing `error:`, stop. Never paste stderr/error text into an issue/PR body or replace a failed image placeholder with an empty string.

4. Build comments and long bodies in `.tmp/*.md` without shell expansion (use an editor/patch or a single-quoted heredoc), then pass the file with `--body-file`; do not use `$(cat <<EOF)` around Markdown.

```bash
gitcode pr comment N -R owner/repo --body-file .tmp/comment.md --json
```

5. After posting, read back with `gitcode issue view N -R owner/repo --comments --json` or `gitcode pr comments N -R owner/repo --json`. Confirm the comment contains the expected `raw.gitcode.com` embed and contains no `error: file not found`.

### Fetching images (raw.gitcode.com)

`raw.gitcode.com` user-images URLs require auth — anonymous GET returns **403 no access right** (verified platform behavior, not a broken link). Use the skill's download script, which reuses the same token resolution as `upload_image.py` and sends `Authorization: Bearer <token>`:

```bash
DOWNLOAD="{baseDir}/scripts/download_image.py"
# Bare URL or Markdown embed ![alt](url 'title'); saves to .tmp/<filename> by default
uv run --no-project "$DOWNLOAD" "https://raw.gitcode.com/user-images/assets/<repo_id>/<uuid>/<file>" -o .tmp/issue44_img1.png --json
uv run --no-project "$DOWNLOAD" "![alt](https://raw.gitcode.com/user-images/assets/.../x.png 'x')" -o .tmp/x.png
```

1. The script accepts a bare `https://raw.gitcode.com/...` URL **or** a full Markdown embed `![alt](url 'title')` (e.g. copied straight from an issue body) and extracts the URL.
2. Prefer `--json`; continue only when the command exits 0 and returns `"success": true` with `status: 200` and a `content_type` starting with `image/`. The saved file path is in `path`.
3. Default output is `.tmp/<url-filename>` if `.tmp/` exists, else `./<url-filename>`; pass `-o` to override. Non-ASCII filenames (e.g. `企业微信截图_*.png`) are kept as-is — copy to an ASCII name before review if needed.
4. On non-zero exit or stderr containing `error:`, stop. Exit 4 means auth/403 (token missing, invalid, or expired — run `gitcode auth status --json`); exit 1 is a transport/server error. Never treat a 403 as a broken image link.
5. To inspect images referenced in an issue/PR body, `gitcode issue view N --json` / `gitcode pr view N --json` and extract `raw.gitcode.com` URLs from the `body` field before downloading.

## Wiki

No `gitcode wiki` subcommand. Wiki is `owner/repo.wiki` (SSH `git@gitcode.com:owner/repo.wiki.git`), default branch **`main`**, entry `Home.md`. Prefer SSH.

## Checklist

1. `gitcode version` + `auth status --json`
2. Lock `-R`
3. Read before write (`view`/`list`/`diff`; code via SSH MR ref) — no HTML scrape
4. Follow the cross-reference rules above; do not promise unverified auto-close behavior
5. Confirm number/URL after create/edit; report `/pull/N` or `/issues/N`
6. Failures: stderr + exit class (0 ok, 1 generic, 2 usage, 3 not found, 4 auth, 5 conflict) — conflict (e.g. `pr create` 409) means read back the cited `!N` and decide from its actual state, not from the message; never invent success

**Policy**: skill sources under `.agents/skills/gitcode/` are tracked; **`cache/` is not**. No binaries, no vendored templates, no secrets in skill files.
