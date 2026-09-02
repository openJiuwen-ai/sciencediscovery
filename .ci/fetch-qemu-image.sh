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

# Fetches the immutable Ubuntu base image used by the QEMU sandbox UT. The
# shared verified fetcher keeps local, cache, and source downloads behind the
# same SHA256 pin.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output=""

usage() {
  cat <<'EOF'
Usage: .ci/fetch-qemu-image.sh --output <path>

Environment:
  CI_QEMU_IMAGE_CACHE_URL          Optional public cache base URL
  CI_QEMU_IMAGE_CACHE_ONLY         Set to 1 to fail instead of using TUNA
  CI_QEMU_IMAGE_DOWNLOAD_MAX_TIME Per-download limit in seconds (default: 1800)
EOF
}

while (($#)); do
  case "$1" in
    --output) output="${2:?--output requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$output" ]] || { echo "--output is required." >&2; exit 2; }

image_name=noble-server-cloudimg-amd64.img
image_url=https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/noble/20260826/noble-server-cloudimg-amd64.img
image_sha256=d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30
download_max_time="${CI_QEMU_IMAGE_DOWNLOAD_MAX_TIME:-1800}"
cache_only="${CI_QEMU_IMAGE_CACHE_ONLY:-0}"
[[ "$cache_only" =~ ^[01]$ ]] \
  || { echo "CI_QEMU_IMAGE_CACHE_ONLY must be 0 or 1." >&2; exit 2; }
cache_arguments=()
if [[ -n "${CI_QEMU_IMAGE_CACHE_URL:-}" ]]; then
  cache_arguments+=(--cache-base-url "$CI_QEMU_IMAGE_CACHE_URL")
fi
if [[ "$cache_only" -eq 1 ]]; then
  cache_arguments+=(--cache-only)
fi

if [[ "$cache_only" -eq 1 ]]; then
  echo "Fetching the pinned Ubuntu cloud image (local cache, then OBS; source fallback disabled)"
else
  echo "Fetching the pinned Ubuntu cloud image (local cache, OBS, then TUNA)"
fi
exec bash "$script_dir/fetch-verified-binary.sh" \
  "${cache_arguments[@]}" \
  --download-max-time "$download_max_time" \
  --filename "$image_name" \
  --output "$output" \
  --sha256 "$image_sha256" \
  --source-url "$image_url"
