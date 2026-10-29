#!/usr/bin/env bash
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

if [[ -f .ci/issue-346-manual-repeat-grade.flag ]]; then
  # Offline #346 measurement: download both official rubrics only. No research.
  required=(E2E_JUDGE_BASE_URL E2E_JUDGE_MODEL E2E_JUDGE_TOKEN HF_TOKEN)
  for name in "${required[@]}"; do
    if [[ -z "${!name:-}" ]]; then echo "BLOCKED: missing $name" >&2; exit 2; fi
  done
  [[ "${CI_ALLOW_REAL:-}" == 1 ]] || { echo 'BLOCKED: CI_ALLOW_REAL=1 required' >&2; exit 2; }
  runtime="${CI_RUNTIME_DIR:?CI_RUNTIME_DIR required}"
  mkdir -p "$runtime"
  uv venv --python "${SCIENCE_RESEARCH_PYTHON:-3.14}" "$runtime/benchmark-venv"
  python="$runtime/benchmark-venv/bin/python"
  uv pip install --python "$python" --only-binary :all: -r .ci/research-requirements.txt
  "$python" test/benchmarks/biomnibench-da/prepare.py download \
    --root "$runtime/biomnibench-da" --case da-13-3
  "$python" test/benchmarks/biomnibench-da/prepare.py download \
    --root "$runtime/biomnibench-da" --case da-14-1
  {
    echo "BIOMNI_PYTHON=$python"
    echo "BIOMNI_DATA_ROOT=$runtime/biomnibench-da"
    echo "BIOMNI_JUDGE_BASE_URL=${E2E_JUDGE_BASE_URL}"
    echo "BIOMNI_JUDGE_MODEL=${E2E_JUDGE_MODEL}"
    echo "BIOMNI_JUDGE_API_KEY=${E2E_JUDGE_TOKEN}"
  } >> "${GITHUB_ENV:?GitHub environment file required}"
  echo "issue-346: prepared da-13-3 and da-14-1 rubrics for offline repeat-grade"
  exit 0
fi

required=(E2E_LLM_BASE_URL E2E_LLM_MODEL E2E_LLM_TOKEN E2E_JUDGE_BASE_URL E2E_JUDGE_MODEL E2E_JUDGE_TOKEN)
if [[ -n "${CI_BIOMNI_CASE_ID:-}" ]]; then required+=(HF_TOKEN); else required+=(JINA_API_KEY HF_TOKEN); fi
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then echo "BLOCKED: missing $name" >&2; exit 2; fi
done
[[ "${CI_ALLOW_REAL:-}" == 1 ]] || { echo 'BLOCKED: CI_ALLOW_REAL=1 required' >&2; exit 2; }
runtime="${CI_RUNTIME_DIR:?CI_RUNTIME_DIR required}"
mkdir -p "$runtime"
uv venv --python "${SCIENCE_RESEARCH_PYTHON:-3.14}" "$runtime/benchmark-venv"
python="$runtime/benchmark-venv/bin/python"
uv pip install --python "$python" --only-binary :all: -r .ci/research-requirements.txt
upstream="$runtime/DeepResearchBench"
if [[ -n "${CI_BIOMNI_CASE_ID:-}" ]]; then
  "$python" test/benchmarks/biomnibench-da/prepare.py download \
    --root "$runtime/biomnibench-da" --case "$CI_BIOMNI_CASE_ID"
else
  git clone --no-checkout https://github.com/Ayanami0730/deep_research_bench.git "$upstream"
  git -C "$upstream" checkout --detach 852f4022d1f98fb707222e395405136e8f0e8d52
fi
{
  echo "DRB_PYTHON=$python"
  echo "BIOMNI_PYTHON=$python"
  echo "DRB_UPSTREAM_DIR=$upstream"
  echo "BIOMNI_DATA_ROOT=$runtime/biomnibench-da"
} >> "${GITHUB_ENV:?GitHub environment file required}"
