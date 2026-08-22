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

set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  check_real_pipeline_env.sh [options]

Check whether the server can run the Protenix antibody design pipeline:
  RFdiffusion -> ProteinMPNN -> MindScience Protenix -> preliminary screening

Options:
  --app-dir DIR            MindSPONGE applications dir. Default: MINDSCIENCE_APP_DIR or derived from ANTIBODY_PIPELINE_HOME
  --scripts-dir DIR        Helper scripts dir. Default: directory containing this script
  --python PYTHON          Python executable from a ScienceDiscovery scientific-env revision. Required
  --protenix-dir DIR       MindScience Protenix application dir. Default: PROTENIX_APP_DIR or APP_DIR/protenix
  --protenix-ckpt FILE     Protenix checkpoint. Default: PROTENIX_CKPT or PROTENIX_DIR/release_data/checkpoint/ms_model_v0.5.0.ckpt
  --protenix-use-msa BOOL  Whether Protenix inference will run with --use_msa. Default: PROTENIX_USE_MSA or false
  --hmmer-home DIR         HMMER directory for Protenix MSA. Default: HMMER_HOME or ANTIBODY_PIPELINE_HOME/tools/hmmer
  --pipeline-env FILE      Optional extra env file. Disabled by default in ScienceDiscovery managed-env mode; do not use host env.sh
  --cann-set-env FILE      Ascend set_env.sh. Default: CANN_SET_ENV or /usr/local/Ascend/ascend-toolkit/set_env.sh
  --target-pdb FILE        Optional target antigen PDB to check.
  --framework-pdb FILE     Optional framework PDB to check.
  --ckpt FILE              RFdiffusion checkpoint. Default: APP_DIR/rf_diffusion/models/RFdiffusion_Ab.ckpt
  --npus LIST              Expected NPU list. Default: 0,1,2,3,4,5,6,7
  -h, --help               Show this help.

Exit code:
  0 if required checks pass
  2 if one or more required checks fail
EOF
}

PIPELINE_HOME="${ANTIBODY_PIPELINE_HOME:-}"
APP_DIR="${MINDSCIENCE_APP_DIR:-}"
if [[ -z "$APP_DIR" && -n "$PIPELINE_HOME" ]]; then
  APP_DIR="$PIPELINE_HOME/models/mindscience/MindSPONGE/applications"
fi
APP_DIR="${APP_DIR:-/opt/antibody_pipeline/models/mindscience/MindSPONGE/applications}"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_python() {
  local candidate
  for candidate in \
    "${SCIENCE_AGENT_MANAGED_PYTHON:-}" \
    "${PYTHON_BIN:-}" \
    "${ANTIBODY_PIPELINE_PYTHON:-}"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' ""
}

