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

# Builds one immutable CI resource inside a CodeArts Build task.
#
# CodeArts bills pipelines and build tasks against separate quotas, and the
# pipeline quota is spent for the month: a step that runs shell or uploads to
# OBS on a pipeline executor draws on it. Every resource therefore reaches
# CodeArts the same way the CI layers do, through the generic `run-shell`
# build task, which checks the branch out and calls
# `.ci/codearts-build-dispatch.sh` with this script's path and a resource
# name. Adding a resource means adding a case here, not editing a build task
# in the console.
#
# A resource differs from a CI layer in one way that shapes this file. A layer
# runs on the build task whose console shell returns success so its OBS action
# still uploads the log; the recorded exit code is the truth. A resource has no
# such luxury: the consumer branch pins these artifacts by checksum, so a
# half-built image that reaches OBS is worse than no image at all. Resources
# run on the strict build task, which propagates the exit code, and this script
# stages nothing into the published directory until every check has passed.
#
# Inputs supplied through the build task's ENVS records:
#   RESOURCE_BUILD_COMMIT   the resources-branch commit the pipeline resolved
#   RESOURCE_BUILD_RUN_ID   the pipeline run id, part of the QEMU Runner key
#   CI_PUBLISH_DIR          staging directory, default .codearts-resources/publish

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
resource="${1:-}"
case "$resource" in
  toolchains|qemu-base|qemu-emulator|qemu-runner|verify) ;;
  "")
    echo "Usage: .ci/codearts-resource.sh toolchains|qemu-base|qemu-emulator|qemu-runner|verify" >&2
    exit 2
    ;;
  *)
    echo "FATAL: '$resource' is not a resource this entry point builds." >&2
    exit 2
    ;;
esac

