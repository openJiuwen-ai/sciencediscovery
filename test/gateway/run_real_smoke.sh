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

# Real-model smoke: run the gateway against a live OpenAI-compatible endpoint
# and assert a full governed turn — system prompt honored, a dynamic proxy tool
# called, the result round-tripped through the stub Node callback, and a final
# streamed answer with replayable history.
#
# Credentials come from the environment or the repo root .env:
#   SCIENCE_AGENT_LLM_BASE_URL / SCIENCE_AGENT_LLM_MODEL / SCIENCE_AGENT_LLM_API_TOKEN
#
# Usage (from repo root):  ./test/gateway/run_real_smoke.sh
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
"$PY" "$HERE/stub_callback.py" --port 4399 >"$TMP/stub.log" 2>&1 & STUB=$!
SCIENCE_AGENT_GATEWAY_PORT=4313 \
  "$PY" -m science_agent_gateway.server >"$TMP/gateway.log" 2>&1 & GW=$!
cleanup(){ kill $STUB $GW 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -sf http://127.0.0.1:4313/health >/dev/null 2>&1 && break; sleep 0.5; done

body="$(python3 - <<PYEOF
import json, os
print(json.dumps({
    "thread_id": "sess-real-smoke",
    "messages": [{"role": "user", "content": "Use the sci_echo tool with text 'ping' and then tell me exactly what it returned."}],
    "system_prompt": "You are a local science analysis agent. Use only the registered workspace tools. Always call a tool before answering when one is relevant.",
    "tools": [{"name": "sci_echo", "description": "Echo text back through the Node workspace. Use to confirm connectivity.",
               "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}],
    "model": {"base_url": os.environ["SCIENCE_AGENT_LLM_BASE_URL"],
              "api_key": os.environ["SCIENCE_AGENT_LLM_API_TOKEN"],
              "model": os.environ["SCIENCE_AGENT_LLM_MODEL"]},
    "callback_url": "http://127.0.0.1:4399/internal/tool-exec",
    "callback_token": "test",
}))
PYEOF
)"

out="$(curl -sN -m 300 http://127.0.0.1:4313/run -H 'content-type: application/json' -d "$body")"

echo "$out" | grep -q '"tool_calls": \[{"name": "sci_echo"' || { echo "FAIL: model did not call sci_echo"; echo "$out"; cat "$TMP/gateway.log"; exit 1; }
echo "$out" | grep -q '\[node:sci_echo\] echo: ping' || { echo "FAIL: tool callback result missing"; echo "$out"; exit 1; }
echo "$out" | grep -q '"final_messages"' || { echo "FAIL: end event lacks final_messages"; echo "$out"; exit 1; }
final_text="$(echo "$out" | python3 -c '
import json, sys
text = "".join(
    e["data"].get("content", "")
    for line in sys.stdin if line.strip()
    for e in [json.loads(line)]
    if e["type"] == "messages-tuple" and e["data"].get("type") == "ai"
)
print(text.strip())')"
[ -n "$final_text" ] || { echo "FAIL: no streamed final answer"; echo "$out"; exit 1; }
echo "Real-model smoke PASS (${SCIENCE_AGENT_LLM_MODEL})."
echo "final answer: ${final_text}"
