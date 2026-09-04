#!/usr/bin/env bash
#
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

# Installs pnpm, uv and optionally bubblewrap on a CI runner that provides only
# Node.js, and prints what it found before it starts. Hosted runner images
# differ in whether the job is root, whether sudo exists, and whether a global
# npm prefix is writable, so every install has ordered fallbacks and reports
# which one succeeded — a failure here should say why, not just stop.
#
# Usage: bash .ci/provision-runner.sh [--sandbox]
#   --sandbox  bubblewrap is required; fail if it cannot be made to work.
# Optional environment:
#   CI_NPM_REGISTRY  npm-compatible registry used by npm, pnpm and Corepack.
#   CI_UV_WHEEL_URL  Exact architecture-specific uv wheel source override. The
#                    downloaded bytes must still match the repository SHA256.
#   CI_BINARY_CACHE_URL  Public OBS base URL for immutable toolchain archives.
#   CI_BINARY_CACHE_DIR  Local verified-archive staging directory.
#   CI_BINARY_CACHE_ONLY Set to 1 to fail instead of using external fallbacks.
#
# PATH is not exported to the caller: a CI step is its own shell. Callers add
#   export PATH="$HOME/.local/node/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"

set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

have() { command -v "$1" >/dev/null 2>&1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  # -n so a runner without passwordless sudo fails fast instead of blocking
  # on a password prompt that nothing will ever answer.
  elif have sudo; then sudo -n "$@"
  else return 127
  fi
}

require_sandbox=0
[ "${1:-}" = "--sandbox" ] && require_sandbox=1

export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$HOME/.local/node/bin:$PNPM_HOME:$HOME/.local/bin:$PATH"
binary_cache_dir="${CI_BINARY_CACHE_DIR:-$PWD/.ci-results/toolchain-cache}"
binary_cache_only="${CI_BINARY_CACHE_ONLY:-0}"
[[ "$binary_cache_only" =~ ^[01]$ ]] \
  || { echo "CI_BINARY_CACHE_ONLY must be 0 or 1." >&2; exit 2; }

# package.json requires >=22.19.0. Provisioning Node here rather than through a
# setup action keeps the workflow dependent on one platform action (checkout)
# instead of two, and makes the version the repository's business.
NODE_REQUIRED=22.19.0
node_too_old() {
  have node || return 0
  local current
  current="$(node --version 2>/dev/null | sed 's/^v//')" || return 0
  [ "$(printf '%s\n%s\n' "$NODE_REQUIRED" "$current" | sort -V | head -1)" != "$NODE_REQUIRED" ]
}

echo "=== runner ==="
echo "user    : $(id -un 2>/dev/null || echo '?') (uid $(id -u))"
echo "os      : $(uname -srm)"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release && echo "distro  : ${PRETTY_NAME:-unknown}"
fi
echo "pwd     : $PWD"
echo "entries : $(ls -A 2>/dev/null | tr '\n' ' ')"
for tool in git curl wget sudo apt-get node npm corepack python3 bwrap; do
  if have "$tool"; then
    printf '  %-9s %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '  %-9s missing\n' "$tool"
  fi
done
echo "node    : $(node --version 2>/dev/null || echo 'missing')"

echo
echo "=== node (need >= $NODE_REQUIRED) ==="
if ! node_too_old; then
  echo "present: $(node --version)"
else
  echo "installing v$NODE_REQUIRED into ~/.local/node"
  node_arch=x64
  case "$(uname -m)" in aarch64|arm64) node_arch=arm64 ;; esac
  node_tar="node-v$NODE_REQUIRED-linux-$node_arch.tar.xz"
  node_url="https://nodejs.org/dist/v$NODE_REQUIRED/$node_tar"
  case "$node_arch" in
    arm64) node_sha256=0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc ;;
    x64) node_sha256=c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2 ;;
  esac
  node_archive="$binary_cache_dir/$node_tar"
  cache_arguments=()
  if [[ -n "${CI_BINARY_CACHE_URL:-}" ]]; then
    cache_arguments+=(--cache-base-url "$CI_BINARY_CACHE_URL")
  fi
  if [[ "$binary_cache_only" == 1 ]]; then
    cache_arguments+=(--cache-only)
  fi
  mkdir -p "$HOME/.local/node"
  bash "$script_dir/fetch-verified-binary.sh" \
    "${cache_arguments[@]}" \
    --filename "$node_tar" \
    --output "$node_archive" \
    --sha256 "$node_sha256" \
    --source-url "$node_url" \
    || { echo "FATAL: could not fetch the pinned Node archive." >&2; exit 1; }
  tar -xJf "$node_archive" -C "$HOME/.local/node" --strip-components=1 \
    || { echo "FATAL: could not unpack $node_tar." >&2; exit 1; }
  hash -r
  echo "installed: $(node --version)"
fi

if [ ! -f package.json ]; then
  echo "FATAL: no package.json in $PWD; the checkout is not where this script was invoked." >&2
  exit 1
fi

