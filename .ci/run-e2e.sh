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

# A host that cannot start the stack itself still installs everything the run
# needs, so a guest can be handed a prepared workspace and only run the
# browser journeys. Both halves use this one entry point; there is no second
# E2E definition.
prepare_only=0
if [[ "${CI_E2E_PREPARE_ONLY:-}" == "1" ]]; then prepare_only=1; fi
prepared=0
if [[ "${CI_E2E_PREPARED:-}" == "1" ]]; then prepared=1; fi
if [[ "$prepare_only" -eq 1 && "$prepared" -eq 1 ]]; then
  printf 'BLOCKED: CI_E2E_PREPARE_ONLY and CI_E2E_PREPARED are mutually exclusive.\n' >&2
  exit 2
fi

# Agent turns run on JiuwenSwarm, behind the adapter (issue 84): that is the
# backend the product ships. CI_E2E_BACKEND=legacy runs the same journeys on the
# built-in loop while it still exists, so a diff between the two reports is a
# diff between the two backends.
backend="${CI_E2E_BACKEND:-jiuwenswarm}"
case "$backend" in
  legacy|jiuwenswarm) ;;
  *)
    printf 'BLOCKED: CI_E2E_BACKEND must be legacy or jiuwenswarm, got %s.\n' "$backend" >&2
    exit 2
    ;;
esac

results_suffix="e2e"
if [[ "$group" != "mocked" ]]; then results_suffix="e2e-$group"; fi
if [[ "$backend" != "jiuwenswarm" ]]; then results_suffix="$results_suffix-$backend"; fi
results_root="${CI_RESULTS_DIR:-/ci-results}/$results_suffix"
# A test run keeps its own data directory, separate from the one an instance a
# person runs for themselves uses (`.sciencediscovery-data`). The container path
# is what CI passes; the repository-local fallback is what a laptop gets, and it
# is gitignored.
runtime_root="${CI_RUNTIME_DIR:-$repository_root/.e2e-data}"
stack_log="$results_root/stack.log"
test_log="$results_root/run.log"
summary="$results_root/summary.txt"
stack_pid=""
jiuwenswarm_started=0
fixture_pid=""
fixture="${CI_E2E_FIXTURE:-standard}"
case "$fixture" in standard|research|literature) ;; *) echo 'Unknown E2E fixture' >&2; exit 2;; esac
if [[ "$fixture" != standard && "$group" != mocked ]]; then echo 'Offline fixtures must never reach real E2E' >&2; exit 2; fi
test_started=0
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$results_root" "$runtime_root"
: > "$stack_log"
: > "$test_log"

