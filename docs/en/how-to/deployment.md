# Deploy ScienceDiscovery

The root [README](../../../README.md) provides the shortest startup path. This guide covers deployment operations; see [Configuration reference](../reference/configuration.md) for environment variables, default ports, quotas, and storage layout.

## Three deployment modes

| Mode | What the user receives | Host dependencies | Intended use |
|---|---|---|---|
| [Source-built single-file binary](#single-file-binary-deployment) | **One** executable per architecture | Source toolchain at build time; Bubblewrap at runtime | Portable internal release artifacts |
| [Docker image](#docker-deployment) | Container image and Compose file | Docker Engine 24+ and Compose v2 | Container-based operations |
| [Local mode](#local-mode-host-processes) | Source repository | Node, pnpm, uv, Python, and Bubblewrap | Development and debugging |

**These paths are independent. Choose one and do not mix them.** The binary path never uses Docker: the executable embeds Node, CPython, gateway dependencies, the web assets, and micromamba. Use the image path for container deployment instead of putting the binary inside an image.

None of the modes bundles Neo4j. Science Memory needs an external Neo4j server and remains disabled when it is not configured; this does not affect the web or conversation path.

## Single-file binary deployment

### Build and run

This section explains how to build, verify, and run the artifact from the current source. The packaging output contains one file per architecture plus `VERSION` and `SHA256SUMS`:

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
```

Build, verify, and run for the host architecture from the repository root:

```bash
case "$(uname -m)" in
  x86_64|amd64|x64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
./scripts/package-binary-release.sh \
  --arch "$arch" --version local --output dist/binary-release-local
artifact="dist/binary-release-local/ScienceDiscovery-local-linux-$arch"
(cd dist/binary-release-local && sha256sum --check SHA256SUMS)
"$artifact" serve
```

`serve` starts the Bubblewrap runner, then the control API with the Web UI, using the same health checks as [local mode](#local-mode-host-processes), then prints the UI URL. Those two are the whole resident stack: the agent loop, the model calls, and the web providers all run inside the API process, and the bundled Python MCP servers are spawned on demand rather than supervised. It listens on <http://127.0.0.1:4310> by default. Sign in with `SCIENCE_AGENT_AUTH_TOKEN`; when it is unset, `serve` prints the token generated on first start. Ctrl-C stops all services in reverse order.

The first `serve` extracts the embedded runtime to `~/.cache/science-discovery/payload/<payload-id>` (change it with `XDG_CACHE_HOME` or `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR`). Later runs reuse it. The directory contains the payload digest, so an upgrade does not overwrite an older extraction. If only the former `~/.cache/science-agent` cache exists, the launcher imports it once by renaming it to the new location and prints a compatibility message. If the new location already exists, the launcher keeps it unchanged and logs that the import was skipped.

### Dependencies installed on first launch

The artifact deliberately does not package uv or the gateway's third-party Python dependency tree. After extraction, the first `serve` installs them into the data directory (later launches reuse them; an upgrade rebuilds only what became stale):

1. **uv** — the wheel pinned at build time (version and SHA256) is downloaded from a PyPI index, Huawei Cloud mirror `https://mirrors.huaweicloud.com/repository/pypi/simple` by default, verified, and its binary is placed under `<data-dir>/tools/uv/`.
2. **The gateway Python environment** — uv creates a venv at `<data-dir>/envs/gateway` on the bundled CPython and installs the hash-pinned requirements exported from `services/gateway/uv.lock` at build time (`--require-hashes`), so the versions match the lockfile exactly while the download goes through the configured mirror.

Related environment variables (usable in `--env-file`):

| Variable | Default | Purpose |
|---|---|---|
| `SCIENCE_AGENT_PYPI_INDEX` | Huawei Cloud PyPI mirror | Package index for Python dependencies |
| `SCIENCE_AGENT_UV_INSTALL_INDEX` | same as `SCIENCE_AGENT_PYPI_INDEX` | Separate index for the uv wheel download |
| `SCIENCE_AGENT_UV_PATH` | — | Use an existing uv executable, skipping the download |

For air-gapped hosts, run the first launch once on a connected machine and copy the whole data directory over, or point `SCIENCE_AGENT_UV_PATH` at a pre-installed uv and `SCIENCE_AGENT_PYPI_INDEX` at a reachable mirror.

### Host dependency: Bubblewrap

Bubblewrap is the **only** host dependency users install. It cannot be bundled because the sandbox needs host-kernel user namespaces. When it is absent, `serve` fails immediately and prints installation commands:

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
sudo pacman -S bubblewrap            # Arch
sudo apk add bubblewrap              # Alpine
```

Enabling the `domain-allowlist` mode of **sandbox network access** additionally needs a usable `python3` on the host (the interpreter for the in-sandbox egress bridge; override it with `SCIENCE_AGENT_EGRESS_PYTHON`). Without it, executions in that mode fail with an explicit reason and the default `none` mode is unaffected. Neither mode needs root, extra capabilities, or host firewall configuration.

To inspect the UI without sandbox execution, start with `--skip-sandbox-check`; `run_python` and `run_shell` will fail while other functions remain available. If Bubblewrap exists but unprivileged user namespaces are restricted, `serve` warns and continues. Diagnose it as described under [Sandbox and host requirements](#sandbox-and-host-requirements).

### Commands and options

```text
ScienceDiscovery serve [options]       Start the Web UI, control API and sandbox runner
ScienceDiscovery extract --to <dir>    Extract the embedded runtime without starting it
ScienceDiscovery version               Print the version and embedded Node, CPython, and micromamba versions
ScienceDiscovery help                  Show help
```

| Option | Default | Purpose |
|---|---|---|
| `--data-dir <path>` | `./.sciencediscovery-data` | Runtime data; see [Storage layout](../reference/configuration.md#storage-layout) |
| `--host <address>` | `127.0.0.1` | Web UI/API bind address |
| `--port <port>` | `4310` | Web UI/API port |
| `--runner-port <port>` | `4311` | Runner port (loopback only) |
| `--env-file <path>` | — | Read `KEY=VALUE` settings before startup; existing environment values win |
| `--bwrap <path>` | `bwrap` on `PATH` | Bubblewrap executable |
| `--skip-sandbox-check` | off | Start without Bubblewrap; sandbox execution is unavailable |
| `--no-scientific-envs` | off | Do not initialize managed scientific environments |

The variables in [Configuration reference](../reference/configuration.md#environment-variables-local-mode) also apply and can be exported or placed in `--env-file`. The API and the runner bind to loopback by default. To expose the API, first replace `SCIENCE_AGENT_AUTH_TOKEN`, then explicitly use `--host 0.0.0.0` only on a trusted, protected network.

### What the binary contains

| Component | Description |
|---|---|
| Launcher | Node single-executable application with a fixed Node binary; the artifact is a normal ELF executable |
| Node runtime | Runs the control API and runner |
| CPython 3.12 | Relocatable distribution; no host Python needed, and it is the base interpreter for the first-launch gateway venv |
| Web assets | Prebuilt `apps/web/dist` |
| Gateway wheel and bootstrap pins | The `sciencediscovery-gateway` wheel (our own code), the hash-locked dependency export, and the uv wheel pin |
| micromamba | Fixed version, seeded to `<data-dir>/scientific-envs/bin/micromamba` on first `serve`, then checked by the runner against the same release manifest |

It does not contain uv or the gateway's third-party Python dependencies (see [Dependencies installed on first launch](#dependencies-installed-on-first-launch)), nor Neo4j, starter Python/R scientific environments, or a conda package cache. Creating a starter environment for the first time still needs access to permitted package channels.

### Build both architecture packages

```bash
./scripts/package-binary-release.sh \
  --version local --output dist/binary-release-local       # x86_64 and aarch64
(cd dist/binary-release-local && sha256sum --check SHA256SUMS)

./scripts/package-binary-release.sh \
  --arch x86_64 --version local --output dist/binary-release-local
```

The build host needs `node`, `pnpm`, `uv`, `tar`, `zstd`, and `sha256sum`; it needs **neither Docker nor QEMU** (uv is a build tool only — it exports the locked dependency list and builds the gateway wheel, and is not shipped). Both architectures can be produced on one x86_64 or aarch64 host. Node and CPython runtimes are downloaded with pinned versions and SHA256 values from `scripts/binary-release/runtimes.json`; the gateway's third-party dependencies are no longer embedded and instead install natively on the user's machine at first launch; TypeScript outputs, web assets, and the gateway wheel are architecture independent. The packager still checks the bundled CPython extension modules' ELF architecture and fails the build on a mismatch. The repository has no submodules, so a plain checkout is enough.

The output contains both executables, `VERSION`, and `SHA256SUMS`. The gateway dependency tree (duckdb, pandas, numpy, onnxruntime, and others) is no longer shipped, so the artifacts are much smaller than the older format that embedded it; that tree is downloaded through the configured mirror at first launch instead. Compression defaults to zstd level 19; use `SCIENCE_AGENT_PAYLOAD_ZSTD_LEVEL` to lower it during iteration.

## Local mode (host processes)

```bash
./scripts/start-stack.sh --mode local              # install, build, and start all services
./scripts/start-stack.sh --mode local --no-build   # start only after a previous build
```

In local mode the shared entry point reads the root `.env`, checks the dependencies from [Requirements](../../../README.md#requirements), installs and builds when needed, and starts ordinary host processes:

| Service | Address | Purpose |
|---|---|---|
| `services/gateway` | no port | Interpreter environment for the bundled Python MCP servers |
| `services/runner` | 127.0.0.1:4311 | Rootless Bubblewrap executor (background) |
| `services/api` | 127.0.0.1:4310 | Control API and Web UI (foreground) |

Ctrl-C stops its background services. `./scripts/run-local.sh [--no-build]` remains a thin compatibility wrapper, and `pnpm start` and `pnpm server` continue to use it. For unattended use, run it under a process manager such as a systemd user unit or tmux, or use [Docker deployment](#docker-deployment). The runner always binds only to loopback.

The first start prepares a Python 3.12 gateway environment under `.sciencediscovery-data/envs/gateway`. It holds the interpreter for the bundled Python MCP servers (biomed, UniProt); the repository has no submodules.

Ascend host NPU workloads use the same local-mode entry point. The Runner exposes `run_npu_job` only after an administrator explicitly sets `SCIENCE_AGENT_NPU_BROKER=1` and configures the workload entry points in `.env`. Before enabling it, create and verify a managed Python scientific environment revision for the Ascend stack; built-in NPU workloads, including smoke tests, submit against that revision rather than `SCIENCE_AGENT_NPU_PYTHON`. See [Configuration reference](../reference/configuration.md#environment-variables-local-mode) for variables and [Ascend NPU Host Broker](../explanation/ascend-npu-runner.md) for the design boundary.

## Docker deployment

One image contains the complete stack. `docker-entrypoint.sh` wraps `scripts/start-stack.sh --mode docker` and starts the same gateway, runner, and control API/Web UI processes in one container; Docker-specific checks run only in this mode. The builder uses pnpm and uv. The runtime image contains Node, prebuilt service Python environments, Bubblewrap, and a fixed micromamba selected and verified for `TARGETARCH`. The host needs only Docker.

### Prerequisites

- A Linux x86_64 or aarch64 host with Docker Engine 24+ and the Compose v2 plugin. The runner needs usable host-kernel user namespaces.
- Unprivileged user namespaces available to the container:

  ```bash
  sysctl kernel.unprivileged_userns_clone            # should be 1 where exposed
  sysctl kernel.apparmor_restrict_unprivileged_userns # must be 0 on Ubuntu 24.04+
  ```

### Build and start

```bash
cp .env.docker.example .env   # or merge its keys into an existing .env
mkdir -p data                 # host directory for all runtime state
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:4310/health
```

Open <http://127.0.0.1:4310> and sign in with `SCIENCE_AGENT_AUTH_TOKEN`; when it is unset, the container log prints the token generated on first start. The first build compiles the Web UI, resolves both service Python environments, and downloads micromamba, so it takes longer and needs network access. Starting services and obtaining micromamba from the completed image do not. The package-network boundary for managed starter Python is described under [Limitations](#limitations).

BuildKit selects the `linux/amd64` or `linux/arm64` micromamba for `TARGETARCH` and verifies it against the runner's shared release manifest. The binary is stored at `/opt/sciencediscovery/provisioner/micromamba`; when `/app/data` is an empty bind mount, the first start copies it to the managed default path and the runner verifies it again. This does not access GitHub at **runtime**.

```bash
docker compose logs -f        # startup order: runner -> API
docker compose ps             # status and health result
docker compose down           # remove the container; preserve ./data
docker compose up -d --build  # rebuild and restart after updating source
```

### Data directory

The host `./data` bind mount maps to `/app/data` and is the only persistent location. Its layout matches [Storage layout](../reference/configuration.md#storage-layout). There are **no Docker named volumes**: projects, sessions, workspaces, credentials, and audit records are ordinary host files that can be inspected, backed up, and removed, and survive `docker compose down` and image rebuilds.

To separate container state from an existing local `data/`, change the host side of the bind mount in `docker-compose.yml`, for example to `- ./docker-data:/app/data`.

The container runs as uid/gid `1000:1000`. If the account IDs differ, set `SCIENCE_AGENT_UID` and `SCIENCE_AGENT_GID` (`id -u`, `id -g`) in `.env` and rebuild. Otherwise, the entry point exits immediately with an explicit unwritable-directory error.

Two locations differ from a host installation:

- uv-managed environments are baked into `/opt/sciencediscovery/envs/{gateway,paper}`, not the data directory. A fresh `compose up` therefore needs no network access for them.
- Fixed micromamba is baked into `/opt/sciencediscovery/provisioner/micromamba` and seeded to `.sciencediscovery-data/scientific-envs/bin/micromamba` for an empty data directory. When `SCIENCE_AGENT_PROVISIONER_PATH` is explicitly set, seeding is skipped and the runner uses that administrator override.

### Sandbox and host requirements

The container does not replace or weaken the Bubblewrap sandbox. Agent Python, R, and shell commands still run under `bwrap` with separate namespaces, seccomp filtering, and — unless an administrator configures a sandbox network domain allowlist — no network at all. Even with an allowlist the sandbox keeps its own empty network namespace and reaches the internet only through the runner's egress gateway. Docker's default security configuration blocks the user-namespace mounts and the fresh procfs Bubblewrap needs, so Compose relaxes these three container settings:

| Setting | Reason |
|---|---|
| `seccomp=unconfined` | Docker's default seccomp permits `mount`/`pivot_root` only with `CAP_SYS_ADMIN`; Bubblewrap invokes them inside its own namespace |
| `apparmor=unconfined` | The `docker-default` AppArmor profile on Debian/Ubuntu denies `mount` |
| `systempaths=unconfined` | Lifts Docker's default read-only and masked paths under `/proc` and `/sys`. Without it the kernel refuses to let Bubblewrap mount a fresh procfs in the sandbox's own pid namespace (`Can't mount proc on /newroot/proc: Operation not permitted`), and the product has to fall back to binding the container's `/proc` |

No capability is added, `privileged: true` is not used, and the Docker socket is not mounted. These settings relax the **container** boundary, not the agent sandbox. Treat this container as trusted local software, like the host installation.

**If `systempaths` is not relaxed** (an older Compose file, a bare `docker run`, or Kubernetes defaults), the product automatically falls back to `--ro-bind /proc /proc`. Executions still run, but the sandbox sees the **container's process list** instead of only its own processes. The fallback is never silent: both the runner startup log and the preflight print a warning naming the cause and the consequence. Restore the stronger profile by adding `systempaths=unconfined` — do not switch to `privileged`.

If the host still restricts user namespaces, the API and UI start and `GET /health` reports runner state, but every `run_python` and `run_shell` fails. Startup runs a Bubblewrap preflight and prints a warning with the checks above. On Ubuntu 24.04+, the usual fix is:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### Limitations

- This is a single-user trust model: one static bearer token, no TLS, and no multi-user accounts. The port is published only on `127.0.0.1` by default because Docker-published ports bypass many host firewall rules. Set `SCIENCE_AGENT_PUBLISH_HOST=0.0.0.0` only on a trusted network and replace the token first.
- The image contains no API tokens, model credentials, or host `.sciencediscovery-data/` content. `.dockerignore` excludes `.sciencediscovery-data/`, `.env`, `node_modules/`, build outputs, and local caches. Credentials enter only through Compose variables and the bind-mounted data directory.
- The image includes fixed micromamba and does not access GitHub for it at runtime, but this iteration does **not** bundle starter Python/R environments or a conda package cache. First-time starter Python creation still needs permitted package channels. Package resolution becomes offline only after an administrator populates and selects `SCIENCE_AGENT_PACKAGE_CACHE_DIR`.
- The image is a convenience package, not a hardened multi-tenant deployment. Containerization does not change the security boundaries of a static bearer token, no TLS, and no runner CPU/memory quotas.

### Build micromamba packages for both architectures

```bash
./scripts/package-micromamba-release.sh --output dist/micromamba-release
sha256sum --check dist/micromamba-release/SHA256SUMS
```

The defaults are `sciencediscovery-micromamba-<version>-linux-x86_64.tar.gz` and `sciencediscovery-micromamba-<version>-linux-aarch64.tar.gz`. Each contains only `bin/micromamba` and a `manifest.json` recording the target architecture, upstream filename, and binary SHA256; the output also contains `VERSION` and `SHA256SUMS`. The script does **not** create or collect starter Python/R environments, conda caches, or other Python trees.

Use `--arch x86_64` or `--arch aarch64` for one architecture, or `--dry-run` to inspect versions, URLs, and SHA256 values without downloading. On a restricted builder, prepare both raw binaries from the release manifest and use `--source-dir <directory>` for local verification and packaging.
