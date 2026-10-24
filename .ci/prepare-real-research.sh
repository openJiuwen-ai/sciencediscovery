#!/usr/bin/env bash
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
required=(E2E_LLM_BASE_URL E2E_LLM_MODEL E2E_LLM_TOKEN E2E_JUDGE_BASE_URL E2E_JUDGE_MODEL E2E_JUDGE_TOKEN)
if [[ -n "${CI_BIOMNI_CASE_ID:-}" ]]; then required+=(HF_TOKEN); else required+=(JINA_API_KEY HF_TOKEN); fi
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then echo "BLOCKED: missing $name" >&2; exit 2; fi
done
[[ "${CI_ALLOW_REAL:-}" == 1 ]] || { echo 'BLOCKED: CI_ALLOW_REAL=1 required' >&2; exit 2; }
runtime="${CI_RUNTIME_DIR:?CI_RUNTIME_DIR required}"
mkdir -p "$runtime"
# Keep the pinned scientific wheels independent of the hosted runner's Python.
uv venv --python 3.12 "$runtime/benchmark-venv"
python="$runtime/benchmark-venv/bin/python"
uv pip install --python "$python" pandas==2.3.3 numpy==2.2.6 scipy==1.15.3 \
  requests==2.32.3 python-dotenv==1.0.1 tqdm==4.67.1 huggingface-hub==0.34.4
upstream="$runtime/DeepResearchBench"
if [[ -n "${CI_BIOMNI_CASE_ID:-}" ]]; then
  "$python" test/benchmarks/biomnibench-da/prepare.py download \
    --root "$runtime/biomnibench-da" --case "$CI_BIOMNI_CASE_ID"
else
  git clone --no-checkout https://github.com/Ayanami0730/deep_research_bench.git "$upstream"
  git -C "$upstream" checkout --detach 852f4022d1f98fb707222e395405136e8f0e8d52
fi
# Paths, not credentials. The workflow already supplies credentials only to this job.
{
  echo "DRB_PYTHON=$python"
  echo "BIOMNI_PYTHON=$python"
  echo "DRB_UPSTREAM_DIR=$upstream"
  echo "BIOMNI_DATA_ROOT=$runtime/biomnibench-da"
} >> "${GITHUB_ENV:?GitHub environment file required}"
