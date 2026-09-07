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

# The image a CodeArts build task runs its shell inside.
#
# Everything a run used to download lives here instead: the toolchain that
# .ci/provision-runner.sh would otherwise fetch, the emulator that runs the
# guest, and the guest image itself. Those three cost a run roughly a hundred
# seconds and 3.4 GB of transfer that never changes between runs.
#
# Nothing in .ci/ needed changing for this. provision-runner.sh installs only
# what it cannot already find on PATH, run-qemu-layer.sh prefers a QEMU the
# host provides over the portable payload, and the guest image is verified by
# checksum wherever it comes from -- so a pre-seeded cache is a cache hit.
#
# The build context is a staging directory prepared by
# .ci/build-codearts-runner-image.sh, not the repository: no product source is
# copied in, and the checkout still arrives per run.

FROM ubuntu:24.04

ARG APT_MIRROR
ARG CI_OBS_CACHE_BASE
ARG CI_NPM_REGISTRY
ARG QEMU_RUNNER_IMAGE_SHA256
ARG SOURCE_COMMIT

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# The mirror the rest of CI already uses -- ci-constants.sh owns the address --
# because the default archive is slow from the build network. bubblewrap is
# what the sandbox tests need, and the guest is started by a QEMU that has no
# use for /dev/kvm, so nothing here is privileged.
RUN mirror="${APT_MIRROR:?APT_MIRROR is required}" \
 && sed -i "s|http://archive.ubuntu.com/ubuntu|$mirror|g; s|http://security.ubuntu.com/ubuntu|$mirror|g" \
      /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update \
 && apt-get install --yes --no-install-recommends \
      bubblewrap \
      bzip2 \
      ca-certificates \
      curl \
      file \
      git \
      gzip \
      python3 \
      tar \
      unzip \
      xz-utils \
      zip \
      zstd \
 && rm -rf /var/lib/apt/lists/*

# Let the repository's own provisioning install the toolchain, from the same
# checksum-pinned cache a run would use. Restating those checksums here would
# put one fact in two places, and this way the image carries exactly what a run
# would have installed. The symlinks make the tools findable whatever HOME the
# build task's shell ends up with; provision-runner.sh then finds everything
# already present and installs nothing.
COPY repo/ /opt/sciencediscovery/repo/
RUN set -Eeuo pipefail \
 && cd /opt/sciencediscovery/repo \
 && CI_BINARY_CACHE_URL="$CI_OBS_CACHE_BASE/toolchains/v1" \
    CI_BINARY_CACHE_ONLY=1 \
    CI_NPM_REGISTRY="$CI_NPM_REGISTRY" \
    bash .ci/provision-runner.sh \
 && rm -rf /opt/sciencediscovery/repo/.ci-results \
 && for tool in "$HOME/.local/node/bin/node" "$HOME/.local/node/bin/npm" \
      "$HOME/.local/node/bin/npx" "$HOME/.local/share/pnpm/pnpm" \
      "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx"; do \
      ln -sfn "$tool" "/usr/local/bin/$(basename "$tool")"; \
    done \
 && node --version && pnpm --version && uv --version && bwrap --version

# The published emulator, exposed under the names run-qemu-layer.sh looks for.
# It is a relocatable musl tree, so each entry point goes through its loader;
# finding these on PATH is what makes that script skip the portable payload.
COPY qemu-emulator.tar /tmp/qemu-emulator.tar
RUN set -Eeuo pipefail \
 && mkdir -p /opt/qemu \
 && tar -xf /tmp/qemu-emulator.tar -C /opt/qemu \
 && rm -f /tmp/qemu-emulator.tar \
 && loader='/opt/qemu/lib/ld-musl-x86_64.so.1 --library-path /opt/qemu/lib:/opt/qemu/usr/lib' \
 && printf '#!/bin/sh\nexec env QEMU_MODULE_DIR=/opt/qemu/usr/lib/qemu %s /opt/qemu/usr/bin/qemu-system-x86_64 -L /opt/qemu/usr/share/qemu "$@"\n' \
      "$loader" > /usr/local/bin/qemu-system-x86_64 \
 && printf '#!/bin/sh\nexec env QEMU_MODULE_DIR=/opt/qemu/usr/lib/qemu %s /opt/qemu/usr/bin/qemu-img "$@"\n' \
      "$loader" > /usr/local/bin/qemu-img \
 && chmod 0755 /usr/local/bin/qemu-system-x86_64 /usr/local/bin/qemu-img \
 && ln -sfn /opt/qemu/usr/share/qemu /usr/share/qemu \
 && qemu-system-x86_64 --version | head -n 1 \
 && qemu-img --version | head -n 1 \
 && timeout 10 qemu-system-x86_64 -machine q35 -m 128 -display none -no-reboot -serial null 2>&1 \
    | grep -qi 'could not load PC BIOS' && { echo "FATAL: the wrapped emulator cannot find its firmware." >&2; exit 1; } || true

ENV QEMU_MODULE_DIR=/opt/qemu/usr/lib/qemu

# Last, and on its own, because it is by far the largest thing here and the
# only one that changes when the guest image is re-pinned. A run seeds its own
# cache from this directory, and the fetcher verifies the checksum either way.
COPY qemu-cache/ /opt/sciencediscovery/qemu-cache/
RUN set -Eeuo pipefail \
 && printf '%s  %s\n' "$QEMU_RUNNER_IMAGE_SHA256" \
      /opt/sciencediscovery/qemu-cache/ScienceDiscovery-qemu-runner-noble-amd64.qcow2 \
    | sha256sum --check --strict

# What a run is standing on, readable from inside it. The guest image carries
# the same kind of marker, and the one time it disagreed with what had been
# published it cost a full debugging round to find out.
RUN set -Eeuo pipefail \
 && { printf 'recipe=%s\n' "ci-runner-v1"; \
      printf 'ubuntu=%s\n' "$(. /etc/os-release && echo "$VERSION_ID")"; \
      printf 'node=%s\n' "$(node --version | sed 's/^v//')"; \
      printf 'pnpm=%s\n' "$(pnpm --version)"; \
      printf 'uv=%s\n' "$(uv --version | awk '{print $2}')"; \
      printf 'bubblewrap=%s\n' "$(bwrap --version | awk '{print $2}')"; \
      printf 'qemu=%s\n' "$(qemu-system-x86_64 --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')"; \
      printf 'qemu_runner_image_sha256=%s\n' "$QEMU_RUNNER_IMAGE_SHA256"; \
      printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"; \
    } > /etc/sciencediscovery-ci-runner \
 && cat /etc/sciencediscovery-ci-runner

LABEL org.opencontainers.image.title="sciencediscovery-ci-runner"
LABEL org.opencontainers.image.description="CodeArts build-task image: repository toolchain, pinned QEMU emulator and pre-provisioned guest image."
