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

# Generic entry point for the CodeArts Build task. The parent pipeline passes
# only a repository-relative script path and compact line-oriented parameters;
# the long build implementation stays in the checked-out repository.
#
# Inputs supplied by CodeArts Build custom parameters:
#   SH_FILE_PATH  Required repository-relative shell script path.
#   ENVS          Optional NAME=VALUE records, one per line.
#   ARGS          Optional script arguments, one per line. Spaces are preserved.
#   WORKSPACE     CodeArts checkout root. Defaults to the current directory.

set -euo pipefail

fail() {
  echo "FATAL: $*" >&2
  exit 2
}

workspace_input="${WORKSPACE:-$PWD}"
script_input="${SH_FILE_PATH:-}"
env_input="${ENVS:-}"
args_input="${ARGS:-}"

[[ -n "$script_input" ]] || fail "SH_FILE_PATH is required."
[[ "$script_input" != /* ]] || fail "SH_FILE_PATH must be relative to WORKSPACE."
[[ "$script_input" != *$'\n'* && "$script_input" != *$'\r'* ]] \
  || fail "SH_FILE_PATH must contain exactly one path."

workspace="$(cd -- "$workspace_input" 2>/dev/null && pwd -P)" \
  || fail "WORKSPACE does not exist or is not accessible."
script_path="$(realpath -e -- "$workspace/$script_input" 2>/dev/null)" \
  || fail "SH_FILE_PATH does not resolve to an existing file."

case "$script_path" in
  "$workspace"/*) ;;
  *) fail "SH_FILE_PATH resolves outside WORKSPACE." ;;
esac
[[ -f "$script_path" ]] || fail "SH_FILE_PATH must resolve to a regular file."

env_count=0
while IFS= read -r record || [[ -n "$record" ]]; do
  record="${record%$'\r'}"
  [[ -n "$record" ]] || continue
  [[ "$record" == *=* ]] || fail "Each ENVS record must use NAME=VALUE."
  name="${record%%=*}"
  value="${record#*=}"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || fail "Invalid environment variable name: $name"
  case "$name" in
    BASH_ENV|BASHOPTS|CDPATH|ENV|GIT_SSH_COMMAND|IFS|LD_LIBRARY_PATH|LD_PRELOAD|PATH|SHELLOPTS)
      fail "Environment variable $name cannot be supplied through ENVS."
      ;;
  esac
  export "$name=$value"
  ((env_count += 1))
done <<<"$env_input"

declare -a script_args=()
while IFS= read -r record || [[ -n "$record" ]]; do
  record="${record%$'\r'}"
  [[ -n "$record" ]] || continue
  script_args+=("$record")
done <<<"$args_input"

display_path="${script_path#"$workspace"/}"
echo "CodeArts Build script: $display_path"
echo "Environment records: $env_count"
echo "Argument records: ${#script_args[@]}"

cd -- "$workspace"
exec bash -- "$script_path" "${script_args[@]}"
