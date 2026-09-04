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

# Fetches the immutable, pre-provisioned QEMU Runner image. The resource
# revision, resource run, and image digest advance together during a manual
# image upgrade; formal CI never falls back to rebuilding or a mutable source.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output=""

usage() {
  cat <<'EOF'
Usage: .ci/fetch-qemu-runner-image.sh --output <path>

Environment:
  CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME  Download limit in seconds (default: 300)
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

resource_commit=7365ff8e9bfb6aa2414c1dc09bf79b3f3e6bc4c8
resource_run_id=f8d5a313663c418a8c54eec630ebe881
checksum_file="$script_dir/qemu-runner-image.sha256"
if ! read -r image_sha256 image_name < "$checksum_file"; then
  echo "FATAL: could not read the QEMU Runner image checksum manifest." >&2
  exit 1
fi
[[ "$image_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "FATAL: invalid QEMU Runner image SHA256 manifest entry." >&2; exit 1; }
[[ "$image_name" =~ ^[0-9A-Za-z._+-]+$ ]] \
  || { echo "FATAL: invalid QEMU Runner image filename in checksum manifest." >&2; exit 1; }
image_base_url="https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/qemu-runner/v1/$resource_commit/$resource_run_id"

echo "Fetching the pinned pre-provisioned QEMU Runner image"
echo "resource commit: $resource_commit"
echo "resource run   : $resource_run_id"
exec bash "$script_dir/fetch-verified-binary.sh" \
  --cache-base-url "$image_base_url" \
  --cache-only \
  --download-max-time "${CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME:-300}" \
  --filename "$image_name" \
  --output "$output" \
  --sha256 "$image_sha256"
