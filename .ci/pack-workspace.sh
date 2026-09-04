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

# Packs the checked-out commit together with the dependency tree and build
# output its host already produced, so a guest can run a test layer without
# installing or compiling anything itself. Source comes from `git archive` so
# the payload holds the commit under test and no local scratch; dependencies
# and build output are appended from the working tree because neither is
# tracked.

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output=""
extra_includes=()

usage() {
  cat <<'EOF'
Usage: .ci/pack-workspace.sh --output <path ending in .tar.gz> [--include <path>]...

  --include  An additional working-tree path to append, relative to the
             repository root. Repeatable. Dependency trees and build output
             are appended automatically.
EOF
}

while (($#)); do
  case "$1" in
    --output) output="${2:?--output requires a value}"; shift 2 ;;
    --include) extra_includes+=("${2:?--include requires a value}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$output" ]] || { echo "--output is required." >&2; exit 2; }
[[ "$output" == *.tar.gz ]] || { echo "--output must end in .tar.gz." >&2; exit 2; }
case "$output" in
  /*) ;;
  *) output="$PWD/$output" ;;
esac

cd "$repo_root"

if [[ ! -d node_modules ]]; then
  echo "FATAL: node_modules is missing; install before packing the workspace." >&2
  exit 1
fi

includes=(node_modules)
for project in config apps/* packages/* services/*; do
  if [[ -d "$project/node_modules" ]]; then includes+=("$project/node_modules"); fi
  if [[ -d "$project/dist" ]]; then includes+=("$project/dist"); fi
done
for include in ${extra_includes[@]+"${extra_includes[@]}"}; do
  if [[ ! -e "$include" ]]; then
    echo "FATAL: requested payload path '$include' does not exist." >&2
    exit 1
  fi
  includes+=("$include")
done

staging="${output%.gz}"
untracked="$staging.untracked"
mkdir -p -- "$(dirname -- "$output")"
rm -f -- "$staging" "$untracked" "$output"
git archive --format=tar HEAD --output "$staging"
# pnpm's store links are deeply nested and overflow ustar's 100-byte link
# field, so the untracked half is written as pax and concatenated: appending
# to the archive git wrote would silently drop those symlinks.
tar --create --format=pax --file "$untracked" -- "${includes[@]}"
tar --concatenate --file "$staging" -- "$untracked"
rm -f -- "$untracked"
# Level 1 keeps the host's packing time small; the payload is mostly text that
# still compresses well, and the guest spends less emulated CPU on a smaller
# download than it saves on a denser one.
gzip -1 -- "$staging"
[[ -s "$output" ]] || { echo "FATAL: the workspace payload is empty." >&2; exit 1; }

echo "workspace payload: $output ($(du -h -- "$output" | cut -f1))"
echo "  commit  : $(git -C "$repo_root" rev-parse HEAD)"
echo "  appended: ${#includes[@]} dependency and build paths"
