#!/usr/bin/env bash
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
case "${1:-}" in
  unit)
    if [[ -z "${DRB_UPSTREAM_DIR:-}" ]]; then
      export DRB_UPSTREAM_DIR="${CI_RUNTIME_DIR:-$PWD/.test-runs}/drb-evaluator"
      if [[ ! -d "$DRB_UPSTREAM_DIR/.git" ]]; then
        git clone --no-checkout https://github.com/Ayanami0730/deep_research_bench.git "$DRB_UPSTREAM_DIR"
        git -C "$DRB_UPSTREAM_DIR" checkout --detach 852f4022d1f98fb707222e395405136e8f0e8d52
      fi
    fi
    uv run --no-project --with pandas==2.3.3 --with numpy==2.2.6 --with scipy==1.15.3 \
      python .ci/research-unittest.py test/benchmarks/biomnibench-da
    uv run --no-project --with requests==2.32.3 --with python-dotenv==1.0.1 --with tqdm==4.67.1 \
      python .ci/research-unittest.py test/benchmarks/deepresearchbench
    ;;
  contract)
    bash scripts/jiuwenswarm.sh setup
    swarm_python="${JIUWENSWARM_SRC:-${JIUWENSWARM_ROOT:-$PWD/.sciencediscovery-data/jiuwenswarm}/src}/.venv/bin/python"
    report_dir="${CI_RESULTS_DIR:-$PWD/.test-runs}/swarm-contract"
    mkdir -p "$report_dir"
    PYTHONPATH="$PWD/services/adapter/src" "$swarm_python" -m pytest -q --tb=short jiuwen_swarm/tests --junitxml="$report_dir/results.xml"
    "$swarm_python" - "$report_dir/results.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET
cases = ET.parse(sys.argv[1]).findall('.//testcase')
assert cases and not any(c.find('skipped') is not None for c in cases), 'empty/skipped contract suite'
PY
    ;;
  *) echo 'Usage: run-research-python.sh unit|contract' >&2; exit 2;;
esac
