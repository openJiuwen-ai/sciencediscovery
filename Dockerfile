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

# ScienceDiscovery — one image carrying the whole local stack. The container uses
# start-stack.sh --mode docker for the same three-process order as local mode
# (agent-loop gateway → bubblewrap runner → control API with the web UI), so no
# cross-container rewiring of loopback gateway/runner/callback URLs is needed.
#
# The uv-managed Python environments are baked into the image under
# /opt/science-agent instead of <data dir>/envs: starting the baked services
# needs no network, and the bind-mounted host directory holds application state
# only. Creating the managed starter Python environment remains a separate,
# channel-dependent step unless an offline package cache is supplied.

ARG NODE_BUILD_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.26
ARG PNPM_VERSION=11.1.2
# Matches services/gateway/.python-version; the PDF worker (>=3.11) reuses it.
ARG PYTHON_VERSION=3.12

FROM ${UV_IMAGE} AS uv

# The release manifest is also imported by environment-store.ts and consumed by
# the standalone packaging script. A Docker build therefore cannot silently
# use a different micromamba version or checksum from the Runner runtime.
# Run the downloader on the build host, not the target architecture. This keeps
# amd64/arm64 cross-builds independent of QEMU while TARGETARCH still selects
# the binary copied into the final target image.
FROM --platform=$BUILDPLATFORM ${NODE_RUNTIME_IMAGE} AS micromamba
ARG TARGETARCH
WORKDIR /source
COPY services/runner/src/micromamba-releases.json services/runner/src/micromamba-releases.json
COPY scripts/fetch-managed-micromamba.mjs scripts/fetch-managed-micromamba.mjs
RUN test -n "$TARGETARCH" \
 || { echo "TARGETARCH is required to select the managed micromamba release (use Docker BuildKit/buildx)." >&2; exit 1; }
RUN node scripts/fetch-managed-micromamba.mjs \
      --arch "$TARGETARCH" \
      --output /opt/science-agent/provisioner/micromamba

# ---------------------------------------------------------------- builder ---
FROM ${NODE_BUILD_IMAGE} AS builder
ARG PNPM_VERSION
ARG PYTHON_VERSION

COPY --from=uv /uv /usr/local/bin/uv

# UV_LINK_MODE=copy keeps cache mounts and environments on separate filesystems
# without relying on hardlinks. The remaining settings make every sync
# production-oriented and let managed Python downloads share the uv cache.
ENV UV_PYTHON_INSTALL_DIR=/opt/science-agent/python \
    UV_PYTHON_CACHE_DIR=/root/.cache/uv/python \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1

RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /app

# Dependency layer first: only workspace manifests, so editing application
# source does not invalidate the pnpm install cache. New workspace packages
# must be added here as well (services/gateway and services/paper are Python
# and carry no package.json).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY config/package.json config/
COPY apps/web/package.json apps/web/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/mcp-sources/package.json packages/mcp-sources/
COPY packages/schema/package.json packages/schema/
COPY services/api/package.json services/api/
COPY services/runner/package.json services/runner/
RUN pnpm install --frozen-lockfile --ignore-scripts

# Install managed Python and third-party Python dependencies before application
# source is copied. Bind-mounted manifests participate in the cache key without
# becoming part of the layer.
RUN mkdir -p \
      services/paper \
      services/gateway

RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install "${PYTHON_VERSION}"

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/paper/pyproject.toml,target=/app/services/paper/pyproject.toml \
    --mount=type=bind,source=services/paper/uv.lock,target=/app/services/paper/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/science-agent/envs/paper \
      uv sync --project services/paper --locked --no-install-project --python "${PYTHON_VERSION}"

# The gateway lock includes the transitive dependencies of its editable
# deerflow-harness path dependency. Trust that lock before local sources exist,
# skip both local packages, then validate it with the final locked sync.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/gateway/pyproject.toml,target=/app/services/gateway/pyproject.toml \
    --mount=type=bind,source=services/gateway/uv.lock,target=/app/services/gateway/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/science-agent/envs/gateway \
      uv sync --project services/gateway --frozen --no-install-project \
        --no-install-package deerflow-harness --python "${PYTHON_VERSION}"

COPY . .

# The gateway installs the deer-flow harness as an editable path dependency, so
# the submodule has to be present in the build context.
RUN test -f third_party/deer-flow/backend/packages/harness/pyproject.toml \
    || { echo "third_party/deer-flow is not checked out. Run: git submodule update --init --recursive" >&2; exit 1; }

RUN pnpm build

# Install the local projects from the complete source tree. The gateway's final
# locked sync preserves the editable deerflow-harness path dependency.
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_PROJECT_ENVIRONMENT=/opt/science-agent/envs/paper \
      uv sync --project services/paper --locked --python "${PYTHON_VERSION}" \
 && UV_PROJECT_ENVIRONMENT=/opt/science-agent/envs/gateway \
      uv sync --project services/gateway --locked --python "${PYTHON_VERSION}"

# ---------------------------------------------------------------- runtime ---
FROM ${NODE_RUNTIME_IMAGE} AS runtime

# bubblewrap: the runner's sandbox. python3: the default sandbox interpreter,
# also probed at startup by services/api/src/environment.ts. git: authorized
# skill imports. openssh-client: remote compute via /usr/bin/ssh. curl: the
# entry point's health waits and the health check. tini: PID 1 signal forwarding
# and zombie reaping for the three services.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      bubblewrap \
      ca-certificates \
      curl \
      git \
      openssh-client \
      procps \
      python3 \
      tini \
 && rm -rf /var/lib/apt/lists/*

# In-container defaults. Everything the gateway and runner need stays on
# container loopback; only the API port is published.
ENV NODE_ENV=production \
    SCIENCE_AGENT_DATA_DIR=/app/data \
    SCIENCE_AGENT_HOST=0.0.0.0 \
    SCIENCE_AGENT_PORT=4310 \
    SCIENCE_AGENT_GATEWAY_HOST=127.0.0.1 \
    SCIENCE_AGENT_GATEWAY_PORT=4312 \
    SCIENCE_AGENT_GATEWAY_URL=http://127.0.0.1:4312 \
    SCIENCE_AGENT_RUNNER_HOST=127.0.0.1 \
    SCIENCE_AGENT_RUNNER_PORT=4311 \
    SCIENCE_AGENT_RUNNER_URL=http://127.0.0.1:4311 \
    SCIENTIFIC_ENVS=1 \
    SCIENCE_AGENT_PROVISIONER_SEED_PATH=/opt/science-agent/provisioner/micromamba \
    SCIENCE_AGENT_ENVS_ROOT=/opt/science-agent/envs \
    SCIENCE_AGENT_PAPER_PYTHON_PATH=/opt/science-agent/envs/paper/bin/python \
    SCIENCE_AGENT_GATEWAY_PYTHON_PATH=/opt/science-agent/envs/gateway/bin/python

COPY --from=builder /opt/science-agent /opt/science-agent
COPY --from=micromamba /opt/science-agent/provisioner /opt/science-agent/provisioner
COPY --from=builder /app /app

WORKDIR /app

# Mount point for the host bind mount; the image itself ships no state.
RUN mkdir -p /app/data && chown node:node /app/data

# The base image already provides uid/gid 1000 as `node`. Compose overrides the
# user when the host account owning ./data uses different ids.
USER node

EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl --silent --fail http://127.0.0.1:4310/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
