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

# Runs once inside the resource-builder VM. Stable, checksum-pinned tools are
# installed for the unprivileged `ci` user; repository dependencies remain a
# per-commit concern and are deliberately not baked into this image.

set -Eeuo pipefail

result=125
archive_dir=/var/cache/sciencediscovery-image-build
toolchain_base=https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/toolchains/v1
ci_home=/home/ci

power_off() {
  local command_rc=$?
  trap - EXIT
  if [[ "$result" -eq 125 && "$command_rc" -ne 0 ]]; then
    result=$command_rc
  fi
  printf '\nQEMU_RESOURCE_IMAGE_RESULT=%s\n' "$result" > /dev/ttyS0
  sync || true
  systemctl poweroff --force --force || poweroff -f || true
  exit "$result"
}
trap power_off EXIT

mkdir -p "$archive_dir"
exec > >(tee -a /var/log/sciencediscovery-qemu-image-build.log) 2>&1

download_verified() {
  local filename=$1
  local expected_sha256=$2
  local destination="$archive_dir/$filename"
  local url="${toolchain_base%/}/${filename//+/%2B}"

  rm -f -- "$destination" "$destination.part"
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 900 \
    --show-error "$url" --output "$destination.part"
  printf '%s  %s\n' "$expected_sha256" "$destination.part" \
    | sha256sum --check --status \
    || { echo "FATAL: checksum mismatch for $filename" >&2; return 1; }
  mv -- "$destination.part" "$destination"
  printf '%s\n' "$destination"
}

id ci >/dev/null 2>&1 || { echo "FATAL: cloud-init did not create user ci." >&2; exit 1; }

node_version=22.19.0
node_filename=node-v22.19.0-linux-x64.tar.xz
node_sha256=c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2
node_archive="$(download_verified "$node_filename" "$node_sha256")"
rm -rf -- "$ci_home/.local/node"
mkdir -p "$ci_home/.local/node"
tar -xJf "$node_archive" -C "$ci_home/.local/node" --strip-components=1

pnpm_version=11.1.2
pnpm_filename=pnpm-11.1.2.tgz
pnpm_sha256=bfe4d2b2c7a3210565bba62929f9efe493eb5f24627201a102ea4514eae8cf80
pnpm_archive="$(download_verified "$pnpm_filename" "$pnpm_sha256")"
pnpm_home="$ci_home/.local/share/pnpm"
pnpm_install="$pnpm_home/.tools/pnpm/$pnpm_version"
rm -rf -- "$pnpm_install"
mkdir -p "$pnpm_install"
tar -xzf "$pnpm_archive" -C "$pnpm_install" --strip-components=1
test -x "$pnpm_install/bin/pnpm.mjs"
ln -sfn "$pnpm_install/bin/pnpm.mjs" "$pnpm_home/pnpm"
ln -sfn "$pnpm_install/bin/pnpx.mjs" "$pnpm_home/pnpx"

uv_version=0.9.26
uv_filename=uv-0.9.26-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
uv_sha256=b7e89798bd3df7dcc4b2b4ac4e2fc11d6b3ff4fe7d764aa3012d664c635e2922
uv_archive="$(download_verified "$uv_filename" "$uv_sha256")"
uv_install="$ci_home/.local/share/uv/$uv_version"
rm -rf -- "$uv_install"
mkdir -p "$uv_install" "$ci_home/.local/bin"
python3 -m zipfile -e "$uv_archive" "$uv_install"
uv_scripts="$uv_install/uv-$uv_version.data/scripts"
mkdir -p "$uv_install/bin"
cp -f -- "$uv_scripts/uv" "$uv_scripts/uvx" "$uv_install/bin/"
chmod 0755 "$uv_install/bin/uv" "$uv_install/bin/uvx"
ln -sfn "$uv_install/bin/uv" "$ci_home/.local/bin/uv"
ln -sfn "$uv_install/bin/uvx" "$ci_home/.local/bin/uvx"

chown -R ci:ci "$ci_home/.local"
cat > /etc/profile.d/sciencediscovery-ci.sh <<'PROFILE'
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$HOME/.local/node/bin:$PNPM_HOME:$HOME/.local/bin:$PATH"
PROFILE
chmod 0644 /etc/profile.d/sciencediscovery-ci.sh

# Persist the guest-only policy required by bubblewrap. The formal runner also
# applies it defensively before testing.
cat > /etc/sysctl.d/90-sciencediscovery-ci.conf <<'SYSCTL'
kernel.apparmor_restrict_unprivileged_userns=0
SYSCTL
sysctl --system >/dev/null

ci_path="$ci_home/.local/node/bin:$pnpm_home:$ci_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
runuser --user ci -- env HOME="$ci_home" PATH="$ci_path" bash -c '
  set -e
  test "$(node --version)" = v22.19.0
  test "$(pnpm --version)" = 11.1.2
  test "$(uv --version)" = "uv 0.9.26"
  bwrap --ro-bind / / --dev /dev true
'

cat > /etc/sciencediscovery-qemu-runner-image <<EOF
recipe=qemu-runner-v1
ubuntu=noble-20260826
node=$node_version
pnpm=$pnpm_version
uv=$uv_version
bubblewrap=$(bwrap --version | awk '{print $2}')
EOF
chmod 0644 /etc/sciencediscovery-qemu-runner-image

apt-get clean
rm -rf -- "$archive_dir" /var/lib/apt/lists
mkdir -p /var/lib/apt/lists/partial
echo "Pre-provisioned QEMU runner image is ready."
cat /etc/sciencediscovery-qemu-runner-image
result=0
