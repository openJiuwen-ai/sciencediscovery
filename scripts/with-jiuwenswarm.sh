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

# Run a command with agent turns on a real JiuwenSwarm, behind a real adapter:
#
#   scripts/with-jiuwenswarm.sh pnpm --filter @sciencediscovery/api test
#
# It installs the pinned JiuwenSwarm when missing (scripts/jiuwenswarm.sh), starts
# an instance of its own (JIUWENSWARM_INSTANCE, default sd-test) and one adapter,
# exports SCIENCE_AGENT_EXECUTOR=jiuwenswarm and SCIENCE_AGENT_ADAPTER_URL for the
# command, and stops what it started afterwards. The command's exit code is kept.
#
# One instance and one adapter serve every process the command starts: a test
# runner's parallel files share them, as the product's sessions do. JiuwenSwarm has
# one tool server per instance, so two adapters on one instance would take it from
# each other.
set -uo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $# -gt 0 ]] || { echo "Usage: scripts/with-jiuwenswarm.sh <command> [arguments...]" >&2; exit 2; }

export JIUWENSWARM_INSTANCE="${JIUWENSWARM_INSTANCE:-sd-test}"
state_dir="${CI_RUNTIME_DIR:-$repository_root/.sciencediscovery-data}/with-jiuwenswarm"
mkdir -p "$state_dir"
# Canonicalize: a relative CI_RUNTIME_DIR (CONTRIBUTING.md's own local-repro example passes one)
# would otherwise be re-resolved against services/adapter's cwd by the uv sync below, putting the
# adapter's venv somewhere this script never looks for it again.
state_dir="$(cd -- "$state_dir" && pwd)"
log="$state_dir/jiuwenswarm-test.log"
: > "$log"

adapter_pid=""
jiuwenswarm_started=0
cleanup() {
  if [[ -n "$adapter_pid" ]]; then kill "$adapter_pid" 2>/dev/null; wait "$adapter_pid" 2>/dev/null; fi
  if [[ "$jiuwenswarm_started" -eq 1 ]]; then "$repository_root/scripts/jiuwenswarm.sh" stop >> "$log" 2>&1; fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

blocked() {
  printf 'BLOCKED: %s (log: %s)\n' "$1" "$log" >&2
  tail -20 "$log" >&2
  exit 2
}

"$repository_root/scripts/jiuwenswarm.sh" setup >> "$log" 2>&1 || blocked "JiuwenSwarm could not be installed"
eval "$("$repository_root/scripts/jiuwenswarm.sh" env)" || blocked "the JiuwenSwarm instance $JIUWENSWARM_INSTANCE is not set up"
gateway_port="${JIUWENSWARM_GATEWAY_URL##*:}"; gateway_port="${gateway_port%%/*}"
if ! (exec 3<>"/dev/tcp/127.0.0.1/$gateway_port") 2>/dev/null; then
  "$repository_root/scripts/jiuwenswarm.sh" start >> "$log" 2>&1 || blocked "JiuwenSwarm did not start"
  jiuwenswarm_started=1
fi

# The adapter's own environment, next to the state directory, so a test run never touches the one a stack uses.
adapter_env="$state_dir/adapter-env"
if [[ ! -x "$adapter_env/bin/python" ]]; then
  (cd "$repository_root/services/adapter" && UV_PROJECT_ENVIRONMENT="$adapter_env" uv sync --quiet) >> "$log" 2>&1 \
    || blocked "the adapter environment could not be provisioned"
fi

free_port() { "$adapter_env/bin/python" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
adapter_port="${SCIENCE_AGENT_TEST_ADAPTER_PORT:-$(free_port)}"
# The adapter proxies what it does not serve to a legacy API; nothing listens there, and nothing here needs it.
SCIENCE_AGENT_PORT="$adapter_port" SCIENCE_AGENT_LEGACY_PORT="$(free_port)" SCIENCE_AGENT_EXECUTOR=jiuwenswarm \
SCIENCE_AGENT_ADAPTER_TOKEN="" JIUWENSWARM_GATEWAY_URL="$JIUWENSWARM_GATEWAY_URL" JIUWENSWARM_MGMT_URL="$JIUWENSWARM_MGMT_URL" \
  "$adapter_env/bin/python" -m sciencediscovery_adapter.server >> "$log" 2>&1 &
adapter_pid=$!
for _ in $(seq 1 60); do
  curl --silent --fail "http://127.0.0.1:$adapter_port/agent/info" >/dev/null 2>&1 && break
  kill -0 "$adapter_pid" 2>/dev/null || blocked "the adapter exited"
  sleep 0.5
done
curl --silent --fail "http://127.0.0.1:$adapter_port/agent/info" | grep -q '"reachable": *true' \
  || blocked "the adapter does not reach JiuwenSwarm"

export SCIENCE_AGENT_EXECUTOR=jiuwenswarm
export SCIENCE_AGENT_ADAPTER_URL="http://127.0.0.1:$adapter_port"
unset SCIENCE_AGENT_ADAPTER_TOKEN
# API fixtures exercise ScienceDiscovery's task lifecycle while Swarm executes
# the agent turns. Keep this test choice explicit; production still supports
# both routes. Callers can select the native route with SUBAGENTS=jiuwenswarm.
export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS="${SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS:-task}"
echo "Agent turns run on JiuwenSwarm (instance $JIUWENSWARM_INSTANCE) through the adapter at $SCIENCE_AGENT_ADAPTER_URL." >&2
"$@"
