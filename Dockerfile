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
# start-stack.sh --mode docker for the same two-process order as local mode
# (bubblewrap runner → control API with the web UI), so no cross-container
# rewiring of the loopback runner URL is needed.
#
# The uv-managed Python environments are baked into the image under
# /opt/sciencediscovery instead of <data dir>/envs: starting the baked services
# needs no network, and the bind-mounted host directory holds application state
# only. Creating the managed starter Python environment remains a separate,
# channel-dependent step unless an offline package cache is supplied.
#
# JiuwenSwarm and the adapter are baked in the same way (also under
# /opt/sciencediscovery, read-only) and run agent turns by default. JiuwenSwarm's
# own instance state still lives under the bind-mounted data directory — see
# scripts/jiuwenswarm.sh and docs/en/getting-started/deployment.md.

ARG NODE_BUILD_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.26
ARG PNPM_VERSION=11.1.2
# Matches services/gateway/.python-version; the PDF worker (>=3.11) reuses it.
ARG PYTHON_VERSION=3.12
# Large Python wheels in the JiuwenSwarm dependency graph can exceed uv's
# 30-second default on slower links. This affects builds only and remains
# overridable (`--build-arg UV_HTTP_TIMEOUT=...`).
ARG UV_HTTP_TIMEOUT=300
# Keep in step with scripts/jiuwenswarm.sh and scripts/binary-release/build-payload.sh,
# which install the same pinned tag for source mode and the release binary.
ARG JIUWENSWARM_TAG=workswarm0.2.6

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
      --output /opt/sciencediscovery/provisioner/micromamba

# Every workspace manifest, and nothing else. The dependency layer below used to
# name each package.json by hand, which silently drifted from
# pnpm-workspace.yaml: a renamed package left `docker compose build` failing on
# a path that no longer existed. Extracting the manifests from the build context
# keeps that list correct without anyone remembering to update it, and the
# extract stays byte-identical while only application source changes, so the
# pnpm install layer below keeps its cache. Architecture-independent, so this
# stage also runs on the build host.
FROM --platform=$BUILDPLATFORM ${NODE_RUNTIME_IMAGE} AS manifests
WORKDIR /source
COPY . .
RUN find . -name node_modules -prune -o -name package.json -exec install -D {} /manifests/{} \;

# The model catalog is deliberately not committed. One snapshot is downloaded
# here and baked into the image so a first container start with no network
# still knows model context windows, prices and thinking capabilities; the user
# refreshes it later from Settings. Architecture-independent, so this stage
# also runs on the build host.
FROM --platform=$BUILDPLATFORM ${NODE_RUNTIME_IMAGE} AS model-catalog
WORKDIR /source
COPY config/external-urls.json config/external-urls.json
COPY scripts/fetch-model-catalog.mjs scripts/fetch-model-catalog.mjs
RUN node scripts/fetch-model-catalog.mjs \
      --output /opt/sciencediscovery/resources/model-catalog/models-dev.json \
 && test -s /opt/sciencediscovery/resources/model-catalog/models-dev.json

# ---------------------------------------------------------------- builder ---
FROM ${NODE_BUILD_IMAGE} AS builder
ARG PNPM_VERSION
ARG PYTHON_VERSION
ARG JIUWENSWARM_TAG
ARG UV_HTTP_TIMEOUT
ENV UV_HTTP_TIMEOUT=${UV_HTTP_TIMEOUT}

COPY --from=uv /uv /usr/local/bin/uv

# UV_LINK_MODE=copy keeps cache mounts and environments on separate filesystems
# without relying on hardlinks. The remaining settings make every sync
# production-oriented and let managed Python downloads share the uv cache.
ENV UV_PYTHON_INSTALL_DIR=/opt/sciencediscovery/python \
    UV_PYTHON_CACHE_DIR=/root/.cache/uv/python \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1

RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /app

# Dependency layer first: only workspace manifests, so editing application
# source does not invalidate the pnpm install cache. The manifests stage above
# derives the list from the build context, so adding a workspace package needs
# no change here (services/gateway and services/paper are Python and carry no
# package.json).
COPY --from=manifests /manifests/ ./
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Install managed Python and third-party Python dependencies before application
# source is copied. Bind-mounted manifests participate in the cache key without
# becoming part of the layer.
RUN mkdir -p \
      services/paper \
      services/gateway \
      services/adapter \
      services/memory-graph \
      services/evolve

RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install "${PYTHON_VERSION}"

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/paper/pyproject.toml,target=/app/services/paper/pyproject.toml \
    --mount=type=bind,source=services/paper/uv.lock,target=/app/services/paper/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/paper \
      uv sync --project services/paper --locked --no-install-project --python "${PYTHON_VERSION}"

# Install the gateway's third-party dependencies from its lock before the local
# sources exist, skipping the local package itself; the final locked sync below
# validates the result once the full tree is present.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/gateway/pyproject.toml,target=/app/services/gateway/pyproject.toml \
    --mount=type=bind,source=services/gateway/uv.lock,target=/app/services/gateway/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/gateway \
      uv sync --project services/gateway --frozen --no-install-project \
        --python "${PYTHON_VERSION}"

# The adapter, same treatment: our own code, a locked third-party dependency
# tree (compiled extensions among them, e.g. uvloop, httptools, pydantic-core).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/adapter/pyproject.toml,target=/app/services/adapter/pyproject.toml \
    --mount=type=bind,source=services/adapter/uv.lock,target=/app/services/adapter/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/adapter \
      uv sync --project services/adapter --frozen --no-install-project \
        --python "${PYTHON_VERSION}"

