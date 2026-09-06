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

# The facts more than one CI script has to agree on, stated once.
#
# What happens otherwise is on record: the guest image's recipe name lived as a
# literal in two files on the resources branch, one was bumped and the other was
# not, and both guest layers then failed a preflight assertion that printed
# nothing at all. `.ci/ci-contract.test.mjs` fails if any script here spells out
# a value this file owns.
#
# Sourced, not executed. qemu-guest-layer.sh runs inside the guest and is copied
# there on its own, so run-qemu-layer.sh writes these values into the seed and
# the guest reads them back from there.

# The host builds the workspace and the guest tests it, so the two must run the
# same interpreters. All three are already pinned where the product declares
# them -- runtimes.json ships the interpreters a release bundles, and
# package.json's packageManager field is what Corepack reads -- so CI reads
# those rather than keeping a fourth copy that can fall behind.
_ci_constants_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for _ci_constants_pin in package.json scripts/binary-release/runtimes.json; do
  [[ -f "$_ci_constants_root/$_ci_constants_pin" ]] || {
    echo "FATAL: $_ci_constants_pin is missing; CI reads the pinned toolchain versions from it." >&2
    exit 1
  }
done
_ci_constants_versions="$(python3 - "$_ci_constants_root" <<'CI_VERSIONS'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
runtimes = json.loads((root / "scripts/binary-release/runtimes.json").read_text())
package = json.loads((root / "package.json").read_text())
print(runtimes["node"]["version"].removeprefix("v"))
print(package["packageManager"].split("@", 1)[1])
print(runtimes["uv"]["version"])
CI_VERSIONS
)"
{
  read -r CI_NODE_VERSION
  read -r CI_PNPM_VERSION
  read -r CI_UV_VERSION
} <<<"$_ci_constants_versions"
for _ci_constants_version in "$CI_NODE_VERSION" "$CI_PNPM_VERSION" "$CI_UV_VERSION"; do
  [[ "$_ci_constants_version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || {
    echo "FATAL: '$_ci_constants_version' is not a pinned toolchain version." >&2
    exit 1
  }
done
unset _ci_constants_root _ci_constants_versions _ci_constants_version _ci_constants_pin

# Bumped on the resources branch whenever the image contents change. The guest
# refuses an image that announces anything else, which catches a publish that
# never reached OBS before its checksum did.
CI_QEMU_RUNNER_RECIPE=qemu-runner-v2

CI_OBS_CACHE_BASE=https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache
