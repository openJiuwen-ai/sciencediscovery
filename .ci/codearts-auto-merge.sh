#!/usr/bin/env bash
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Merges the merge request a CODEOWNER asked for with a `/merge` comment.
#
# The auto-merge pipeline used to carry this as three shell steps of its own.
# Pipeline executor minutes ran out, so the pipeline now only routes the
# trigger: one build task runs this script, exactly the way the test layers
# already run .ci/codearts-layer.sh. What the build task hands over is small
# enough to survive a build parameter:
#
#   CODEARTS_MERGE_ID     the merge request number, from ${MERGE_ID}
#   CODEARTS_COMMIT_ID    its head commit when the comment arrived, ${COMMIT_ID}
#   GITCODE_TOKEN         the pipeline's private parameter
#
# Everything else -- who commented, the merge request's state, the branch it
# targets -- is read back from GitCode here, because the webhook payload is
# several kilobytes of JSON and a build parameter is the wrong place for it.
#
# Authorization is CODEOWNERS on the authority branch, never the CODEOWNERS in
# the merge request: a merge request cannot grant itself the right to merge.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

REPO_OWNER="${REPO_OWNER:-openJiuwen}"
REPO_NAME="${REPO_NAME:-sciencediscovery}"
GITCODE_API_BASE="${GITCODE_API_BASE:-https://api.gitcode.com/api/v5}"
# CODEOWNERS is read from this branch, whatever the merge request targets.
AUTH_BRANCH="${AUTH_BRANCH:-main}"
export REPO_OWNER REPO_NAME GITCODE_API_BASE

WORK_DIR="$PWD/.ci-results/auto-merge"
mkdir -p -- "$WORK_DIR"

api() { python3 "$script_dir/gitcode-merge-request.py" "$@"; }

[[ -n "${GITCODE_TOKEN:-}" ]] || {
  echo "FATAL: GITCODE_TOKEN is empty; set it as a private pipeline parameter." >&2
  exit 1
}
MR_NUMBER="${CODEARTS_MERGE_ID:-}"
[[ "$MR_NUMBER" =~ ^[1-9][0-9]*$ ]] || {
  echo "FATAL: CODEARTS_MERGE_ID is '${MR_NUMBER}'; this pipeline only runs from a /merge comment on a merge request." >&2
  exit 1
}

# Report a refusal on the merge request, then stop the job. The build task runs
# with STRICT_EXIT=1, so a non-zero status here is what turns the run red.
say() {
  printf '%s\n' "$1" > "$WORK_DIR/comment.md"
  api comment "$MR_NUMBER" "$WORK_DIR/comment.md" \
    || echo "WARN: could not post the comment on !$MR_NUMBER" >&2
}
fail() {
  say "$1"
  printf 'FATAL: %s\n' "$1" >&2
  exit 1
}

# --- who asked ---------------------------------------------------------------
if ! MERGE_COMMAND="$(api merge-command "$MR_NUMBER" 2>&1)"; then
  echo "FATAL: could not read the comments of !$MR_NUMBER ($MERGE_COMMAND)" >&2
  exit 1
fi
COMMENTER="$(printf '%s\n' "$MERGE_COMMAND" | sed -n 1p)"
COMMENT_ID="$(printf '%s\n' "$MERGE_COMMAND" | sed -n 2p)"
echo "merge request !$MR_NUMBER: /merge comment $COMMENT_ID by @$COMMENTER"

# --- what is being merged ----------------------------------------------------
if ! PR_FIELDS="$(api pr-fields "$MR_NUMBER" 2>&1)"; then
  fail "❌ 自动合并失败：读取 PR !$MR_NUMBER 失败（$PR_FIELDS）。"
fi
pr_field() { printf '%s\n' "$PR_FIELDS" | sed -n "${1}p"; }
PR_STATE="$(pr_field 1)"
PR_BASE="$(pr_field 2)"
PR_HEAD="$(pr_field 3)"
PR_MERGEABLE="$(pr_field 4)"
PR_DRAFT="$(pr_field 5)"
PR_MERGED="$(pr_field 6)"
PR_APPROVALS="$(pr_field 7)"
PR_ASSIGNEES="$(pr_field 8)"
TARGET_BRANCH="$PR_BASE"
echo "merge request !$MR_NUMBER -> $TARGET_BRANCH (state $PR_STATE, head ${PR_HEAD:0:7})"

# The acknowledgement is best effort and deliberately early: the merge request
# hears that the request arrived before the checks below decide anything.
say "🔄 收到 @$COMMENTER 的 \`/merge\`，正在校验并把 PR !$MR_NUMBER 以 rebase 方式合入 \`$TARGET_BRANCH\`…"

if [[ -z "$TARGET_BRANCH" ]] || ! git check-ref-format --branch "$TARGET_BRANCH" >/dev/null 2>&1; then
  fail "❌ 自动合并被拒绝：目标分支 \`$TARGET_BRANCH\` 不是合法的分支名。"