# npm and pnpm share the user npmrc. Corepack does not read that file, so it
# needs the same mirror separately and expects its base URL without a trailing
# slash. The user-level file persists across steps in the same CI job.
if [ -n "${CI_NPM_REGISTRY:-}" ]; then
  npm_registry="${CI_NPM_REGISTRY%/}/"
  export COREPACK_NPM_REGISTRY="${npm_registry%/}"
  npm config set registry "$npm_registry" --location=user >/dev/null 2>&1 \
    || { echo "FATAL: could not configure the npm registry." >&2; exit 1; }
  echo
  echo "=== npm registry ==="
  echo "configured: $(npm config get registry)"
fi

# The pin lives in package.json so the workflow cannot drift from the repository.
pnpm_spec="$(node -p "require('./package.json').packageManager || 'pnpm@latest'" 2>/dev/null || echo 'pnpm@latest')"

# Corepack verifies registry metadata and npm -g depends on a writable global
# prefix. When CI supplies an npm-compatible registry, installing the pinned
# package tarball directly avoids both failure modes and stays under $PNPM_HOME.
install_pnpm_from_registry() {
  local registry="$1" version="${pnpm_spec#pnpm@}" archive install_dir expected_sha256 expected_sha512 actual_sha512
  local -a cache_arguments=()
  case "$version" in
    11.1.2)
      expected_sha256=bfe4d2b2c7a3210565bba62929f9efe493eb5f24627201a102ea4514eae8cf80
      expected_sha512=415a1cc25974731e75455c1468371be74c5aa5fb7621b50d4056d222451609f11412f23fd602e6169f1e060466641f798597e1be961a10688836a67b16569499
      ;;
    *)
      echo "direct registry install has no pinned checksum for pnpm '$version'" >&2
      return 1
      ;;
  esac

  archive="$binary_cache_dir/pnpm-$version.tgz"
  install_dir="$PNPM_HOME/.tools/pnpm/$version"
  mkdir -p "$(dirname "$archive")" "$install_dir" || return 1
  if [[ -n "${CI_BINARY_CACHE_URL:-}" ]]; then
    cache_arguments+=(--cache-base-url "$CI_BINARY_CACHE_URL")
  fi
  if [[ "$binary_cache_only" == 1 ]]; then
    cache_arguments+=(--cache-only)
  fi
  bash "$script_dir/fetch-verified-binary.sh" \
    "${cache_arguments[@]}" \
    --filename "pnpm-$version.tgz" \
    --output "$archive" \
    --sha256 "$expected_sha256" \
    --source-url "${registry%/}/pnpm/-/pnpm-$version.tgz" || return 1
  have sha512sum || return 1
  actual_sha512="$(sha512sum "$archive" | awk '{print $1}')" || return 1
  if [ "$actual_sha512" != "$expected_sha512" ]; then
    echo "pnpm tarball checksum mismatch: expected $expected_sha512, got $actual_sha512" >&2
    return 1
  fi
  tar -xzf "$archive" -C "$install_dir" --strip-components=1 || return 1
  [ -x "$install_dir/bin/pnpm.mjs" ] || return 1
  ln -sfn "$install_dir/bin/pnpm.mjs" "$PNPM_HOME/pnpm" || return 1
  ln -sfn "$install_dir/bin/pnpx.mjs" "$PNPM_HOME/pnpx" || return 1
  hash -r
}

echo
echo "=== pnpm ($pnpm_spec) ==="
if have pnpm; then
  echo "already present"
elif [ -n "${npm_registry:-}" ] && install_pnpm_from_registry "$npm_registry"; then
  echo "installed from configured registry"
elif [[ "$binary_cache_only" == 1 ]]; then
  echo "FATAL: the pinned pnpm archive is absent or invalid in the required cache." >&2
  exit 1
elif have corepack && corepack enable >/dev/null 2>&1 && corepack prepare --activate >/dev/null 2>&1; then
  echo "installed via corepack"
elif have corepack && as_root corepack enable >/dev/null 2>&1 && corepack prepare --activate >/dev/null 2>&1; then
  echo "installed via corepack as root"
elif have npm && npm install -g "$pnpm_spec" >/dev/null 2>&1; then
  echo "installed via npm -g"
elif have npm && as_root npm install -g "$pnpm_spec" >/dev/null 2>&1; then
  echo "installed via npm -g as root"
elif have curl && curl -fsSL https://get.pnpm.io/install.sh | env "PNPM_VERSION=${pnpm_spec#pnpm@}" SHELL=/bin/bash bash - >/dev/null 2>&1; then
  echo "installed via the standalone script"
else
  echo "FATAL: could not install pnpm by any route (corepack, npm -g, standalone)." >&2
  exit 1
fi
pnpm --version || { echo "FATAL: pnpm installed but not runnable." >&2; exit 1; }

