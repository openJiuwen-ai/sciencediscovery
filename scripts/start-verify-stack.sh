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

# A second, isolated ScienceDiscovery stack on alternate ports for manual
# verification of in-flight frontend changes — without disturbing the main
# stack the user is running tasks against in another terminal.
#
# The user's main stack (ports 4310/4311/17674) runs from a *separate repo
# checkout* (e.g. ../sciencediscovery_1) with its own data dir. This script
# runs from THIS repo, so the two stacks use different data dirs — no SQLite
# lock contention, they can run side by side. Everything here is port-shifted
# and uses this repo's data dir; Neo4j (7474) is *shared* (graph data is keyed
# by session_id, so two instances don't clobber each other); the sidecar just
# needs the password pushed once because this repo's data dir has no
# System-Settings store yet.
#
# Ports:  API 4312 · Runner 4313 · memory-graph sidecar 17675 · vite 5174
# Data:   ./data/  (this repo's own data dir — NOT shared with the other repo's stack)
#
# Usage:  bash scripts/start-verify-stack.sh
# Stop:   Ctrl-C (SIGINT to this process; all four children — sidecar, API,
#         runner, vite — exit within ~3s).

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd -- "$repo_root"

# --- Port + path overrides (must be set before sourcing .env so they win) ----
# This repo's own data dir. The user's main stack lives in a different repo
# checkout with its own data dir, so there's no shared-state contention to
# guard against — the two stacks can run concurrently.
export SCIENCE_DISCOVERY_DATA_DIR="data"
export SCIENCE_AGENT_DATA_DIR="data"
export SCIENCE_AGENT_PORT="4312"
export SCIENCE_AGENT_RUNNER_PORT="4313"
export SCIENCE_AGENT_RUNNER_URL="http://127.0.0.1:4313"
export SCIENCE_AGENT_MEMORY_GRAPH_PORT="17675"
export SCIENCE_AGENT_MEMORY_GRAPH_HOST="127.0.0.1"
export SCIENCE_AGENT_MEMORY_GRAPH_URL="http://127.0.0.1:17675"
# Shared Neo4j (the main stack's). Password is pushed to the sidecar below.
export SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP="http://127.0.0.1:7474"
# Internal loopback token the API uses to talk to the sidecar — reuse the same
# value; it's only local auth and two sidecars never see each other.
export SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN="science-agent-memory-graph-local"
# Runner token — distinct from the main stack so the API doesn't auth to the
# wrong runner on 4311.
export SCIENCE_AGENT_RUNNER_TOKEN="science-agent-runner-verify"
# Reuse the main stack's auth token (already in data/secrets/auth-token) so the
# browser session that was logged into the main stack works unchanged on 5174.
export SCIENCE_AGENT_AUTH_TOKEN="LnyxiBTG-IkeW3kWfnPsXxVZMWkHri3j-1iS9LYma6Q"

# Source the shared .env for everything not port-related (LLM base URL, model
# names, indices, …). Our exports above take precedence (set -a makes them
# survive the source).
set -a
# shellcheck disable=SC1091
source "$repo_root/.env"
set +a

# No preflight lock guard: the main stack (4310/4311/17674) runs from a
# separate repo checkout with its own data dir, so there's no shared SQLite to
# contend — this verify stack is meant to run *while* the main stack is up.
# (An earlier version wrongly refused to start when 4310/4311 was listening,
# which defeated the whole purpose of this script.)
mkdir -p "$SCIENCE_DISCOVERY_DATA_DIR"

# Preflight: refuse to start if any of our ports is already in use — otherwise
# a leftover process from a previous run makes wait_healthy pass instantly
# against someone else's server, masking the failure.
for p in 4312 4313 17675 5174; do
  if ss -tln 2>/dev/null | grep -q ":$p\b"; then
    echo "[verify] port $p already in use — another stack running? Stop it first." >&2
    exit 1
  fi
done

# Re-assert the overrides — .env may have reset them.
export SCIENCE_DISCOVERY_DATA_DIR="data"
export SCIENCE_AGENT_DATA_DIR="data"
export SCIENCE_AGENT_PORT="4312"
export SCIENCE_AGENT_RUNNER_PORT="4313"
export SCIENCE_AGENT_RUNNER_URL="http://127.0.0.1:4313"
export SCIENCE_AGENT_MEMORY_GRAPH_PORT="17675"
export SCIENCE_AGENT_MEMORY_GRAPH_HOST="127.0.0.1"
export SCIENCE_AGENT_MEMORY_GRAPH_URL="http://127.0.0.1:17675"
export SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP="http://127.0.0.1:7474"
export SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN="science-agent-memory-graph-local"
export SCIENCE_AGENT_RUNNER_TOKEN="science-agent-runner-verify"
export SCIENCE_AGENT_AUTH_TOKEN="LnyxiBTG-IkeW3kWfnPsXxVZMWkHri3j-1iS9LYma6Q"

