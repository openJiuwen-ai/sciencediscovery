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

# Boots the pinned Ubuntu image once under software-only QEMU, installs the
# stable Runner toolchain, then emits a checksum-pinned reusable qcow2 image.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
base_image=""
output_dir=""

usage() {
  cat <<'EOF'
Usage: .ci/build-qemu-runner-image.sh --base-image <path> --output-dir <dir>

Environment:
  QEMU_IMAGE_BUILD_TIMEOUT_SECONDS  Guest provisioning limit (default: 3300)
  RESOURCE_BUILD_COMMIT             Resource branch commit recorded in VERSION
  RESOURCE_BUILD_RUN_ID             Pipeline run recorded in VERSION
EOF
}

while (($#)); do
  case "$1" in
    --base-image) base_image="${2:?--base-image requires a value}"; shift 2 ;;
    --output-dir) output_dir="${2:?--output-dir requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -s "$base_image" ]] || { echo "--base-image must name a non-empty file." >&2; exit 2; }
[[ -n "$output_dir" ]] || { echo "--output-dir is required." >&2; exit 2; }
[[ "${QEMU_IMAGE_BUILD_TIMEOUT_SECONDS:-3300}" =~ ^[1-9][0-9]*$ ]] \
  || { echo "QEMU_IMAGE_BUILD_TIMEOUT_SECONDS must be a positive integer." >&2; exit 2; }
[[ "$(uname -m)" == x86_64 ]] \
  || { echo "FATAL: the QEMU Runner image builder requires an x86_64 host." >&2; exit 1; }
for command in curl python3 sha256sum tar timeout; do
  command -v "$command" >/dev/null 2>&1 \
    || { echo "FATAL: required host command '$command' is unavailable." >&2; exit 1; }
done

mkdir -p -- "$output_dir"
work_dir="$output_dir/.build"
cache_dir="$output_dir/.qemu-cache"
seed_dir="$work_dir/seed"
serial_log="$work_dir/serial.log"
image_name=ScienceDiscovery-qemu-runner-noble-amd64.qcow2
image_path="$output_dir/$image_name"
compacted_image="$work_dir/$image_name"
http_pid=""

