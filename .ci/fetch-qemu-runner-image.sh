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
# One definition for the versions, names and locations more than one CI
# script has to agree on.
# shellcheck source=.ci/ci-constants.sh
source "$script_dir/ci-constants.sh"

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

resource_commit=97c17ab77b9d30cdf982aaed7e6261bf7d358bd8
resource_run_id=bd0367fec86e446e9295ff2f9e022bc6
checksum_file="$script_dir/qemu-runner-image.sha256"
if ! read -r image_sha256 image_name < "$checksum_file"; then
  echo "FATAL: could not read the QEMU Runner image checksum manifest." >&2
  exit 1
fi
[[ "$image_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "FATAL: invalid QEMU Runner image SHA256 manifest entry." >&2; exit 1; }
[[ "$image_name" =~ ^[0-9A-Za-z._+-]+$ ]] \
  || { echo "FATAL: invalid QEMU Runner image filename in checksum manifest." >&2; exit 1; }
# The key holds only the run id. A push-triggered pipeline cannot resolve its
# own commit into a step parameter, so the commit that built this image is
# recorded in the published VERSION manifest and above rather than in the path.
image_base_url="$CI_OBS_CACHE_BASE/qemu-runner/v2/$resource_run_id"

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
