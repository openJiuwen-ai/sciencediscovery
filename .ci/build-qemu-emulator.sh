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

# Assembles the portable, user-space QEMU emulator the test pipeline boots its
# guests with, and publishes it as one verifiable tarball.
#
# The test jobs used to run this apk bootstrap themselves on every run: about
# 166 seconds of downloading and unpacking 52 Alpine packages, repeated by each
# guest job, on a runner that cannot install host packages anyway. This branch
# owns that work once. The result is a relocatable tree of a musl loader, the
# QEMU binaries, their libraries and firmware, so a consumer only downloads,
# verifies and extracts it.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# One definition for the names, versions and locations every resource script
# has to agree on.
# shellcheck source=.ci/qemu-resources.sh
source "$script_dir/qemu-resources.sh"

output_dir=""
work_dir=""

usage() {
  cat <<'EOF'
Usage: .ci/build-qemu-emulator.sh --output-dir <dir> [--work-dir <dir>]

Environment:
  RESOURCE_BUILD_COMMIT  Resource branch commit recorded in VERSION
  RESOURCE_BUILD_RUN_ID  Pipeline run recorded in VERSION
EOF
}

while (($#)); do
  case "$1" in
    --output-dir) output_dir="${2:?--output-dir requires a value}"; shift 2 ;;
    --work-dir) work_dir="${2:?--work-dir requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$output_dir" ]] || { echo "--output-dir is required." >&2; exit 2; }
mkdir -p -- "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
work_dir="${work_dir:-$output_dir/.build}"
mkdir -p -- "$work_dir"
work_dir="$(cd -- "$work_dir" && pwd)"

if [[ "$(uname -m)" != x86_64 ]]; then
  echo "FATAL: the portable QEMU payload is built for x86_64 hosts only." >&2
  exit 1
fi
for command in curl sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 \
    || { echo "FATAL: required host command '$command' is unavailable." >&2; exit 1; }
done

# Pinned exactly as the consumer used to pin them, so this payload is the same
# software the test jobs were assembling for themselves.
alpine_release=v3.22
alpine_bootstrap_release=v3.23
alpine_mirror=https://mirrors.tuna.tsinghua.edu.cn/alpine
bootstrap_dir="$work_dir/alpine-bootstrap"
qemu_root="$work_dir/qemu-root"
apk_tools_file="$work_dir/apk-tools-static-3.0.8-r0.apk"
apk_tools_url="$alpine_mirror/$alpine_bootstrap_release/main/x86_64/apk-tools-static-3.0.8-r0.apk"
apk_tools_sha256=2edccd3267ce540f8d2371a0f394e84b40d8348ecc28425309e6d07079ed1259
alpine_keys_file="$work_dir/alpine-keys-2.5-r0.apk"
alpine_keys_url="$alpine_mirror/$alpine_release/main/x86_64/alpine-keys-2.5-r0.apk"
alpine_keys_sha256=1069fa68769607690e46b0d689f1ad9b5e346be2752ece313685b4f29ec70e25
alpine_signing_key=alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub
ca_bundle_file="$work_dir/ca-certificates-bundle-20260611-r0.apk"
ca_bundle_url="$alpine_mirror/$alpine_release/main/x86_64/ca-certificates-bundle-20260611-r0.apk"
ca_bundle_sha256=a18fd1bd8bea03966ee5719aa61e44d9a810db2c8b6641b45f92b30e860f0927
payload_name="$QEMU_EMULATOR_PAYLOAD_NAME"

download_verified() {
  local url=$1 destination=$2 expected_sha256=$3
  if [[ -f "$destination" ]] \
    && printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum --check --status; then
    return
  fi
  rm -f -- "$destination" "$destination.part"
  curl --fail --location --retry 3 --show-error "$url" --output "$destination.part"
  printf '%s  %s\n' "$expected_sha256" "$destination.part" | sha256sum --check --status \
    || { echo "FATAL: checksum mismatch for $url" >&2; exit 1; }
  mv -- "$destination.part" "$destination"
}

extract_archive_member() {
  local archive=$1
  shift
  local extract_log="$work_dir/archive-extract.log"
  if ! tar -xzf "$archive" -C "$bootstrap_dir" "$@" 2> "$extract_log"; then
    cat "$extract_log" >&2
    echo "FATAL: could not extract the Alpine bootstrap." >&2
    exit 1
  fi
}