truthy_env() {
  case "${1,,}" in
    0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

require_managed_python() {
  if [[ -z "${PYTHON_BIN:-}" || ! -x "$PYTHON_BIN" ]]; then
    echo "error: --python must be a valid ScienceDiscovery scientific-env revision Python" >&2
    echo "       expected: .../data/scientific-envs/revisions/<env>/<rev>/bin/python, python3, or python3.x" >&2
    exit 2
  fi
  if [[ -n "${PIPELINE_HOME:-}" ]]; then
    case "$PYTHON_BIN" in
      "$PIPELINE_HOME"/venv/*|"$PIPELINE_HOME"/python_user/*|"$PIPELINE_HOME"/bin/*)
        echo "error: refusing host pipeline Python: $PYTHON_BIN" >&2
        echo "       create/select a ScienceDiscovery scientific environment and pass its bin/python" >&2
        exit 2
        ;;
    esac
  fi
  if truthy_env "${ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV:-${ANTIBODY_REQUIRE_SCIENCEAGENT_ENV:-1}}"; then
    case "$PYTHON_BIN" in
      */scientific-envs/revisions/*/bin/python|*/scientific-envs/revisions/*/bin/python3|*/scientific-envs/revisions/*/bin/python3.*) ;;
      *)
        echo "error: Python is not from a ScienceDiscovery scientific environment revision: $PYTHON_BIN" >&2
        echo "       expected: .../data/scientific-envs/revisions/<env>/<rev>/bin/python, python3, or python3.x" >&2
        exit 2
        ;;
    esac
  fi
}

require_no_host_pipeline_env() {
  if truthy_env "${ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV:-${ANTIBODY_REQUIRE_SCIENCEAGENT_ENV:-1}}" && [[ -n "${PIPELINE_ENV:-}" ]]; then
    echo "error: refusing --pipeline-env in ScienceDiscovery managed-env mode: $PIPELINE_ENV" >&2
    echo "       do not source host env.sh; install Python deps into the ScienceDiscovery scientific environment" >&2
    exit 2
  fi
}

PYTHON_BIN="$(resolve_python)"
PROTENIX_DIR="${PROTENIX_APP_DIR:-}"
PROTENIX_CKPT="${PROTENIX_CKPT:-}"
PROTENIX_USE_MSA="${PROTENIX_USE_MSA:-false}"
HMMER_HOME="${HMMER_HOME:-}"
CANN_SET_ENV="${CANN_SET_ENV:-/usr/local/Ascend/ascend-toolkit/set_env.sh}"
PIPELINE_ENV="${ANTIBODY_PIPELINE_ENV:-}"
# ScienceDiscovery managed-env mode does not auto-source host pipeline env.sh.
TARGET_PDB=""
FRAMEWORK_PDB=""
RF_CKPT=""
NPUS="0,1,2,3,4,5,6,7"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --scripts-dir) SCRIPTS_DIR="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --protenix-dir) PROTENIX_DIR="$2"; shift 2 ;;
    --protenix-ckpt|--checkpoint) PROTENIX_CKPT="$2"; shift 2 ;;
    --protenix-use-msa) PROTENIX_USE_MSA="$2"; shift 2 ;;
    --hmmer-home) HMMER_HOME="$2"; shift 2 ;;
    --pipeline-env) PIPELINE_ENV="$2"; shift 2 ;;
    --cann-set-env) CANN_SET_ENV="$2"; shift 2 ;;
    --target-pdb) TARGET_PDB="$2"; shift 2 ;;
    --framework-pdb) FRAMEWORK_PDB="$2"; shift 2 ;;
    --ckpt) RF_CKPT="$2"; shift 2 ;;
    --npus) NPUS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

RF_DIFFUSION_DIR="$APP_DIR/rf_diffusion"
PROTEINMPNN_DIR="$APP_DIR/proteinmpnn"
PROTENIX_DIR="${PROTENIX_DIR:-$APP_DIR/protenix}"
PROTENIX_CKPT="${PROTENIX_CKPT:-$PROTENIX_DIR/release_data/checkpoint/ms_model_v0.5.0.ckpt}"
if [[ -z "$HMMER_HOME" && -n "$PIPELINE_HOME" ]]; then
  HMMER_HOME="$PIPELINE_HOME/tools/hmmer"
fi
HMMER_HOME="${HMMER_HOME:-}"
RF_CKPT="${RF_CKPT:-$RF_DIFFUSION_DIR/models/RFdiffusion_Ab.ckpt}"

fail_count=0
warn_count=0

pass() { printf '[PASS] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; warn_count=$((warn_count + 1)); }
fail() { printf '[FAIL] %s\n' "$*"; fail_count=$((fail_count + 1)); }

source_pipeline_env() {
  require_no_host_pipeline_env
  if [[ -z "$PIPELINE_ENV" ]]; then
    return 0
  fi
  if [[ -f "$PIPELINE_ENV" ]]; then
    set +u
    # shellcheck disable=SC1090
    source "$PIPELINE_ENV" >/dev/null 2>&1 || warn "Pipeline env returned non-zero: $PIPELINE_ENV"
    set -u
    pass "Pipeline env loaded: $PIPELINE_ENV"
  else
    warn "Pipeline env not found: $PIPELINE_ENV"
  fi
}

check_dir() {
  local label="$1"
  local path="$2"
  if [[ -d "$path" ]]; then pass "$label: $path"; else fail "$label missing: $path"; fi
}

check_file() {
  local label="$1"
  local path="$2"
  if [[ -f "$path" ]]; then pass "$label: $path"; else fail "$label missing: $path"; fi
}

check_exe() {
  local label="$1"
  local path="$2"
  if [[ -x "$path" ]]; then pass "$label: $path"; else fail "$label missing or not executable: $path"; fi
}

truthy() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

echo "Antibody Protenix pipeline environment check"
echo "  APP_DIR          : $APP_DIR"
echo "  SCRIPTS_DIR      : $SCRIPTS_DIR"
echo "  PYTHON_BIN       : $PYTHON_BIN"
echo "  PROTENIX_DIR     : $PROTENIX_DIR"
echo "  PROTENIX_CKPT    : $PROTENIX_CKPT"
echo "  PROTENIX_USE_MSA : $PROTENIX_USE_MSA"
echo "  HMMER_HOME       : $HMMER_HOME"
echo "  PIPELINE_ENV     : $PIPELINE_ENV"
echo "  CANN_SET_ENV     : $CANN_SET_ENV"
echo "  NPUS             : $NPUS"

source_pipeline_env
PIPELINE_HOME="${ANTIBODY_PIPELINE_HOME:-$PIPELINE_HOME}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(resolve_python)"
  echo "  PYTHON_RESOLVED  : $PYTHON_BIN"
fi
require_managed_python

check_dir "MindSPONGE applications" "$APP_DIR"
check_dir "RFdiffusion dir" "$RF_DIFFUSION_DIR"
check_dir "ProteinMPNN dir" "$PROTEINMPNN_DIR"
check_dir "MindScience Protenix dir" "$PROTENIX_DIR"
check_dir "Helper scripts dir" "$SCRIPTS_DIR"
check_exe "Python" "$PYTHON_BIN"
check_file "RFdiffusion run_inference.py" "$RF_DIFFUSION_DIR/run_inference.py"
check_file "ProteinMPNN script" "$PROTEINMPNN_DIR/proteinmpnn_interface_design.py"
check_file "Protenix inference.py" "$PROTENIX_DIR/inference.py"
check_file "Protenix set_path.sh" "$PROTENIX_DIR/set_path.sh"
check_file "RFdiffusion checkpoint" "$RF_CKPT"
check_file "Protenix checkpoint" "$PROTENIX_CKPT"

for helper in run_full_antibody_pipeline.sh run_after_rfdiffusion.sh pdb_to_protenix_json.py screen_protenix_results.py; do
  check_file "Helper $helper" "$SCRIPTS_DIR/$helper"
done

if [[ -n "$TARGET_PDB" ]]; then check_file "Target antigen PDB" "$TARGET_PDB"; fi
if [[ -n "$FRAMEWORK_PDB" ]]; then check_file "Framework PDB" "$FRAMEWORK_PDB"; fi

if [[ -f "$CANN_SET_ENV" ]]; then
  set +u
  # shellcheck disable=SC1090
  if source "$CANN_SET_ENV" >/dev/null 2>&1; then
    pass "CANN set_env.sh sourced into current shell"
  else
    warn "CANN set_env.sh found but failed: $CANN_SET_ENV"
  fi
  set -u
else
  warn "CANN set_env.sh not found: $CANN_SET_ENV"
fi

if command -v npu-smi >/dev/null 2>&1; then
  pass "npu-smi found: $(command -v npu-smi)"
  npu-smi info >/dev/null 2>&1 && pass "npu-smi info works" || warn "npu-smi info failed"
else
  warn "npu-smi not found in PATH"
fi

if truthy "$PROTENIX_USE_MSA"; then
  if [[ -n "$HMMER_HOME" && -x "$HMMER_HOME/hmmscan" ]]; then
    pass "hmmscan found: $HMMER_HOME/hmmscan"
  elif [[ -n "$HMMER_HOME" && -x "$HMMER_HOME/bin/hmmscan" ]]; then
    pass "hmmscan found: $HMMER_HOME/bin/hmmscan"
  elif command -v hmmscan >/dev/null 2>&1; then
    pass "hmmscan found in PATH: $(command -v hmmscan)"
  else
    fail "hmmscan not found, but Protenix MSA is enabled."
  fi
else
  warn "Protenix MSA disabled; hmmscan is only needed for MSA-enabled runs."
fi

if [[ -x "$PYTHON_BIN" ]]; then
  "$PYTHON_BIN" - <<'PY'
import sys
print("python:", sys.version.replace("\n", " "))
print("exe:", sys.executable)
PY
  if (cd "$RF_DIFFUSION_DIR" && PYTHONPATH="$APP_DIR/../..:$RF_DIFFUSION_DIR:${PYTHONPATH:-}" "$PYTHON_BIN" - <<'PY'
import importlib
mods = ["sympy", "safetensors", "mindspore", "mindscience", "rfdiffusion"]
for mod in mods:
    importlib.import_module(mod)
print("RFdiffusion python imports ok")
PY
  ); then pass "RFdiffusion Python imports"; else fail "RFdiffusion Python imports failed"; fi

  if (cd "$PROTENIX_DIR" && PYTHONPATH="$APP_DIR/../..:$PROTENIX_DIR:${PYTHONPATH:-}" "$PYTHON_BIN" - <<'PY'
import importlib
mods = ["mindspore", "configs.configs_inference", "runner.batch_inference"]
for mod in mods:
    importlib.import_module(mod)
print("MindScience Protenix imports ok")
PY
  ); then pass "MindScience Protenix Python imports"; else fail "MindScience Protenix Python imports failed"; fi

fi

echo
echo "Summary: failures=$fail_count warnings=$warn_count"
if [[ "$fail_count" -gt 0 ]]; then
  exit 2
fi
exit 0
