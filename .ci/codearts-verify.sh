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

# The failure authority for a CodeArts run.
#
# Every layer runs in a build task whose console shell returns success even
# when the layer failed, so that its OBS action still uploads the diagnostics.
# Each CodeArts job is therefore green by construction and cannot decide the
# run. This job reads every layer's recorded exit code back out of OBS and is
# the one place a failure can turn the run red.
#
# Inputs supplied through the build task's ENVS records:
#   CI_COMMIT, CI_RUN_ID   the run whose OBS prefix is verified

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=.ci/codearts-ci-layers.sh
. "$repo_root/.ci/codearts-ci-layers.sh"

publish_dir="${CI_PUBLISH_DIR:-$repo_root/.ci-results/publish}"
case "$publish_dir" in
  /*) ;;
  *) publish_dir="$repo_root/$publish_dir" ;;
esac
mkdir -p -- "$publish_dir"
# Record the verdict as an object of its own. The console shell around this
# script returns success whatever happens, so `verify/exit-code` is the one
# place a reader can see what this job decided.
record_verdict() {
  printf '%s\n' "$1" > "$publish_dir/exit-code"
}
record_verdict 1

base_url="$(codearts_run_base_url)"
echo "Verifying published results under $base_url"

object_url() {
  python3 - "$base_url/$1" "$2" <<'PY'
import sys
from urllib.parse import quote

print("{}/{}".format(sys.argv[1].rstrip("/"), quote(sys.argv[2], safe="")))
PY
}

probe_object() {
  local suffix="$1" object_name="$2" url status attempt
  url="$(object_url "$suffix" "$object_name")"
  for attempt in 1 2 3 4 5; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --range 0-0 "$url" || true)"
    case "$status" in
      200|206) echo "  object present: $suffix/$object_name (HTTP $status)"; return 0 ;;
    esac
    [ "$attempt" -eq 5 ] || sleep 2
  done
  echo "FATAL: $suffix/$object_name was never published to OBS." >&2
  return 1
}

# The packaging layers must publish a usable artifact set, not just a log.
verify_binary_artifacts() {
  local suffix="$1" architecture="$2" binary_name checksum
  binary_name="ScienceDiscovery-${CI_COMMIT:0:8}-linux-$architecture"
  probe_object "$suffix" "$binary_name" || return 1
  probe_object "$suffix" SHA256SUMS || return 1
  probe_object "$suffix" VERSION || return 1
  checksum="$(curl -fsS "$base_url/$suffix/SHA256SUMS")"
  if ! printf '%s\n' "$checksum" | grep -Eq "^[0-9a-f]{64}  $binary_name$"; then
    echo "FATAL: $suffix/SHA256SUMS has an unexpected format." >&2
    return 1
  fi
}

failed=0
for entry in "${CODEARTS_CI_LAYERS[@]}"; do
  name="${entry%%:*}"
  suffix="${entry#*:}"
  code="$(codearts_layer_exit_code "$suffix")"
  if [ "$code" = "0" ]; then
    echo "$name: PASSED"
  else
    echo "$name: FAILED (recorded exit code: $code)"
    failed=1
    continue
  fi
  if ! probe_object "$suffix" run.log; then failed=1; fi
  case "$name" in
    binary-x86_64) verify_binary_artifacts "$suffix" x86_64 || failed=1 ;;
    binary-aarch64) verify_binary_artifacts "$suffix" aarch64 || failed=1 ;;
  esac
done

if [ "$failed" -ne 0 ]; then
  echo "FATAL: at least one CI layer did not publish a successful result." >&2
  exit 1
fi
record_verdict 0
echo "All CI layers published a successful result."
