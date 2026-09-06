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

# Fetches the portable QEMU emulator the guest jobs boot with. The
# `ci/codearts-resources` branch assembles it from signed Alpine packages once
# and publishes it at a stable key; a test job only downloads and verifies it.
# The tree inside the archive is reproducible — an independent build of the
# same commit produced byte-identical contents — but the archive's own bytes
# depend on the packing host's tar, so `.ci/qemu-emulator.sha256` records what
# the publishing run reported, not what a local build produces.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# One definition for the versions, names and locations more than one CI
# script has to agree on.
# shellcheck source=.ci/ci-constants.sh
source "$script_dir/ci-constants.sh"

output=""

usage() {
  cat <<'EOF'
Usage: .ci/fetch-qemu-emulator.sh --output <path>

Environment:
  CI_QEMU_EMULATOR_DOWNLOAD_MAX_TIME  Download limit in seconds (default: 300)
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

checksum_file="$script_dir/qemu-emulator.sha256"
if ! read -r payload_sha256 payload_name < "$checksum_file"; then
  echo "FATAL: could not read the QEMU emulator checksum manifest." >&2
  exit 1
fi
[[ "$payload_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "FATAL: invalid QEMU emulator SHA256 manifest entry." >&2; exit 1; }
[[ "$payload_name" =~ ^[0-9A-Za-z._+-]+$ ]] \
  || { echo "FATAL: invalid QEMU emulator filename in checksum manifest." >&2; exit 1; }
cache_base_url="$CI_OBS_CACHE_BASE/qemu-emulator/v1"

echo "Fetching the pinned portable QEMU emulator"
exec bash "$script_dir/fetch-verified-binary.sh" \
  --cache-base-url "$cache_base_url" \
  --cache-only \
  --download-max-time "${CI_QEMU_EMULATOR_DOWNLOAD_MAX_TIME:-300}" \
  --filename "$payload_name" \
  --output "$output" \
  --sha256 "$payload_sha256"
