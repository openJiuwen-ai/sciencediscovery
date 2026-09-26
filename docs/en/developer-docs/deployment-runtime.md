# Deployment Runtime Internals

This document records implementation details for local source mode, Docker, and remote Runner deployment that do not belong in the user deployment tutorial. For operational steps, see the [deployment guide](../getting-started/deployment.md).

## Local source startup chain

Local mode starts through:

```bash
scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

The launcher:

1. reads the repository-root `.env`;
2. validates dependencies;
3. installs and builds as needed;
4. selects Bubblewrap on Linux or Seatbelt on macOS;
5. starts the JiuwenSwarm, adapter, API/Web, and Runner components;
6. prints the `Open to sign in` URL and local service access token.

Historical entry points `./scripts/run-local.sh [--no-build]`, `pnpm start`, and `pnpm server` remain compatibility wrappers.

The public HTTP entry point is 4310. See [Runtime architecture](architecture.md) for the current process and port responsibilities.

The first local start also prepares the gateway Python environment and the pinned micromamba runtime. Exact storage paths live in [Configuration reference](../reference/configuration.md).

## Remote Runner automatic deployment

SSH deployment uses a Runner SEA single file that includes its own Node runtime, so the remote machine does not need Node installed.

A full Linux local build, Docker build, and release package prepare Linux x64/arm64 Runner SEA artifacts. For partial builds, after building Runner/Executor run:

```bash
pnpm runner:binary
```

Outputs live under:

```text
services/runner/dist/sea/
```

They ship with the product and are not committed to source.

When connecting to a remote host:

1. select the artifact matching remote `uname -m`;
2. upload it through authenticated SSH SFTP after host-fingerprint verification;
3. verify SHA-256;
4. publish and start it directly;
5. reuse an identical build when already present;
6. keep Runner HTTP traffic inside the SSH tunnel.

The Runner SEA contains Node and Runner code, not a complete Linux userland. The remote host still needs:

- system libraries capable of running the Node ELF;
- Bubblewrap;
- usable sandbox kernel features.

Scientific environments are prepared through the managed-environment mechanism. Missing deployment or sandbox prerequisites fail explicitly rather than falling back to bare SSH execution.

### Runner binary lifecycle

Each remote Runner binary is named by its own SHA-256.

After an application upgrade, reconnecting adds a new file instead of overwriting the old one. Once the new Runner passes health checks, the control plane best-effort removes older files in the same directory that:

- use the SHA-256 naming convention;
- are not currently executed by any process.

Active Runner binaries are always preserved. Files outside the naming convention are untouched. Cleanup failure is logged but does not break an established connection.

## Docker build/runtime differences

The Docker image bakes service runtime environments into the image while application state remains in the host bind-mounted data directory.

Compared with host local mode:

- gateway/paper Python environments live under `/opt/sciencediscovery/envs/`;
- pinned micromamba lives at `/opt/sciencediscovery/provisioner/micromamba`;
- an empty data directory is seeded with micromamba at `/app/data/scientific-envs/bin/micromamba`;
- projects, sessions, credentials, workspaces, and audit data remain under `/app/data`.

See [Configuration reference](../reference/configuration.md#docker-environment-variables) for complete Docker variables and bind-mount mappings.

## Multiple Docker instances

Multiple instances on one host are isolated by three values:

- Compose project name;
- published port;
- data directory.

Example:

```bash
mkdir -p data-b

COMPOSE_PROJECT_NAME=sciencediscovery-b \
SCIENCE_AGENT_PUBLISH_PORT=4320 \
SCIENCE_AGENT_DATA_HOST_DIR=./data-b \
  docker compose up -d
```

Or use a separate env file:

```bash
docker compose --env-file .env.b up -d
docker compose --env-file .env.b ps
docker compose --env-file .env.b down
```

Each instance must have a unique data directory and host port, and management commands must keep the same project name/env file. Different code trees should generally use different `SCIENCE_AGENT_IMAGE` tags.

Multi-instance operation does not require and should not weaken security settings.

## Docker sandbox boundary

The container does not replace Bubblewrap. Agent Python/R/Shell still run under the bwrap + seccomp sandbox.

The official Compose file relaxes three restrictions on the trusted container boundary so Bubblewrap can create its inner namespaces:

| Setting | Why |
| --- | --- |
| `seccomp=unconfined` | Docker's default seccomp blocks mount / pivot_root required by bwrap |
| `apparmor=unconfined` | docker-default AppArmor on some hosts rejects mount |
| `systempaths=unconfined` | allows bwrap to mount a private procfs in its own PID namespace |

These settings relax the **container** boundary, not the Agent sandbox. Compose adds no capabilities, does not use `privileged: true`, and does not mount the Docker socket.

Without `systempaths=unconfined`, Runner may fall back to read-only binding the container's `/proc` into the sandbox. Execution still works, but the sandbox can see the container process list and logs a warning.

See [Sandbox execution](sandbox-execution.md) for exact probes, seccomp, network allowlists, and namespace behavior.

## Docker build dependencies and diagnostics

Docker builds depend on BuildKit `TARGETARCH`. The error:

```text
TARGETARCH is required to select the managed micromamba release
```

normally means old `docker-compose` v1 or disabled BuildKit. Use Docker 24+ and `docker compose`.

Build-time dependencies include Docker Hub, ghcr.io, Debian apt, npm registry, PyPI, GitHub Releases, and models.dev.

Build proxies can use BuildKit predefined arguments:

```bash
docker compose build \
  --build-arg HTTP_PROXY=http://proxy.example:3128 \
  --build-arg HTTPS_PROXY=http://proxy.example:3128
```

Runtime model, connector, and research-source proxies belong in product network proxy settings or Compose environment variables, not Dockerfile changes.

## Current Docker limitations

The Docker path is a convenient trusted single-user deployment, not a hardened multi-tenant service.

Important boundaries:

- one static bearer token;
- no TLS by default;
- no Runner CPU/memory cgroup quota;
- publish to `127.0.0.1` by default;
- the image contains no user API tokens, model credentials, or host data-directory contents;
- starter Python/R environments and the conda package cache are not fully preloaded, so first environment creation may still require package sources;
- independent Python sidecar capabilities not included in the image/startup path are unavailable; use `/health` and current-version docs as the authority.

## Ascend NPU

Ascend Host Broker, device selection, allowlisted workloads, and managed-environment requirements already have dedicated documentation:

- [Ascend NPU Runner](ascend-npu-runner.md)
- [Sandbox execution](sandbox-execution.md)
- [Configuration reference](../reference/configuration.md)
