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

# Requires the aarch64 packaging build task to have published a complete,
# self-consistent artifact set.
#
# The ARM build task returns success even when packaging failed, so that its
# OBS action still uploads the diagnostics. This check is therefore the failure
# authority for that path: missing objects, a nonzero recorded exit code and a
# malformed checksum all fail closed here.
#
# Inputs supplied through the build task's ENVS records:
#   CI_COMMIT, CI_RUN_ID   the run whose OBS prefix is verified

set -euo pipefail

: "${CI_COMMIT:?CI_COMMIT is required}"
: "${CI_RUN_ID:?CI_RUN_ID is required}"

BASE_URL="https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/ci/$CI_COMMIT/$CI_RUN_ID/binary/aarch64"
SHORT_SHA="${CI_COMMIT:0:8}"
BINARY_NAME="ScienceDiscovery-$SHORT_SHA-linux-aarch64"
object_url() {
  python3 - "$BASE_URL" "$1" <<'PY'
import sys
from urllib.parse import quote

print("{}/{}".format(sys.argv[1].rstrip("/"), quote(sys.argv[2], safe="")))
PY
}
probe_object() {
  object_name="$1"
  url=$(object_url "$object_name")
  attempt=1
  while [ "$attempt" -le 5 ]; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --range 0-0 "$url" || true)
    case "$status" in
      200|206)
        echo "Verified aarch64 OBS object: $object_name (HTTP $status)"
        return 0
        ;;
    esac
    echo "Waiting for aarch64 OBS object $object_name (attempt $attempt, HTTP ${status:-none})"
    attempt=$((attempt + 1))
    [ "$attempt" -gt 5 ] || sleep 2
  done
  echo "FATAL: ARM CodeArts Build did not publish $object_name to $BASE_URL/." >&2
  return 1
}
for object_name in "$BINARY_NAME" SHA256SUMS VERSION run.log exit-code; do
  probe_object "$object_name"
done
exit_code=$(curl -fsS "$BASE_URL/exit-code" | tr -d '[:space:]')
[ "$exit_code" = "0" ] || {
  echo "FATAL: ARM package recorded exit-code $exit_code instead of 0." >&2
  exit 1
}
checksum=$(curl -fsS "$BASE_URL/SHA256SUMS")
printf '%s\n' "$checksum" | grep -Eq "^[0-9a-f]{64}  $BINARY_NAME$" || {
  echo "FATAL: aarch64 SHA256SUMS has an unexpected format." >&2
  exit 1
}
