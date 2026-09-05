#!/usr/bin/env bash
#
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

# Runs one CI layer inside a CodeArts Build task.
#
# CodeArts bills pipelines and build tasks against separate quotas, and a job
# that runs shell on a pipeline executor spends the pipeline's. Every layer
# therefore reaches CodeArts through the generic `run-shell` build task, which
# checks out and rebases the merge request and then calls
# `.ci/codearts-build-dispatch.sh` with this script's path and the layer name.
# Adding a CI layer means adding a case here, not editing a build task in the
# console.
#
# Everything the layer wants published is staged into one directory so the
# build task's OBS action uploads exactly that and nothing else — the QEMU
# layers leave a multi-hundred-megabyte payload and a disk image beside their
# log.
#
# Inputs supplied through the build task's ENVS records:
#   CI_NPM_REGISTRY               npm-compatible registry for provisioning
#   CI_PYPI_INDEX                 PyPI index for provisioning
#   CI_BINARY_CACHE_URL           verified toolchain cache base URL
#   UV_DEFAULT_INDEX              PyPI index for uv at run time
#   UV_PYTHON_INSTALL_MIRROR      CPython download mirror for uv
#   MICROMAMBA_CONDA_MIRROR       conda mirror for the packaging layers
#   CI_PUBLISH_DIR                staging directory, default .ci-results/publish

set -uo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
layer="${1:-}"
case "$layer" in
  ut-host|ut-guest|e2e|st|binary-x86_64) ;;
  "")
    echo "Usage: .ci/codearts-layer.sh ut-host|ut-guest|e2e|st|binary-x86_64" >&2
    exit 2
    ;;
  *)
    echo "FATAL: '$layer' is not a CI layer this entry point runs." >&2
    exit 2
    ;;
esac

