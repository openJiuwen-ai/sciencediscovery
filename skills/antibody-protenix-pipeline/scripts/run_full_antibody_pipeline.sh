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
  run_full_antibody_pipeline.sh [options]

Run the full antibody design pipeline:
  RFdiffusion -> ProteinMPNN -> MindScience Protenix -> preliminary screening

The target antigen PDB, antibody framework PDB, and hotspot list are explicit
scientific inputs. This script never falls back to bundled example PDB files.

Options:
  --run-dir DIR              Pipeline run directory. Default: APP_DIR/pipeline_runs/antibody_protenix_<N>_<timestamp>
  --num-designs N            Total designs to generate. Default: 600
  --app-dir DIR              MindSPONGE applications directory. Default: MINDSCIENCE_APP_DIR or derived from ANTIBODY_PIPELINE_HOME
  --scripts-dir DIR          Helper scripts directory. Default: directory containing this script
  --python PYTHON            Python executable from a ScienceDiscovery scientific-env revision. Required
  --npus LIST                Ascend physical device list. Default: 0,1,2,3,4,5,6,7
  --workers-per-npu N        RFdiffusion workers per NPU. Default: 2
  --target-pdb PDB           Target antigen PDB. Required.
  --framework-pdb PDB        Antibody framework PDB. Required.
  --ckpt PATH                RFdiffusion checkpoint path.
  --hotspots LIST            RFdiffusion hotspot list using target-PDB chain labels. Required.
  --design-loops LIST        RFdiffusion design loops. Default: [H1:8,H2:6,H3:16]
  --final-step N             RFdiffusion inference.final_step. Default: 160
  --diffuser-t N             RFdiffusion diffuser.T. Default: 200
  --protenix-dir DIR         MindScience Protenix application directory. Default: APP_DIR/protenix or PROTENIX_APP_DIR
  --protenix-ckpt FILE       Protenix checkpoint. Default: PROTENIX_CKPT or PROTENIX_DIR/release_data/checkpoint/ms_model_v0.5.0.ckpt
  --protenix-use-msa BOOL    Pass through to inference.py --use_msa. Default: PROTENIX_USE_MSA or false
  --protenix-n-sample N      Pass through to inference.py --n_sample. Default: PROTENIX_N_SAMPLE or 1
  --protenix-seeds LIST      Pass through to inference.py --seeds. Default: PROTENIX_SEEDS or 42
  --hmmer-home DIR           HMMER home for Protenix MSA. Default: HMMER_HOME or ANTIBODY_PIPELINE_HOME/tools/hmmer
  --pipeline-env FILE        Optional extra env file. Disabled by default in ScienceDiscovery managed-env mode; do not use host env.sh
  --cann-set-env FILE        Ascend toolkit set_env.sh. Default: CANN_SET_ENV or /usr/local/Ascend/ascend-toolkit/set_env.sh
  --force                    Remove existing pipeline outputs under --run-dir before rebuilding.
  -h, --help                 Show this help.
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
NUM_DESIGNS=600
NPUS="0,1,2,3,4,5,6,7"
WORKERS_PER_NPU=2
TARGET_PDB=""
FRAMEWORK_PDB=""
RF_CKPT="./models/RFdiffusion_Ab.ckpt"
HOTSPOTS=""
DESIGN_LOOPS="[H1:8,H2:6,H3:16]"
FINAL_STEP=160
DIFFUSER_T=200
PROTENIX_DIR="${PROTENIX_APP_DIR:-}"
PROTENIX_CKPT="${PROTENIX_CKPT:-}"
PROTENIX_USE_MSA="${PROTENIX_USE_MSA:-false}"
PROTENIX_N_SAMPLE="${PROTENIX_N_SAMPLE:-1}"
PROTENIX_SEEDS="${PROTENIX_SEEDS:-42}"
HMMER_HOME="${HMMER_HOME:-}"
CANN_SET_ENV="${CANN_SET_ENV:-/usr/local/Ascend/ascend-toolkit/set_env.sh}"
PIPELINE_ENV="${ANTIBODY_PIPELINE_ENV:-}"
FORCE=0
# ScienceDiscovery managed-env mode does not auto-source host pipeline env.sh.

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --num-designs) NUM_DESIGNS="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --scripts-dir) SCRIPTS_DIR="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --npus) NPUS="$2"; shift 2 ;;
    --workers-per-npu) WORKERS_PER_NPU="$2"; shift 2 ;;
    --target-pdb) TARGET_PDB="$2"; shift 2 ;;
    --framework-pdb) FRAMEWORK_PDB="$2"; shift 2 ;;
    --ckpt) RF_CKPT="$2"; shift 2 ;;
    --hotspots) HOTSPOTS="$2"; shift 2 ;;
    --design-loops) DESIGN_LOOPS="$2"; shift 2 ;;
    --final-step) FINAL_STEP="$2"; shift 2 ;;
    --diffuser-t) DIFFUSER_T="$2"; shift 2 ;;
    --protenix-dir) PROTENIX_DIR="$2"; shift 2 ;;
    --protenix-ckpt|--checkpoint) PROTENIX_CKPT="$2"; shift 2 ;;
    --protenix-use-msa) PROTENIX_USE_MSA="$2"; shift 2 ;;
    --protenix-n-sample) PROTENIX_N_SAMPLE="$2"; shift 2 ;;
    --protenix-seeds) PROTENIX_SEEDS="$2"; shift 2 ;;
    --hmmer-home) HMMER_HOME="$2"; shift 2 ;;
    --pipeline-env) PIPELINE_ENV="$2"; shift 2 ;;
    --cann-set-env) CANN_SET_ENV="$2"; shift 2 ;;
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