echo "=== assembling the portable QEMU emulator ==="
download_verified "$apk_tools_url" "$apk_tools_file" "$apk_tools_sha256"
download_verified "$alpine_keys_url" "$alpine_keys_file" "$alpine_keys_sha256"
download_verified "$ca_bundle_url" "$ca_bundle_file" "$ca_bundle_sha256"
rm -rf -- "$bootstrap_dir" "$qemu_root"
mkdir -p -- "$bootstrap_dir" "$qemu_root"
extract_archive_member "$apk_tools_file" sbin/apk.static
extract_archive_member "$alpine_keys_file" "usr/share/apk/keys/$alpine_signing_key"
extract_archive_member "$ca_bundle_file" etc/ssl/certs/ca-certificates.crt
ca_bundle="$bootstrap_dir/etc/ssl/certs/ca-certificates.crt"
[[ -s "$ca_bundle" ]] || { echo "FATAL: the verified TLS CA bundle is empty or missing." >&2; exit 1; }

# The CA bundle authenticates the mirror's certificate; the signing key
# independently authenticates the Alpine indexes and packages.
SSL_CERT_FILE="$ca_bundle" "$bootstrap_dir/sbin/apk.static" \
  --root "$qemu_root" \
  --arch x86_64 \
  --keys-dir "$bootstrap_dir/usr/share/apk/keys" \
  --repository "$alpine_mirror/$alpine_release/main" \
  --repository "$alpine_mirror/$alpine_release/community" \
  --initdb \
  --no-cache \
  --no-scripts \
  --no-chown \
  add qemu-system-x86_64 qemu-img

qemu_binary="$qemu_root/usr/bin/qemu-system-x86_64"
qemu_img="$qemu_root/usr/bin/qemu-img"
qemu_loader="$qemu_root/lib/ld-musl-x86_64.so.1"
for required in "$qemu_binary" "$qemu_img" "$qemu_loader"; do
  [[ -x "$required" ]] || { echo "FATAL: the assembled payload is missing $required." >&2; exit 1; }
done

# Prove the payload runs from an arbitrary directory before publishing it; a
# consumer that has to discover this after a download has already paid for the
# whole guest boot.
run_from_payload() {
  env "QEMU_MODULE_DIR=$qemu_root/usr/lib/qemu" "$qemu_loader" \
    --library-path "$qemu_root/lib:$qemu_root/usr/lib" "$@"
}
run_from_payload "$qemu_binary" --version
run_from_payload "$qemu_img" --version
[[ -f "$qemu_root/usr/share/qemu/bios-256k.bin" ]] \
  || { echo "FATAL: the assembled payload has no QEMU firmware." >&2; exit 1; }

qemu_version="$(run_from_payload "$qemu_binary" --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')"
[[ -n "$qemu_version" ]] || { echo "FATAL: could not read the assembled QEMU version." >&2; exit 1; }

# Pack reproducibly: fixed timestamps, ownership and member order, and no
# compression layer, whose output is the part that varies between tool
# versions. The payload then depends only on the pinned Alpine packages, so a
# consumer can commit this checksum before the first publish and a rerun
# republishes identical bytes. var/log holds apk's own install log, the one
# file carrying the build's wall-clock time; nothing in it is needed to run
# QEMU. In-region OBS makes the extra megabytes cheaper than the risk.
rm -f -- "$output_dir/$payload_name"
tar --create --format=pax \
  --pax-option='exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime' \
  --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --exclude=./var/log \
  --directory "$qemu_root" --file "$output_dir/$payload_name" .
(
  cd "$output_dir"
  sha256sum "$payload_name" > SHA256SUMS
  sha256sum --check SHA256SUMS
)
cat > "$output_dir/VERSION" <<EOF
recipe=$QEMU_EMULATOR_RECIPE
alpine_release=$alpine_release
alpine_bootstrap_release=$alpine_bootstrap_release
qemu=$qemu_version
packages=qemu-system-x86_64,qemu-img
resource_commit=${RESOURCE_BUILD_COMMIT:-unknown}
resource_run_id=${RESOURCE_BUILD_RUN_ID:-unknown}
EOF
rm -rf -- "$work_dir"
echo "QEMU emulator payload created: $output_dir/$payload_name"
cat "$output_dir/SHA256SUMS"
