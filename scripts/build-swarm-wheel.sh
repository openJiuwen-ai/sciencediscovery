#!/usr/bin/env bash
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
wheel_dir="${1:?wheel output directory required}"
tag="${2:?pinned tag required}"
build_dir="$(mktemp -d)"
trap 'rm -rf -- "$build_dir"' EXIT
git clone --quiet --depth 1 --branch "$tag" \
  "${JIUWENSWARM_GIT_URL:-https://gitcode.com/openJiuwen/jiuwenswarm.git}" "$build_dir/source"
python3 "$script_dir/swarm-patches.py" apply "$build_dir/source" "$tag"
uv build --wheel --out-dir "$wheel_dir" "$build_dir/source"
