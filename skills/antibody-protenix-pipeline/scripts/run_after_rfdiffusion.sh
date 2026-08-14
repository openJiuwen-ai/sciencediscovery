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

usage() {
  cat <<'EOF'
Usage:
  run_after_rfdiffusion.sh --run-dir RUN_DIR [options]

Continue the antibody pipeline from an existing RFdiffusion output directory:
  ProteinMPNN -> MindScience Protenix -> preliminary screening

Required:
  --run-dir DIR              Pipeline run directory containing 01_rfdiffusion.

Options:
  --rf-dir DIR               RFdiffusion output directory. Default: RUN_DIR/01_rfdiffusion
  --target-pdb PDB           Original target antigen PDB for hotspot residue mapping. Required.
  --num-designs N            Expected design count. Default: 200
  --app-dir DIR              MindSPONGE applications directory. Default: MINDSCIENCE_APP_DIR or derived from ANTIBODY_PIPELINE_HOME
  --scripts-dir DIR          Directory containing helper scripts. Auto-detected if incomplete.
  --python PYTHON            Python executable from a ScienceDiscovery scientific-env revision. Required
  --npus LIST                Ascend physical device list. Protenix runs one concurrent inference per listed device. Default: 0,1,2,3,4,5,6,7
  --protenix-dir DIR         MindScience Protenix application directory. Default: APP_DIR/protenix or PROTENIX_APP_DIR
  --protenix-ckpt FILE       Protenix checkpoint. Default: PROTENIX_CKPT or PROTENIX_DIR/release_data/checkpoint/ms_model_v0.5.0.ckpt
  --protenix-use-msa BOOL    Pass through to inference.py --use_msa. Default: PROTENIX_USE_MSA or false
  --protenix-n-sample N      Pass through to inference.py --n_sample. Default: PROTENIX_N_SAMPLE or 1
  --protenix-seeds LIST      Pass through to inference.py --seeds. Default: PROTENIX_SEEDS or 42
  --hmmer-home DIR           HMMER home for Protenix MSA. Default: HMMER_HOME or ANTIBODY_PIPELINE_HOME/tools/hmmer
  --pipeline-env FILE        Optional extra env file. Disabled by default in ScienceDiscovery managed-env mode; do not use host env.sh
  --cann-set-env FILE        Ascend toolkit set_env.sh. Default: CANN_SET_ENV or /usr/local/Ascend/ascend-toolkit/set_env.sh
  --hotspots LIST            Chain-labelled target residues to screen. Required.
  --force                    Remove downstream output directories before running.
  -h, --help                 Show this help.

Outputs under RUN_DIR:
  02_proteinmpnn
  03_protenix_input_json
  04_protenix_output
  05_screening
EOF
}

SELF_SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
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
  if truthy_env "${ANTIBODY_REQUIRE_SCIENCEAGENT_ENV:-1}"; then
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
  if truthy_env "${ANTIBODY_REQUIRE_SCIENCEAGENT_ENV:-1}" && [[ -n "${PIPELINE_ENV:-}" ]]; then
    echo "error: refusing --pipeline-env in ScienceDiscovery managed-env mode: $PIPELINE_ENV" >&2
    echo "       do not source host env.sh; install Python deps into the ScienceDiscovery scientific environment" >&2
    exit 2
  fi
}

