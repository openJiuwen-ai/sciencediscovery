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

# Builds the image a CodeArts build task runs its shell inside.
#
# Every artifact baked in is fetched by the repository's own pinned fetchers,
# so the image carries exactly what a run would have downloaded and the
# checksums stay in one place. The build context is the staging directory this
# assembles, never the repository: no product source reaches the image.

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=.ci/ci-constants.sh
source "$repo_root/.ci/ci-constants.sh"

registry=swr.cn-north-4.myhuaweicloud.com/openjiuwen
# provision-runner.sh installs pnpm from a configured registry or not at all
# when the cache is the only permitted source; the pipeline passes the same
# mirror to every layer.
npm_registry="${CI_NPM_REGISTRY:-https://repo.huaweicloud.com/repository/npm/}"
name=sciencediscovery-ci-runner
tag=latest
push=0
stage=""

usage() {
  cat <<'EOF'
Usage: .ci/build-codearts-runner-image.sh [--tag <tag>] [--stage <dir>] [--push]

  --tag    Image tag, default `latest`.
  --stage  Directory for the build context; defaults to a temporary one under
           .tmp/ and is reused, so a rebuild does not download 3 GB again.
  --push   Push after building. The registry rejects OCI media types, so the
           push always requests Docker Schema 2 and no attestations.
EOF
}

while (($#)); do
  case "$1" in
    --tag) tag="${2:?--tag requires a value}"; shift 2 ;;
    --stage) stage="${2:?--stage requires a value}"; shift 2 ;;
    --push) push=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

image="$registry/$name:$tag"
stage="${stage:-$repo_root/.tmp/codearts-runner-image}"
mkdir -p "$stage/qemu-cache"

echo "=== staging the build context ==="
# Only what the image build reads: the repository's provisioning scripts and
# the two files the shared constants derive the toolchain versions from.
rm -rf -- "$stage/repo"
mkdir -p "$stage/repo/scripts/binary-release"
cp -a -- "$repo_root/.ci" "$stage/repo/.ci"
rm -rf -- "$stage/repo/.ci/.ci-results"
cp -- "$repo_root/package.json" "$stage/repo/package.json"
cp -- "$repo_root/scripts/binary-release/runtimes.json" \
  "$stage/repo/scripts/binary-release/runtimes.json"

# The emulator and the guest image, through the fetchers that own their
# checksums. Both land in the staging directory and are reused on a rebuild.
bash "$repo_root/.ci/fetch-qemu-emulator.sh" --output "$stage/qemu-emulator.tar"
bash "$repo_root/.ci/fetch-qemu-runner-image.sh" \
  --output "$stage/qemu-cache/ScienceDiscovery-qemu-runner-noble-amd64.qcow2"
cp -- "$repo_root/.ci/codearts-runner.Dockerfile" "$stage/Dockerfile"

read -r runner_image_sha256 _ < "$repo_root/.ci/qemu-runner-image.sha256"
echo "=== building $image ==="
build=(docker buildx build
  --file "$stage/Dockerfile"
  --build-arg "CI_OBS_CACHE_BASE=$CI_OBS_CACHE_BASE"
  --build-arg "CI_NPM_REGISTRY=$npm_registry"
  --build-arg "QEMU_RUNNER_IMAGE_SHA256=$runner_image_sha256"
  --build-arg "SOURCE_COMMIT=$(git -C "$repo_root" rev-parse HEAD)"
  # SWR parses only Docker Schema 2: an OCI manifest, or the attestation
  # manifest BuildKit adds by default, is refused after the layers upload with
  # `Invalid image, fail to parse 'manifest.json'`.
  --provenance=false
  --sbom=false
)
if [ "$push" -eq 1 ]; then
  build+=(--output "type=image,name=$image,oci-mediatypes=false,push=true")
else
  build+=(--tag "$image" --load)
fi
"${build[@]}" "$stage"
echo "built $image"