if ! [[ "$NUM_DESIGNS" =~ ^[0-9]+$ ]] || [[ "$NUM_DESIGNS" -lt 1 ]]; then
  echo "error: --num-designs must be a positive integer" >&2
  exit 2
fi

RF_DIFFUSION_DIR="$APP_DIR/rf_diffusion"
PROTENIX_DIR="${PROTENIX_DIR:-$APP_DIR/protenix}"
PROTENIX_CKPT="${PROTENIX_CKPT:-$PROTENIX_DIR/release_data/checkpoint/ms_model_v0.5.0.ckpt}"
if [[ -z "$TARGET_PDB" ]]; then
  echo "error: --target-pdb is required; ask the user to provide a workspace-local antigen PDB" >&2
  exit 2
fi
if [[ -z "$FRAMEWORK_PDB" ]]; then
  echo "error: --framework-pdb is required; ask the user to provide a workspace-local antibody framework PDB" >&2
  exit 2
fi
if [[ -z "$HOTSPOTS" ]]; then
  echo "error: --hotspots is required; ask the user for chain-labelled target residues such as [B45,B46,B49]" >&2
  exit 2
fi
TARGET_PDB="$(abs_path "$TARGET_PDB")"
FRAMEWORK_PDB="$(abs_path "$FRAMEWORK_PDB")"
RF_CKPT="$(abs_path "$RF_CKPT")"
if [[ -z "$HMMER_HOME" && -n "$PIPELINE_HOME" ]]; then
  HMMER_HOME="$PIPELINE_HOME/tools/hmmer"
fi
HMMER_HOME="${HMMER_HOME:-}"

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

if [[ -z "$RUN_DIR" ]]; then
  RUN_DIR="$APP_DIR/pipeline_runs/antibody_protenix_${NUM_DESIGNS}_$(date +%Y%m%d_%H%M%S)"
fi
RUN_DIR="$(abs_path "${RUN_DIR%/}")"
SCRIPTS_DIR="$(abs_path "$SCRIPTS_DIR")"
RF_OUT="$RUN_DIR/01_rfdiffusion"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$RF_OUT" "$LOG_DIR"

AFTER_SCRIPT="$SCRIPTS_DIR/run_after_rfdiffusion.sh"
if [[ ! -f "$AFTER_SCRIPT" ]]; then
  echo "error: missing downstream wrapper: $AFTER_SCRIPT" >&2
  exit 2
fi

count_top_pdbs() {
  find "$RF_OUT" -maxdepth 1 -type f -name "output_*.pdb" | wc -l
}