cd "$repo_root"
work_dir="$repo_root/.codearts-resources"
publish_dir="${CI_PUBLISH_DIR:-$work_dir/publish}"
case "$publish_dir" in
  /*) ;;
  *) publish_dir="$repo_root/$publish_dir" ;;
esac
rm -rf -- "$publish_dir"
mkdir -p -- "$publish_dir"

obs_base=https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache
emulator_name=ScienceDiscovery-qemu-emulator-alpine-x86_64.tar
runner_image_name=ScienceDiscovery-qemu-runner-noble-amd64.qcow2
# Bumped whenever the image's contents change, so a guest that boots an older
# published image fails its own assertion instead of running the tests.
runner_recipe=qemu-runner-v2
emulator_recipe=qemu-emulator-v1

build_commit="${RESOURCE_BUILD_COMMIT:?RESOURCE_BUILD_COMMIT is required}"
run_id="${RESOURCE_BUILD_RUN_ID:?RESOURCE_BUILD_RUN_ID is required}"
[[ "$build_commit" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "FATAL: RESOURCE_BUILD_COMMIT is not a commit id." >&2; exit 2; }
[[ "$run_id" =~ ^[0-9A-Za-z_-]+$ ]] \
  || { echo "FATAL: RESOURCE_BUILD_RUN_ID is not a run id." >&2; exit 2; }

# The build task checks out a branch tip, while the OBS key and the VERSION
# manifest carry the commit the pipeline resolved. A push that lands between
# the two would otherwise publish one commit's artifact under another's key.
checked_out_commit="$(git rev-parse HEAD)"
if [ "$checked_out_commit" != "$build_commit" ]; then
  echo "FATAL: the build task checked out $checked_out_commit but the pipeline resolved $build_commit." >&2
  exit 1
fi

echo "=== CodeArts resource build ==="
echo "resource : $resource"
echo "commit   : $build_commit"
echo "run      : $run_id"
echo "publish  : ${publish_dir#"$repo_root"/}"

# Hand the build task's OBS action exactly the files that belong under this
# resource's key prefix. The source directory is rebuilt from scratch by each
# case below, so everything left in it at this point is intended output.
stage_directory() { # <directory>
  local directory="$1" name count=0
  [ -d "$directory" ] || { echo "FATAL: $directory was never produced." >&2; return 1; }
  while IFS= read -r name; do
    cp -a -- "$directory/$name" "$publish_dir/"
    echo "  publishing $name"
    count=$((count + 1))
  done < <(find "$directory" -maxdepth 1 -type f -printf '%f\n' | sort)
  [ "$count" -gt 0 ] || { echo "FATAL: $directory holds no files to publish." >&2; return 1; }
  echo "staged $count file(s) for OBS"
}

# Read one object back out of OBS. The build task's upload action runs after
# this script, so this is only ever called from the `verify` resource, once the
# jobs that produced the objects have finished.
fetch_published() { # <base-url> <directory> <name>
  local base="$1" directory="$2" name="$3" attempt=1
  while [ "$attempt" -le 5 ]; do
    if curl --fail --location --retry 2 --connect-timeout 15 \
      --max-time 600 --silent --show-error \
      "$base/$name" --output "$directory/$name.part"; then
      mv -- "$directory/$name.part" "$directory/$name"
      echo "downloaded $name"
      return 0
    fi
    rm -f -- "$directory/$name.part"
    echo "waiting for published object $name (attempt $attempt)"
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "FATAL: published object is unavailable: $name" >&2
  return 1
}

# Confirm that what OBS now serves is byte-for-byte what the build recorded.
# The checksum is printed rather than only compared: the consumer branch pins
# it by hand, and a mismatch there has to be read off this line.
verify_published() { # <base-url> <directory> <artifact-name> <recipe>
  local base="$1" directory="$2" name="$3" recipe="$4" expected actual
  rm -rf -- "$directory"
  mkdir -p -- "$directory"
  fetch_published "$base" "$directory" SHA256SUMS
  fetch_published "$base" "$directory" VERSION
  fetch_published "$base" "$directory" "$name"
  [ "$(wc -l < "$directory/SHA256SUMS")" -eq 1 ] \
    || { echo "FATAL: $name's SHA256SUMS covers more than one artifact." >&2; return 1; }
  grep -Eq "^[0-9a-f]{64}  $name\$" "$directory/SHA256SUMS"
  expected="$(awk '{print $1}' "$directory/SHA256SUMS")"
  actual="$(sha256sum "$directory/$name" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "FATAL: published $name hashes to $actual, not the recorded $expected." >&2
    return 1
  fi
  cat "$directory/VERSION"
  grep -Fx "recipe=$recipe" "$directory/VERSION"
  grep -Fx "resource_commit=$build_commit" "$directory/VERSION"
  echo "verified published $name: $actual"
}

build_toolchains() {
  rm -rf -- "$work_dir/toolchains"
  bash .ci/prepare-codearts-resources.sh \
    --group toolchains --output-dir "$work_dir"
  stage_directory "$work_dir/toolchains"
}

build_qemu_base() {
  rm -rf -- "$work_dir/qemu"
  bash .ci/prepare-codearts-resources.sh \
    --group qemu --output-dir "$work_dir"
  stage_directory "$work_dir/qemu"
}

build_qemu_emulator() {
  local output_dir="$work_dir/qemu-emulator"
  rm -rf -- "$output_dir"
  RESOURCE_BUILD_COMMIT="$build_commit" \
  RESOURCE_BUILD_RUN_ID="$run_id" \
    bash .ci/build-qemu-emulator.sh --output-dir "$output_dir"
  (cd "$output_dir" && sha256sum --check SHA256SUMS)
  cat "$output_dir/VERSION"
  grep -Fx "recipe=$emulator_recipe" "$output_dir/VERSION"
  ls -lh "$output_dir/$emulator_name"
  stage_directory "$output_dir"
}

build_qemu_runner() {
  local base_dir="$work_dir/qemu-base" output_dir="$work_dir/qemu-runner"
  rm -rf -- "$base_dir" "$output_dir"
  mkdir -p -- "$base_dir" "$output_dir"
  # The base cloud image was published by the qemu-base resource in this same
  # run; take it from OBS rather than fetching it upstream a second time.
  CI_QEMU_IMAGE_CACHE_URL="$obs_base/qemu/v1" \
  CI_QEMU_IMAGE_CACHE_ONLY=1 \
    bash .ci/fetch-qemu-image.sh \
      --output "$base_dir/noble-server-cloudimg-amd64.img"
  RESOURCE_BUILD_COMMIT="$build_commit" \
  RESOURCE_BUILD_RUN_ID="$run_id" \
    bash .ci/build-qemu-runner-image.sh \
      --base-image "$base_dir/noble-server-cloudimg-amd64.img" \
      --output-dir "$output_dir"
  (cd "$output_dir" && sha256sum --check SHA256SUMS)
  cat "$output_dir/VERSION"
  grep -Fx "recipe=$runner_recipe" "$output_dir/VERSION"
  grep -Fx "resource_commit=$build_commit" "$output_dir/VERSION"
  grep -Fx "resource_run_id=$run_id" "$output_dir/VERSION"
  ls -lh "$output_dir/$runner_image_name"
  # The base image is only an input; publishing it here would write it a second
  # time under the Runner image's per-run key.
  rm -rf -- "$base_dir"
  stage_directory "$output_dir"
}

verify_published_resources() {
  local log="$publish_dir/verify.log"
  verify_published "$obs_base/qemu-emulator/v1" \
    "$work_dir/qemu-emulator-published" "$emulator_name" "$emulator_recipe"
  verify_published "$obs_base/qemu-runner/v1/$build_commit/$run_id" \
    "$work_dir/qemu-runner-published" "$runner_image_name" "$runner_recipe"
  grep -Fx "resource_run_id=$run_id" "$work_dir/qemu-runner-published/VERSION"
  # The consumer branch pins the Runner image by these three values.
  {
    printf 'resource_commit=%s\n' "$build_commit"
    printf 'resource_run_id=%s\n' "$run_id"
    cat "$work_dir/qemu-runner-published/SHA256SUMS"
  } | tee "$log"
}

case "$resource" in
  toolchains) build_toolchains ;;
  qemu-base) build_qemu_base ;;
  qemu-emulator) build_qemu_emulator ;;
  qemu-runner) build_qemu_runner ;;
  verify) verify_published_resources ;;
esac

echo "$resource completed"
