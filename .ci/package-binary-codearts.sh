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

# Native binary packaging entry point for the ARM CodeArts Build task. Keep
# orchestration here so the parent pipeline only passes short line-oriented
# parameters through SH_FILE_PATH, ENVS, and ARGS.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"

architecture="aarch64"
output_relative=".ci-results/binary-release-aarch64"
version=""

usage() {
  cat <<'EOF'
Usage: .ci/package-binary-codearts.sh [options]

Options:
  --arch <x86_64|aarch64>  Native architecture to package (default: aarch64)
  --output <directory>     Repository-relative output directory
  --version <version>      Artifact version (default: expected/current commit)
  -h, --help               Show this help

Environment:
  EXPECTED_COMMIT                 Optional 40-hex integration checkout assertion
  ARTIFACT_COMMIT                 Optional 40-hex source commit for output naming
  CI_NPM_REGISTRY                 npm mirror passed to runner provisioning
  CI_PYPI_INDEX                   Python package index embedded in the runtime
  CI_UV_WHEEL_URL                 Optional exact uv wheel source override
  UV_DEFAULT_INDEX                Python index embedded as the runtime default
  UV_PYTHON_INSTALL_MIRROR        CPython standalone mirror base URL
  MICROMAMBA_CONDA_MIRROR         Optional conda-forge mirror base URL
  CI_BINARY_CACHE_URL             Optional public OBS toolchain cache base URL
  CI_BINARY_CACHE_DIR             Repository-local cache staging directory
  CI_BINARY_CACHE_ONLY            Set to 1 to require the configured cache
EOF
}

while (($#)); do
  case "$1" in
    --arch) architecture="${2:?--arch requires a value}"; shift 2 ;;
    --output) output_relative="${2:?--output requires a value}"; shift 2 ;;
    --version) version="${2:?--version requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$architecture" in
  amd64|x64|x86_64)
    architecture="x86_64"
    native_names='amd64|x86_64'
    library_triplet='x86_64-linux-gnu'
    ;;
  arm64|aarch64)
    architecture="aarch64"
    native_names='aarch64|arm64'
    library_triplet='aarch64-linux-gnu'
    ;;
  *) echo "Unsupported architecture: $architecture" >&2; exit 2 ;;
esac