pids=()
cleanup() {
  echo
  echo "[verify] stopping (sending SIGINT to children)..." >&2
  for pid in "${pids[@]:-}"; do
    kill -INT "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Resolve the prebuilt Python interpreters (built by the main stack) ------
gateway_python="$repo_root/data/envs/gateway/bin/python"
[[ -x "$gateway_python" ]] || gateway_python="$repo_root/services/gateway/.venv/bin/python"
memory_graph_python="$repo_root/data/envs/memory-graph/bin/python"

if [[ ! -x "$memory_graph_python" ]]; then
  echo "[verify] memory-graph env missing at $memory_graph_python. Build the main stack once first." >&2
  exit 1
fi
if [[ ! -x "$gateway_python" ]]; then
  echo "[verify] gateway env missing. Build the main stack once first." >&2
  exit 1
fi
export SCIENCE_AGENT_GATEWAY_PYTHON_PATH="$gateway_python"
export SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH="$repo_root/extensions_config.json"

# Make sure the built dist exists (the main stack's build is reused).
for d in services/api/dist/server.js services/runner/dist/server.js; do
  [[ -f "$repo_root/$d" ]] || { echo "[verify] missing $d — run 'pnpm build' first." >&2; exit 1; }
done

wait_healthy() {
  local name="$1" url="$2" tries=0
  until curl -sf -m 1 -o /dev/null "$url"; do
    tries=$((tries + 1))
    if [[ $tries -gt 60 ]]; then
      echo "[verify] $name did not become healthy at $url" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "[verify] $name healthy at $url"
}

# --- 1. memory-graph sidecar (17675) -----------------------------------------
echo "[verify] starting memory-graph sidecar on 17675..." >&2
"$memory_graph_python" -m sciencediscovery_memory_graph.server &
pids+=("$!")
wait_healthy "memory-graph" "http://127.0.0.1:17675/health"

# Push the shared Neo4j password once: this sidecar's data dir is fresh and has
# no System-Settings store, so the API wouldn't push it on its own.
echo "[verify] pushing Neo4j password to the sidecar..." >&2
curl -sf -X POST http://127.0.0.1:17675/internal/neo4j-password \
  -H "Authorization: Bearer $SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password":"12345678","http_uri":"http://127.0.0.1:7474","user":"neo4j"}' \
  -o /dev/null || echo "[verify] password push failed (continuing — card will show unreachable)" >&2

# --- 2. control API (4312) ---------------------------------------------------
echo "[verify] starting control API on 4312..." >&2
node services/api/dist/server.js &
pids+=("$!")
wait_healthy "api" "http://127.0.0.1:4312/health"

# --- 3. runner (4313) --------------------------------------------------------
echo "[verify] starting runner on 4313..." >&2
node services/runner/dist/server.js &
pids+=("$!")
wait_healthy "runner" "http://127.0.0.1:4313/health"

# --- 4. vite dev server (5174, proxies to the API on 4312) -------------------
echo "[verify] starting vite dev server on 5174..." >&2
( cd apps/web && exec node_modules/.bin/vite --config verify-vite.config.ts ) &
pids+=("$!")
wait_healthy "vite" "http://127.0.0.1:5174/"

echo
echo "[verify] stack ready."
echo "  API:      http://127.0.0.1:4312  (health: http://127.0.0.1:4312/health)"
echo "  Runner:   http://127.0.0.1:4313"
echo "  sidecar:  http://127.0.0.1:17675"
echo "  Neo4j:    shared (http://127.0.0.1:7474)"
echo "  Frontend: http://127.0.0.1:5174  (vite dev server, proxy → 4312)"
echo "  data dir: $repo_root/$SCIENCE_DISCOVERY_DATA_DIR"
echo
echo "Auth token (from $SCIENCE_DISCOVERY_DATA_DIR/secrets/auth-token):"
cat "$SCIENCE_DISCOVERY_DATA_DIR/secrets/auth-token" 2>/dev/null || echo "  (not generated yet)"
echo
echo "Open http://127.0.0.1:5174 in the browser."
echo
echo "[verify] Ctrl-C to stop all (sidecar · API · runner · vite)."

wait -n
