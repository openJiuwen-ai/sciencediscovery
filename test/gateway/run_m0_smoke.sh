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

# Gateway smoke (mock model): prove the gateway assembles an agent from a
# request (system prompt + dynamic tools + model spec + message history), calls
# an external tool that round-trips over HTTP to a stub "Node" callback, and
# streams events. No model credential needed — a local OpenAI-compatible mock
# drives the loop deterministically.
#
# Usage (from repo root):  ./test/gateway/run_m0_smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GATEWAY="$ROOT/services/gateway"

if [[ -x "$ROOT/data/envs/gateway/bin/python" ]]; then
  PY="$ROOT/data/envs/gateway/bin/python"
elif [[ -x "$GATEWAY/.venv/bin/python" ]]; then
  PY="$GATEWAY/.venv/bin/python"
else
  echo "Gateway Python missing. Run ./scripts/run-local.sh once, or: (cd services/gateway && uv sync)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
MOCK_TOOL_NAME=sci_echo MOCK_TOOL_ARGS='{"text":"ping"}' \
  "$PY" "$HERE/mock_model.py" --port 9099 >"$TMP/mock.log" 2>&1 & MOCK=$!
"$PY" "$HERE/stub_callback.py" --port 4399 >"$TMP/stub.log" 2>&1 & STUB=$!
# Ensure the gateway package is importable when using a bare src layout.
export PYTHONPATH="$GATEWAY/src${PYTHONPATH:+:$PYTHONPATH}"
SCIENCE_AGENT_GATEWAY_PORT=4312 \
  "$PY" -m science_agent_gateway.server >"$TMP/gateway.log" 2>&1 & GW=$!
cleanup(){ kill $MOCK $STUB $GW 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -sf http://127.0.0.1:4312/health >/dev/null 2>&1 && break; sleep 0.5; done

out="$(curl -sN -m 90 http://127.0.0.1:4312/run -H 'content-type: application/json' -d '{
  "thread_id":"sess-m0-smoke",
  "messages":[{"role":"user","content":"Please echo hello."}],
  "system_prompt":"You are a local science analysis agent under test.",
  "tools":[{"name":"sci_echo","description":"Echo text back through the Node workspace.",
            "input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],
  "model":{"base_url":"http://127.0.0.1:9099/v1","api_key":"dummy","model":"mock-1"},
  "callback_url":"http://127.0.0.1:4399/internal/tool-exec","callback_token":"test"}')"

# Assertions: tool call emitted, callback round-trip result, terminal end with
# the replayable final history, and a streamed final answer.
echo "$out" | grep -q '"tool_calls": \[{"name": "sci_echo"' || { echo "FAIL: no tool_calls event"; echo "$out"; cat "$TMP/gateway.log"; exit 1; }
echo "$out" | grep -q '\[node:sci_echo\] echo: ping' || { echo "FAIL: tool callback result missing"; echo "$out"; exit 1; }
echo "$out" | grep -q '"type": "end"' || { echo "FAIL: no terminal end event"; echo "$out"; exit 1; }
echo "$out" | grep -q '"final_messages"' || { echo "FAIL: end event lacks final_messages"; echo "$out"; exit 1; }
echo "$out" | grep -q 'summarized' || { echo "FAIL: no streamed final answer"; echo "$out"; exit 1; }
echo "Gateway mock smoke PASS: assembly + external-tool HTTP callback + streaming verified."
