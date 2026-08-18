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

# Browser/stack orchestration is intentionally separate from pnpm commands:
# it owns service lifecycle, Chromium installation and report collection.
set -uo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
group="${1:-mocked}"
case "$group" in
  mocked) ;;
  real|legacy) ;;
  *)
    printf 'Usage: .ci/run-e2e.sh [mocked|real|legacy]\n' >&2
    exit 2
    ;;
esac

results_suffix="e2e"
if [[ "$group" != "mocked" ]]; then results_suffix="e2e-$group"; fi
results_root="${CI_RESULTS_DIR:-/ci-results}/$results_suffix"
runtime_root="${CI_RUNTIME_DIR:-/ci-cache/science-agent-e2e}"
stack_log="$results_root/stack.log"
test_log="$results_root/run.log"
summary="$results_root/summary.txt"
stack_pid=""
test_started=0
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$results_root" "$runtime_root"
: > "$stack_log"
: > "$test_log"

finish() {
  local status=$?
  local result_status="failed"
  trap - EXIT INT TERM
  if [[ -n "$stack_pid" ]]; then
    # start-stack runs several children and keeps the API in the foreground.
    # Terminate the dedicated session as a group so its shell cannot remain
    # blocked waiting for pnpm while report collection waits behind it.
    kill -TERM -- "-$stack_pid" 2>/dev/null || true
    wait "$stack_pid" 2>/dev/null || true
  fi
  if [[ "$test_started" -eq 1 ]]; then
    mkdir -p "$results_root/playwright-report" "$results_root/test-results"
    if [[ -d "$repository_root/.e2e/playwright-report" ]]; then
      cp -a "$repository_root/.e2e/playwright-report/." "$results_root/playwright-report/"
    fi
    if [[ -d "$repository_root/.e2e/test-results" ]]; then
      cp -a "$repository_root/.e2e/test-results/." "$results_root/test-results/"
    fi
  fi
  if [[ "$status" -eq 0 ]]; then
    result_status="passed"
  elif [[ "$status" -eq 2 ]]; then
    result_status="blocked"
  fi
  {
    printf 'layer=e2e\n'
    printf 'group=%s\n' "$group"
    printf 'status=%s\n' "$result_status"
    printf 'exit_code=%s\n' "$status"
    printf 'started_at=%s\n' "$started_at"
    printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$summary"
  exit "$status"
}
trap finish EXIT INT TERM

if [[ "$group" == "real" ]]; then
  if [[ "${CI_ALLOW_REAL:-}" != "1" ]]; then
    printf 'BLOCKED: set CI_ALLOW_REAL=1 for explicit live-model opt-in.\n' | tee -a "$test_log" >&2
    exit 2
  fi
  for required_name in E2E_LLM_BASE_URL E2E_LLM_MODEL E2E_LLM_TOKEN; do
    if [[ -z "${!required_name:-}" ]]; then
      printf 'BLOCKED: missing %s.\n' "$required_name" | tee -a "$test_log" >&2
      exit 2
    fi
  done
elif [[ "$group" == "legacy" && "${CI_ALLOW_LEGACY:-}" != "1" ]]; then
  printf 'BLOCKED: set CI_ALLOW_LEGACY=1 to run unaudited legacy E2E.\n' | tee -a "$test_log" >&2
  exit 2
fi

cd "$repository_root"
if [[ ! -f third_party/deer-flow/backend/packages/harness/pyproject.toml ]]; then
  printf 'BLOCKED: third_party/deer-flow is not initialized; mount a recursive checkout.\n' | tee -a "$test_log" >&2
  exit 2
fi

pnpm install --frozen-lockfile 2>&1 | tee -a "$test_log" || exit $?
node test/sync-e2e.mjs --write 2>&1 | tee -a "$test_log" || exit $?
npm install --prefix .e2e 2>&1 | tee -a "$test_log" || exit $?
# The upstream postinstall uses $PWD and therefore creates a container-absolute
# link. Normalize it so the bind-mounted checkout remains usable on the host.
ln -sfn ../.e2e/node_modules "$repository_root/test/node_modules"
.e2e/node_modules/.bin/playwright install chromium 2>&1 | tee -a "$test_log" || exit $?

auth_token_path="$runtime_root/auth-token"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$auth_token_path"
IFS= read -r auth_token < "$auth_token_path"

export SCIENCE_AGENT_AUTH_TOKEN="$auth_token"
export SCIENCE_AGENT_DATA_DIR="$runtime_root/data"
export SCIENCE_AGENT_PORT="${SCIENCE_AGENT_PORT:-4310}"
export SCIENCE_AGENT_RUNNER_PORT="${SCIENCE_AGENT_RUNNER_PORT:-4311}"
export SCIENCE_AGENT_RUNNER_URL="http://127.0.0.1:${SCIENCE_AGENT_RUNNER_PORT}"
export SCIENCE_AGENT_GATEWAY_PORT="${SCIENCE_AGENT_GATEWAY_PORT:-4312}"
export SCIENCE_AGENT_GATEWAY_URL="http://127.0.0.1:${SCIENCE_AGENT_GATEWAY_PORT}"
# The default mocked job must not turn J3 into a conda-channel provisioning
# job. A dedicated CI setup job may opt in after its network policy is reviewed.
export SCIENTIFIC_ENVS="${E2E_SCIENTIFIC_ENVS:-0}"
export E2E_API_TOKEN="$auth_token"
export E2E_BASE_URL="http://127.0.0.1:${SCIENCE_AGENT_PORT}"
export E2E_API_URL="$E2E_BASE_URL"
export E2E_JOURNEY_REPORTS="$results_root/journey-reports"

setsid ./scripts/start-stack.sh --mode local > "$stack_log" 2>&1 &
stack_pid=$!

healthy=0
for _ in $(seq 1 180); do
  if curl --silent --fail "$E2E_BASE_URL/health" >/dev/null; then
    healthy=1
    break
  fi
  if ! kill -0 "$stack_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  printf 'BLOCKED: isolated E2E stack did not become healthy; inspect stack.log.\n' | tee -a "$test_log" >&2
  exit 2
fi

node test/check-e2e-meta.mjs 2>&1 | tee -a "$test_log" || exit $?
test_started=1
npm --prefix .e2e run "test:$group" 2>&1 | tee -a "$test_log"
exit ${PIPESTATUS[0]}
