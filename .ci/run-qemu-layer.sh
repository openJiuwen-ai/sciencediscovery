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

# Runs one repository test layer in a pre-provisioned Ubuntu guest under QEMU's
# software-only TCG accelerator. A full guest kernel supplies the user/mount
# namespaces denied by containerized CodeArts hosts; /dev/kvm is deliberately
# not required.
#
# This host installs and builds; the guest only runs tests. Emulated CPU is
# far slower than native, so every second spent compiling inside the guest is
# wasted: the prepared workspace is packed here and handed over ready to test.

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
layer="${1:-}"
pack_arguments=()
case "$layer" in
  ut-guest)
    layer_prerequisites=(node_modules services/runner/dist)
    # The sandbox packages have no external runtime dependency: pnpm links
    # their workspace dependencies straight at the package directories, so the
    # installed tree's ~26,000 entries would be unpacked and never read.
    pack_arguments=(--dependencies workspace)
    ;;
  e2e)
    # The browser journeys additionally need the built UI and the .e2e
    # environment, whose Playwright install and pinned Chromium the host
    # produced with `CI_E2E_PREPARE_ONLY=1 pnpm ci:e2e`.
    layer_prerequisites=(node_modules apps/web/dist .e2e/node_modules .e2e/browsers)
    # The stack this guest starts runs the real services, which do have
    # external dependencies, so this layer keeps the installed tree.
    pack_arguments=(--dependencies full --include .e2e)
    ;;
  "") echo "Usage: .ci/run-qemu-layer.sh ut-guest|e2e" >&2; exit 2 ;;
  *) echo "FATAL: '$layer' is not a layer this guest runs." >&2; exit 2 ;;
esac