[[ "$output_relative" != /* ]] \
  || { echo "--output must be relative to the repository root." >&2; exit 2; }
[[ "$output_relative" != *$'\n'* && "$output_relative" != *$'\r'* ]] \
  || { echo "--output must contain exactly one path." >&2; exit 2; }
case "$output_relative" in
  .ci-results/*) ;;
  *) echo "--output must be a dedicated subdirectory below .ci-results/." >&2; exit 2 ;;
esac

cd -- "$repository_root"
current_commit="$(git rev-parse HEAD)"
if [[ -n "${EXPECTED_COMMIT:-}" ]]; then
  [[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] \
    || { echo "EXPECTED_COMMIT must be a 40-hex commit SHA." >&2; exit 2; }
  [[ "${EXPECTED_COMMIT,,}" == "$current_commit" ]] || {
    echo "FATAL: CodeArts Build checked out $current_commit, expected ${EXPECTED_COMMIT,,}." >&2
    exit 1
  }
fi

artifact_commit="${ARTIFACT_COMMIT:-$current_commit}"
[[ "$artifact_commit" =~ ^[0-9a-fA-F]{40}$ ]] \
  || { echo "ARTIFACT_COMMIT must be a 40-hex commit SHA." >&2; exit 2; }
artifact_commit="${artifact_commit,,}"
git cat-file -e "$artifact_commit^{commit}" 2>/dev/null \
  || { echo "ARTIFACT_COMMIT is not available in this checkout." >&2; exit 2; }
short_commit="${artifact_commit:0:8}"

version="${version:-$artifact_commit}"
[[ "$version" =~ ^[0-9A-Za-z._+-]+$ ]] \
  || { echo "--version contains characters that are unsafe in an artifact name." >&2; exit 2; }

results_root="$(realpath -m -- "$repository_root/.ci-results")"
case "$results_root" in
  "$repository_root/.ci-results") ;;
  *) echo ".ci-results must not resolve through a symbolic link." >&2; exit 2 ;;
esac
output_dir="$(realpath -m -- "$repository_root/$output_relative")"
case "$output_dir" in
  "$results_root"/*) ;;
  *) echo "--output must resolve below the repository .ci-results directory." >&2; exit 2 ;;
esac
rm -rf -- "$output_dir"
mkdir -p -- "$output_dir"
result_log="$output_dir/run.log"

if [[ -n "${CI_BINARY_CACHE_DIR:-}" ]]; then
  if [[ "$CI_BINARY_CACHE_DIR" == /* ]]; then
    binary_cache_dir="$(realpath -m -- "$CI_BINARY_CACHE_DIR")"
  else
    binary_cache_dir="$(realpath -m -- "$repository_root/$CI_BINARY_CACHE_DIR")"
  fi
  case "$binary_cache_dir" in
    "$repository_root"/*) ;;
    *) echo "CI_BINARY_CACHE_DIR must resolve inside the repository." >&2; exit 2 ;;
  esac
  export CI_BINARY_CACHE_DIR="$binary_cache_dir"
  export BINARY_CACHE_DIR="$binary_cache_dir"
fi
export BINARY_CACHE_URL="${CI_BINARY_CACHE_URL:-}"
export BINARY_CACHE_ONLY="${CI_BINARY_CACHE_ONLY:-0}"

run_build() (
  set -euo pipefail

  local actual_arch zstd_root versioned_artifact normalized_artifact
  local node_cache node_sha python_cache python_sha micromamba_cache micromamba_sha uv_cache uv_sha
  local -a package_flags=()

  actual_arch="$(uname -m)"
  [[ "$actual_arch" =~ ^($native_names)$ ]] || {
    echo "FATAL: requested native $architecture build, received runner $actual_arch." >&2
    return 1
  }
  echo "Verified native CodeArts Build runner: $actual_arch"
  echo "Building integration commit: $current_commit"
  echo "Naming artifacts for source commit: $artifact_commit"

  export CI_NPM_REGISTRY="${CI_NPM_REGISTRY:-}"
  export CI_PYPI_INDEX="${CI_PYPI_INDEX:-}"
  export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-${CI_PYPI_INDEX:-}}"
  export UV_PYTHON_INSTALL_MIRROR="${UV_PYTHON_INSTALL_MIRROR:-}"
  bash .ci/provision-runner.sh

  zstd_root="$HOME/.local/share/codearts-zstd"
  export PNPM_HOME="$HOME/.local/share/pnpm"
  export PATH="$zstd_root/usr/bin:$HOME/.local/node/bin:$PNPM_HOME:$HOME/.local/bin:$PATH"
  export LD_LIBRARY_PATH="$zstd_root/usr/lib/$library_triplet:${LD_LIBRARY_PATH:-}"

  if ! command -v zstd >/dev/null 2>&1; then
    echo "zstd is missing; attempting an unprivileged package extraction."
    local download_dir="$output_dir/.zstd-packages" found_deb=0 package
    command -v apt-get >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1 || {
      echo "FATAL: the ARM build image must provide zstd or apt-get plus dpkg-deb." >&2
      return 1
    }
    rm -rf -- "$zstd_root" "$download_dir"
    mkdir -p -- "$zstd_root" "$download_dir"
    (
      cd -- "$download_dir"
      apt-get download zstd libzstd1
    )
    for package in "$download_dir"/*.deb; do
      [[ -e "$package" ]] || continue
      found_deb=1
      dpkg-deb --extract "$package" "$zstd_root"
    done
    [[ "$found_deb" -eq 1 ]] || {
      echo "FATAL: the package download produced no zstd archives." >&2
      return 1
    }
    rm -rf -- "$download_dir"
    hash -r
  fi
  zstd --version

  if command -v bwrap >/dev/null 2>&1 \
    && bwrap --ro-bind / / --dev /dev true >/dev/null 2>&1; then
    echo "bubblewrap probe passed; enabling the four-entry binary smoke gate."
  else
    echo "WARNING: bubblewrap/user namespaces are unavailable on this CodeArts Build runner."
    echo "WARNING: using --skip-smoke; this artifact is packaging-only and has not passed the release smoke gate."
    package_flags+=(--skip-smoke)
  fi

  CI=true pnpm install --frozen-lockfile --ignore-scripts
  bash scripts/package-binary-release.sh \
    --arch "$architecture" \
    --output "$output_dir" \
    --version "$version" \
    "${package_flags[@]}"

  versioned_artifact="$output_dir/ScienceDiscovery-$version-linux-$architecture"
  normalized_artifact="$output_dir/ScienceDiscovery-$short_commit-linux-$architecture"
  [[ -x "$versioned_artifact" ]]
  [[ -s "$output_dir/VERSION" ]]
  [[ -s "$output_dir/SHA256SUMS" ]]
  mv -- "$versioned_artifact" "$normalized_artifact"
  (
    cd -- "$output_dir"
    sha256sum "ScienceDiscovery-$short_commit-linux-$architecture" >SHA256SUMS
    sha256sum --check SHA256SUMS
    ls -lh "ScienceDiscovery-$short_commit-linux-$architecture" VERSION SHA256SUMS
  )

)

set +e
run_build 2>&1 | tee "$result_log"
build_rc=${PIPESTATUS[0]}
set -e
printf '%s\n' "$build_rc" >"$output_dir/exit-code"
echo "CodeArts native $architecture packaging exited with status $build_rc"
exit "$build_rc"
