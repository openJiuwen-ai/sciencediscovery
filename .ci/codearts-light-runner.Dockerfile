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

# The image for a build task that only talks to git and an HTTP API.
#
# .ci/codearts-runner.Dockerfile carries the toolchain, the emulator and a
# 3.1 GB guest image, which is exactly what a test layer needs and roughly
# forty seconds of pull for a job that needs none of it: the auto merge reads
# CODEOWNERS, calls GitCode and counts commits. This recipe is the same Ubuntu
# and the same mirror, with nothing but git, python3 and a CA bundle.
#
# It announces itself in the same file the full image uses, so the build task's
# shell reports which of the two it is standing on without knowing that either
# exists. Anything that needs node, pnpm, uv, bubblewrap or QEMU belongs on the
# full image; .ci/codearts-runner-shell.reference.sh reports the toolchain as
# absent here rather than failing, so choosing the wrong image for a test layer
# fails in that layer, where the reason is legible.

FROM ubuntu:24.04

ARG APT_MIRROR
ARG SOURCE_COMMIT

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# git clones the repository under test, python3 makes the GitCode calls with
# nothing but its standard library, and the CA bundle is what makes both of
# those reach an https host at all.
RUN mirror="${APT_MIRROR:?APT_MIRROR is required}" \
 && sed -i "s|http://archive.ubuntu.com/ubuntu|$mirror|g; s|http://security.ubuntu.com/ubuntu|$mirror|g" \
      /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates \
      curl \
      git \
      python3 \
 && rm -rf /var/lib/apt/lists/*

RUN set -Eeuo pipefail \
 && { printf 'recipe=%s\n' "ci-light-v1"; \
      printf 'ubuntu=%s\n' "$(. /etc/os-release && echo "$VERSION_ID")"; \
      printf 'git=%s\n' "$(git --version | awk '{print $3}')"; \
      printf 'python3=%s\n' "$(python3 --version | awk '{print $2}')"; \
      printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"; \
    } > /etc/sciencediscovery-ci-runner \
 && cat /etc/sciencediscovery-ci-runner

LABEL org.opencontainers.image.title="sciencediscovery-ci-light"
LABEL org.opencontainers.image.description="CodeArts build-task image for jobs that only need git, python3 and a CA bundle."
