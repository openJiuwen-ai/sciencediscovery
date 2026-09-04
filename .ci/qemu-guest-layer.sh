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

# Runs one repository test layer inside the full Linux guest started by
# run-qemu-layer.sh. The host has already installed dependencies and built the
# workspace and hands both over in the payload, so this script only unpacks and
# tests. It must run as root so it can give the checkout to the
# pre-provisioned, unprivileged `ci` user.

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

seed_url="${1:?usage: qemu-guest-layer.sh <seed-url>}"
source_dir=/home/ci/sciencediscovery
env_file=/home/ci/layer-env
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

fetch() {
  curl --fail --location --retry 3 --silent --show-error "$seed_url/$1" "${@:2}"
}

layer="$(fetch layer)"
layer_env=()
case "$layer" in
  ut-guest)
    layer_script=ci:ut:guest
    ;;
  e2e)
    layer_script=ci:e2e
    # The stack is started here, but nothing is installed here: the host ran
    # the same entry point with CI_E2E_PREPARE_ONLY=1. Emulated services need
    # far longer than the native health budget to answer.
    layer_env+=(CI_E2E_PREPARED=1 CI_E2E_BROWSERS_DIR=.e2e/browsers CI_E2E_STACK_TIMEOUT_SECONDS=1800)
    ;;
  *) echo "FATAL: the host asked for an unknown layer '$layer'." >&2; exit 2 ;;
esac

echo "=== QEMU sandbox guest ==="
echo "layer   : $layer ($layer_script)"
echo "kernel  : $(uname -srm)"
echo "machine : $(uname -m)"
echo "kvm     : irrelevant (the host selected TCG before boot)"

# Stream the payload straight into place: writing a multi-hundred-megabyte
# archive to the emulated disk first would double the slowest step here.
rm -rf -- "$source_dir"
mkdir -p "$source_dir"
fetch workspace.tar.gz | tar -xzf - -C "$source_dir"
chown -R ci:ci "$source_dir"
fetch layer-env --output "$env_file"

# Only the mirror and behaviour settings the host allow-listed cross over.
guest_env=(HOME=/home/ci)
while IFS='=' read -r name value; do
  case "$name" in
    CI_NPM_REGISTRY|UV_DEFAULT_INDEX|UV_PYTHON_INSTALL_MIRROR|E2E_SCIENTIFIC_ENVS|CI_E2E_STACK_TIMEOUT_SECONDS)
      guest_env+=("$name=$value")
      ;;
    "") ;;
    *) echo "ignoring unexpected guest environment entry: $name" >&2 ;;
  esac
done < "$env_file"

# Keep the image's persisted guest-only userns policy defensive against a
# boot that did not apply every sysctl.d entry before cloud-init runcmd.
sysctl --write kernel.apparmor_restrict_unprivileged_userns=0 || true

set +e
# The layer defaults come first so an allow-listed value from the host, which
# `env` applies afterwards, wins.
runuser --user ci -- env \
  ${layer_env[@]+"${layer_env[@]}"} \
  "${guest_env[@]}" \
  "QEMU_LAYER_SCRIPT=$layer_script" \
  bash -c '
    set -Eeuo pipefail
    cd /home/ci/sciencediscovery
    export CI_RESULTS_DIR=/home/ci/ci-results
    export CI_RUNTIME_DIR=/home/ci/ci-runtime
    export PATH="$HOME/.local/node/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"
    test "$(node --version)" = v22.19.0
    test "$(pnpm --version)" = 11.1.2
    test "$(uv --version)" = "uv 0.9.26"
    grep -Fx "recipe=qemu-runner-v1" /etc/sciencediscovery-qemu-runner-image
    registry="${CI_NPM_REGISTRY:-https://repo.huaweicloud.com/repository/npm/}"
    npm config set registry "${registry%/}/" --location=user
    # The workspace arrived installed and built. pnpm 11 otherwise re-verifies
    # the dependency tree before running a script and can reinstall it, which
    # is exactly the emulated work this handover exists to remove.
    export npm_config_verify_deps_before_run=false
    # Pure TCG can stretch concurrent timing enough to turn disconnect cleanup
    # into an unrelated EPIPE race. Serialize test files without skipping or
    # changing any assertion.
    export QEMU_REAL_NODE="$(command -v node)"
    export QEMU_NODE_SHIM=1
    mkdir -p "$HOME/.local/qemu-node-shim"
    ln -sfn /usr/local/sbin/qemu-guest-layer "$HOME/.local/qemu-node-shim/node"
    export PATH="$HOME/.local/qemu-node-shim:$PATH"
    echo "=== sandbox preflight as ci ==="
    bwrap --ro-bind / / --dev /dev true
    pnpm "$QEMU_LAYER_SCRIPT"
  '
test_rc=$?
set -e

# run-layer.mjs writes summary.json; the E2E entry point writes summary.txt.
for summary in "/home/ci/ci-results/$layer/summary.json" "/home/ci/ci-results/$layer/summary.txt"; do
  if [ -f "$summary" ]; then
    echo "=== $layer summary ==="
    cat "$summary"
  fi
done
exit "$test_rc"