cleanup() {
  if [[ -n "$http_pid" ]] && kill -0 "$http_pid" 2>/dev/null; then
    kill "$http_pid" 2>/dev/null || true
    wait "$http_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -rf -- "$work_dir"
mkdir -p -- "$seed_dir" "$cache_dir"

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
  alpine_release=v3.22
  alpine_bootstrap_release=v3.23
  alpine_mirror=https://mirrors.tuna.tsinghua.edu.cn/alpine
  bootstrap_dir="$cache_dir/alpine-bootstrap"
  apk_tools_file="$cache_dir/apk-tools-static-3.0.8-r0.apk"
  apk_tools_url="$alpine_mirror/$alpine_bootstrap_release/main/x86_64/apk-tools-static-3.0.8-r0.apk"
  apk_tools_sha256=2edccd3267ce540f8d2371a0f394e84b40d8348ecc28425309e6d07079ed1259
  alpine_keys_file="$cache_dir/alpine-keys-2.5-r0.apk"
  alpine_keys_url="$alpine_mirror/$alpine_release/main/x86_64/alpine-keys-2.5-r0.apk"
  alpine_keys_sha256=1069fa68769607690e46b0d689f1ad9b5e346be2752ece313685b4f29ec70e25
  alpine_signing_key=alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub
  ca_bundle_file="$cache_dir/ca-certificates-bundle-20260611-r0.apk"
  ca_bundle_url="$alpine_mirror/$alpine_release/main/x86_64/ca-certificates-bundle-20260611-r0.apk"
  ca_bundle_sha256=a18fd1bd8bea03966ee5719aa61e44d9a810db2c8b6641b45f92b30e860f0927

  download_verified() {
    local url=$1 destination=$2 expected_sha256=$3
    if [[ -f "$destination" ]] \
      && printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum --check --status; then
      return
    fi
    rm -f -- "$destination" "$destination.part"
    curl --fail --location --retry 3 --show-error "$url" --output "$destination.part"
    printf '%s  %s\n' "$expected_sha256" "$destination.part" \
      | sha256sum --check --status \
      || { echo "FATAL: checksum mismatch for $url" >&2; exit 1; }
    mv -- "$destination.part" "$destination"
  }

  extract_archive_member() {
    local archive=$1
    shift
    local extract_log="$cache_dir/archive-extract.log"
    if ! tar -xzf "$archive" -C "$bootstrap_dir" "$@" 2> "$extract_log"; then
      cat "$extract_log" >&2
      echo "FATAL: could not extract the portable QEMU bootstrap." >&2
      exit 1
    fi
  }

  qemu_binary="$qemu_root/usr/bin/qemu-system-x86_64"
  qemu_img="$qemu_root/usr/bin/qemu-img"
  qemu_loader="$qemu_root/lib/ld-musl-x86_64.so.1"
  echo "Preparing signed Alpine QEMU packages without installing host packages"
  download_verified "$apk_tools_url" "$apk_tools_file" "$apk_tools_sha256"
  download_verified "$alpine_keys_url" "$alpine_keys_file" "$alpine_keys_sha256"
  download_verified "$ca_bundle_url" "$ca_bundle_file" "$ca_bundle_sha256"
  rm -rf -- "$bootstrap_dir" "$qemu_root"
  mkdir -p -- "$bootstrap_dir" "$qemu_root"
  extract_archive_member "$apk_tools_file" sbin/apk.static
  extract_archive_member "$alpine_keys_file" "usr/share/apk/keys/$alpine_signing_key"
  extract_archive_member "$ca_bundle_file" etc/ssl/certs/ca-certificates.crt
  ca_bundle="$bootstrap_dir/etc/ssl/certs/ca-certificates.crt"
  [[ -s "$ca_bundle" ]] || { echo "FATAL: verified TLS CA bundle is missing." >&2; exit 1; }
  SSL_CERT_FILE="$ca_bundle" "$bootstrap_dir/sbin/apk.static" \
    --root "$qemu_root" \
    --arch x86_64 \
    --keys-dir "$bootstrap_dir/usr/share/apk/keys" \
    --repository "$alpine_mirror/$alpine_release/main" \
    --repository "$alpine_mirror/$alpine_release/community" \
    --initdb --no-cache --no-scripts --no-chown \
    add qemu-system-x86_64 qemu-img
  qemu_command=(
    env "QEMU_MODULE_DIR=$qemu_root/usr/lib/qemu"
    "$qemu_loader" --library-path "$qemu_root/lib:$qemu_root/usr/lib" "$qemu_binary"
  )
  qemu_img_command=(
    env "QEMU_MODULE_DIR=$qemu_root/usr/lib/qemu"
    "$qemu_loader" --library-path "$qemu_root/lib:$qemu_root/usr/lib" "$qemu_img"
  )
  qemu_firmware=(-L "$qemu_root/usr/share/qemu" -bios "$qemu_root/usr/share/qemu/bios-256k.bin")
fi

"${qemu_command[@]}" --version
"${qemu_img_command[@]}" --version

cp --reflink=auto -- "$base_image" "$image_path"
"${qemu_img_command[@]}" resize "$image_path" 16G
cp -- "$script_dir/provision-qemu-runner-image.sh" "$seed_dir/provision.sh"
printf 'instance-id: sciencediscovery-qemu-runner-v1\nlocal-hostname: resource-builder\n' > "$seed_dir/meta-data"
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
  - ca-certificates
  - curl
  - git
  - python3
  - xz-utils
runcmd:
  - [bash, -c, "curl --fail --location --retry 3 --silent --show-error http://10.0.2.2:QEMU_HTTP_PORT/provision.sh --output /usr/local/sbin/provision-qemu-runner-image && chmod 0755 /usr/local/sbin/provision-qemu-runner-image && /usr/local/sbin/provision-qemu-runner-image"]
CLOUD_CONFIG

http_port=$((19080 + ($$ % 1000)))
sed -i "s/QEMU_HTTP_PORT/$http_port/g" "$seed_dir/user-data"
python3 -m http.server "$http_port" --bind 0.0.0.0 --directory "$seed_dir" &
http_pid=$!
kill -0 "$http_pid" 2>/dev/null \
  || { echo "FATAL: could not start cloud-init server on port $http_port." >&2; exit 1; }

echo "Booting the resource-builder guest with QEMU TCG"
set +e
timeout --signal=TERM "${QEMU_IMAGE_BUILD_TIMEOUT_SECONDS:-3300}" \
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
  -drive "if=virtio,format=qcow2,file=$image_path" \
  -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:$http_port/" \
  2>&1 | tee "$serial_log"
qemu_rc=${PIPESTATUS[0]}
set -e

marker="$(tr -d '\r' < "$serial_log" \
  | sed -n 's/^QEMU_RESOURCE_IMAGE_RESULT=\([0-9][0-9]*\)$/\1/p' \
  | tail -n 1)"
if [[ -z "$marker" ]]; then
  echo "FATAL: guest exited without a provisioning marker (QEMU status $qemu_rc)." >&2
  exit 1
fi
if [[ "$qemu_rc" -ne 0 ]]; then
  echo "FATAL: QEMU exited with status $qemu_rc after guest marker $marker." >&2
  exit 1
fi
if [[ "$marker" -ne 0 ]]; then
  echo "FATAL: guest provisioning failed with status $marker (QEMU status $qemu_rc)." >&2
  exit "$marker"
fi

"${qemu_img_command[@]}" check "$image_path"
"${qemu_img_command[@]}" convert -p -O qcow2 "$image_path" "$compacted_image"
mv -- "$compacted_image" "$image_path"
(
  cd -- "$output_dir"
  sha256sum "$image_name" > SHA256SUMS
)
cat > "$output_dir/VERSION" <<EOF
recipe=qemu-runner-v1
base_image=noble-server-cloudimg-amd64.img
base_sha256=d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30
node=22.19.0
pnpm=11.1.2
uv=0.9.26
system_packages=bubblewrap,ca-certificates,curl,git,python3,xz-utils
resource_commit=${RESOURCE_BUILD_COMMIT:-unknown}
resource_run_id=${RESOURCE_BUILD_RUN_ID:-unknown}
EOF
rm -rf -- "$work_dir" "$cache_dir"
echo "QEMU Runner image created: $image_path"
cat "$output_dir/SHA256SUMS"
