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

# Repository test toolchain only. The build context is .ci/ and no product
# source is copied into the image; CI bind-mounts a checkout at /src.
ARG NODE_IMAGE=node:22.19.0-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.26

FROM ${UV_IMAGE} AS uv
FROM ${NODE_IMAGE}

ARG PNPM_VERSION=11.1.2
ARG PLAYWRIGHT_VERSION=1.61.1
ARG PYTHON_VERSION=3.12

COPY --from=uv /uv /uvx /usr/local/bin/

# bubblewrap is exercised by Runner tests and by mocked journeys. Playwright's
# own installer supplies the architecture-appropriate Chromium system libs.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      bash \
      bubblewrap \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      procps \
      python3 \
      python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "pnpm@${PNPM_VERSION}" \
 && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
 && npm cache clean --force

# Gateway development and test environments require Python 3.12. Keep the
# interpreter in the immutable toolchain while project venvs remain in the
# bind-mounted checkout.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv python install "${PYTHON_VERSION}"

ENV CI=1 \
    CI_RESULTS_DIR=/ci-results \
    HOME=/ci-home \
    NPM_CONFIG_CACHE=/ci-cache/npm \
    PLAYWRIGHT_BROWSERS_PATH=/ci-cache/ms-playwright \
    PNPM_HOME=/usr/local/share/pnpm \
    UV_CACHE_DIR=/ci-cache/uv

RUN mkdir -p /src /ci-results /ci-cache /ci-home \
 && chmod 1777 /ci-results /ci-cache /ci-home

# The checkout must not live at /workspace: the Runner's bubblewrap sandbox
# mounts the Session workspace over that exact path. Fixtures that build
# absolute paths below process.cwd() would then be shadowed inside the sandbox,
# and the NPU Broker's workspace-relative argument rewriting would re-anchor
# paths that already start with /workspace, doubling the prefix.
WORKDIR /src
USER node
CMD ["bash"]
