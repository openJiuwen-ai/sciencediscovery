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

# Prepare or reuse a shared read-only JiuwenSwarm installation on a self-hosted
# Docker runner's local cache volume (SD_CI_CACHE_DIR, default /ci-cache).
#
# Multiple runner containers share SD_CI_CACHE_DIR on the host. A flock serializes
# cold installs per cache key, and stripping .git lets scripts/jiuwenswarm.sh
# cmd_setup() take its pre-installed read-only fast path while every job keeps
# its own isolated JIUWENSWARM_HOME under CI_RUNTIME_DIR.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cache_dir="${SD_CI_CACHE_DIR:-/ci-cache}"
cache_root="$cache_dir/jiuwenswarm"

compute_key() {
  local files=()
  local candidate
  for candidate in \
    "$repository_root/scripts/jiuwenswarm.sh" \
    "$repository_root/scripts/swarm-patches.py"; do
    [[ -f "$candidate" ]] && files+=("$candidate")
  done
  if [[ -d "$repository_root/jiuwen_swarm/patches" ]]; then
    while IFS= read -r candidate; do
      files+=("$candidate")
    done < <(LC_ALL=C find "$repository_root/jiuwen_swarm/patches" -type f | LC_ALL=C sort)
  fi
  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "Cannot compute CI_SWARM_CACHE_KEY: no JiuwenSwarm input files found under $repository_root." >&2
    exit 1
  fi
  sha256sum "${files[@]}" | sha256sum | awk '{print $1}'
}

key="${CI_SWARM_CACHE_KEY:-$(compute_key)}"
if [[ ! "$key" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid CI_SWARM_CACHE_KEY: $key" >&2
  exit 1
fi

mkdir -p "$cache_root"
lock_file="$cache_root/$key.lock"
entry_dir="$cache_root/$key"
target="$entry_dir/src"
ready_marker="$entry_dir/.ready"

exec 9>"$lock_file"
flock 9

if [[ -f "$ready_marker" && -x "$target/.venv/bin/jiuwenswarm-start" && ! -d "$target/.git" ]]; then
  echo "Using warm local JiuwenSwarm cache at $target (key=$key)." >&2
else
  echo "Populating local JiuwenSwarm cache at $target (key=$key)..." >&2
  mkdir -p "$entry_dir"
  rm -rf "$target" "$ready_marker"
  temp_home="$(mktemp -d "${TMPDIR:-/tmp}/sd-swarm-cache-warm.XXXXXX")"
  warm_failed=1
  cleanup() {
    rm -rf "${temp_home:-}"
    if [[ "${warm_failed:-0}" -eq 1 ]]; then
      rm -rf "$target" "$ready_marker"
    fi
  }
  trap cleanup EXIT INT TERM

  # Install directly at the final path so virtualenv shebangs and pyvenv.cfg
  # match $target permanently.
  SCIENCE_AGENT_JIUWENSWARM_OVERRIDES=1 \
  JIUWENSWARM_SRC="$target" \
  JIUWENSWARM_HOME="$temp_home" \
  JIUWENSWARM_INSTANCE="sd-cache-warm" \
    bash "$repository_root/scripts/jiuwenswarm.sh" setup

  # Strip .git so subsequent jobs take cmd_setup()'s read-only pre-installed path
  # and never mutate the shared cache directory.
  rm -rf "$target/.git"
  if [[ ! -x "$target/.venv/bin/jiuwenswarm-start" ]]; then
    echo "Local JiuwenSwarm cache build missing executable $target/.venv/bin/jiuwenswarm-start." >&2
    exit 1
  fi

  touch "$ready_marker"
  warm_failed=0
  rm -rf "$temp_home"
  temp_home=""
  trap - EXIT INT TERM
  echo "Populated local JiuwenSwarm cache at $target (key=$key)." >&2
fi

flock -u 9
exec 9>&-

# Export only JIUWENSWARM_SRC; callers that actually drive JiuwenSwarm
# (scripts/with-jiuwenswarm.sh and .ci/run-e2e.sh) opt in via
# SCIENCE_AGENT_JIUWENSWARM_OVERRIDES=1 so non-Swarm unit tests stay unaffected.
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'JIUWENSWARM_SRC=%s\n' "$target" >> "$GITHUB_ENV"
else
  printf 'JIUWENSWARM_SRC=%s\n' "$target"
fi