fi

# --- authorization -----------------------------------------------------------
git fetch --no-tags --force origin "+refs/heads/$AUTH_BRANCH:refs/remotes/origin/$AUTH_BRANCH"
OWNERS="$(git show "origin/$AUTH_BRANCH:CODEOWNERS" \
  | sed -e 's/#.*//' | tr -s '[:space:]' '\n' | sed -n 's/^@//p' | tr '[:upper:]' '[:lower:]' | sort -u)"
COMMENTER_LOWER="$(printf '%s' "$COMMENTER" | tr '[:upper:]' '[:lower:]')"
echo "authorizing @$COMMENTER against CODEOWNERS of $AUTH_BRANCH@$(git rev-parse --short "origin/$AUTH_BRANCH"): $(printf '%s\n' "$OWNERS" | tr '\n' ' ')"
if ! printf '%s\n' "$OWNERS" | grep -qx -- "$COMMENTER_LOWER"; then
  fail "❌ 自动合并被拒绝：@$COMMENTER 不在 \`$AUTH_BRANCH\` 分支的 CODEOWNERS 中（以 \`$AUTH_BRANCH\` 上的文件为准，PR 里对 CODEOWNERS 的修改不生效），只有 CODEOWNERS 里的成员可以发送 \`/merge\`。"
fi

# --- the merge request's live state decides ----------------------------------
if [[ "$PR_MERGED" == true ]]; then
  fail "ℹ️ 自动合并未执行：PR !$MR_NUMBER 已经合并。"
fi
if [[ "$PR_STATE" != open && "$PR_STATE" != opened ]]; then
  fail "❌ 自动合并被拒绝：本 PR 当前状态是 \`$PR_STATE\`，不是 open。"
fi
if [[ "$PR_DRAFT" == true ]]; then
  fail "❌ 自动合并被拒绝：本 PR 仍是草稿，请先标记为 ready。"
fi
SOURCE_SHA="$(printf '%s' "${CODEARTS_COMMIT_ID:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$PR_HEAD" != "$SOURCE_SHA" ]]; then
  fail "❌ 自动合并被拒绝：PR !$MR_NUMBER 在这条 \`/merge\` 评论之后有新提交（评论时 \`${SOURCE_SHA:0:7}\`，现在 \`${PR_HEAD:0:7}\`）。确认新提交后请重新发送 \`/merge\`。"
fi
if [[ "$PR_MERGEABLE" == false ]]; then
  fail "❌ 自动合并失败：PR !$MR_NUMBER 与 \`$TARGET_BRANCH\` 有冲突，没有合并。请在源分支上 rebase 到最新 \`$TARGET_BRANCH\` 并解决冲突后，再发送 \`/merge\`。"
fi
# The CODEOWNERS /merge comment is the authorization; the merge is forced past
# GitCode's approval rule and the report says so.
FORCE_NOTE=""
if [[ "$PR_APPROVALS" == false ]]; then
  FORCE_NOTE="GitCode 的审批规则尚未满足（审批人：${PR_ASSIGNEES:-见 PR 页面}），已按 CODEOWNERS 授权强制合入。"
fi

# --- merge -------------------------------------------------------------------
git fetch --no-tags --force origin "+refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"
TARGET_BEFORE="$(git rev-parse "origin/$TARGET_BRANCH")"
if ! MERGE_RESPONSE="$(api merge "$MR_NUMBER" 2>&1)"; then
  fail "❌ 自动合并失败：GitCode 拒绝以 rebase 强制合并 PR !$MR_NUMBER（$MERGE_RESPONSE）。若提示权限不足，需要仓库开启「允许管理员强制合入」且令牌账号为管理员；冲突时请在源分支上 rebase 到最新 \`$TARGET_BRANCH\`；然后再发送 \`/merge\`。"
fi
printf '%s\n' "$MERGE_RESPONSE" > "$WORK_DIR/merge-response.json"

git fetch --no-tags --force origin "+refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"
TARGET_AFTER="$(git rev-parse "origin/$TARGET_BRANCH")"
PUSHED_COUNT="$(git rev-list --count "$TARGET_BEFORE..$TARGET_AFTER")"
# The merge already happened; a report that fails to post must not fail the job.
say "✅ 自动合并完成（由 @$COMMENTER 的 \`/merge\` 评论触发）。

PR !$MR_NUMBER 已以 rebase 方式合并到 \`$TARGET_BRANCH\`：\`${TARGET_BEFORE:0:7}..${TARGET_AFTER:0:7}\`（$PUSHED_COUNT 个提交）${FORCE_NOTE:+

$FORCE_NOTE}"
echo "merged !$MR_NUMBER into $TARGET_BRANCH: $TARGET_BEFORE..$TARGET_AFTER ($PUSHED_COUNT commits)"
