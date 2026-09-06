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

# Where each CI layer publishes its result, and how to read it back.
#
# The build task's console shell returns success even when the layer failed,
# so that its OBS action still uploads the log. The recorded `exit-code` object
# is therefore the only truthful status, and both the verification job and the
# merge-request result table read it from here rather than from a CodeArts job
# status that is green by construction.
#
# Sourced, not executed.

# name:obs-suffix, in the order the result table lists them.
#
# E2E is deliberately absent. Its journeys reach the browser and run to
# completion under emulation, but every one of them outruns a Playwright
# timeout sized for native speed, so the layer stays off until those are
# scaled. The entry point, the guest and `pnpm ci:e2e` are untouched:
# restoring it means adding the pair back here and the job back to the
# workflow.
CODEARTS_CI_LAYERS=(
  "ut-host:ut-host"
  "ut-guest:ut-guest"
  "st:st"
  "binary-x86_64:binary/x86_64"
  "binary-aarch64:binary/aarch64"
)

codearts_run_base_url() {
  printf 'https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/ci/%s/%s' \
    "${CI_COMMIT:?CI_COMMIT is required}" "${CI_RUN_ID:?CI_RUN_ID is required}"
}

# Echo the recorded exit code for one layer, or `missing`. OBS is
# read-after-write consistent for new objects but the upload action runs after
# the layer, so a short retry keeps a just-finished job from looking absent.
codearts_layer_exit_code() {
  local suffix="$1" base attempt value
  base="$(codearts_run_base_url)"
  for attempt in 1 2 3 4 5; do
    if value="$(curl -fsS --max-time 60 "$base/$suffix/exit-code" 2>/dev/null)"; then
      printf '%s' "$value" | tr -d '[:space:]'
      return 0
    fi
    [ "$attempt" -eq 5 ] || sleep 2
  done
  printf 'missing'
}

# PASSED only for a recorded zero. A missing object means the layer never got
# far enough to publish one, which is a failure, not an unknown.
codearts_layer_status() {
  local code
  code="$(codearts_layer_exit_code "$1")"
  if [ "$code" = "0" ]; then printf 'PASSED'; else printf 'FAILED'; fi
}
