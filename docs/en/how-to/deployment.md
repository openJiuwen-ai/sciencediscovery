# Deploy ScienceDiscovery

The root [README](../../../README.md) provides the shortest startup path. This guide covers deployment operations; see [Configuration reference](../reference/configuration.md) for environment variables, default ports, quotas, and storage layout.

## Three deployment modes

| Mode | What the user receives | Host dependencies | Intended use |
|---|---|---|---|
| [Source-built single-file binary](#single-file-binary-deployment) | **One** executable per architecture | Source toolchain at build time; Bubblewrap at runtime | Portable internal release artifacts |
| [Docker image](#docker-deployment) | Container image and Compose file | Docker Engine 24+ and Compose v2 | Container-based operations |
| [Local mode](#local-mode-host-processes) | Source repository | Node, pnpm, uv, and Python; Linux uses Bubblewrap, while macOS uses the built-in Seatbelt sandbox | Development and debugging |

**These paths are independent. Choose one and do not mix them.** The binary path never uses Docker: the executable embeds Node, CPython, gateway dependencies, the web assets, and micromamba. Use the image path for container deployment instead of putting the binary inside an image.

None of the modes bundles Neo4j. ScienceMemory needs an external Neo4j server and remains disabled when it is not configured; this does not affect the web or conversation path.

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

`serve` starts the Bubblewrap runner, then the control API with the Web UI, using the same health checks as [local mode](#local-mode-host-processes), then prints the `Open to sign in` URL and the local service access token. Those two are the whole resident stack: the agent loop, the model calls, and the web providers all run inside the API process, and the bundled Python MCP servers are spawned on demand rather than supervised. It listens on <http://127.0.0.1:4310> by default. Open the `Open to sign in` URL from the startup output; the browser saves the local service access token automatically and signs in. (If opening <http://127.0.0.1:4310> directly, the Connection guide allows pasting the local service access token.) Keep the sign-in URL private. When `SCIENCE_AGENT_AUTH_TOKEN` is set, that configured token is used. Ctrl-C stops all services in reverse order.

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

To inspect the UI without sandbox execution, start with `--skip-sandbox-check`; `run_shell` will fail while other functions remain available. If Bubblewrap exists but unprivileged user namespaces are restricted, `serve` warns and continues. Diagnose it as described under [Sandbox and host requirements](#sandbox-and-host-requirements).

### Commands and options

```text
ScienceDiscovery serve [options]       Start the Web UI, control API and sandbox runner
ScienceDiscovery run [input] [options] Run an agent task against a running serve, as a CLI client
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

### The run subcommand (CLI client)

The Web UI is the recommended surface for interactive work (open `http://127.0.0.1:4310` and sign in with the token `serve` printed). `run` is the command-line front end to that same `serve`: identical behaviour, meant for driving a task straight from a terminal or from a pipe or script. It loads the same token as `serve` (from `.env` or `--data-dir`), so nothing has to be passed explicitly. Files the agent produces land under `projects/<id>/sessions/<id>/workspace/` inside `--data-dir`, not in the current working directory; reach them there or through the Artifact panel in the Web UI.

Start `serve` first, then run the client from a second terminal:

```bash
./ScienceDiscovery serve                        # terminal 1: the resident stack
./ScienceDiscovery run "Write me a quicksort"   # terminal 2: one agent task as a client
```

It connects to `http://127.0.0.1:4310` by default and reads the token `serve` generated from `--data-dir` (default `./.sciencediscovery-data`), so sharing a `--data-dir` between `run` and `serve` needs no further setup. Typed directly at a terminal it defaults to **text mode** — the answer on stdout, progress on stderr, and a 1/2/3 choice when a permission card appears. In a pipe or a script it defaults to **jsonl mode** and requires an explicit `--auto-approve`, because a non-interactive run cannot answer a permission prompt and refuses to start instead. Full options: `./ScienceDiscovery run --help`.

> In local source mode there is no `ScienceDiscovery` binary; run the client as `node services/launcher/dist/main.js run ...`, pointed at the `serve` that `start-stack.sh` started (same default address and data directory, so again no extra configuration). In Docker mode, do not run `run` inside the container; from the host, pass `--data-dir ./data` to point at the bind-mounted data directory (or give `--token` explicitly), and leave the rest at their defaults.

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

Source mode supports Linux x86_64/aarch64 and macOS x64/arm64. Both platforms use the same startup command and require Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, Git, and curl. The sandbox dependency is platform-specific:

- Linux needs Bubblewrap 0.6+ (0.8+ recommended) and usable unprivileged user namespaces.
- macOS uses the built-in Seatbelt sandbox through `/usr/bin/sandbox-exec`; Bubblewrap is not required.

From the repository root, run:

```bash
./scripts/start-stack.sh --mode local              # install, build, and start all services
./scripts/start-stack.sh --mode local --no-build   # start only after a previous build
```

SSH auto-deployment uses a single-file Runner SEA with its own Node runtime, so the target machine does not need Node installed. A full local start on Linux, a Docker build, and a binary release all prepare both Linux x64 and arm64 Runners; developers who build only some packages can run `pnpm runner:binary` after building the Runner and the Executor. The files land in `services/runner/dist/sea/`, ship with the product, and are not committed to the source tree.

On connect the product picks the file matching the remote `uname -m`, streams it over the authenticated SSH SFTP channel whose host fingerprint is already verified, publishes it after checking its SHA-256, and starts it directly; an identical build already on the machine is reused. The Runner's HTTP traffic still travels only through the SSH tunnel. The SEA contains Node and the Runner code, not a full Linux userland: the machine still needs the system libraries to run that Node ELF, Bubblewrap, and a usable sandbox, and scientific environments are prepared through the existing managed-environment mechanism. When a deployment or sandbox prerequisite is missing the product reports it instead of falling back to bare SSH execution.

Each binary is named after its own SHA-256, so upgrading the control plane and reconnecting adds a file rather than overwriting one. Once the new binary has started and passed its health check, the control plane deletes the other SHA-256-named Runner binaries in that directory that no process is executing — each is about 120 MB, and a long run of iterations accumulates several GB. A binary a process is still executing is always kept, including one another control plane's connection is using, and files in that directory that do not carry such a name are left alone. The step is best effort: a failure is recorded in the connection log and does not affect the connection.

In local mode the shared entry point reads the root `.env`, checks the dependencies from [Requirements](../../../README.md#requirements), installs and builds when needed, and starts ordinary host processes. It automatically selects Bubblewrap on Linux and Seatbelt on macOS, so `SCIENCE_AGENT_SANDBOX_PROVIDER` does not need to be set manually:

| Service | Address | Purpose |
|---|---|---|
| `services/gateway` | no port | Interpreter environment for the bundled Python MCP servers |
| `services/runner` | 127.0.0.1:4311 | Rootless Bubblewrap (Linux) or Seatbelt (macOS) executor (background) |
| `services/api` | 127.0.0.1:4310 | Control API and Web UI (foreground) |

After startup, the terminal prints the `Open to sign in` URL and the local service access token. In another terminal, run `curl -fsS http://127.0.0.1:4310/health`, then open the `Open to sign in` URL in a browser; the browser saves the local service access token automatically and signs in. Ctrl-C stops the background services. `./scripts/run-local.sh [--no-build]` remains a thin compatibility wrapper, and `pnpm start` and `pnpm server` continue to use it. For unattended use, run it under a process manager such as a Linux systemd user unit or tmux on either Linux or macOS; Docker remains a Linux-only alternative. The runner always binds only to loopback.

The first start prepares a Python 3.12 gateway environment under `.sciencediscovery-data/envs/gateway`. It holds the interpreter for the bundled Python MCP servers (biomed, UniProt), and startup also provisions the pinned micromamba release for the host platform and architecture, so the first run needs access to the dependency sources. The repository has no submodules.

If macOS reports that Seatbelt is unavailable, first verify that `test -x /usr/bin/sandbox-exec` succeeds and check whether the current terminal or a parent sandbox prevents applying a Seatbelt profile. Startup does not silently fall back to unsandboxed execution. macOS support applies only to local source mode; the Linux single-file binary and Docker paths do not run directly on macOS.

Ascend host NPU workloads use the same local-mode entry point. The Runner exposes `run_npu_job` only after an administrator explicitly sets `SCIENCE_AGENT_NPU_BROKER=1` and configures the workload entry points in `.env`. Before enabling it, create and verify a managed Python scientific environment revision for the Ascend stack; built-in NPU workloads, including smoke tests, submit against that revision rather than `SCIENCE_AGENT_NPU_PYTHON`. See [Configuration reference](../reference/configuration.md#environment-variables-local-mode) for variables and [Ascend NPU Host Broker](../explanation/ascend-npu-runner.md) for the design boundary.

## Docker deployment

One image contains the complete stack. `docker-entrypoint.sh` wraps `scripts/start-stack.sh --mode docker` and starts the same gateway, runner, and control API/Web UI processes in one container; Docker-specific checks run only in this mode. The builder uses pnpm and uv. The runtime image contains Node, prebuilt service Python environments, Bubblewrap, and a fixed micromamba selected and verified for `TARGETARCH`. The host needs only Docker.

### Prerequisites

- A Linux x86_64 or aarch64 host with Docker Engine 24+ and the Compose v2 plugin. The runner needs usable host-kernel user namespaces.
- Unprivileged user namespaces available to the container, which the Bubblewrap sandbox depends on. **The gate is the probe the product actually runs, not the value of any sysctl**: both the container entry point and the runner build a minimal sandbox at startup and decide from the result. Confirm it positively once the stack is up:

  ```bash
  docker compose exec sciencediscovery sh -c '
    bwrap --unshare-all --unshare-user --die-with-parent \
      --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib \
      --symlink usr/lib64 /lib64 --proc /proc /usr/bin/true' \
    && echo "sandbox probe passed"
  ```

  These are the arguments `packages/sandbox-capability` probes with. Keep the outer `sh -c`: when `docker compose exec` makes `bwrap` the session's first process it cannot bring up loopback, which fails for reasons unrelated to sandbox capability. If the probe fails, see [Sandbox and host requirements](#sandbox-and-host-requirements).

### Build and start

```bash
cp .env.docker.example .env   # or merge its keys into an existing .env
mkdir -p data                 # host directory for all runtime state
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:4310/health
```

Check the container logs (`docker compose logs`) for the `Open to sign in` URL and local service access token, then open the sign-in URL in a browser to authenticate and save the token automatically. If opening <http://127.0.0.1:4310> directly, paste the local service access token into the Connection guide. When `SCIENCE_AGENT_AUTH_TOKEN` is set, that configured token is used. The first build compiles the Web UI, resolves both service Python environments, and downloads micromamba, so it takes longer and needs network access. Starting services and obtaining micromamba from the completed image do not. The package-network boundary for managed starter Python is described under [Limitations](#limitations).

BuildKit selects the `linux/amd64` or `linux/arm64` micromamba for `TARGETARCH` and verifies it against the runner's shared release manifest. The binary is stored at `/opt/sciencediscovery/provisioner/micromamba`; when `/app/data` is an empty bind mount, the first start copies it to the managed default path and the runner verifies it again. This does not access GitHub at **runtime**.

```bash
docker compose logs -f        # startup order: runner -> API
docker compose ps             # status and health result
docker compose down           # remove the container; preserve ./data
docker compose up -d --build  # rebuild and restart after updating source
```

### Data directory

The host `./data` bind mount maps to `/app/data` and is the only persistent location. Its layout matches [Storage layout](../reference/configuration.md#storage-layout). There are **no Docker named volumes**: projects, sessions, workspaces, credentials, and audit records are ordinary host files that can be inspected, backed up, and removed, and survive `docker compose down` and image rebuilds.

To separate container state from an existing local `data/`, set `SCIENCE_AGENT_DATA_HOST_DIR` in `.env`, for example `SCIENCE_AGENT_DATA_HOST_DIR=./docker-data`. Editing `docker-compose.yml` is not needed.

The container runs as uid/gid `1000:1000`. If the account IDs differ, set `SCIENCE_AGENT_UID` and `SCIENCE_AGENT_GID` (`id -u`, `id -g`) in `.env` and rebuild. Otherwise, the entry point exits immediately with an explicit unwritable-directory error.

Two locations differ from a host installation:

- uv-managed environments are baked into `/opt/sciencediscovery/envs/{gateway,paper}`, not the data directory. A fresh `compose up` therefore needs no network access for them.
- Fixed micromamba is baked into `/opt/sciencediscovery/provisioner/micromamba` and seeded, for an empty data directory, to `scientific-envs/bin/micromamba` inside the data directory — `/app/data/scientific-envs/bin/micromamba` in the container, `./data/scientific-envs/bin/micromamba` on the host. When `SCIENCE_AGENT_PROVISIONER_PATH` is explicitly set, seeding is skipped and the runner uses that administrator override.

### Several instances on one host

A single instance needs nothing extra: `docker compose up -d` uses the current directory name as the Compose project name and publishes on `127.0.0.1:4310`.

To run a second instance on the same host, give it its own **Compose project name**, **published port**, and **data directory**. The service sets no `container_name`, so the container and default network names are derived from the project name and changing it is enough to keep two instances apart:

```bash
COMPOSE_PROJECT_NAME=sciencediscovery-b \
SCIENCE_AGENT_PUBLISH_PORT=4320 \
SCIENCE_AGENT_DATA_HOST_DIR=./data-b \
  docker compose up -d
```

Putting those three in their own env file is easier to live with; pass it to every later command:

```bash
docker compose --env-file .env.b up -d
docker compose --env-file .env.b ps
docker compose --env-file .env.b down
```

Notes:

- The project name determines the container name (`<project>-sciencediscovery-1`) and the default network name; `docker compose -p <project> ...` is equivalent to `COMPOSE_PROJECT_NAME`.
- Every instance needs its own `SCIENCE_AGENT_DATA_HOST_DIR`. The data directory holds all state, and sharing one makes two instances overwrite each other.
- Every instance needs its own `SCIENCE_AGENT_PUBLISH_PORT`; host ports cannot repeat.
- When two instances are built from different checkouts, give each its own `SCIENCE_AGENT_IMAGE` so the later build does not overwrite a shared tag.
- Every later management command needs the same project name or env file, or `docker compose ps` / `down` acts on the other instance.
- Running several instances neither needs nor justifies weakening security settings: keep the three `security_opt` entries below and do not switch to `privileged`.

### Sandbox and host requirements

The container does not replace or weaken the Bubblewrap sandbox. Agent Python, R, and shell commands still run under `bwrap` with separate namespaces, seccomp filtering, and — unless an administrator configures a sandbox network domain allowlist — no network at all. Even with an allowlist the sandbox keeps its own empty network namespace and reaches the internet only through the runner's egress gateway. Docker's default security configuration blocks the user-namespace mounts and the fresh procfs Bubblewrap needs, so Compose relaxes these three container settings:

| Setting | Reason |
|---|---|
| `seccomp=unconfined` | Docker's default seccomp permits `mount`/`pivot_root` only with `CAP_SYS_ADMIN`; Bubblewrap invokes them inside its own namespace |
| `apparmor=unconfined` | The `docker-default` AppArmor profile on Debian/Ubuntu denies `mount` |
| `systempaths=unconfined` | Lifts Docker's default read-only and masked paths under `/proc` and `/sys`. Without it the kernel refuses to let Bubblewrap mount a fresh procfs in the sandbox's own pid namespace (`Can't mount proc on /newroot/proc: Operation not permitted`), and the product has to fall back to binding the container's `/proc` |

No capability is added, `privileged: true` is not used, and the Docker socket is not mounted. These settings relax the **container** boundary, not the agent sandbox. Treat this container as trusted local software, like the host installation.

**If `systempaths` is not relaxed** (an older Compose file, a bare `docker run`, or Kubernetes defaults), the product automatically falls back to `--ro-bind /proc /proc`. Executions still run, but the sandbox sees the **container's process list** instead of only its own processes. The fallback is never silent: both the runner startup log and the preflight print a warning naming the cause and the consequence. Restore the stronger profile by adding `systempaths=unconfined` — do not switch to `privileged`.

When the probe fails, the API and UI still start and `GET /health` still reports runner state, but every `run_shell` fails. Both the entry point and the runner print an explicit warning to `docker compose logs`, carrying Bubblewrap's own failure line — read that line first, it names the step that was refused.

Work through these in order; do not skip the first two and change a kernel switch:

1. **Whether Compose's `security_opt` was edited away.** Missing any of the three above fails the probe: without `seccomp`/`apparmor` no namespace can be created, and without `systempaths` the failure is `Can't mount proc on /newroot/proc`.
2. **The host's AppArmor configuration.** Ubuntu 24.04+ restricts unprivileged user namespaces by default, but the restriction is configured **per profile**: `/etc/apparmor.d/` can grant `userns create` to a specific program, and a container runtime can carry its own profile. So `kernel.apparmor_restrict_unprivileged_userns` being 1 does not mean the sandbox is unusable — this project's probe passes on Ubuntu 24.04 hosts where that value is 1. **If the probe passes, leave this value alone.**
3. **The kernel switches, only after ruling out the first two.** They need root and do not persist:

   ```bash
   sysctl kernel.unprivileged_userns_clone             # should be 1 where the knob exists
   sysctl kernel.apparmor_restrict_unprivileged_userns # read it together with the point above, never on its own
   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # only once the probe is known to fail because of it
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