run_rfdiffusion_inline() {
  local out_dir="$1"
  local total_designs="$2"
  local shard_root="${out_dir}_shards"
  local ascend_device_env="${ASCEND_DEVICE_ENV:-ASCEND_RT_VISIBLE_DEVICES}"
  local rfdiffusion_script="run_inference.py"

  IFS=',' read -r -a npu_array <<< "$NPUS"
  if [[ "${#npu_array[@]}" -lt 1 ]]; then
    echo "error: NPUS is empty" >&2
    exit 2
  fi
  if ! [[ "$WORKERS_PER_NPU" =~ ^[0-9]+$ ]] || [[ "$WORKERS_PER_NPU" -lt 1 ]]; then
    echo "error: WORKERS_PER_NPU must be a positive integer" >&2
    exit 2
  fi

  mkdir -p "$out_dir/logs" "$shard_root"
  export PYTHONPATH="$APP_DIR/../..:$RF_DIFFUSION_DIR/env:${PYTHONPATH:-}"

  local total_workers=$((${#npu_array[@]} * WORKERS_PER_NPU))
  if [[ "$total_workers" -gt "$total_designs" ]]; then
    total_workers="$total_designs"
  fi

  echo "RFdiffusion inline parallel settings"
  echo "  RF_DIFFUSION_DIR : $RF_DIFFUSION_DIR"
  echo "  OUT_DIR          : $out_dir"
  echo "  TOTAL_DESIGNS    : $total_designs"
  echo "  NPUS             : $NPUS"
  echo "  WORKERS_PER_NPU  : $WORKERS_PER_NPU"
  echo "  TOTAL_WORKERS    : $total_workers"
  echo "  PYTHON_BIN       : $PYTHON_BIN"
  echo "  SHARD_ROOT       : $shard_root"
  echo "  TARGET_PDB       : $TARGET_PDB"
  echo "  FRAMEWORK_PDB    : $FRAMEWORK_PDB"
  echo "  RF_CKPT          : $RF_CKPT"
  echo "  HOTSPOTS         : $HOTSPOTS"
  echo "  DESIGN_LOOPS     : $DESIGN_LOOPS"
  echo "  FINAL_STEP       : $FINAL_STEP"
  echo "  DIFFUSER_T       : $DIFFUSER_T"

  cd "$RF_DIFFUSION_DIR"

  local pids=()
  local worker=0
  local remaining="$total_designs"
  local npu slot workers_left shard_count shard_dir shard_prefix log_path

  for npu in "${npu_array[@]}"; do
    for slot in $(seq 1 "$WORKERS_PER_NPU"); do
      if [[ "$worker" -ge "$total_workers" ]]; then
        break 2
      fi
      workers_left=$((total_workers - worker))
      shard_count=$(((remaining + workers_left - 1) / workers_left))
      shard_dir="$shard_root/shard_$(printf "%03d" "$worker")"
      shard_prefix="$shard_dir/output"
      log_path="$out_dir/logs/rfdiffusion_shard_$(printf "%03d" "$worker")_npu${npu}.log"
      mkdir -p "$shard_dir"

      echo "[launch] worker=$worker npu=$npu designs=$shard_count log=$log_path"
      (
        export "$ascend_device_env=$npu"
        if [[ "$ascend_device_env" == "DEVICE_ID" ]]; then
          export DEVICE_ID="$npu"
        else
          export DEVICE_ID="0"
        fi
        "$PYTHON_BIN" "$rfdiffusion_script" \
          --config-name antibody \
          "inference.output_prefix=$shard_prefix" \
          "inference.num_designs=$shard_count" \
          "inference.ckpt_override_path=$RF_CKPT" \
          "antibody.target_pdb=$TARGET_PDB" \
          "antibody.framework_pdb=$FRAMEWORK_PDB" \
          "ppi.hotspot_res=$HOTSPOTS" \
          "antibody.design_loops=$DESIGN_LOOPS" \
          "inference.final_step=$FINAL_STEP" \
          "diffuser.T=$DIFFUSER_T"
      ) >"$log_path" 2>&1 &
      pids+=("$!")

      worker=$((worker + 1))
      remaining=$((remaining - shard_count))
    done
  done

  local fail=0
  local pid
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      fail=1
    fi
  done
  if [[ "$fail" -ne 0 ]]; then
    echo "error: one or more RFdiffusion shards failed; inspect $out_dir/logs" >&2
    exit 1
  fi

  local idx=0
  local pdb base trb new_base
  while IFS= read -r -d '' pdb; do
    base="${pdb%.pdb}"
    trb="${base}.trb"
    new_base="$out_dir/output_$(printf "%06d" "$idx")"
    cp "$pdb" "${new_base}.pdb"
    if [[ -f "$trb" ]]; then
      cp "$trb" "${new_base}.trb"
    fi
    idx=$((idx + 1))
  done < <(find "$shard_root" -mindepth 2 -maxdepth 2 -type f -name "output_*.pdb" -print0 | sort -z)

  if [[ "$idx" -ne "$total_designs" ]]; then
    echo "error: collected $idx PDB files, expected $total_designs" >&2
    exit 1
  fi
  echo "Collected $idx RFdiffusion designs into $out_dir"
}


write_artifact_manifest() {
  local pipeline_workspace
  local manifest
  pipeline_workspace="$(dirname "$(dirname "$RUN_DIR")")"
  manifest="$pipeline_workspace/artifact_manifest.txt"
  mkdir -p "$pipeline_workspace"
  : >"$manifest"

  add_file() {
    local path="$1"
    if [[ -f "$path" ]]; then
      realpath --relative-to="$pipeline_workspace" "$path" >>"$manifest"
    fi
  }

  add_tree() {
    local dir="$1"
    local pattern="$2"
    if [[ -d "$dir" ]]; then
      find "$dir" -type f -name "$pattern" -print0 | sort -z | while IFS= read -r -d '' path; do
        realpath --relative-to="$pipeline_workspace" "$path" >>"$manifest"
      done
    fi
  }

  add_file "$RUN_DIR/05_screening/protenix_screening_report.md"
  add_file "$RUN_DIR/05_screening/protenix_screening_summary.csv"
  add_tree "$RUN_DIR/04_protenix_output" "*.cif"

  sort -u "$manifest" -o "$manifest"
  echo "Artifact manifest: $manifest"
  echo "Artifact count: $(wc -l < "$manifest")"
}

start_ts=$(date +%s)

echo "Full antibody Protenix pipeline"
echo "  RUN_DIR            : $RUN_DIR"
echo "  NUM_DESIGNS        : $NUM_DESIGNS"
echo "  APP_DIR            : $APP_DIR"
echo "  SCRIPTS_DIR        : $SCRIPTS_DIR"
echo "  PYTHON_BIN         : $PYTHON_BIN"
echo "  NPUS               : $NPUS"
echo "  WORKERS_PER_NPU    : $WORKERS_PER_NPU"
echo "  TARGET_PDB         : $TARGET_PDB"
echo "  FRAMEWORK_PDB      : $FRAMEWORK_PDB"
echo "  RF_CKPT            : $RF_CKPT"
echo "  HOTSPOTS           : $HOTSPOTS"
echo "  DESIGN_LOOPS       : $DESIGN_LOOPS"
echo "  FINAL_STEP         : $FINAL_STEP"
echo "  DIFFUSER_T         : $DIFFUSER_T"
echo "  PROTENIX_DIR       : $PROTENIX_DIR"
echo "  PROTENIX_CKPT      : $PROTENIX_CKPT"
echo "  PROTENIX_USE_MSA   : $PROTENIX_USE_MSA"
echo "  PROTENIX_N_SAMPLE  : $PROTENIX_N_SAMPLE"
echo "  PROTENIX_SEEDS     : $PROTENIX_SEEDS"
echo "  HMMER_HOME         : $HMMER_HOME"
echo "  PIPELINE_ENV       : $PIPELINE_ENV"
echo "  CANN_SET_ENV       : $CANN_SET_ENV"
echo

rf_count=$(count_top_pdbs)
if [[ "$FORCE" == "1" && "$rf_count" -ne 0 ]]; then
  rm -rf "$RF_OUT" "${RF_OUT}_shards"
  mkdir -p "$RF_OUT"
  rf_count=0
fi
if [[ "$rf_count" -eq "$NUM_DESIGNS" ]]; then
  echo "[skip] RFdiffusion already has $rf_count top-level PDB files"
else
  if [[ "$rf_count" -ne 0 ]]; then
    echo "error: RFdiffusion output has $rf_count PDB files, expected $NUM_DESIGNS." >&2
    echo "       Use a fresh --run-dir, or finish/clean the partial RF run first." >&2
    exit 1
  fi
  echo "[$(date '+%F %T')] Step 1/2: RFdiffusion"
  echo "  log: $LOG_DIR/01_rfdiffusion.log"
  run_rfdiffusion_inline "$RF_OUT" "$NUM_DESIGNS" >"$LOG_DIR/01_rfdiffusion.log" 2>&1

  rf_count=$(count_top_pdbs)
  if [[ "$rf_count" -ne "$NUM_DESIGNS" ]]; then
    echo "error: RFdiffusion produced $rf_count PDB files, expected $NUM_DESIGNS" >&2
    echo "       Check $LOG_DIR/01_rfdiffusion.log" >&2
    exit 1
  fi
fi

echo "[$(date '+%F %T')] Step 2/2: ProteinMPNN + Protenix + screening"
echo "  log: $LOG_DIR/02_after_rfdiffusion.log"
after_cmd=(
  bash "$AFTER_SCRIPT"
  --run-dir "$RUN_DIR"
  --rf-dir "$RF_OUT"
  --target-pdb "$TARGET_PDB"
  --num-designs "$NUM_DESIGNS"
  --app-dir "$APP_DIR"
  --scripts-dir "$SCRIPTS_DIR"
  --python "$PYTHON_BIN"
  --protenix-dir "$PROTENIX_DIR"
  --protenix-ckpt "$PROTENIX_CKPT"
  --protenix-use-msa "$PROTENIX_USE_MSA"
  --protenix-n-sample "$PROTENIX_N_SAMPLE"
  --protenix-seeds "$PROTENIX_SEEDS"
  --hmmer-home "$HMMER_HOME"
  --pipeline-env "$PIPELINE_ENV"
  --cann-set-env "$CANN_SET_ENV"
  --npus "$NPUS"
  --hotspots "$HOTSPOTS"
)
if [[ "$FORCE" == "1" ]]; then
  after_cmd+=(--force)
fi
"${after_cmd[@]}" >"$LOG_DIR/02_after_rfdiffusion.log" 2>&1

write_artifact_manifest

end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

echo
echo "Done."
echo "Elapsed seconds: $elapsed"
echo "Run dir: $RUN_DIR"
echo "Reports:"
echo "  $RUN_DIR/05_screening/protenix_screening_report.md"
