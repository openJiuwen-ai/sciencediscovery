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

# Materialize immutable, checksum-pinned resources for the CodeArts upload steps.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# One definition for the names, versions and locations every resource script
# has to agree on. The checksums below stay here beside their download: a
# version bump has to be reviewed together with the hash it changes.
# shellcheck source=.ci/qemu-resources.sh
source "$script_dir/qemu-resources.sh"
group=""
output_dir=""

usage() {
  cat <<'EOF'
Usage: .ci/prepare-codearts-resources.sh --group <toolchains|qemu> --output-dir <path>

Environment:
  CODEARTS_TOOLCHAIN_CACHE_URL  Existing public toolchain cache base URL
  CODEARTS_QEMU_CACHE_URL       Existing public QEMU image cache base URL
  CODEARTS_RESOURCE_MAX_TIME    Per-download limit in seconds (default: 1800)
EOF
}

while (($#)); do
  case "$1" in
    --group) group="${2:?--group requires a value}"; shift 2 ;;
    --output-dir) output_dir="${2:?--output-dir requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$group" == toolchains || "$group" == qemu ]] \
  || { echo "--group must be toolchains or qemu." >&2; exit 2; }
[[ -n "$output_dir" ]] || { echo "--output-dir is required." >&2; exit 2; }

toolchain_cache_url="${CODEARTS_TOOLCHAIN_CACHE_URL:-$OBS_CACHE_BASE/toolchains/v1}"
qemu_cache_url="${CODEARTS_QEMU_CACHE_URL:-$OBS_CACHE_BASE/qemu/v1}"
download_max_time="${CODEARTS_RESOURCE_MAX_TIME:-1800}"

fetch_toolchain() {
  local filename="$1" sha256="$2" source_url="$3"
  bash "$script_dir/fetch-verified-binary.sh" \
    --cache-base-url "$toolchain_cache_url" \
    --download-max-time "$download_max_time" \
    --filename "$filename" \
    --output "$output_dir/toolchains/$filename" \
    --sha256 "$sha256" \
    --source-url "$source_url"
}

if [[ "$group" == toolchains ]]; then
  mkdir -p -- "$output_dir/toolchains"

  fetch_toolchain \
    node-v$TOOLCHAIN_NODE_VERSION-linux-x64.tar.xz \
    c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2 \
    https://npmmirror.com/mirrors/node/v$TOOLCHAIN_NODE_VERSION/node-v$TOOLCHAIN_NODE_VERSION-linux-x64.tar.xz
  fetch_toolchain \
    node-v$TOOLCHAIN_NODE_VERSION-linux-arm64.tar.xz \
    0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc \
    https://npmmirror.com/mirrors/node/v$TOOLCHAIN_NODE_VERSION/node-v$TOOLCHAIN_NODE_VERSION-linux-arm64.tar.xz
  fetch_toolchain \
    cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz \
    f04a55ae95e8bd352cdff8da11c344fe609ec84795d106fa91b6620366d786fe \
    https://registry.npmmirror.com/-/binary/python-build-standalone/20260805/cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
  fetch_toolchain \
    cpython-3.12.13+20260805-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz \
    f3510827b61e7a2aa89a1bb7bac73d45521939c489cf43f4699618efaead0611 \
    https://registry.npmmirror.com/-/binary/python-build-standalone/20260805/cpython-3.12.13+20260805-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz
  fetch_toolchain \
    micromamba-2.8.1-0-linux-64.tar.bz2 \
    a934c3709c997feae403a27fd1e321c106d26ffa4f294800ffb11cbc9a3e8515 \
    https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/linux-64/micromamba-2.8.1-0.tar.bz2
  fetch_toolchain \
    micromamba-2.8.1-0-linux-aarch64.tar.bz2 \
    70c60a36609ee8bcc07a3a1a66b2c3a65cff7c1053466963437f1bda72e5210f \
    https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/linux-aarch64/micromamba-2.8.1-0.tar.bz2
  fetch_toolchain \
    pnpm-$TOOLCHAIN_PNPM_VERSION.tgz \
    bfe4d2b2c7a3210565bba62929f9efe493eb5f24627201a102ea4514eae8cf80 \
    https://repo.huaweicloud.com/repository/npm/pnpm/-/pnpm-$TOOLCHAIN_PNPM_VERSION.tgz
  fetch_toolchain \
    uv-$TOOLCHAIN_UV_VERSION-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl \
    b7e89798bd3df7dcc4b2b4ac4e2fc11d6b3ff4fe7d764aa3012d664c635e2922 \
    https://pypi.tuna.tsinghua.edu.cn/packages/38/16/a07593a040fe6403c36f3b0a99b309f295cbfe19a1074dbadb671d5d4ef7/uv-$TOOLCHAIN_UV_VERSION-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
  fetch_toolchain \
    uv-$TOOLCHAIN_UV_VERSION-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl \
    ea296b700d7c4c27acdfd23ffaef2b0ecdd0aa1b58d942c62ee87df3b30f06ac \
    https://pypi.tuna.tsinghua.edu.cn/packages/ba/3d/b8186a7dec1346ca4630c674b760517d28bffa813a01965f4b57596bacf3/uv-$TOOLCHAIN_UV_VERSION-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl

  echo "Prepared 9 verified toolchain resources in $output_dir/toolchains"
  exit 0
fi

mkdir -p -- "$output_dir/qemu"
CI_QEMU_IMAGE_CACHE_URL="$qemu_cache_url" \
CI_QEMU_IMAGE_DOWNLOAD_MAX_TIME="$download_max_time" \
  bash "$script_dir/fetch-qemu-image.sh" \
    --output "$output_dir/qemu/$QEMU_BASE_IMAGE_NAME"
echo "Prepared the verified QEMU image in $output_dir/qemu"