results_root="${CI_RESULTS_DIR:-$repo_root/.ci-results}"
case "$results_root" in
  /*) ;;
  *) results_root="$repo_root/$results_root" ;;
esac
result_dir="$results_root/$layer"
cache_dir="$results_root/qemu-cache"
seed_dir="$result_dir/seed"
serial_log="$result_dir/serial.log"
run_log="$result_dir/run.log"
exit_file="$result_dir/exit-code"
guest_disk="$result_dir/guest.qcow2"
http_pid=

mkdir -p "$result_dir" "$cache_dir" "$seed_dir"
: > "$run_log"
exec > >(tee -a "$run_log") 2>&1

cleanup() {
  if [ -n "$http_pid" ] && kill -0 "$http_pid" 2>/dev/null; then
    kill "$http_pid" 2>/dev/null || true
    wait "$http_pid" 2>/dev/null || true
  fi
  rm -f -- "$guest_disk"
}

record_exit() {
  local rc=$?
  trap - EXIT
  cleanup
  printf '%s\n' "$rc" > "$exit_file"
  exit "$rc"
}
trap record_exit EXIT

for command in curl git gzip python3 sha256sum tar timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FATAL: required host command '$command' is unavailable." >&2
    exit 1
  fi
done
if [ "$(uname -m)" != x86_64 ]; then
  echo "FATAL: this experiment currently supports only an x86_64 QEMU host." >&2
  exit 1
fi
# Fail before spending minutes on emulation when the handover is incomplete.
for prerequisite in "${layer_prerequisites[@]}"; do
  if [ ! -e "$repo_root/$prerequisite" ]; then
    echo "FATAL: $prerequisite is missing; install and build on this host before running the $layer guest." >&2
    exit 1
  fi
done

echo "=== QEMU TCG host ==="
echo "layer  : $layer"
echo "kernel : $(uname -srm)"
echo "kvm    : $([ -e /dev/kvm ] && echo present-but-unused || echo absent-and-not-required)"
echo "mode   : full-system emulation with a guest kernel"

qemu_root="$cache_dir/qemu-root"
qemu_command=()
qemu_img_command=()
qemu_firmware=()
if command -v qemu-system-x86_64 >/dev/null 2>&1 \
  && command -v qemu-img >/dev/null 2>&1; then
  qemu_command=("$(command -v qemu-system-x86_64)")
  qemu_img_command=("$(command -v qemu-img)")
  echo "Using QEMU provided by the host"
else
  # The portable emulator is assembled once on ci/codearts-resources and
  # published at a stable, checksum-pinned key. Assembling it here cost about
  # 166 seconds of Alpine package downloads and unpacking on every guest job.
  payload="$cache_dir/ScienceDiscovery-qemu-emulator-alpine-x86_64.tar"
  qemu_binary="$qemu_root/usr/bin/qemu-system-x86_64"
  qemu_img="$qemu_root/usr/bin/qemu-img"
  qemu_loader="$qemu_root/lib/ld-musl-x86_64.so.1"
  if [ ! -x "$qemu_binary" ] || [ ! -x "$qemu_img" ] || [ ! -x "$qemu_loader" ]; then
    bash "$repo_root/.ci/fetch-qemu-emulator.sh" --output "$payload"
    rm -rf -- "$qemu_root"
    mkdir -p -- "$qemu_root"
    tar -xf "$payload" -C "$qemu_root"
    for required in "$qemu_binary" "$qemu_img" "$qemu_loader"; do
      if [ ! -x "$required" ]; then
        echo "FATAL: the published QEMU emulator is missing $required." >&2
        exit 1
      fi
    done
  else
    echo "Using the cached portable QEMU payload"
  fi
  qemu_command=(
    env "QEMU_MODULE_DIR=$qemu_root/usr/lib/qemu"
    "$qemu_loader"
    --library-path "$qemu_root/lib:$qemu_root/usr/lib"
    "$qemu_binary"
  )
  qemu_img_command=(
    env "QEMU_MODULE_DIR=$qemu_root/usr/lib/qemu"
    "$qemu_loader"
    --library-path "$qemu_root/lib:$qemu_root/usr/lib"
    "$qemu_img"
  )
  qemu_firmware=(
    -L "$qemu_root/usr/share/qemu"
    -bios "$qemu_root/usr/share/qemu/bios-256k.bin"
  )
fi
if ! "${qemu_command[@]}" --version; then
  echo "FATAL: the user-space QEMU bootstrap is not runnable on this host." >&2
  exit 1
fi
"${qemu_img_command[@]}" --version

image_name=ScienceDiscovery-qemu-runner-noble-amd64.qcow2
image_path="$cache_dir/$image_name"
bash "$repo_root/.ci/fetch-qemu-runner-image.sh" --output "$image_path"

# Keep the checksum-pinned pre-provisioned image immutable. Test dependencies
# and build output are written only to this disposable overlay.
rm -f -- "$guest_disk"
"${qemu_img_command[@]}" create \
  -f qcow2 -F qcow2 -b "$image_path" "$guest_disk" 16G

# The guest receives the commit under test plus the dependency tree and build
# output this host produced, and installs or compiles nothing itself.
bash "$repo_root/.ci/pack-workspace.sh" --output "$seed_dir/workspace.tar.gz" \
  ${pack_arguments[@]+"${pack_arguments[@]}"}
cp "$repo_root/.ci/qemu-guest-layer.sh" "$seed_dir/guest.sh"
printf '%s\n' "$layer" > "$seed_dir/layer"
# Only mirror and behaviour settings cross into the guest; nothing here may
# carry a credential.
: > "$seed_dir/layer-env"
for name in CI_NPM_REGISTRY SCIENCE_AGENT_PYPI_INDEX UV_DEFAULT_INDEX UV_PYTHON_INSTALL_MIRROR E2E_SCIENTIFIC_ENVS CI_E2E_STACK_TIMEOUT_SECONDS; do
  value="$(printenv "$name" || true)"
  case "$value" in
    "") ;;
    *[!-+_.,:/=[:alnum:]]*) echo "FATAL: $name holds characters the guest environment file cannot carry." >&2; exit 1 ;;
    *) printf '%s=%s\n' "$name" "$value" >> "$seed_dir/layer-env" ;;
  esac
done
printf 'instance-id: sciencediscovery-qemu-sandbox\nlocal-hostname: sandbox-ut\n' > "$seed_dir/meta-data"
: > "$seed_dir/vendor-data"
cat > "$seed_dir/user-data" <<'CLOUD_CONFIG'
#cloud-config
runcmd:
  - [bash, -c, "curl --fail --location --retry 3 --silent --show-error http://10.0.2.2:QEMU_HTTP_PORT/guest.sh --output /usr/local/sbin/qemu-guest-layer && chmod 0755 /usr/local/sbin/qemu-guest-layer && /usr/local/sbin/qemu-guest-layer http://10.0.2.2:QEMU_HTTP_PORT"]
CLOUD_CONFIG

http_port=$((18080 + ($$ % 1000)))
sed -i "s/QEMU_HTTP_PORT/$http_port/g" "$seed_dir/user-data"
python3 -m http.server "$http_port" --bind 0.0.0.0 --directory "$seed_dir" &
http_pid=$!
if ! kill -0 "$http_pid" 2>/dev/null; then
  echo "FATAL: could not start the cloud-init seed server on port $http_port." >&2
  exit 1
fi

echo "=== starting Ubuntu guest ==="
echo "accelerator : tcg (KVM is not requested)"
echo "resources   : 4 vCPU, 4096 MiB"
echo "timeout     : ${QEMU_TIMEOUT_SECONDS:-7200} seconds"
set +e
timeout --signal=TERM "${QEMU_TIMEOUT_SECONDS:-7200}" \
  "${qemu_command[@]}" \
  "${qemu_firmware[@]}" \
  -machine q35 \
  -accel tcg,thread=multi \
  -cpu max \
  -smp 4 \
  -m 4096 \
  -nographic \
  -vga none \
  -monitor none \
  -no-reboot \
  -netdev user,id=net0 \
  -device virtio-net-pci,netdev=net0,romfile= \
  -drive "if=virtio,format=qcow2,file=$guest_disk" \
  -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:$http_port/" \
  2>&1 | tee "$serial_log"
qemu_rc=${PIPESTATUS[0]}
set -e

marker="$(tr -d '\r' < "$serial_log" \
  | sed -n 's/^QEMU_SANDBOX_TEST_RESULT=\([0-9][0-9]*\)$/\1/p' \
  | tail -n 1)"
if [ -z "$marker" ]; then
  echo "FATAL: the guest exited without a $layer result marker (QEMU status $qemu_rc)." >&2
  exit 1
fi
if [ "$marker" -gt 255 ]; then
  echo "FATAL: the guest returned invalid $layer status '$marker'." >&2
  exit 1
fi
echo "$layer guest result: $marker (QEMU status $qemu_rc)"
exit "$marker"
