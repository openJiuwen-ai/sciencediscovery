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
#
# PATH is not exported to the caller: a CI step is its own shell. Callers add
#   export PATH="$HOME/.local/node/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"

set -uo pipefail

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
  mkdir -p "$HOME/.local/node"
  if have curl; then curl -fsSL "$node_url" -o "/tmp/$node_tar"
  elif have wget; then wget -qO "/tmp/$node_tar" "$node_url"
  else echo "FATAL: neither curl nor wget is available to fetch Node." >&2; exit 1
  fi
  tar -xJf "/tmp/$node_tar" -C "$HOME/.local/node" --strip-components=1 \
    || { echo "FATAL: could not unpack $node_tar." >&2; exit 1; }
  hash -r
  echo "installed: $(node --version)"
fi

if [ ! -f package.json ]; then
  echo "FATAL: no package.json in $PWD; the checkout is not where this script was invoked." >&2
  exit 1
fi

# The pin lives in package.json so the workflow cannot drift from the repository.
pnpm_spec="$(node -p "require('./package.json').packageManager || 'pnpm@latest'" 2>/dev/null || echo 'pnpm@latest')"
echo
echo "=== pnpm ($pnpm_spec) ==="
if have pnpm; then
  echo "already present"
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

echo
echo "=== uv ==="
if have uv; then
  echo "already present"
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
