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

# Produce the two micromamba-only Linux release bundles. Scientific Python/R
# environments and package caches are intentionally outside this script.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
fetcher="$script_dir/fetch-managed-micromamba.mjs"

architecture="all"
dry_run=0
output_dir=""
source_dir=""

usage() {
  cat <<'EOF'
Usage: scripts/package-micromamba-release.sh [options]

Options:
  --arch <all|x86_64|aarch64>  Architectures to package (default: all)
  --output <directory>         Output directory (default: dist/micromamba-release-<version>)
  --source-dir <directory>     Use pre-downloaded release binaries from this directory
  --dry-run                    Validate and print the release plan without downloading
  -h, --help                   Show this help

Each tarball contains only bin/micromamba and manifest.json. It never packages
the starter scientific Python/R environments or a conda package cache.
EOF
}

while (($#)); do
  case "$1" in
    --arch)
      architecture="${2:?--arch requires a value}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --output)
      output_dir="${2:?--output requires a value}"
      shift 2
      ;;
    --source-dir)
      source_dir="${2:?--source-dir requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$architecture" in
  all) architectures=(x86_64 aarch64) ;;
  amd64|x64|x86_64) architectures=(x86_64) ;;
  arm64|aarch64) architectures=(aarch64) ;;
  *)
    echo "Unsupported architecture: $architecture" >&2
    exit 2
    ;;
esac

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

IFS=$'\t' read -r version _ < <(node "$fetcher" --arch x86_64 --print-tsv)
output_dir="${output_dir:-$repository_root/dist/micromamba-release-$version}"

echo "Micromamba release version: $version"
echo "Output directory: $output_dir"
echo "Contents: micromamba binary only (no scientific Python/R environments)"
for requested_arch in "${architectures[@]}"; do
  IFS=$'\t' read -r release_version runtime_arch docker_arch package_arch filename expected_sha256 url \
    < <(node "$fetcher" --arch "$requested_arch" --print-tsv)
  [[ "$release_version" == "$version" ]] || { echo "Release version mismatch for $requested_arch" >&2; exit 1; }
  echo "- linux/$docker_arch ($package_arch): $filename $expected_sha256"
  echo "  source: $url"
done

if ((dry_run)); then
  exit 0
fi

if [[ -e "$output_dir" ]] && [[ -n "$(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Output directory is not empty: $output_dir" >&2
  exit 1
fi
mkdir -p "$output_dir"
stage_dir="$(mktemp -d "$output_dir/.stage.XXXXXX")"
trap 'rm -rf -- "$stage_dir"' EXIT

artifact_names=()
for requested_arch in "${architectures[@]}"; do
  IFS=$'\t' read -r release_version runtime_arch docker_arch package_arch filename expected_sha256 url \
    < <(node "$fetcher" --arch "$requested_arch" --print-tsv)
  bundle_name="sciencediscovery-micromamba-${release_version}-linux-${package_arch}"
  bundle_dir="$stage_dir/$bundle_name"
  mkdir -p "$bundle_dir/bin"

  fetch_arguments=(--arch "$requested_arch" --output "$bundle_dir/bin/micromamba")
  if [[ -n "$source_dir" ]]; then
    fetch_arguments+=(--source "$source_dir/$filename")
  fi
  node "$fetcher" "${fetch_arguments[@]}"

  cat >"$bundle_dir/manifest.json" <<EOF
{
  "formatVersion": 1,
  "name": "sciencediscovery-micromamba",
  "version": "$release_version",
  "platform": "linux",
  "architecture": "$package_arch",
  "dockerPlatform": "linux/$docker_arch",
  "runtimeArchitecture": "$runtime_arch",
  "binary": "bin/micromamba",
  "binarySha256": "$expected_sha256",
  "upstreamFilename": "$filename"
}
EOF

  artifact_name="$bundle_name.tar.gz"
  tar --create --gzip --file "$output_dir/$artifact_name" \
    --directory "$stage_dir" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    "$bundle_name"
  artifact_names+=("$artifact_name")
done

{
  echo "micromamba=$version"
  echo "format=sciencediscovery-micromamba-bundle-v1"
  echo "contents=micromamba-only"
  printf 'architectures='
  local_separator=""
  for requested_arch in "${architectures[@]}"; do
    printf '%s%s' "$local_separator" "linux-$requested_arch"
    local_separator=,
  done
  printf '\n'
} >"$output_dir/VERSION"

(
  cd "$output_dir"
  sha256sum "${artifact_names[@]}" >SHA256SUMS
)

echo "Created ${#artifact_names[@]} artifact(s) with VERSION and SHA256SUMS in $output_dir"
