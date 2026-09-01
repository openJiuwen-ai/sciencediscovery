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

# Runs the existing Runner unit-test layer inside the full Linux guest started
# by run-qemu-sandbox-ut.sh. This must run as root so it can hand the checkout
# to the unprivileged `ci` user and enable Ubuntu's unprivileged-userns policy.

set -Eeuo pipefail

# The guest installs this same file as a narrow `node` shim for the test step.
# All non-test invocations are byte-for-byte argument forwards; only Node's
# test runner receives serialized file scheduling under slow TCG emulation.
if [ "${QEMU_NODE_SHIM:-0}" = 1 ]; then
  real_node="${QEMU_REAL_NODE:?QEMU_REAL_NODE is required by the node shim}"
  if [ "${1:-}" = --test ]; then
    shift
    exec "$real_node" --test --test-concurrency=1 "$@"
  fi
  exec "$real_node" "$@"
fi

seed_url="${1:?usage: qemu-sandbox-guest.sh <seed-url>}"
source_dir=/home/ci/sciencediscovery
archive=/home/ci/source.tar
test_rc=125

power_off() {
  local command_rc=$?
  trap - EXIT
  if [ "$test_rc" -eq 125 ] && [ "$command_rc" -ne 0 ]; then
    test_rc=$command_rc
  fi
  # Write the authority marker straight to the serial device. cloud-init adds
  # a service prefix to normal stdout, which would make exact host parsing
  # ambiguous among the test process's own output.
  printf '\nQEMU_SANDBOX_TEST_RESULT=%s\n' "$test_rc" > /dev/ttyS0
  sync || true
  systemctl poweroff --force --force || poweroff -f || true
  exit "$test_rc"
}
trap power_off EXIT

echo "=== QEMU sandbox guest ==="
echo "kernel  : $(uname -srm)"
echo "machine : $(uname -m)"
echo "kvm     : irrelevant (the host selected TCG before boot)"

curl --fail --location --retry 3 --silent --show-error \
  "$seed_url/source.tar" --output "$archive"
rm -rf -- "$source_dir"
mkdir -p "$source_dir"
tar -xf "$archive" -C "$source_dir"
chown -R ci:ci "$source_dir"

# Ubuntu 24.04's AppArmor policy restricts unprivileged user namespaces by
# default. The VM has its own kernel and policy, so changing this guest-only
# setting does not need privileges from the CodeArts container host.
sysctl --write kernel.apparmor_restrict_unprivileged_userns=0 || true

set +e
runuser --user ci -- env \
  CI_BINARY_CACHE_URL="${CI_BINARY_CACHE_URL:-https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/toolchains/v1}" \
  CI_NPM_REGISTRY="${CI_NPM_REGISTRY:-https://repo.huaweicloud.com/repository/npm/}" \
  CI_PYPI_INDEX="${CI_PYPI_INDEX:-https://repo.huaweicloud.com/repository/pypi/simple}" \
  HOME=/home/ci \
  bash -c '
    set -Eeuo pipefail
    cd /home/ci/sciencediscovery
    export CI_BINARY_CACHE_DIR=/home/ci/.cache/sciencediscovery/toolchains
    export CI_RESULTS_DIR=/home/ci/ci-results
    export CI_RUNTIME_DIR=/home/ci/ci-runtime
    export UV_DEFAULT_INDEX="$CI_PYPI_INDEX"
    bash .ci/provision-runner.sh --sandbox
    export PATH="$HOME/.local/node/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"
    # Pure TCG can stretch concurrent timing enough to turn disconnect cleanup
    # into an unrelated EPIPE race. Serialize test files without skipping or
    # changing any Runner assertion.
    export QEMU_REAL_NODE="$(command -v node)"
    export QEMU_NODE_SHIM=1
    mkdir -p "$HOME/.local/qemu-node-shim"
    ln -sfn /usr/local/sbin/qemu-sandbox-guest "$HOME/.local/qemu-node-shim/node"
    export PATH="$HOME/.local/qemu-node-shim:$PATH"
    echo "=== sandbox preflight as ci ==="
    bwrap --ro-bind / / --dev /dev true
    pnpm ci:ut:runner
  '
test_rc=$?
set -e

if [ -f /home/ci/ci-results/ut-runner/summary.json ]; then
  echo "=== Runner UT summary ==="
  cat /home/ci/ci-results/ut-runner/summary.json
fi
exit "$test_rc"
