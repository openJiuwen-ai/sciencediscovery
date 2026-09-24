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

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sandbox_npu_runtime.sh
source "$ROOT/sandbox_npu_runtime.sh"
configure_sandbox_npu_runtime

# The selected managed environment, frozen Skill package and Runner NPU mount
# are authoritative. Do not inherit legacy host-pipeline discovery variables
# from a Session profile.
unset ANTIBODY_PIPELINE_HOME ANTIBODY_PIPELINE_ENV ANTIBODY_MODELS_DIR
unset MINDSCIENCE_ROOT MINDSCIENCE_APP_DIR PROTENIX_APP_DIR
unset RF_DIFFUSION_CKPT PROTENIX_CKPT HMMER_HOME CANN_SET_ENV

PYTHON_BIN="${SCIENCE_ENV_PYTHON:-}"
if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python || command -v python3 || true)"
fi
if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  echo "error: no Python from the selected managed scientific environment" >&2
  exit 2
fi
MANAGED_PYTHON="$PYTHON_BIN"
unset SCIENCE_AGENT_MANAGED_PYTHON PYTHON_BIN ANTIBODY_PIPELINE_PYTHON
export SCIENCE_ENV_PYTHON="$MANAGED_PYTHON"

# requirements.txt is declarative; selecting a managed environment does not
# install or reconcile it automatically. Fail before model launch when the
# selected Runner environment is incomplete or has an incompatible critical
# version. This check intentionally runs for both --validate-only and run.
"$MANAGED_PYTHON" "$ROOT/validate_managed_environment.py" "$ROOT/../requirements.txt"

if [[ "${1:-}" == "--prepare-only" ]]; then
  shift
  exec "$MANAGED_PYTHON" "$ROOT/antibody_pipeline_manager.py" prepare \
    --clone-missing --download-missing "$@"
elif [[ "${1:-}" == "--validate-only" ]]; then
  shift
  exec "$MANAGED_PYTHON" "$ROOT/antibody_pipeline_manager.py" validate "$@"
fi

exec "$MANAGED_PYTHON" "$ROOT/antibody_pipeline_manager.py" run "$@"
