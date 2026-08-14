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

# Seed the Runner's managed path from the immutable image copy. The Runner
# performs its own SHA256 verification against micromamba-releases.json.
set -euo pipefail

data_dir="${1:?usage: seed-managed-micromamba.sh <data-directory>}"

# Do not mutate the data directory when managed scientific environments are
# explicitly disabled. A later enabled restart will seed the still-empty path.
if [[ ! "${SCIENTIFIC_ENVS:-1}" =~ ^(1|true|yes)$ ]]; then
  exit 0
fi

# An administrator-provided path is authoritative; do not create or replace the
# managed default when the override is present.
if [[ -n "${SCIENCE_AGENT_PROVISIONER_PATH:-}" ]]; then
  exit 0
fi

provisioner_seed="${SCIENCE_AGENT_PROVISIONER_SEED_PATH:-}"
provisioner_target="$data_dir/scientific-envs/bin/micromamba"
if [[ -e "$provisioner_target" ]]; then
  exit 0
fi
if [[ -z "$provisioner_seed" || ! -x "$provisioner_seed" ]]; then
  echo "The image micromamba seed is unavailable at ${provisioner_seed:-<unset>}. Rebuild the image." >&2
  exit 1
fi

mkdir -p "$(dirname -- "$provisioner_target")"
temporary="$provisioner_target.${BASHPID}.tmp"
trap 'rm -f -- "$temporary"' EXIT
cp -- "$provisioner_seed" "$temporary"
chmod 0755 "$temporary"
mv -- "$temporary" "$provisioner_target"
trap - EXIT