finish() {
  local status=$?
  local result_status="failed"
  trap - EXIT INT TERM
  if [[ -n "$fixture_pid" ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ -n "$stack_pid" ]]; then
    # start-stack runs several children and keeps the API in the foreground.
    # Terminate the dedicated session as a group so its shell cannot remain
    # blocked waiting for pnpm while report collection waits behind it.
    kill -TERM -- "-$stack_pid" 2>/dev/null || true
    wait "$stack_pid" 2>/dev/null || true
  fi
  # The JiuwenSwarm instance this layer started goes with its stack; one that was
  # already running (a developer's) is left alone.
  if [[ "$jiuwenswarm_started" -eq 1 ]]; then
    "$repository_root/scripts/jiuwenswarm.sh" stop >> "$stack_log" 2>&1 || true
    # Transport diagnostics already omit URLs, credentials, arguments and
    # response bodies. Preserve them per fixture before the next Swarm start
    # truncates its shared log; stack.log only contains the adapter's side.
    local swarm_log="${JIUWENSWARM_ROOT:-$repository_root/.sciencediscovery-data/jiuwenswarm}/jiuwenswarm.log"
    if [[ -f "$swarm_log" ]]; then
      grep -E 'platform_mcp_(request_failed|transport_failed|transport_open|transport_close|connect_ready|disconnect_requested|request_cancel)' \
        "$swarm_log" > "$results_root/platform-mcp-transport.log" || true
    fi
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
    # A preparation run installed dependencies and ran no journey; calling that
    # "passed" would report coverage nothing produced.
    if [[ "$prepare_only" -eq 1 ]]; then result_status="prepared"; fi
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

# Keeping the pinned browser inside the repository lets a prepared workspace
# carry it to a guest instead of downloading it again over emulated network.
if [[ -n "${CI_E2E_BROWSERS_DIR:-}" ]]; then
  case "${CI_E2E_BROWSERS_DIR}" in
    /*) PLAYWRIGHT_BROWSERS_PATH="$CI_E2E_BROWSERS_DIR" ;;
    *) PLAYWRIGHT_BROWSERS_PATH="$repository_root/$CI_E2E_BROWSERS_DIR" ;;
  esac
  export PLAYWRIGHT_BROWSERS_PATH
  mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
fi

if [[ "$prepared" -eq 1 ]]; then
  for required in .e2e/node_modules .e2e/package.json; do
    if [[ ! -e "$required" ]]; then
      printf 'BLOCKED: CI_E2E_PREPARED is set but %s is missing; its host did not prepare this workspace.\n' "$required" \
        | tee -a "$test_log" >&2
      exit 2
    fi
  done
  printf 'Using the workspace its host prepared: dependencies and the pinned Chromium are already installed.\n' \
    | tee -a "$test_log"
else
  pnpm install --frozen-lockfile 2>&1 | tee -a "$test_log" || exit $?
  node test/sync-e2e.mjs --write 2>&1 | tee -a "$test_log" || exit $?
  npm install --prefix .e2e 2>&1 | tee -a "$test_log" || exit $?
  .e2e/node_modules/.bin/playwright install chromium 2>&1 | tee -a "$test_log" || exit $?
fi
# The upstream postinstall uses $PWD and therefore creates a container-absolute
# link. Normalize it so the bind-mounted checkout — or an unpacked payload —
# remains usable wherever it landed.
ln -sfn ../.e2e/node_modules "$repository_root/test/node_modules"

if [[ "$prepare_only" -eq 1 ]]; then
  printf 'E2E preparation complete; the stack is deliberately not started here.\n' | tee -a "$test_log"
  exit 0
fi

auth_token_path="$runtime_root/auth-token"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$auth_token_path"
IFS= read -r auth_token < "$auth_token_path"

export SCIENCE_AGENT_AUTH_TOKEN="$auth_token"
export SCIENCE_DISCOVERY_DATA_DIR="$runtime_root/data"
# The product's own defaults — 4310/4311, evolve 4313, memory-graph 17674 — belong
# to the instance a person leaves running. A test stack that reuses them competes
# with that instance for the port and puts its own address in front of whoever the
# suite then talks to, so the layer keeps a block of its own. An explicit override
# still wins, which is how two runs share one machine.
export SCIENCE_AGENT_PORT="${SCIENCE_AGENT_PORT:-4410}"
export SCIENCE_AGENT_RUNNER_PORT="${SCIENCE_AGENT_RUNNER_PORT:-4411}"
export SCIENCE_AGENT_EVOLVE_PORT="${SCIENCE_AGENT_EVOLVE_PORT:-4413}"
export SCIENCE_AGENT_MEMORY_GRAPH_PORT="${SCIENCE_AGENT_MEMORY_GRAPH_PORT:-17774}"
# Moving a service is only half of it: the API dials each sidecar by URL, and
# every one of those has its own hardcoded default (see
# services/api/src/bootstrap/config.ts). Setting only the port starts the
# service on the new one and leaves the API knocking on the old one, which
# fails as a connection refused the API reports to the browser as a bare
# "fetch failed". Derive every URL from the port that was just chosen.
export SCIENCE_AGENT_RUNNER_URL="http://127.0.0.1:${SCIENCE_AGENT_RUNNER_PORT}"
export SCIENCE_AGENT_EVOLVE_URL="http://127.0.0.1:${SCIENCE_AGENT_EVOLVE_PORT}"
export SCIENCE_AGENT_MEMORY_GRAPH_URL="http://127.0.0.1:${SCIENCE_AGENT_MEMORY_GRAPH_PORT}"
# The default mocked job must not turn J3 into a conda-channel provisioning
# job. A dedicated CI setup job may opt in after its network policy is reviewed.
export SCIENTIFIC_ENVS="${E2E_SCIENTIFIC_ENVS:-0}"
# The model catalog is downloaded when a release is packaged and refreshed on
# demand at run time. Neither belongs in a browser test, so the stack loads a
# small committed excerpt of the published document instead: the journeys can
# then assert exact context windows, prices and thinking capabilities without a
# network call and without depending on what the live catalog says today.
export SCIENCE_AGENT_MODEL_CATALOG_PATH="$repository_root/test/fixtures/model-catalog.json"
export E2E_API_TOKEN="$auth_token"
export E2E_BASE_URL="http://127.0.0.1:${SCIENCE_AGENT_PORT}"
export E2E_API_URL="$E2E_BASE_URL"
export E2E_JOURNEY_REPORTS="$results_root/journey-reports"
# This layer started the stack above, on a data directory it owns, and will kill
# it again on the way out, so a journey may empty it to reach a first-run state.
# Nothing else grants that: a suite merely pointed at an address — someone's own
# instance, a colleague's machine — clears nothing and reports the journey as
# blocked instead.
export E2E_ALLOW_STACK_RESET=1

if [[ "$backend" == "jiuwenswarm" ]]; then
  export SCIENCE_AGENT_ADAPTER=1
  export SCIENCE_AGENT_EXECUTOR=jiuwenswarm
  # The journeys run on the tools the product ships: JiuwenSwarm's own (its todo planning, its skill_tool),
  # its host tools replaced by ScienceDiscovery's sandboxed ones. Sub-agents are the one exception: they
  # delegate with ScienceDiscovery's `task`, because a JiuwenSwarm `subagent_spawn` sub-agent has none of the
  # tools, sandbox, deliverables or sub-agent cards the delegation journeys are about (see Known gap 1a in
  # docs/en/reference/jiuwenswarm-migration-status.md).
  export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task
  export E2E_SWARM_TASK=1
  if [[ "$fixture" != standard ]]; then
    # Research mocks script platform tool contracts; standard/real use product defaults.
    export SCIENCE_AGENT_JIUWENSWARM_PLANNING=update_plan
    export SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours
  fi
  # A JiuwenSwarm instance of this layer's own, so a run never shares skills, config or sessions with the
  # instance a developer uses (the install itself, JIUWENSWARM_ROOT, is shared).
  export JIUWENSWARM_INSTANCE="${JIUWENSWARM_INSTANCE:-sd-e2e}"
  # Install the pinned release when missing and create this layer's instance. A
  # prepared workspace is one whose host installed the Node dependencies and the
  # pinned Chromium — the shared runner does that before it freezes the plan —
  # not JiuwenSwarm or its instance, so this runs either way; with the install
  # already present it only makes sure the instance exists.
  "$repository_root/scripts/jiuwenswarm.sh" setup >> "$test_log" 2>&1 || {
    printf 'BLOCKED: JiuwenSwarm could not be installed (scripts/jiuwenswarm.sh setup); see %s.\n' "$test_log" | tee -a "$test_log" >&2
    exit 2
  }
  eval "$("$repository_root/scripts/jiuwenswarm.sh" env)" || {
    printf 'BLOCKED: the JiuwenSwarm instance %s is not set up.\n' "$JIUWENSWARM_INSTANCE" | tee -a "$test_log" >&2
    exit 2
  }
  jiuwenswarm_gateway_port="${JIUWENSWARM_GATEWAY_URL##*:}"; jiuwenswarm_gateway_port="${jiuwenswarm_gateway_port%%/*}"
  if [[ "$fixture" != standard ]]; then
    if (exec 3<>"/dev/tcp/127.0.0.1/$jiuwenswarm_gateway_port") 2>/dev/null; then
      echo 'BLOCKED: research fixture refuses to modify a running Swarm instance' >&2; exit 2
    fi
    swarm_python="${JIUWENSWARM_SRC:-${JIUWENSWARM_ROOT:-$repository_root/.sciencediscovery-data/jiuwenswarm}/src}/.venv/bin/python"
    "$swarm_python" .ci/prepare-research-fixture.py >> "$test_log" 2>&1 || exit 2
    export E2E_SWARM_EXCLUSIVE=1 E2E_SWARM_COMPACTION=1 E2E_MCP_FAULT_PROXY=1
    export E2E_MCP_PROXY_PORT="$((SCIENCE_AGENT_PORT + 5))"
    export E2E_MCP_PROXY_TARGET="http://127.0.0.1:${SCIENCE_AGENT_PORT}"
    export SCIENCE_AGENT_ADAPTER_PUBLIC_URL="http://127.0.0.1:${E2E_MCP_PROXY_PORT}"
    if ss -ltn "sport = :$E2E_MCP_PROXY_PORT" 2>/dev/null | grep -q LISTEN; then
      printf 'BLOCKED: MCP fault proxy port %s is already in use.\n' "$E2E_MCP_PROXY_PORT" >&2
      exit 2
    fi
    # Keep fixture startup diagnostics separate: start-stack redirects stack_log
    # with `>`, which otherwise erases any early proxy bind failure.
    node test/fixtures/swarm-mcp-fault-proxy.mjs > "$results_root/mcp-proxy.log" 2>&1 &
    fixture_pid=$!
    proxy_ready=0
    for _ in $(seq 1 50); do
      if curl --silent --fail --max-time 1 --output /dev/null "http://127.0.0.1:${E2E_MCP_PROXY_PORT}/health"; then
        proxy_ready=1
        break
      fi
      if ! kill -0 "$fixture_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if [[ "$proxy_ready" -ne 1 ]]; then
      printf 'BLOCKED: MCP fault proxy did not listen on port %s; see %s.\n' "$E2E_MCP_PROXY_PORT" "$results_root/mcp-proxy.log" >&2
      exit 2
    fi
    if [[ "$fixture" == literature ]]; then
      export E2E_LITERATURE_FIXTURE=1
      export SCIENCE_AGENT_API_ENTRYPOINT="$repository_root/test/fixtures/literature-api.mjs"
    fi
  fi
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$jiuwenswarm_gateway_port") 2>/dev/null; then
    "$repository_root/scripts/jiuwenswarm.sh" start >> "$stack_log" 2>&1 || {
      printf 'BLOCKED: JiuwenSwarm did not start; see %s.\n' "$stack_log" | tee -a "$test_log" >&2
      exit 2
    }
    jiuwenswarm_started=1
  fi
  export JIUWENSWARM_GATEWAY_URL JIUWENSWARM_MGMT_URL
fi

stack_arguments=(--mode local)
# A prepared workspace already carries the installed dependencies and the
# build. Letting the stack redo them inside a guest makes pnpm try to purge a
# modules directory that came from another store, which it refuses to do
# without a TTY, and the stack dies before it can listen.
if [[ "$prepared" -eq 1 ]]; then stack_arguments+=(--no-node-build); fi
# A taken port is not refused anywhere below: the stack loses that bind, the
# journeys reach whoever already owns the address, and the run reports a wall of
# 401s that reads like a broken token. Say it here instead, while the port is
# still the answer.
busy_ports=("$SCIENCE_AGENT_PORT" "$SCIENCE_AGENT_RUNNER_PORT" "$SCIENCE_AGENT_EVOLVE_PORT" "$SCIENCE_AGENT_MEMORY_GRAPH_PORT")
if [[ "$backend" == jiuwenswarm ]]; then
  busy_ports+=("${SCIENCE_AGENT_LEGACY_PORT:-$((SCIENCE_AGENT_PORT + 100))}")
fi
for busy_port in "${busy_ports[@]}"; do
  if ss -ltn "sport = :$busy_port" 2>/dev/null | grep -q LISTEN; then
    printf 'BLOCKED: port %s is already in use; another stack owns it. Choose free API (including its legacy port +100), runner, evolve and memory-graph ports.\n' \
      "$busy_port" | tee -a "$test_log" >&2
    exit 2
  fi
done

setsid ./scripts/start-stack.sh "${stack_arguments[@]}" > "$stack_log" 2>&1 &
stack_pid=$!

# Under software emulation the services take far longer to provision their
# Python environments and listen, so the wait is a knob rather than a constant.
health_timeout="${CI_E2E_STACK_TIMEOUT_SECONDS:-180}"
healthy=0
for _ in $(seq 1 "$health_timeout"); do
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

if [[ "$group" == real ]]; then
  node .ci/configure-real-e2e.mjs >> "$test_log" 2>&1 || exit 2
fi

node test/check-e2e-meta.mjs 2>&1 | tee -a "$test_log"
metadata_status=${PIPESTATUS[0]}
if [[ "$metadata_status" -ne 0 ]]; then exit "$metadata_status"; fi
test_started=1
playwright_args=()
if [[ -n "${CI_E2E_SPEC:-}" ]]; then playwright_args+=("$CI_E2E_SPEC"); fi
if [[ -n "${CI_E2E_GREP:-}" ]]; then playwright_args+=(--grep "$CI_E2E_GREP"); fi
npm --prefix .e2e run "test:$group" -- "${playwright_args[@]}" 2>&1 | tee -a "$test_log"
journeys_status=${PIPESTATUS[0]}

# What only the JiuwenSwarm backend does, checked against the same stack: the
# approvals JiuwenSwarm's permission engine asks and the user answers, the host
# tools it must not reach, skills imported into it and switched there, the
# trajectory recorded from its model calls, its language. Each check builds and
# deletes its own project and scripted model. Left out here: todo-plan (the
# journeys plan with update_plan), web-search (the internet), compression and
# history-restart (a small context window, a JiuwenSwarm restart).
live_status=0
if [[ "$backend" == "jiuwenswarm" && "$group" == "mocked" && "$fixture" == standard ]]; then
  live_checks="${CI_E2E_JIUWENSWARM_CHECKS:-history history-names run-shell host-tools approvals skills skill-switch trajectory language}"
  # shellcheck disable=SC2086 # the list is words on purpose
  node test/contract/jw-only/live.mjs $live_checks 2>&1 | tee "$results_root/jiuwenswarm-checks.log" | tee -a "$test_log"
  live_status=${PIPESTATUS[0]}
  printf 'jiuwenswarm_checks=%s\n' "$([[ "$live_status" -eq 0 ]] && echo passed || echo failed)" >> "$results_root/jiuwenswarm-checks.log"
fi
if [[ "$journeys_status" -ne 0 ]]; then exit "$journeys_status"; fi
exit "$live_status"
