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

# Runs `pnpm ci:ut:runner` in an Ubuntu guest under QEMU's software-only TCG
# accelerator. A full guest kernel supplies the user/mount namespaces denied
# by containerized CodeArts hosts; /dev/kvm is deliberately not required.

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
results_root="${CI_RESULTS_DIR:-$repo_root/.ci-results}"
case "$results_root" in
  /*) ;;
  *) results_root="$repo_root/$results_root" ;;
esac
result_dir="$results_root/ut-runner-qemu"
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

for command in apt-get curl dpkg-deb git python3 sha256sum tar timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FATAL: required host command '$command' is unavailable." >&2
    exit 1
  fi
done
if [ "$(uname -m)" != x86_64 ]; then
  echo "FATAL: this experiment currently supports only an x86_64 QEMU host." >&2
  exit 1
fi

echo "=== QEMU TCG host ==="
echo "kernel : $(uname -srm)"
echo "kvm    : $([ -e /dev/kvm ] && echo present-but-unused || echo absent-and-not-required)"
echo "mode   : full-system emulation with a guest kernel"

qemu_root="$cache_dir/qemu-root"
qemu_binary=
qemu_img=
qemu_env=()
qemu_firmware=()
if command -v qemu-system-x86_64 >/dev/null 2>&1 \
  && command -v qemu-img >/dev/null 2>&1; then
  qemu_binary="$(command -v qemu-system-x86_64)"
  qemu_img="$(command -v qemu-img)"
else
  package_dir="$cache_dir/qemu-packages"
  mkdir -p "$package_dir" "$qemu_root"
  packages=(
    ipxe-qemu
    libdaxctl1
    libfdt1
    libkmod2
    libndctl6
    libpmem1
    qemu-system-common
    qemu-system-data
    qemu-system-x86
    qemu-utils
    seabios
  )
  if ! compgen -G "$package_dir/qemu-system-x86_*.deb" >/dev/null; then
    echo "Downloading QEMU packages without installing them on the host"
    (
      cd "$package_dir"
      apt-get download "${packages[@]}"
    )
  fi
  rm -rf -- "$qemu_root"
  mkdir -p "$qemu_root"
  for package_file in "$package_dir"/*.deb; do
    dpkg-deb --extract "$package_file" "$qemu_root"
  done
  qemu_binary="$qemu_root/usr/bin/qemu-system-x86_64"
  qemu_img="$qemu_root/usr/bin/qemu-img"
  qemu_env=(
    "LD_LIBRARY_PATH=$qemu_root/usr/lib/x86_64-linux-gnu"
    "QEMU_MODULE_DIR=$qemu_root/usr/lib/x86_64-linux-gnu/qemu"
  )
  qemu_firmware=(
    -L "$qemu_root/usr/share/qemu"
    -bios "$qemu_root/usr/share/seabios/bios-256k.bin"
  )
fi
if ! env "${qemu_env[@]}" "$qemu_binary" --version; then
  echo "FATAL: the user-space QEMU bootstrap is not runnable on this host." >&2
  if command -v ldd >/dev/null 2>&1; then
    ldd "$qemu_binary" || true
  fi
  exit 1
fi
env "${qemu_env[@]}" "$qemu_img" --version

image_name=noble-server-cloudimg-amd64.img
image_path="$cache_dir/$image_name"
image_url=https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/noble/20260826/noble-server-cloudimg-amd64.img
image_sha256=d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30
if [ -f "$image_path" ] && printf '%s  %s\n' "$image_sha256" "$image_path" | sha256sum --check --status; then
  echo "Using the verified cached Ubuntu cloud image"
else
  rm -f -- "$image_path"
  echo "Downloading the pinned Ubuntu cloud image from TUNA"
  curl --fail --location --retry 3 --show-error \
    "$image_url" --output "$image_path"
  printf '%s  %s\n' "$image_sha256" "$image_path" | sha256sum --check --status \
    || { echo "FATAL: Ubuntu cloud image checksum mismatch." >&2; exit 1; }
fi

# The published cloud image is deliberately compact. A disposable overlay
# gives package installation and pnpm enough room while keeping the pinned base
# immutable; Ubuntu cloud-init grows its root partition and filesystem at boot.
rm -f -- "$guest_disk"
env "${qemu_env[@]}" "$qemu_img" create \
  -f qcow2 -F qcow2 -b "$image_path" "$guest_disk" 16G

git -C "$repo_root" archive --format=tar HEAD > "$seed_dir/source.tar"
cp "$repo_root/.ci/qemu-sandbox-guest.sh" "$seed_dir/guest.sh"
printf 'instance-id: sciencediscovery-qemu-sandbox\nlocal-hostname: sandbox-ut\n' > "$seed_dir/meta-data"
: > "$seed_dir/vendor-data"
cat > "$seed_dir/user-data" <<'CLOUD_CONFIG'
#cloud-config
users:
  - default
  - name: ci
    gecos: CI Runner
    groups: [adm, sudo]
    lock_passwd: true
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
apt:
  preserve_sources_list: false
  primary:
    - arches: [amd64]
      uri: https://mirrors.tuna.tsinghua.edu.cn/ubuntu
package_update: true
packages:
  - bubblewrap
runcmd:
  - [bash, -c, "curl --fail --location --retry 3 --silent --show-error http://10.0.2.2:QEMU_HTTP_PORT/guest.sh --output /usr/local/sbin/qemu-sandbox-guest && chmod 0755 /usr/local/sbin/qemu-sandbox-guest && /usr/local/sbin/qemu-sandbox-guest http://10.0.2.2:QEMU_HTTP_PORT"]
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
env "${qemu_env[@]}" \
  CI_BINARY_CACHE_URL="${CI_BINARY_CACHE_URL:-}" \
  CI_NPM_REGISTRY="${CI_NPM_REGISTRY:-}" \
  CI_PYPI_INDEX="${CI_PYPI_INDEX:-}" \
  timeout --signal=TERM "${QEMU_TIMEOUT_SECONDS:-7200}" \
  "$qemu_binary" \
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
  echo "FATAL: the guest exited without a Runner UT result marker (QEMU status $qemu_rc)." >&2
  exit 1
fi
if [ "$marker" -gt 255 ]; then
  echo "FATAL: the guest returned invalid Runner UT status '$marker'." >&2
  exit 1
fi
echo "Runner UT guest result: $marker (QEMU status $qemu_rc)"
exit "$marker"