# UI-accessible sidecars must be present in the one-image deployment too.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/memory-graph/pyproject.toml,target=/app/services/memory-graph/pyproject.toml \
    --mount=type=bind,source=services/memory-graph/uv.lock,target=/app/services/memory-graph/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/memory-graph \
      uv sync --project services/memory-graph --frozen --no-install-project \
        --python "${PYTHON_VERSION}"

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/evolve/pyproject.toml,target=/app/services/evolve/pyproject.toml \
    --mount=type=bind,source=services/evolve/uv.lock,target=/app/services/evolve/uv.lock \
    UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/evolve \
      uv sync --project services/evolve --frozen --no-install-project --extra candidates \
        --python "${PYTHON_VERSION}"

# JiuwenSwarm itself: not our code and not a workspace project, so it has no
# lockfile to sync against here — installed straight from its PyPI release
# ("workswarm") into its own venv, at the same path scripts/jiuwenswarm.sh
# expects (JIUWENSWARM_SRC below points start-stack.sh's runtime helper at
# it). The pinned tag's PyPI publish resolves its own git-pinned transitive
# dependency (openjiuwen) as a plain PyPI version, so this needs no cloning
# for dependency provisioning. After COPY, replace the Swarm package with a
# patched wheel built from the pinned Git tag, as binary packaging also does.
# This dependency layer stays cacheable across source-only changes.
RUN --mount=type=cache,target=/root/.cache/uv \
    case "${JIUWENSWARM_TAG}" in \
      workswarm*) jiuwenswarm_pypi_version="${JIUWENSWARM_TAG#workswarm}" ;; \
      *) echo "JIUWENSWARM_TAG must look like workswarm<version> (its PyPI package+version); got: ${JIUWENSWARM_TAG}" >&2; exit 1 ;; \
    esac \
 && uv venv /opt/sciencediscovery/jiuwenswarm/src/.venv --python "${PYTHON_VERSION}" \
 && uv pip install --python /opt/sciencediscovery/jiuwenswarm/src/.venv/bin/python \
      "workswarm==${jiuwenswarm_pypi_version}"

COPY . .

RUN pnpm build && pnpm runner:binary

# Patch the actual installed package, not the virtualenv's parent directory.
# A mismatch with the pinned Git sources fails the build, never container boot.
RUN bash scripts/build-swarm-wheel.sh /tmp/swarm-wheels "$JIUWENSWARM_TAG" \
 && swarm_python=/opt/sciencediscovery/jiuwenswarm/src/.venv/bin/python \
 && uv pip install --python "$swarm_python" --no-deps --reinstall /tmp/swarm-wheels/*.whl \
 && swarm_package_root="$("$swarm_python" -c 'import importlib.util,pathlib; print(pathlib.Path(importlib.util.find_spec("jiuwenswarm").origin).parent.parent)')" \
 && "$swarm_python" scripts/swarm-patches.py apply "$swarm_package_root" "$JIUWENSWARM_TAG" \
 && "$swarm_python" scripts/swarm-patches.py verify "$swarm_package_root" "$JIUWENSWARM_TAG"

# Install the local projects from the complete source tree.
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/paper \
      uv sync --project services/paper --locked --python "${PYTHON_VERSION}" \
 && UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/gateway \
      uv sync --project services/gateway --locked --python "${PYTHON_VERSION}" \
 && UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/adapter \
      uv sync --project services/adapter --locked --python "${PYTHON_VERSION}" \
 && UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/memory-graph \
      uv sync --project services/memory-graph --locked --python "${PYTHON_VERSION}" \
 && UV_PROJECT_ENVIRONMENT=/opt/sciencediscovery/envs/evolve \
      uv sync --project services/evolve --locked --extra candidates --python "${PYTHON_VERSION}"

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

# In-container defaults. Everything the runner needs stays on container
# loopback; only the API port is published.
ENV NODE_ENV=production \
    SCIENCE_AGENT_DATA_DIR=/app/data \
    SCIENCE_AGENT_HOST=0.0.0.0 \
    SCIENCE_AGENT_PORT=4310 \
    SCIENCE_AGENT_RUNNER_HOST=127.0.0.1 \
    SCIENCE_AGENT_RUNNER_PORT=4311 \
    SCIENCE_AGENT_RUNNER_URL=http://127.0.0.1:4311 \
    SCIENTIFIC_ENVS=1 \
    SCIENCE_AGENT_PROVISIONER_SEED_PATH=/opt/sciencediscovery/provisioner/micromamba \
    SCIENCE_AGENT_MODEL_CATALOG_PATH=/opt/sciencediscovery/resources/model-catalog/models-dev.json \
    SCIENCE_AGENT_ENVS_ROOT=/opt/sciencediscovery/envs \
    SCIENCE_AGENT_PAPER_PYTHON_PATH=/opt/sciencediscovery/envs/paper/bin/python \
    SCIENCE_AGENT_GATEWAY_PYTHON_PATH=/opt/sciencediscovery/envs/gateway/bin/python \
    SCIENCE_AGENT_ADAPTER_PYTHON_PATH=/opt/sciencediscovery/envs/adapter/bin/python \
    SCIENCE_AGENT_MEMORY_GRAPH_PYTHON_PATH=/opt/sciencediscovery/envs/memory-graph/bin/python \
    SCIENCE_AGENT_EVOLVE_PYTHON_PATH=/opt/sciencediscovery/envs/evolve/bin/python \
    JIUWENSWARM_SRC=/opt/sciencediscovery/jiuwenswarm/src

COPY --from=builder /opt/sciencediscovery /opt/sciencediscovery
COPY --from=micromamba /opt/sciencediscovery/provisioner /opt/sciencediscovery/provisioner
COPY --from=model-catalog /opt/sciencediscovery/resources /opt/sciencediscovery/resources
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