PYTHON_BIN="$(resolve_python)"
RUN_DIR=""
RF_DIR=""
TARGET_PDB=""
NUM_DESIGNS=200
NPUS="0,1,2,3,4,5,6,7"
PROTENIX_DIR="${PROTENIX_APP_DIR:-}"
PROTENIX_CKPT="${PROTENIX_CKPT:-}"
PROTENIX_USE_MSA="${PROTENIX_USE_MSA:-false}"
PROTENIX_N_SAMPLE="${PROTENIX_N_SAMPLE:-1}"
PROTENIX_SEEDS="${PROTENIX_SEEDS:-42}"
HMMER_HOME="${HMMER_HOME:-}"
CANN_SET_ENV="${CANN_SET_ENV:-/usr/local/Ascend/ascend-toolkit/set_env.sh}"
PIPELINE_ENV="${ANTIBODY_PIPELINE_ENV:-}"
# ScienceDiscovery managed-env mode does not auto-source host pipeline env.sh.
HOTSPOTS=""
FORCE=0
: "${ASCEND_DEVICE_ENV:=ASCEND_RT_VISIBLE_DEVICES}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --rf-dir) RF_DIR="$2"; shift 2 ;;
    --target-pdb) TARGET_PDB="$2"; shift 2 ;;
    --num-designs) NUM_DESIGNS="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --scripts-dir) SCRIPTS_DIR="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --npus) NPUS="$2"; shift 2 ;;
    --protenix-dir) PROTENIX_DIR="$2"; shift 2 ;;
    --protenix-ckpt|--checkpoint) PROTENIX_CKPT="$2"; shift 2 ;;
    --protenix-use-msa) PROTENIX_USE_MSA="$2"; shift 2 ;;
    --protenix-n-sample) PROTENIX_N_SAMPLE="$2"; shift 2 ;;
    --protenix-seeds) PROTENIX_SEEDS="$2"; shift 2 ;;
    --hmmer-home) HMMER_HOME="$2"; shift 2 ;;
    --pipeline-env) PIPELINE_ENV="$2"; shift 2 ;;
    --cann-set-env) CANN_SET_ENV="$2"; shift 2 ;;
    --hotspots) HOTSPOTS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) readlink -m "$PWD/$1" ;;
  esac
}

if [[ -z "$RUN_DIR" ]]; then
  echo "error: --run-dir is required" >&2
  usage >&2
  exit 2
fi
if ! [[ "$NUM_DESIGNS" =~ ^[0-9]+$ ]] || [[ "$NUM_DESIGNS" -lt 1 ]]; then
  echo "error: --num-designs must be a positive integer" >&2
  exit 2
fi
if ! [[ "$PROTENIX_N_SAMPLE" =~ ^[0-9]+$ ]] || [[ "$PROTENIX_N_SAMPLE" -lt 1 ]]; then
  echo "error: --protenix-n-sample must be a positive integer" >&2
  exit 2
fi
if [[ -z "$HOTSPOTS" ]]; then
  echo "error: --hotspots is required; ask the user for chain-labelled target residues such as [B45,B46,B49]" >&2
  exit 2
fi

RUN_DIR="$(abs_path "${RUN_DIR%/}")"
RF_DIR="$(abs_path "${RF_DIR:-$RUN_DIR/01_rfdiffusion}")"
if [[ -n "$TARGET_PDB" ]]; then
  TARGET_PDB="$(abs_path "$TARGET_PDB")"
fi
SCRIPTS_DIR="$(abs_path "$SCRIPTS_DIR")"
PROTEINMPNN_DIR="$APP_DIR/proteinmpnn"
PROTENIX_DIR="${PROTENIX_DIR:-$APP_DIR/protenix}"
PROTENIX_CKPT="${PROTENIX_CKPT:-$PROTENIX_DIR/release_data/checkpoint/ms_model_v0.5.0.ckpt}"
if [[ -z "$HMMER_HOME" && -n "$PIPELINE_HOME" ]]; then
  HMMER_HOME="$PIPELINE_HOME/tools/hmmer"
fi
HMMER_HOME="${HMMER_HOME:-}"
if [[ ! -f "$TARGET_PDB" ]]; then
  echo "error: --target-pdb is required and must exist for hotspot mapping: $TARGET_PDB" >&2
  exit 2
fi

require_no_host_pipeline_env
if [[ -n "$PIPELINE_ENV" && -f "$PIPELINE_ENV" ]]; then
  set +u
  # shellcheck disable=SC1090
  source "$PIPELINE_ENV" >/dev/null 2>&1 || echo "warning: pipeline env returned non-zero: $PIPELINE_ENV" >&2
  set -u
fi
PIPELINE_HOME="${ANTIBODY_PIPELINE_HOME:-$PIPELINE_HOME}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(resolve_python)"
fi
require_managed_python