UV_REQUIRED=0.9.26
install_uv_from_mirror() {
  local install_dir="$HOME/.local/share/uv/$UV_REQUIRED" runtime_arch uv_wheel uv_wheel_sha256 uv_wheel_path default_uv_wheel_url uv_wheel_url actual_sha256 wheel_scripts
  local -a cache_arguments=()
  have python3 || return 1
  case "$(uname -m)" in
    aarch64|arm64)
      runtime_arch=aarch64
      default_uv_wheel_url=https://pypi.tuna.tsinghua.edu.cn/packages/ba/3d/b8186a7dec1346ca4630c674b760517d28bffa813a01965f4b57596bacf3/uv-0.9.26-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl
      ;;
    amd64|x86_64)
      runtime_arch=x86_64
      default_uv_wheel_url=https://pypi.tuna.tsinghua.edu.cn/packages/38/16/a07593a040fe6403c36f3b0a99b309f295cbfe19a1074dbadb671d5d4ef7/uv-0.9.26-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
      ;;
    *) return 1 ;;
  esac
  uv_wheel_url="${CI_UV_WHEEL_URL:-$default_uv_wheel_url}"
  read -r uv_wheel uv_wheel_sha256 < <(node -e '
    const manifest = require(process.argv[1]);
    const entry = manifest.uv.architectures[process.argv[2]];
    if (!entry) process.exit(1);
    console.log(`${entry.filename} ${entry.sha256}`);
  ' "$script_dir/../scripts/binary-release/runtimes.json" "$runtime_arch") || return 1
  uv_wheel_path="$binary_cache_dir/$uv_wheel"
  mkdir -p "$binary_cache_dir" "$install_dir" "$HOME/.local/bin" || return 1
  if [[ -n "${CI_BINARY_CACHE_URL:-}" ]]; then
    cache_arguments+=(--cache-base-url "$CI_BINARY_CACHE_URL")
  fi
  if [[ "$binary_cache_only" == 1 ]]; then
    cache_arguments+=(--cache-only)
  fi
  bash "$script_dir/fetch-verified-binary.sh" \
    "${cache_arguments[@]}" \
    --filename "$uv_wheel" \
    --output "$uv_wheel_path" \
    --sha256 "$uv_wheel_sha256" \
    --source-url "$uv_wheel_url" || return 1
  [[ -f "$uv_wheel_path" ]] || return 1
  actual_sha256="$(sha256sum "$uv_wheel_path" | awk '{print $1}')" || return 1
  [[ "$actual_sha256" == "$uv_wheel_sha256" ]] || {
    echo "uv wheel checksum mismatch: expected $uv_wheel_sha256, got $actual_sha256" >&2
    return 1
  }
  rm -rf -- "$install_dir"
  mkdir -p "$install_dir" || return 1
  python3 -m zipfile -e "$uv_wheel_path" "$install_dir" || return 1
  wheel_scripts="$install_dir/uv-$UV_REQUIRED.data/scripts"
  mkdir -p "$install_dir/bin" || return 1
  cp -f -- "$wheel_scripts/uv" "$wheel_scripts/uvx" "$install_dir/bin/" || return 1
  chmod 0755 "$install_dir/bin/uv" "$install_dir/bin/uvx" || return 1
  [ -x "$install_dir/bin/uv" ] || return 1
  ln -sfn "$install_dir/bin/uv" "$HOME/.local/bin/uv" || return 1
  ln -sfn "$install_dir/bin/uvx" "$HOME/.local/bin/uvx" || return 1
  hash -r
}

echo
echo "=== uv (uv@$UV_REQUIRED) ==="
echo "python  : $(python3 --version 2>&1 || echo 'missing')"
echo "pip     : $(python3 -m pip --version 2>&1 || echo 'missing')"
if have uv; then
  echo "already present"
elif install_uv_from_mirror; then
  echo "installed from pinned TUNA wheel"
elif [[ "$binary_cache_only" == 1 ]]; then
  echo "FATAL: the pinned uv wheel is absent or invalid in the required cache." >&2
  exit 1
elif have curl && curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; then
  echo "installed via curl"
elif have wget && wget -qO- https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; then
  echo "installed via wget"
else
  echo "FATAL: could not install uv; neither curl nor wget succeeded." >&2
  exit 1
fi
uv --version || { echo "FATAL: uv installed but not runnable." >&2; exit 1; }

echo
echo "=== bubblewrap ==="
if ! have bwrap; then
  # Never let a failed package install abort the script: the preflight below is
  # the authority on whether the sandbox actually works.
  as_root apt-get update >/dev/null 2>&1 || echo "apt-get update failed or unavailable"
  as_root apt-get install --yes --no-install-recommends bubblewrap >/dev/null 2>&1 \
    || echo "apt-get install bubblewrap failed or unavailable"
fi
# Ubuntu 24.04 denies unprivileged user namespaces by AppArmor policy; both the
# Runner sandbox and Chromium need them. Clearing it is a no-op on 22.04.
as_root sysctl --write kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 \
  || echo "could not clear kernel.apparmor_restrict_unprivileged_userns"
if have bwrap && bwrap --ro-bind / / --dev /dev true >/dev/null 2>&1; then
  echo "working: $(bwrap --version)"
elif [ "$require_sandbox" -eq 1 ]; then
  echo "FATAL: bubblewrap is unavailable or cannot create a namespace on this runner." >&2
  echo "       ut-runner and the mocked journeys cannot execute without it." >&2
  exit 1
else
  echo "unavailable; continuing"
fi

echo
echo "=== provisioned ==="
