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

# Produce the ScienceDiscovery single-file release binaries.
#
# Each supported architecture yields exactly one executable that carries the
# product: Web UI, control API, sandbox runner, their Node and
# CPython runtimes and micromamba. uv and the gateway's Python dependency tree
# are deliberately not packaged; the first `serve` on the user's machine
# downloads them from a configurable package index (Huawei Cloud mirror by
# default) at versions pinned inside the payload. A user downloads that one
# file and runs
# `./ScienceDiscovery serve`.
#
# This is the binary deployment path and it never involves Docker, neither at
# build time nor at run time. Container users take the separate image path
# documented in docs/zh/how-to/deployment.md.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"

architecture="all"
output_dir=""
version=""
keep_payload=0
skip_smoke=0

usage() {
  cat <<'EOF'
Usage: scripts/package-binary-release.sh [options]

Options:
  --arch <all|x86_64|aarch64>  Architectures to build (default: all)
  --output <directory>         Output directory (default: dist/binary-release-<version>)
  --version <version>          Release version label (default: git describe)
  --keep-payload               Keep the uncompressed payload trees for inspection
  --skip-smoke                 Skip the four-entry smoke gate on the built artifact.
                               The gate boots the packaged app, which spawns the
                               bubblewrap runner, so it cannot pass on a host
                               without bwrap. Artifacts stay unverified — prefer
                               installing bubblewrap over using this.
  -h, --help                   Show this help

Both architectures build from either an x86_64 or an aarch64 host: the Node and
CPython runtimes are downloaded from pinned manifests and the gateway's Python
dependencies are resolved as target-platform wheels.
EOF
}

while (($#)); do
  case "$1" in
    --arch) architecture="${2:?--arch requires a value}"; shift 2 ;;
    --keep-payload) keep_payload=1; shift ;;
    --output) output_dir="${2:?--output requires a value}"; shift 2 ;;
    --skip-smoke) skip_smoke=1; shift ;;
    --version) version="${2:?--version requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$architecture" in
  all) architectures=(x86_64 aarch64) ;;
  amd64|x64|x86_64) architectures=(x86_64) ;;
  arm64|aarch64) architectures=(aarch64) ;;
  *) echo "Unsupported architecture: $architecture" >&2; exit 2 ;;
esac

for tool in node pnpm uv tar zstd sha256sum; do
  command -v "$tool" >/dev/null || { echo "$tool is required to build the release." >&2; exit 1; }
done

cd "$repository_root"
if [[ -z "$version" ]]; then
  version="$(git describe --tags --always --dirty 2>/dev/null || echo 0.0.0)"
fi
output_dir="${output_dir:-$repository_root/dist/binary-release-$version}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"

assert_no_release_build_paths() { # <release artifact>
  local artifact="$1" needle
  for needle in "$repository_root" "$output_dir" "${HOME:-}" "${USERPROFILE:-}"; do
    if [[ -n "$needle" ]] && grep -aFq -- "$needle" "$artifact"; then
      echo "Release artifact leaks a build-machine path: $needle" >&2
      exit 1
    fi
  done
  if grep -aEq '\.missioncrew|MissionCrew|\.worktrees' "$artifact"; then
    echo "Release artifact leaks private build-workspace metadata." >&2
    exit 1
  fi
}

echo "ScienceDiscovery binary release $version"
echo "Output directory: $output_dir"
echo "Architectures: ${architectures[*]}"
echo "Deployment mode: single-file binary (no Docker on this path)"

# The launcher must be compiled before it can be bundled into the executables.
CI=true pnpm --filter @sciencediscovery/launcher build

artifact_names=()
native_artifact=""
case "$(uname -m)" in
  amd64|x86_64) native_architecture="x86_64" ;;
  aarch64|arm64) native_architecture="aarch64" ;;
  *) native_architecture="" ;;
esac
for target in "${architectures[@]}"; do
  payload_dir="$output_dir/.payload-$target"
  artifact="ScienceDiscovery-$version-linux-$target"
  bash "$script_dir/binary-release/build-payload.sh" \
    --arch "$target" --output "$payload_dir" --version "$version" \
    --shared "$output_dir/.shared"
  node "$script_dir/binary-release/build-binary.mjs" \
    --arch "$target" --payload "$payload_dir" --output "$output_dir/$artifact"
  assert_no_release_build_paths "$output_dir/$artifact"
  artifact_names+=("$artifact")
  if [[ "$target" == "$native_architecture" ]]; then
    native_artifact="$artifact"
  fi
  if [[ "$keep_payload" -eq 0 ]]; then
    rm -rf -- "$payload_dir"
  fi
done

rm -rf -- "$output_dir"/.work-* "$output_dir/.shared" "$output_dir/.downloads"

{
  echo "science-agent=$version"
  echo "format=science-agent-single-binary-v1"
  echo "contents=web+api+gateway+runner+node+cpython+micromamba"
  echo "excluded=neo4j,uv,gateway-python-deps"
  echo "first-launch-installs=uv,gateway-python-deps"
  echo "host-requirements=bubblewrap"
  printf 'architectures='
  separator=""
  for target in "${architectures[@]}"; do
    printf '%s%s' "$separator" "linux-$target"
    separator=,
  done
  printf '\n'
} >"$output_dir/VERSION"

(cd "$output_dir" && sha256sum "${artifact_names[@]}" >SHA256SUMS)

if ((skip_smoke)); then
  echo "Skipping the four-entry smoke gate (--skip-smoke); $native_artifact is unverified."
elif [[ -n "$native_artifact" ]]; then
  echo "Running four-entry smoke gate for $native_artifact..."
  SCIENCE_AGENT_UV_PATH="$(command -v uv)" \
    node "$script_dir/binary-release/smoke-binary.mjs" \
      --binary "$output_dir/$native_artifact"
else
  echo "No artifact in this build is executable on $(uname -m); four-entry smoke was not run."
fi

echo
echo "Release artifacts in $output_dir:"
for artifact in "${artifact_names[@]}"; do
  printf '  %-48s %s\n' "$artifact" "$(du -h "$output_dir/$artifact" | cut -f1)"
done
echo "  VERSION, SHA256SUMS"
