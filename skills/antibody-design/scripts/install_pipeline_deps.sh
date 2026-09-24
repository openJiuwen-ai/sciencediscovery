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

# Ensure external tools needed by the antibody pipeline are available.
# This is intended to be the first resumable runner step.
# Usage:
#   bash install_pipeline_deps.sh [hmmer_home] [marker_file] [python_bin]
#   bash install_pipeline_deps.sh --pipeline-home DIR --python PYTHON --pipeline-env FILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_HOME="${ANTIBODY_PIPELINE_HOME:-$PWD/antibody_pipeline}"
HMMER_HOME_ARG=""
MARKER=""
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

truthy_flag() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

require_managed_python() {
  if [[ -z "${PYTHON_BIN:-}" || ! -x "$PYTHON_BIN" ]]; then
    echo "error: --python must be a valid ScienceDiscovery scientific-env revision Python" >&2
    exit 2
  fi
  if [[ -n "${PIPELINE_HOME:-}" ]]; then
    case "$PYTHON_BIN" in
      "$PIPELINE_HOME"/venv/*|"$PIPELINE_HOME"/python_user/*|"$PIPELINE_HOME"/bin/*)
        echo "error: refusing host pipeline Python: $PYTHON_BIN" >&2
        exit 2
        ;;
    esac
  fi
  if truthy_env "${ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV:-${ANTIBODY_REQUIRE_SCIENCEAGENT_ENV:-1}}"; then
    case "$PYTHON_BIN" in
      */scientific-envs/revisions/*/bin/python|*/scientific-envs/revisions/*/bin/python3|*/scientific-envs/revisions/*/bin/python3.*) ;;
      *)
        echo "error: Python is not from a ScienceDiscovery scientific environment revision: $PYTHON_BIN" >&2
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

PYTHON_BIN=""
PIPELINE_ENV="${ANTIBODY_PIPELINE_ENV:-}"
POSITIONAL=()

usage() {
  sed -n '4,8p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pipeline-home) PIPELINE_HOME="$2"; shift 2 ;;
    --hmmer-home) HMMER_HOME_ARG="$2"; shift 2 ;;
    --marker) MARKER="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --pipeline-env) PIPELINE_ENV="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; POSITIONAL+=("$@"); break ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

# ScienceDiscovery managed-env mode does not auto-source host pipeline env.sh.
require_no_host_pipeline_env
if [[ -n "$PIPELINE_ENV" && -f "$PIPELINE_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$PIPELINE_ENV"
fi

HMMER_HOME_ARG="${HMMER_HOME_ARG:-${POSITIONAL[0]:-${HMMER_HOME:-$PIPELINE_HOME/tools/hmmer}}}"
MARKER="${MARKER:-${POSITIONAL[1]:-}}"
PYTHON_BIN="${PYTHON_BIN:-${POSITIONAL[2]:-$(resolve_python)}}"
require_managed_python

if [[ -n "${MARKER}" ]]; then
  mkdir -p "$(dirname "${MARKER}")"
fi

export HMMER_HOME="${HMMER_HOME_ARG}"
export PATH="${HMMER_HOME}/bin:${PATH}"

if truthy_flag "${INSTALL_HMMER:-0}" || truthy_flag "${PROTENIX_USE_MSA:-false}"; then
  HMMER_MARKER="${MARKER}.hmmer" bash "${SCRIPT_DIR}/install_hmmer_for_protenix_msa.sh" "${HMMER_HOME}"
else
  echo "Skipping HMMER install; set INSTALL_HMMER=1 or PROTENIX_USE_MSA=true when MSA is required."
fi

install_python_packages() {
  require_managed_python
  local pip_args=()
  if [[ -n "${PYTHON_PIP_INDEX_URL:-}" ]]; then
    pip_args+=(--index-url "${PYTHON_PIP_INDEX_URL}")
  fi
  "${PYTHON_BIN}" -m pip install "${pip_args[@]}" "$@"
}

missing_specs=()
while IFS= read -r spec; do
  [[ -n "$spec" ]] && missing_specs+=("$spec")
done < <("${PYTHON_BIN}" - <<'PY'
import importlib.util
import importlib.metadata
pairs = [
    ("sympy", "sympy"),
    ("safetensors", "safetensors"),
    ("attr", "attrs"),
    ("psutil", "psutil"),
    ("dill", "dill"),
    ("asttokens", "asttokens"),
    ("yaml", "pyyaml"),
    ("ml_collections", "ml_collections"),
    ("optree", "optree"),
    ("sklearn", "scikit-learn"),
    ("pandas", "pandas"),
    ("rdkit", "rdkit==2024.3.5"),
    ("matplotlib", "matplotlib==3.9.2"),
    ("tqdm", "tqdm"),
    ("Bio", "biopython==1.83"),
]
for module, spec in pairs:
    if importlib.util.find_spec(module) is None:
        print(spec)
if importlib.util.find_spec("biotite") is None:
    print("numpy==1.26.4")
    print("scipy==1.17.0")
    print("biotite==1.4.0")
else:
    try:
        from biotite.structure.io import pdbx
    except Exception:
        print("numpy==1.26.4")
        print("scipy==1.17.0")
        print("biotite==1.4.0")
    else:
        if not hasattr(pdbx, "PDBX_BOND_TYPE_ID_TO_TYPE"):
            print("numpy==1.26.4")
            print("scipy==1.17.0")
            print("biotite==1.4.0")
try:
    numpy_version = importlib.metadata.version("numpy")
except importlib.metadata.PackageNotFoundError:
    print("numpy==1.26.4")
else:
    if numpy_version.split(".", 1)[0] != "1":
        print("numpy==1.26.4")
PY
)

if (( ${#missing_specs[@]} > 0 )); then
  echo "Installing missing Python packages into the ScienceDiscovery managed environment: ${missing_specs[*]}"
  install_python_packages "${missing_specs[@]}"
fi

if ! "${PYTHON_BIN}" - <<'PY' >/dev/null 2>&1
import sympy, safetensors, attr, psutil, dill, asttokens
import yaml, ml_collections, optree, sklearn, biotite, pandas, rdkit, matplotlib, tqdm, Bio
PY
then
  echo "Python runtime dependencies are still incomplete for $(${PYTHON_BIN} -c 'import sys; print(sys.executable)')" >&2
  echo "Install the missing RFdiffusion/Protenix dependencies into the selected user-owned environment, then rerun preflight." >&2
  exit 2
fi

if ! "${PYTHON_BIN}" - <<'PY' >/dev/null 2>&1
import mindspore
PY
then
  echo "MindSpore is not importable in $(${PYTHON_BIN} -c 'import sys; print(sys.executable)')" >&2
  echo "Install the host-compatible MindSpore Ascend wheel in the ScienceDiscovery scientific environment, then rerun preflight." >&2
  if [[ "${INSTALL_MINDSPORE:-0}" == "1" ]]; then
    spec="${MINDSPORE_PIP_SPEC:-mindspore}"
    echo "INSTALL_MINDSPORE=1 set; attempting: pip install ${spec}" >&2
    install_python_packages "${spec}"
  else
    exit 2
  fi
fi

if ! "${PYTHON_BIN}" - <<'PY' >/dev/null 2>&1
import mindspore
PY
then
  echo "MindSpore remains unavailable after installation attempt." >&2
  exit 2
fi

"${PYTHON_BIN}" - <<'PY'
import mindspore
print('MindSpore import ok')
PY

for exe in jackhmmer nhmmer hmmsearch hmmbuild hmmalign hmmscan; do
  printf '%-10s -> ' "${exe}"
  command -v "${exe}" || true
done

if [[ -n "${MARKER}" ]]; then
  {
    echo "checked_at=$(date '+%F %T')"
    echo "python=$(${PYTHON_BIN} -c 'import sys; print(sys.executable)')"
    echo "hmmer_home=${HMMER_HOME}"
    for exe in jackhmmer nhmmer hmmsearch hmmbuild hmmalign hmmscan; do
      printf '%s=' "${exe}"
      command -v "${exe}" || true
    done
  } >"${MARKER}"
fi
