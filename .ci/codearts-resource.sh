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
# The consumer branch pins these artifacts by checksum, so a half-built image
# that reaches OBS is worse than no image at all. Two things keep that from
# happening, and neither is the build task's exit code.
#
# The build cases stage nothing into the published directory until every check
# has passed, so a failure leaves the OBS action with an empty directory. And
# `verify` reads the published objects back and refuses any whose VERSION does
# not name this run, which is what catches a build that quietly produced
# nothing. That job is the run's failure authority; only it needs a build task
# whose console shell propagates the exit code, and it publishes nothing, so it
# does not need one that uploads.
#
# Inputs supplied through the build task's ENVS records:
#   RESOURCE_BUILD_COMMIT   the resources-branch commit the pipeline resolved
#   RESOURCE_BUILD_RUN_ID   the pipeline run id, part of the QEMU Runner key
#   CI_PUBLISH_DIR          staging directory, default .ci-results/publish

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
# The CI layers stage into .ci-results/publish and their uploads land, so
# this uses the same path rather than a second one whose handling in the
# build task's OBS action cannot be read from here.
publish_dir="${CI_PUBLISH_DIR:-$repo_root/.ci-results/publish}"
case "$publish_dir" in
  /*) ;;
  *) publish_dir="$repo_root/$publish_dir" ;;
esac
rm -rf -- "$publish_dir"
mkdir -p -- "$publish_dir"

# One definition for the names, versions and locations every resource script
# has to agree on.
# shellcheck source=.ci/qemu-resources.sh
source "$repo_root/.ci/qemu-resources.sh"
obs_base="$OBS_CACHE_BASE"
emulator_name="$QEMU_EMULATOR_PAYLOAD_NAME"
runner_image_name="$QEMU_RUNNER_IMAGE_NAME"
runner_recipe="$QEMU_RUNNER_RECIPE"
emulator_recipe="$QEMU_EMULATOR_RECIPE"

run_id="${RESOURCE_BUILD_RUN_ID:?RESOURCE_BUILD_RUN_ID is required}"
[[ "$run_id" =~ ^[0-9A-Za-z_-]+$ ]] \
  || { echo "FATAL: RESOURCE_BUILD_RUN_ID is not a run id." >&2; exit 2; }

# The commit is read from the checkout rather than passed in. A push-triggered
# pipeline does not resolve `sources.<name>.commit_id`, so a pipeline that
# forwarded it handed this script an empty string; the checkout is the commit
# that actually got built. RESOURCE_BUILD_COMMIT stays supported so a caller
# that does know the commit still gets the mismatch check.
checked_out_commit="$(git rev-parse HEAD)"
build_commit="${RESOURCE_BUILD_COMMIT:-$checked_out_commit}"
[[ "$build_commit" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "FATAL: RESOURCE_BUILD_COMMIT is not a commit id." >&2; exit 2; }
if [ "$checked_out_commit" != "$build_commit" ]; then
  echo "FATAL: the build task checked out $checked_out_commit but the caller expected $build_commit." >&2
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
  # The run id, not this job's own checkout, is what says the object came from
  # this run. Every job fetches the branch tip when it starts, so a push that
  # lands mid-run leaves the jobs on different commits -- and then a check
  # against this job's HEAD fails an artifact that is otherwise fine, while
  # still missing the case where two artifacts came from different commits.
  # Pin the run here and compare the commits to each other below.
  grep -Fx "resource_run_id=$run_id" "$directory/VERSION"
  published_commits+=("$(sed -n 's/^resource_commit=//p' "$directory/VERSION")")
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
      --output "$base_dir/$QEMU_BASE_IMAGE_NAME"
  RESOURCE_BUILD_COMMIT="$build_commit" \
  RESOURCE_BUILD_RUN_ID="$run_id" \
    bash .ci/build-qemu-runner-image.sh \
      --base-image "$base_dir/$QEMU_BASE_IMAGE_NAME" \
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
  local log="$publish_dir/verify.log" commit
  published_commits=()
  verify_published "$obs_base/qemu-emulator/v1" \
    "$work_dir/qemu-emulator-published" "$emulator_name" "$emulator_recipe"
  verify_published "$obs_base/qemu-runner/v2/$run_id" \
    "$work_dir/qemu-runner-published" "$runner_image_name" "$runner_recipe"
  # One run must publish one commit's work. Different commits here means the
  # branch moved while the run was in flight, and the artifacts do not belong
  # to each other however well each one verifies on its own.
  for commit in "${published_commits[@]}"; do
    if [ "$commit" != "${published_commits[0]}" ]; then
      echo "FATAL: this run published artifacts built from ${published_commits[0]} and $commit." >&2
      return 1
    fi
  done
  build_commit="${published_commits[0]}"
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
