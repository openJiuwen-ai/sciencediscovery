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
# The wheel already carries the patched tree, but a wheel only packages the
# Python package — the apply receipt (.sciencediscovery-patches.json) stays
# in the repo root and is NOT inside the wheel. Without it, the payload-side
# apply step sees an unmanifested, already-patched tree and falls back to
# per-patch reverse checks, which later patches break (0015 rewrites hunks
# 0001 added): git apply fails, the build dies. Ship the receipt next to the
# wheel so the installer can drop it into site-packages, where the digest
# short-circuit recognizes the already-patched state as a verified no-op.
# The recorded file digests include tests/ paths the wheel form legitimately
# omits — swarm-patches.py tolerates absent optional paths in the receipt,
# mirroring how it records them.
cp "$build_dir/source/.sciencediscovery-patches.json" "$wheel_dir/jiuwenswarm-patches-manifest.json"