cd "$repo_root"
results_dir="$repo_root/.ci-results"
publish_dir="${CI_PUBLISH_DIR:-$results_dir/publish}"
case "$publish_dir" in
  /*) ;;
  *) publish_dir="$repo_root/$publish_dir" ;;
esac
rm -rf -- "$publish_dir"
mkdir -p -- "$publish_dir"
run_log="$publish_dir/run.log"
: > "$run_log"
exec > >(tee -a "$run_log") 2>&1

echo "=== CodeArts build layer ==="
echo "layer   : $layer"
echo "commit  : $(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "publish : ${publish_dir#"$repo_root"/}"

export PATH="$HOME/.local/node/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"

provision_runner() {
  if [ ! -f "$repo_root/pnpm-workspace.yaml" ]; then
    echo "FATAL: the build task did not check out the repository." >&2
    return 1
  fi
  CI_BINARY_CACHE_ONLY=1 \
  CI_BINARY_CACHE_DIR="$results_dir/toolchain-cache" \
    bash .ci/provision-runner.sh
}

# uv.lock records index URLs, so a mirrored resolution rewrites the file. Redo
# the resolution deliberately and refuse it if any locked version moved.
retarget_python_lockfiles() {
  local project lock locked retargeted
  echo "python install mirror: ${UV_PYTHON_INSTALL_MIRROR:-unset}"
  for project in services/gateway services/paper services/memory-graph; do
    lock="$project/uv.lock"
    echo "retargeting $lock to ${UV_DEFAULT_INDEX:-the default index}"
    locked="$(sed -n -e '/^name = /p' -e '/^version = /p' "$lock")"
    uv lock --project "$project" || return 1
    retargeted="$(sed -n -e '/^name = /p' -e '/^version = /p' "$lock")"
    if [ "$locked" != "$retargeted" ]; then
      echo "FATAL: retargeting $lock changed locked package versions" >&2
      return 1
    fi
  done
}

# Copy a layer's own results next to the log the build task publishes. The
# layer entry points write into CI_RESULTS_DIR/<name>/; only the small files
# belong in OBS.
publish_from() {
  local source_dir="$1"
  shift
  local name
  for name in "$@"; do
    if [ -e "$source_dir/$name" ]; then cp -a -- "$source_dir/$name" "$publish_dir/"; fi
  done
}

run_ut_host() {
  provision_runner || return $?
  retarget_python_lockfiles || return $?
  export CI_RESULTS_DIR="$results_dir"
  export CI_RUNTIME_DIR="$HOME/ci-runtime-ut-host"
  echo "dependency mirrors: npm=$(npm config get registry), pypi=${UV_DEFAULT_INDEX:-unset}"
  pnpm ci:ut:host
}

run_st() {
  provision_runner || return $?
  export CI_RESULTS_DIR="$results_dir"
  export CI_RUNTIME_DIR="$HOME/ci-runtime-st"
  echo "dependency mirrors: npm=$(npm config get registry), pypi=${UV_DEFAULT_INDEX:-unset}"
  pnpm ci:st
}

run_ut_guest() {
  provision_runner || return $?
  export CI_RESULTS_DIR="$results_dir"
  export CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME="${CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME:-300}"
  # Stop the guest inside the build task's own budget: a guest killed from
  # outside records no exit code and uploads no log.
  export QEMU_TIMEOUT_SECONDS="${QEMU_TIMEOUT_SECONDS:-1500}"
  # The guest runs the tests and nothing else; compiling under emulation cost
  # this layer about eight minutes per run.
  pnpm install --frozen-lockfile || return $?
  pnpm build || return $?
  bash .ci/run-qemu-layer.sh ut-guest
}

run_e2e() {
  provision_runner || return $?
  export CI_RESULTS_DIR="$results_dir"
  export CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME="${CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME:-300}"
  export QEMU_TIMEOUT_SECONDS="${QEMU_TIMEOUT_SECONDS:-6300}"
  pnpm install --frozen-lockfile || return $?
  pnpm build || return $?
  # The same ci:e2e entry point, stopped after installation: this host owns
  # every download and compile, the guest owns the stack and the journeys.
  CI_RESULTS_DIR="$results_dir/prepare" \
  CI_RUNTIME_DIR="$HOME/ci-runtime-e2e" \
  CI_E2E_PREPARE_ONLY=1 \
  CI_E2E_BROWSERS_DIR=.e2e/browsers \
    pnpm ci:e2e || return $?
  bash .ci/run-qemu-layer.sh e2e
}

run_binary_x86_64() {
  provision_runner || return $?
  local zstd_root="$HOME/.local/share/codearts-zstd"
  export PATH="$zstd_root/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$zstd_root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  if ! command -v zstd >/dev/null 2>&1; then
    echo "zstd is not preinstalled; downloading signed Ubuntu packages for user-space extraction."
    local download_dir="$results_dir/binary-zstd-packages"
    rm -rf -- "$zstd_root" "$download_dir"
    mkdir -p -- "$zstd_root" "$download_dir"
    if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-deb >/dev/null 2>&1; then
      echo "FATAL: zstd is missing and apt-get/dpkg-deb are unavailable for a user-space install." >&2
      return 1
    fi
    (cd "$download_dir" && apt-get download zstd libzstd1) || return $?
    local package found=0
    for package in "$download_dir"/*.deb; do
      [ -e "$package" ] || continue
      found=1
      dpkg-deb --extract "$package" "$zstd_root" || return $?
    done
    if [ "$found" -ne 1 ]; then
      echo "FATAL: the Ubuntu package download produced no zstd packages." >&2
      return 1
    fi
    hash -r
  fi
  zstd --version || return $?

  local source_sha_file=.ci-results/codearts-checkout/source-sha source_sha
  if [ -s "$source_sha_file" ]; then source_sha="$(cat "$source_sha_file")"; else source_sha="$(git rev-parse HEAD)"; fi
  local integration_sha short_sha output_dir versioned final
  integration_sha="$(git rev-parse HEAD)"
  short_sha="${source_sha:0:8}"
  output_dir="$results_dir/binary-release-x86_64"
  echo "Packaging rebased checkout: source=$source_sha integration=$integration_sha"
  mkdir -p -- "$output_dir"

  local package_flags=()
  if command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --dev /dev true >/dev/null 2>&1; then
    echo "bubblewrap probe passed; enabling the four-entry binary smoke gate."
  else
    echo "WARNING: bubblewrap/user namespaces are unavailable on this CodeArts runner."
    echo "WARNING: using --skip-smoke; this artifact is packaging-only and has not passed the release smoke gate."
    package_flags+=(--skip-smoke)
  fi
  # The packaging entry point builds the launcher before its payload stage
  # installs dependencies, so a fresh checkout must hydrate the workspace.
  CI=true pnpm install --frozen-lockfile --ignore-scripts || return $?
  BINARY_CACHE_URL="${CI_BINARY_CACHE_URL:-}" \
  BINARY_CACHE_ONLY=1 \
  BINARY_CACHE_DIR="$results_dir/toolchain-cache" \
    bash scripts/package-binary-release.sh \
      --arch x86_64 \
      --output "$output_dir" \
      --version "$source_sha" \
      ${package_flags[@]+"${package_flags[@]}"} || return $?

  versioned="$output_dir/ScienceDiscovery-$source_sha-linux-x86_64"
  final="ScienceDiscovery-$short_sha-linux-x86_64"
  test -x "$versioned" || return 1
  test -s "$output_dir/VERSION" || return 1
  mv -- "$versioned" "$output_dir/$final" || return 1
  (
    cd "$output_dir"
    sha256sum "$final" > SHA256SUMS
    sha256sum --check SHA256SUMS
    ls -lh "$final" VERSION SHA256SUMS
  ) || return $?
  publish_from "$output_dir" "$final" SHA256SUMS VERSION
}

status=0
case "$layer" in
  ut-host) run_ut_host || status=$? ;;
  st) run_st || status=$? ;;
  ut-guest) run_ut_guest || status=$? ;;
  e2e) run_e2e || status=$? ;;
  binary-x86_64) run_binary_x86_64 || status=$? ;;
esac

# The layer entry points keep their own run.log; fold the tail into the
# published log so one object explains the outcome.
case "$layer" in
  ut-host) layer_results="$results_dir/ut-host" ;;
  st) layer_results="$results_dir/st" ;;
  ut-guest) layer_results="$results_dir/ut-guest" ;;
  e2e) layer_results="$results_dir/e2e" ;;
  *) layer_results="" ;;
esac
if [ -n "$layer_results" ] && [ -f "$layer_results/run.log" ]; then
  echo "=== $layer run.log (last 120 lines) ==="
  tail -n 120 "$layer_results/run.log"
  publish_from "$layer_results" summary.json summary.txt
fi

printf '%s\n' "$status" > "$publish_dir/exit-code"
echo "$layer exited with status $status"
exit "$status"
