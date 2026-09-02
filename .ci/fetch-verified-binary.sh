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

# Fetch one immutable CI toolchain binary. A verified local copy wins, then a
# public OBS cache is tried, and only a cache miss falls back to the source URL.
# The same SHA256 pin protects every route.

set -euo pipefail

cache_base_url=""
cache_only=0
filename=""
output=""
sha256=""
source_url=""

usage() {
  cat <<'EOF'
Usage: .ci/fetch-verified-binary.sh [options]

Options:
  --cache-base-url <url>  Optional public OBS cache base URL
  --cache-only            Return status 3 instead of using a source URL on miss
  --filename <name>       Stable cache object filename
  --output <path>         Local archive destination
  --sha256 <digest>       Expected lowercase SHA256
  --source-url <url>      Authoritative fallback URL
EOF
}

while (($#)); do
  case "$1" in
    --cache-base-url) cache_base_url="${2:?--cache-base-url requires a value}"; shift 2 ;;
    --cache-only) cache_only=1; shift ;;
    --filename) filename="${2:?--filename requires a value}"; shift 2 ;;
    --output) output="${2:?--output requires a value}"; shift 2 ;;
    --sha256) sha256="${2:?--sha256 requires a value}"; shift 2 ;;
    --source-url) source_url="${2:?--source-url requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$filename" =~ ^[0-9A-Za-z._+-]+$ ]] \
  || { echo "--filename contains unsafe characters." >&2; exit 2; }
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "--sha256 must be a lowercase 64-hex digest." >&2; exit 2; }
[[ "$cache_only" -eq 1 || "$source_url" == https://* ]] \
  || { echo "--source-url must use HTTPS." >&2; exit 2; }
[[ -z "$cache_base_url" || "$cache_base_url" == https://* ]] \
  || { echo "--cache-base-url must use HTTPS." >&2; exit 2; }
[[ -n "$output" ]] || { echo "--output is required." >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 \
  || { echo "sha256sum is required to verify CI binaries." >&2; exit 1; }

verify() {
  local path="$1" actual
  [[ -s "$path" ]] || return 1
  actual="$(sha256sum "$path" | awk '{print $1}')"
  [[ "$actual" == "$sha256" ]]
}

mkdir -p -- "$(dirname -- "$output")"
if verify "$output"; then
  echo "CI binary local cache hit: $filename"
  exit 0
fi
rm -f -- "$output"

temporary="$output.$$.tmp"
trap 'rm -f -- "$temporary"' EXIT

download() {
  local url="$1"
  rm -f -- "$temporary"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$url" -o "$temporary"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$temporary" "$url"
  else
    echo "FATAL: neither curl nor wget is available to fetch $filename." >&2
    return 1
  fi
}

if [[ -n "$cache_base_url" ]]; then
  cache_url="${cache_base_url%/}/$filename"
  echo "Checking OBS cache: $cache_url"
  if download "$cache_url" && verify "$temporary"; then
    mv -- "$temporary" "$output"
    echo "CI binary OBS cache hit: $filename"
    exit 0
  fi
  echo "CI binary OBS cache miss or checksum mismatch: $filename"
fi

if [[ "$cache_only" -eq 1 ]]; then
  exit 3
fi

echo "Downloading authoritative source: $source_url"
download "$source_url" \
  || { echo "FATAL: source download failed for $filename." >&2; exit 1; }
verify "$temporary" \
  || { echo "FATAL: source checksum mismatch for $filename." >&2; exit 1; }
mv -- "$temporary" "$output"
echo "CI binary source download verified: $filename"