MPNN_OUT="$RUN_DIR/02_proteinmpnn"
PROTENIX_INPUT_DIR="$RUN_DIR/03_protenix_input_json"
PROTENIX_OUTPUT_DIR="$RUN_DIR/04_protenix_output"
SCREEN_DIR="$RUN_DIR/05_screening"
LOG_DIR="$RUN_DIR/logs"

count_files() {
  local dir="$1"
  local pattern="$2"
  if [[ ! -d "$dir" ]]; then
    echo 0
    return
  fi
  find "$dir" -type f -name "$pattern" | wc -l
}

count_top_files() {
  local dir="$1"
  local pattern="$2"
  if [[ ! -d "$dir" ]]; then
    echo 0
    return
  fi
  find "$dir" -maxdepth 1 -type f -name "$pattern" | wc -l
}

count_protenix_input_json() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo 0
    return
  fi
  find "$dir" -maxdepth 1 -type f -name "*.json" ! -name "*.chain_map.json" | wc -l
}

reset_dir() {
  local dir="$1"
  case "$dir" in
    "$RUN_DIR"/*) ;;
    *) echo "error: refusing to remove path outside run dir: $dir" >&2; exit 2 ;;
  esac
  if [[ "$FORCE" == "1" && -e "$dir" ]]; then
    rm -rf "$dir"
  fi
}

require_count() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" -ne "$expected" ]]; then
    echo "error: $label count is $actual, expected $expected" >&2
    exit 1
  fi
}

require_min_count() {
  local label="$1"
  local actual="$2"
  local minimum="$3"
  if [[ "$actual" -lt "$minimum" ]]; then
    echo "error: $label count is $actual, expected at least $minimum" >&2
    exit 1
  fi
}

helper_candidates() {
  printf '%s\n' \
    "$SCRIPTS_DIR" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
}

find_helper() {
  local name="$1"
  local candidate
  while IFS= read -r candidate; do
    if [[ -n "$candidate" && -f "$candidate/$name" ]]; then
      printf '%s\n' "$candidate/$name"
      return 0
    fi
  done < <(helper_candidates)

  echo "error: cannot find helper script: $name" >&2
  echo "       searched these directories:" >&2
  helper_candidates | sed 's/^/       - /' >&2
  exit 2
}

resolve_scripts_dir() {
  local script_path
  script_path="$(find_helper pdb_to_protenix_json.py)"
  SCRIPTS_DIR="$(cd "$(dirname "$script_path")" && pwd)"
  echo "[info] primary helper scripts dir: $SCRIPTS_DIR"
}

run_logged() {
  local name="$1"
  shift
  local log="$LOG_DIR/${name}.log"
  echo "[$(date '+%F %T')] $name"
  echo "  log: $log"
  if ! "$@" >"$log" 2>&1; then
    echo "error: stage $name failed; log: $log" >&2
    echo "--- ${name}.log tail ---" >&2
    tail -n 80 "$log" >&2 || true
    return 1
  fi
}

run_proteinmpnn_inline() (
  source_cann_env
  cd "$PROTEINMPNN_DIR"
  "$PYTHON_BIN" proteinmpnn_interface_design.py -pdbdir "$RF_DIR" -outpdbdir "$MPNN_OUT"
)

source_cann_env() {
  if [[ -f "$CANN_SET_ENV" ]]; then
    set +u
    # shellcheck disable=SC1090
    source "$CANN_SET_ENV" >/dev/null 2>&1 || echo "warning: CANN set_env.sh returned non-zero: $CANN_SET_ENV" >&2
    set -u
  else
    echo "warning: CANN set_env.sh not found: $CANN_SET_ENV" >&2
  fi
}

run_protenix_inline() (
  local json_dir="$1"
  local output_dir="$2"
  local inference_script="$PROTENIX_DIR/inference.py"

  source_cann_env
  if [[ ! -d "$json_dir" ]]; then
    echo "error: Protenix JSON directory does not exist: $json_dir" >&2
    exit 2
  fi
  if [[ ! -f "$inference_script" ]]; then
    echo "error: Protenix inference script not found: $inference_script" >&2
    exit 2
  fi
  if [[ ! -f "$PROTENIX_CKPT" ]]; then
    echo "error: Protenix checkpoint not found: $PROTENIX_CKPT" >&2
    exit 2
  fi
  if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "error: Python executable not found or not executable: $PYTHON_BIN" >&2
    exit 2
  fi

  cd "$PROTENIX_DIR"
  if [[ -f "$PROTENIX_DIR/set_path.sh" ]]; then
    # shellcheck disable=SC1090
    source "$PROTENIX_DIR/set_path.sh"
  fi
  export PYTHONPATH="$PROTENIX_DIR:$APP_DIR/../..:${PYTHONPATH:-}"
  export PYTHONNOUSERSITE=1
  if [[ -n "$HMMER_HOME" ]]; then
    export PATH="$HMMER_HOME:$HMMER_HOME/bin:$PATH"
  fi

  mapfile -d '' JSON_FILES < <(find "$json_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.chain_map.json' -print0 | sort -z)
  if (( ${#JSON_FILES[@]} == 0 )); then
    echo "error: no Protenix .json files found in $json_dir" >&2
    exit 1
  fi

  IFS=',' read -r -a NPU_LIST <<< "$NPUS"
  if (( ${#NPU_LIST[@]} == 0 )); then
    echo "error: NPUS is empty" >&2
    exit 2
  fi
  local log_dir="$output_dir/logs"
  mkdir -p "$output_dir" "$log_dir"

  echo "RUN_AFTER_INLINE_PROTENIX : 1"
  echo "Self script              : $SELF_SCRIPT"
  echo "JSON files               : ${#JSON_FILES[@]}"
  echo "NPUs                     : $NPUS"
  echo "Max concurrent Protenix  : ${#NPU_LIST[@]}"
  echo "Device env               : $ASCEND_DEVICE_ENV"
  echo "Python                   : $PYTHON_BIN"
  echo "Protenix dir             : $PROTENIX_DIR"
  echo "Checkpoint               : $PROTENIX_CKPT"
  echo "Output dir               : $output_dir"
  echo "Log dir                  : $log_dir"
  echo "Use MSA                  : $PROTENIX_USE_MSA"
  echo "n_sample                 : $PROTENIX_N_SAMPLE"
  echo "seeds                    : $PROTENIX_SEEDS"
  echo "PYTHONPATH               : $PYTHONPATH"

  local first_npu="${NPU_LIST[0]}"
  local -a device_env
  if [[ "$ASCEND_DEVICE_ENV" == "DEVICE_ID" ]]; then
    device_env=(DEVICE_ID="$first_npu")
  else
    device_env=("$ASCEND_DEVICE_ENV=$first_npu" DEVICE_ID=0)
  fi

  env "${device_env[@]}" PYTHONPATH="$PYTHONPATH" PYTHONNOUSERSITE=1 "$PYTHON_BIN" - <<'PY'
import importlib
import sys
for mod in ("mindspore", "configs.configs_inference", "runner.batch_inference"):
    importlib.import_module(mod)
print("python:", sys.version.split()[0])
print("exe:", sys.executable)
print("Protenix import check ok")
PY

  local compat_script="$SCRIPTS_DIR/protenix_py312_compat.py"
  local -a protenix_entrypoint
  if [[ -f "$compat_script" ]]; then
    echo "Python 3.12 compat wrapper : $compat_script"
    protenix_entrypoint=("$PYTHON_BIN" "$compat_script" "$inference_script")
  else
    protenix_entrypoint=("$PYTHON_BIN" "$inference_script")
  fi

  run_one_protenix_json() (
    local json_path="$1"
    local npu="$2"
    local log_path="$3"
    local -a per_job_device_env
    if [[ "$ASCEND_DEVICE_ENV" == "DEVICE_ID" ]]; then
      per_job_device_env=(DEVICE_ID="$npu")
    else
      per_job_device_env=("$ASCEND_DEVICE_ENV=$npu" DEVICE_ID=0)
    fi
    env "${per_job_device_env[@]}" PYTHONPATH="$PYTHONPATH" PYTHONNOUSERSITE=1 "${protenix_entrypoint[@]}" \
      --seeds "$PROTENIX_SEEDS" \
      --dump_dir "$output_dir" \
      --input_json_path "$json_path" \
      --use_msa "$PROTENIX_USE_MSA" \
      --n_sample "$PROTENIX_N_SAMPLE" \
      --load_checkpoint_path "$PROTENIX_CKPT" \
      >"$log_path" 2>&1
  )

  local json_path name log_path npu pid fail total_json completed skipped
  local -a pids=()
  local -a pid_names=()
  local -a failed_names=()
  local launched=0
  local max_parallel="${#NPU_LIST[@]}"
  total_json="${#JSON_FILES[@]}"
  completed=0
  skipped=0
  fail=0

  report_protenix_failures() {
    local failed_csv
    skipped=$((total_json - launched))
    failed_csv="$(IFS=,; echo "${failed_names[*]}")"
    if [[ -z "$failed_csv" ]]; then
      failed_csv="unknown"
    fi
    echo "error: Protenix jobs failed: $failed_csv; launched $launched/$total_json, completed $completed, skipped $skipped; inspect $log_dir" >&2
  }

  for json_path in "${JSON_FILES[@]}"; do
    name="$(basename "${json_path%.json}")"
    log_path="$log_dir/${name}.log"
    npu="${NPU_LIST[$((launched % max_parallel))]}"
    echo "[protenix] launch name=$name npu=$npu log=$log_path"
    run_one_protenix_json "$json_path" "$npu" "$log_path" &
    pids+=("$!")
    pid_names+=("$name")
    launched=$((launched + 1))

    if (( ${#pids[@]} >= max_parallel )); then
      for i in "${!pids[@]}"; do
        pid="${pids[$i]}"
        if ! wait "$pid"; then
          fail=1
          failed_names+=("${pid_names[$i]}")
        else
          completed=$((completed + 1))
        fi
      done
      pids=()
      pid_names=()
      if [[ "$fail" -ne 0 ]]; then
        report_protenix_failures
        exit 1
      fi
    fi
  done
  for i in "${!pids[@]}"; do
    pid="${pids[$i]}"
    if ! wait "$pid"; then
      fail=1
      failed_names+=("${pid_names[$i]}")
    else
      completed=$((completed + 1))
    fi
  done
  if [[ "$fail" -ne 0 ]]; then
    report_protenix_failures
    exit 1
  fi

  echo "All Protenix jobs finished successfully: completed $completed/$total_json."
)

mkdir -p "$LOG_DIR"
export CANN_SET_ENV
resolve_scripts_dir
source_cann_env

echo "Continue antibody pipeline after RFdiffusion"
echo "  SELF_SCRIPT        : $SELF_SCRIPT"
echo "  RUN_DIR            : $RUN_DIR"
echo "  APP_DIR            : $APP_DIR"
echo "  SCRIPTS_DIR        : $SCRIPTS_DIR"
echo "  RF_DIR             : $RF_DIR"
echo "  NUM_DESIGNS        : $NUM_DESIGNS"
echo "  PROTEINMPNN_OUT    : $MPNN_OUT"
echo "  PROTENIX_INPUT_DIR : $PROTENIX_INPUT_DIR"
echo "  PROTENIX_OUTPUT_DIR: $PROTENIX_OUTPUT_DIR"
echo "  SCREEN_DIR         : $SCREEN_DIR"
echo "  PROTENIX_DIR       : $PROTENIX_DIR"
echo "  PROTENIX_CKPT      : $PROTENIX_CKPT"
echo "  PROTENIX_USE_MSA   : $PROTENIX_USE_MSA"
echo "  PROTENIX_N_SAMPLE  : $PROTENIX_N_SAMPLE"
echo "  PROTENIX_SEEDS     : $PROTENIX_SEEDS"
echo "  NPUS               : $NPUS"
echo "  TARGET_PDB         : $TARGET_PDB"
echo "  HOTSPOTS           : $HOTSPOTS"
echo "  FORCE              : $FORCE"

rf_count=$(count_top_files "$RF_DIR" "output_*.pdb")
require_count "RFdiffusion top-level PDB" "$rf_count" "$NUM_DESIGNS"

if [[ "$FORCE" == "1" ]]; then
  echo "[force] rebuilding ProteinMPNN, Protenix input, Protenix output, and screening outputs"
  reset_dir "$MPNN_OUT"
  reset_dir "$PROTENIX_INPUT_DIR"
  reset_dir "$PROTENIX_OUTPUT_DIR"
  reset_dir "$SCREEN_DIR"
fi

mpnn_count=$(count_files "$MPNN_OUT" "*.pdb")
if [[ "$mpnn_count" -eq "$NUM_DESIGNS" ]]; then
  echo "[skip] proteinmpnn already has $mpnn_count PDB files"
else
  if [[ "$mpnn_count" -ne 0 && "$FORCE" != "1" ]]; then
    echo "error: ProteinMPNN output has $mpnn_count PDB files, expected $NUM_DESIGNS; rerun with --force to rebuild downstream outputs" >&2
    exit 1
  fi
  reset_dir "$MPNN_OUT"
  mkdir -p "$MPNN_OUT"
  run_logged proteinmpnn run_proteinmpnn_inline
  mpnn_count=$(count_files "$MPNN_OUT" "*.pdb")
  require_count "ProteinMPNN PDB" "$mpnn_count" "$NUM_DESIGNS"
fi

json_count=$(count_protenix_input_json "$PROTENIX_INPUT_DIR")
if [[ "$json_count" -eq "$NUM_DESIGNS" ]]; then
  echo "[skip] pdb_to_protenix_json already has $json_count JSON files"
else
  if [[ "$json_count" -ne 0 && "$FORCE" != "1" ]]; then
    echo "error: Protenix JSON input has $json_count files, expected $NUM_DESIGNS; rerun with --force to rebuild downstream outputs" >&2
    exit 1
  fi
  reset_dir "$PROTENIX_INPUT_DIR"
  mkdir -p "$PROTENIX_INPUT_DIR"
  run_logged pdb_to_protenix_json "$PYTHON_BIN" "$(find_helper pdb_to_protenix_json.py)" "$MPNN_OUT" -o "$PROTENIX_INPUT_DIR"
  json_count=$(count_protenix_input_json "$PROTENIX_INPUT_DIR")
  require_count "Protenix JSON" "$json_count" "$NUM_DESIGNS"
fi

protenix_count=$(count_files "$PROTENIX_OUTPUT_DIR" "*summary_confidence_sample_*.json")
if [[ "$protenix_count" -ge "$NUM_DESIGNS" ]]; then
  echo "[skip] Protenix already has $protenix_count confidence JSON files"
else
  if [[ "$protenix_count" -ne 0 && "$FORCE" != "1" ]]; then
    echo "error: Protenix output has $protenix_count confidence files, expected at least $NUM_DESIGNS; rerun with --force to rebuild Protenix and screening outputs" >&2
    exit 1
  fi
  reset_dir "$PROTENIX_OUTPUT_DIR"
  mkdir -p "$PROTENIX_OUTPUT_DIR"
  run_logged protenix run_protenix_inline "$PROTENIX_INPUT_DIR" "$PROTENIX_OUTPUT_DIR"
  protenix_count=$(count_files "$PROTENIX_OUTPUT_DIR" "*summary_confidence_sample_*.json")
  require_min_count "Protenix confidence JSON" "$protenix_count" "$NUM_DESIGNS"
fi

reset_dir "$SCREEN_DIR"
mkdir -p "$SCREEN_DIR"
run_logged screen_protenix "$PYTHON_BIN" "$(find_helper screen_protenix_results.py)" \
  --protenix-root "$PROTENIX_OUTPUT_DIR" \
  --out-dir "$SCREEN_DIR" \
  --target-pdb "$TARGET_PDB" \
  --hotspots "$HOTSPOTS"

echo
echo "Done."
echo "Reports:"
echo "  $SCREEN_DIR/protenix_screening_report.md"
