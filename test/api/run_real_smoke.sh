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

# Real-model agent-loop smoke: the Node-native loop -> live model -> real
# createWorkspaceTools handler. Credentials come from the environment or the
# repo root .env (SCIENCE_AGENT_LLM_BASE_URL / _MODEL / _API_TOKEN).
#
# Usage (from repo root):  ./test/api/run_real_smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then set -a; # shellcheck disable=SC1091
  source "$ROOT/.env"; set +a; fi
: "${SCIENCE_AGENT_LLM_BASE_URL:?set SCIENCE_AGENT_LLM_BASE_URL or add it to the repo root .env}"
: "${SCIENCE_AGENT_LLM_MODEL:?}"
: "${SCIENCE_AGENT_LLM_API_TOKEN:?}"

cd "$ROOT"
pnpm --filter @sciencediscovery/api exec tsx "$HERE/agent_loop_real_smoke.ts"
