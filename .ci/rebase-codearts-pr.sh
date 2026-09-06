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

# Recreate the merge-request change on top of the target commit downloaded by
# CodeArts. This checkout is disposable: the rebased commit is never pushed.

set -euo pipefail

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

source_branch="${1:-}"
source_sha="${2:-}"

[[ -n "$source_branch" ]] || fail "the source branch is required"
git check-ref-format --branch "$source_branch" >/dev/null \
  || fail "the source branch is not a valid Git branch"
[[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ ]] \
  || fail "the source commit must be a 40-hex SHA"
source_sha="${source_sha,,}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "the current directory is not a Git worktree"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] \
  || fail "the downloaded target checkout contains tracked changes"

target_sha="$(git rev-parse HEAD)"
git cat-file -e "$source_sha^{commit}" 2>/dev/null \
  || fail "source commit $source_sha is not available locally"

merge_base="$(git merge-base "$target_sha" "$source_sha" 2>/dev/null || true)"
if [[ -z "$merge_base" && "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  echo "The checkout is shallow; fetching complete history for the integration rebase."
  git fetch --no-tags --unshallow origin
  merge_base="$(git merge-base "$target_sha" "$source_sha" 2>/dev/null || true)"
fi
[[ -n "$merge_base" ]] \
  || fail "target $target_sha and source $source_sha have no merge base"

echo "Preparing CodeArts integration checkout:"
echo "  target_sha=$target_sha"
echo "  source_branch=$source_branch"
echo "  source_sha=$source_sha"
echo "  merge_base=$merge_base"

if ! git \
  -c user.name='CodeArts CI' \
  -c user.email='codearts-ci@localhost' \
  -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null \
  rebase --onto "$target_sha" "$merge_base" "$source_sha"; then
  git rebase --abort >/dev/null 2>&1 || true
  fail "the PR cannot be rebased onto target $target_sha"
fi

integration_sha="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$target_sha" "$integration_sha" \
  || fail "rebased commit $integration_sha does not contain target $target_sha"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] \
  || fail "the integration checkout contains tracked changes after rebase"

metadata_dir="${CI_CHECKOUT_METADATA_DIR:-.ci-results/codearts-checkout}"
mkdir -p -- "$metadata_dir"
printf '%s\n' "$target_sha" >"$metadata_dir/target-sha"
printf '%s\n' "$source_sha" >"$metadata_dir/source-sha"
printf '%s\n' "$integration_sha" >"$metadata_dir/integration-sha"

echo "Prepared rebased PR checkout: source=$source_sha target=$target_sha integration=$integration_sha"
git show -s --format='integration subject: %s'
