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

# Real-model adapter smoke: GatewayAgent -> real Gateway -> live model
# -> real createWorkspaceTools handler. Credentials come from the environment or
# the repo root .env (SCIENCE_AGENT_LLM_BASE_URL / _MODEL / _API_TOKEN).
#
# Usage (from repo root):  ./test/api/run_real_smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GATEWAY="$ROOT/services/gateway"

if [[ -f "$ROOT/.env" ]]; then set -a; # shellcheck disable=SC1091
  source "$ROOT/.env"; set +a; fi
: "${SCIENCE_AGENT_LLM_BASE_URL:?set SCIENCE_AGENT_LLM_BASE_URL or add it to the repo root .env}"
: "${SCIENCE_AGENT_LLM_MODEL:?}"
: "${SCIENCE_AGENT_LLM_API_TOKEN:?}"

if [[ -x "$ROOT/data/envs/gateway/bin/python" ]]; then
  PY="$ROOT/data/envs/gateway/bin/python"
elif [[ -x "$GATEWAY/.venv/bin/python" ]]; then
  PY="$GATEWAY/.venv/bin/python"
else
  echo "Gateway Python missing. Run ./scripts/run-local.sh once, or: (cd services/gateway && uv sync)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
export PYTHONPATH="$GATEWAY/src${PYTHONPATH:+:$PYTHONPATH}"
( SCIENCE_AGENT_GATEWAY_PORT=4316 "$PY" -m science_agent_gateway.server ) >"$TMP/gateway.log" 2>&1 & GW=$!
cleanup(){ kill $GW 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -sf http://127.0.0.1:4316/health >/dev/null 2>&1 && break; sleep 0.5; done

cd "$ROOT"
GATEWAY_URL=http://127.0.0.1:4316 pnpm --filter @science-agent/api exec tsx "$HERE/gateway_real_smoke.ts"
