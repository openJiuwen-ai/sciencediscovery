#!/usr/bin/env bash
# ScienceDiscovery CodeArts build task, running inside
# swr.cn-north-4.myhuaweicloud.com/openjiuwen/sciencediscovery-ci-runner:latest
#
# Custom parameters this task reads:
#   GIT_REPO_URL     repository to check out
#   GIT_REF          ref to test, e.g. refs/merge-requests/<id>/head
#   GIT_TARGET_REF   ref it will merge into, e.g. refs/heads/main
#   SH_FILE_PATH     repository-relative script the dispatcher runs
#   ENVS             NAME=VALUE records, one per line
#   ARGS             script arguments, one per line
#   ARTIFACT_PATH    directory the OBS action uploads, default .ci-results/publish
#   STRICT_EXIT      1 to fail the task on a non-zero script status
# CodeArts runs this step's command with /bin/sh, and on this image that is
# dash, which rejects `set -o pipefail` on the line below. The shebang is only
# honoured when the file is executed directly, so hand over explicitly before
# anything else runs.
if [ -z "${BASH_VERSION:-}" ]; then
  exec /bin/bash "$0" "$@"
fi

set -Eeuo pipefail

# The OBS action resolves the artifact path under .codearts-build/repository --
# its log says so outright: `解析构建产物路径：.codearts-build/repository/...`.
# Working anywhere else leaves that action an empty directory to collect, which
# is what happened while this used the workspace root: every layer ran, every
# layer reported success, and the verification job found nothing published.
REPO_DIR="${WORKSPACE:-$PWD}/.codearts-build/repository"
mkdir -p -- "$REPO_DIR"
ARTIFACT_PATH="${ARTIFACT_PATH:-.ci-results/publish}"
STRICT_EXIT="${STRICT_EXIT:-0}"
BAKED_CACHE=/opt/sciencediscovery/qemu-cache

log() { printf '%s\n' "$*"; }
fail() { printf 'FATAL: %s\n' "$*" >&2; exit 2; }

log "=== ScienceDiscovery run-shell task ==="
log "image     : $(cat /etc/sciencediscovery-ci-runner 2>/dev/null || echo unlabelled)"
# Two images run this same shell. The full one carries the toolchain for the
# test layers; the light one carries git and python3 for a job that needs
# neither, and pulls in a second instead of forty. So report the toolchain
# rather than require it: a layer that needs node then fails inside the layer,
# where the reason is legible, instead of on this banner.
log "node/pnpm : $(node --version 2>/dev/null || echo none) / $(pnpm --version 2>/dev/null || echo none)"
log "repository: $REPO_DIR"
cd -- "$REPO_DIR"

# The build agent creates this directory outside the container, under a uid the
# container does not have, and git refuses a repository owned by someone else.
# That check protects a shared machine from a repository it stumbled into; this
# is a workspace handed to this container for one run.
git config --global --add safe.directory '*'

# --- checkout ---------------------------------------------------------------
# The task is handed a ref to test and the ref it will merge into. Replaying the
# change onto the target is what the pipeline is asked to verify; when the two
# are the same ref, as on a push-triggered branch, that replay is a no-op.
[[ -n "${GIT_REPO_URL:-}" ]] || fail "GIT_REPO_URL is required."
[[ -n "${GIT_REF:-}" ]] || fail "GIT_REF is required."
TARGET_REF="${GIT_TARGET_REF:-$GIT_REF}"
# The task may have downloaded the repository already. Point origin at the URL
# this run was given either way: the rebase helper falls back to `fetch
# --unshallow origin` when it needs history, so origin has to be the repository
# under test and not whatever a previous step configured.
[[ -e .git ]] || git init --quiet .
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "$GIT_REPO_URL"
git fetch --no-tags --force origin \
  "+$TARGET_REF:refs/remotes/origin/codearts-target" \
  "+$GIT_REF:refs/remotes/origin/codearts-source"
target_sha="$(git rev-parse refs/remotes/origin/codearts-target)"
source_sha="$(git rev-parse refs/remotes/origin/codearts-source)"
git checkout --force --detach "$target_sha"
if [[ "$source_sha" != "$target_sha" ]]; then
  [[ -f .ci/rebase-codearts-pr.sh ]] || fail "the target lacks .ci/rebase-codearts-pr.sh."
  bash .ci/rebase-codearts-pr.sh codearts-pr-source "$source_sha"
fi
log "checked out: $(git rev-parse HEAD) ($(git log -1 --format=%s))"
export EXPECTED_COMMIT="$(git rev-parse HEAD)"
export ARTIFACT_COMMIT="$EXPECTED_COMMIT"

# --- what the image already provides ----------------------------------------
# The guest image is the largest thing a run used to download. It is baked in;
# seeding the cache with a link makes the repository's fetcher find it, verify
# its checksum as usual, and skip the download. A pin the image predates simply
# misses the checksum and downloads as before.
if [[ -d "$BAKED_CACHE" ]]; then
  mkdir -p .ci-results/qemu-cache
  for baked in "$BAKED_CACHE"/*; do
    [[ -e "$baked" ]] || continue
    ln -sfn "$baked" ".ci-results/qemu-cache/$(basename "$baked")"
  done
  log "seeded the QEMU cache from the image"
fi

# --- run --------------------------------------------------------------------
[[ -n "${SH_FILE_PATH:-}" ]] || fail "SH_FILE_PATH is required."
[[ -f .ci/codearts-build-dispatch.sh ]] || fail "the checkout lacks .ci/codearts-build-dispatch.sh."
set +e
WORKSPACE="$REPO_DIR" bash .ci/codearts-build-dispatch.sh
rc=$?
set -e

# --- report -----------------------------------------------------------------
# Every layer records its status where the verification job and the merge
# request table read it, because a task that fails here would skip its own OBS
# upload and leave nothing to read. One task runs with STRICT_EXIT=1 and is the
# only thing that can turn the run red.
mkdir -p -- "$ARTIFACT_PATH"
printf '%s\n' "$rc" > "$ARTIFACT_PATH/exit-code"
log "artifacts in $(cd -- "$ARTIFACT_PATH" && pwd): $(ls -A "$ARTIFACT_PATH" | tr '\n' ' ')"
log "script exited with status $rc"
if [[ "$STRICT_EXIT" == 1 ]]; then
  exit "$rc"
fi
log "status recorded for the verification job; this task reports success so its artifacts upload."
exit 0
