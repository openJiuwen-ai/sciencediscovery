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

# Build or verify HMMER for Protenix MSA.
# Usage:
#   bash install_hmmer_for_protenix_msa.sh [hmmer_home] [build_root]
#
# Optional env:
#   HMMER_VERSION=3.4
#   HMMER_URL=https://eddylab.org/software/hmmer/hmmer-3.4.tar.gz
#   HMMER_SHA256=<expected sha256 for hmmer-3.4.tar.gz>
#   HMMER_TARBALL=/path/to/hmmer-3.4.tar.gz
#   HMMER_MARKER=/path/to/workspace/00_preflight/hmmer.ok
#   JOBS=8

PIPELINE_HOME="${ANTIBODY_PIPELINE_HOME:-$PWD/antibody_pipeline}"
PREFIX="${1:-${HMMER_HOME:-$PIPELINE_HOME/tools/hmmer}}"
BUILD_ROOT="${2:-$PIPELINE_HOME/build/hmmer_build}"
VERSION="${HMMER_VERSION:-3.4}"
JOBS="${JOBS:-8}"
DEFAULT_TARBALL="hmmer-${VERSION}.tar.gz"
URL="${HMMER_URL:-https://eddylab.org/software/hmmer/${DEFAULT_TARBALL}}"
SHA256="${HMMER_SHA256:-}"

need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required build tool not found: $1" >&2
    echo "hint: install build essentials first, for example: yum groupinstall -y 'Development Tools' or apt-get install -y build-essential wget tar" >&2
    exit 2
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: need sha256sum or shasum to verify ${DEFAULT_TARBALL}" >&2
    exit 2
  fi
}

verify_tarball() {
  local tarball="$1"
  if [[ -z "$SHA256" ]]; then
    echo "error: HMMER_SHA256 is required before building from ${DEFAULT_TARBALL}" >&2
    echo "       provide an operator-verified sha256 for ${URL} or the local HMMER_TARBALL" >&2
    exit 2
  fi
  local actual
  actual="$(sha256_file "$tarball")"
  if [[ "${actual,,}" != "${SHA256,,}" ]]; then
    echo "error: HMMER tarball sha256 mismatch: $tarball" >&2
    echo "       expected: ${SHA256}" >&2
    echo "       actual:   ${actual}" >&2
    exit 2
  fi
}

have_all_hmmer_bins_on_path() {
  for exe in jackhmmer nhmmer hmmsearch hmmbuild hmmalign hmmscan; do
    command -v "${exe}" >/dev/null 2>&1 || return 1
  done
}

write_marker() {
  if [[ -n "${HMMER_MARKER:-}" ]]; then
    mkdir -p "$(dirname "${HMMER_MARKER}")"
    {
      echo "HMMER_HOME=${HMMER_HOME:-}"
      echo "PATH_PREFIX=${PREFIX}/bin"
      date '+checked_at=%F %T'
      for exe in jackhmmer nhmmer hmmsearch hmmbuild hmmalign hmmscan; do
        printf '%s=' "${exe}"
        command -v "${exe}"
      done
    } >"${HMMER_MARKER}"
  fi
}

if [[ -d "${PREFIX}/bin" ]]; then
  export HMMER_HOME="${PREFIX}"
  export PATH="${PREFIX}/bin:${PATH}"
fi

if have_all_hmmer_bins_on_path; then
  echo "HMMER executables already available in PATH"
  write_marker
  exit 0
fi

need_tool tar
need_tool make
need_tool gcc

mkdir -p "${PREFIX}" "${BUILD_ROOT}"

if [[ -n "${HMMER_TARBALL:-}" ]]; then
  cp "${HMMER_TARBALL}" "${BUILD_ROOT}/${DEFAULT_TARBALL}"
elif [[ -f "./${DEFAULT_TARBALL}" ]]; then
  cp "./${DEFAULT_TARBALL}" "${BUILD_ROOT}/${DEFAULT_TARBALL}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${BUILD_ROOT}/${DEFAULT_TARBALL}" "${URL}"
elif command -v curl >/dev/null 2>&1; then
  curl -L -o "${BUILD_ROOT}/${DEFAULT_TARBALL}" "${URL}"
else
  echo "error: need wget or curl to download ${URL}" >&2
  exit 2
fi

cd "${BUILD_ROOT}"
verify_tarball "${BUILD_ROOT}/${DEFAULT_TARBALL}"
tar -zxf "${DEFAULT_TARBALL}"
cd "hmmer-${VERSION}"
./configure --prefix="${PREFIX}"
make -j"${JOBS}"
make install
(cd easel && make install)

export HMMER_HOME="${PREFIX}"
export PATH="${PREFIX}/bin:${PATH}"

if ! have_all_hmmer_bins_on_path; then
  echo "error: HMMER build finished, but one or more executables are still missing" >&2
  for exe in jackhmmer nhmmer hmmsearch hmmbuild hmmalign hmmscan; do
    printf '%-10s -> ' "${exe}"
    command -v "${exe}" || true
  done
  exit 2
fi

echo "HMMER_HOME=${HMMER_HOME}"
for exe in jackhmmer nhmmer hmmsearch hmmbuild hmmalign hmmscan; do
  printf '%-10s -> ' "${exe}"
  command -v "${exe}"
done
write_marker

cat <<EOF

Add this to ~/.bashrc or the conda env activation script:
export HMMER_HOME=${PREFIX}
export PATH=\$HMMER_HOME/bin:\$PATH
EOF
