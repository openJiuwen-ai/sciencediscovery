# Deploy ScienceDiscovery

If this is your first time using ScienceDiscovery, start with the [Quick Start](quick-start.md). This page is for users who need another deployment path, want to run the service long-term, or need startup troubleshooting.

## Choose a deployment path

| Mode | Supported platforms | Best for | Recommendation |
| --- | --- | --- | --- |
| Prepackaged single file | Linux x86_64 / aarch64 | Users who want the shortest startup path | **Recommended** |
| Local source mode | Linux x86_64 / aarch64, macOS x64 / arm64 | macOS users, development, source changes | Recommended |
| Docker | Linux x86_64 / aarch64 | Existing container environments and operational isolation | As needed |

The three paths are independent. Choose one. Once the service is running, return to the [Quick Start](quick-start.md) for model configuration and the first task.

---

## Prepackaged single-file deployment (Linux)

### Prerequisites

- Linux on x86_64 or aarch64;
- Bubblewrap;
- network access for first-launch dependency preparation;
- at least one model provider API key.

Install Bubblewrap:

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# Or
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
```

### Download and start

Download the file matching your architecture from the [Releases page](https://github.com/openJiuwen-ai/sciencediscovery/releases):

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
```

You can run the downloaded file directly or rename it first:

```bash
mv ScienceDiscovery-<version>-linux-<architecture> ScienceDiscovery
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

A successful startup prints an `Open to sign in` URL. Open it in your browser.

### What happens on first launch

The first `serve` prepares some runtime dependencies and therefore needs network access. Later launches reuse the prepared environment.

For offline hosts, prepare the data directory on a connected machine or configure reachable package mirrors. See the [configuration reference](../reference/configuration.md).

### Common startup options

```text
ScienceDiscovery serve [options]
```

Most users only need:

| Option | Purpose |
| --- | --- |
| `--data-dir <path>` | Set the data directory |
| `--host <address>` | Set the Web/API bind address |
| `--port <port>` | Set the Web/API port |
| `--env-file <path>` | Read environment variables from a file |
| `--skip-sandbox-check` | Start the UI when sandbox execution is unavailable; code execution will not work |

The service binds to the local machine by default. If you must expose it, configure a separate authentication token first and use only a trusted network.

---

## Local source mode (Linux / macOS)

Use local source mode when:

- you are on macOS;
- you need to modify or debug the source;
- you do not want the prepackaged Linux binary.

### Prerequisites

Both platforms require:

- Node.js 22.19+;
- pnpm 11.1.2;
- Python 3;
- uv 0.9+;
- Git;
- curl.

Sandbox requirements differ:

- Linux: Bubblewrap 0.6+, 0.8+ recommended;
- macOS: the built-in Seatbelt sandbox; Bubblewrap is not required.

### Clone and start

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery
git checkout feat/jiuwenswarm

scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

The first run installs dependencies and builds the project, so it needs network access.

After a successful build, later starts can use:

```bash
./scripts/start-stack.sh --mode local --no-build
```

A successful startup prints the same `Open to sign in` URL.

### macOS notes

macOS currently supports local source mode only. The Linux single-file binary and the Linux Docker path on this page do not run directly on macOS.

If startup reports that Seatbelt is unavailable, check:

```bash
test -x /usr/bin/sandbox-exec
```

If this fails, or your terminal is itself inside a stricter sandbox, fix the host restriction first.

---

## Docker deployment (Linux)

Docker is intended for users who already operate containerized services and want the runtime isolated from the host.

### Prerequisites

- Linux on x86_64 or aarch64;
- Docker Engine 24+;
- Docker Compose v2;
- enough disk space for the image, build cache, and scientific environments;
- build-time access to Docker Hub, npm, PyPI, and other dependency sources.

> macOS and Windows Docker Desktop are not the supported path. Code execution depends on Linux kernel sandbox capabilities.

### 1. Prepare configuration and storage

From the repository root:

```bash
cp .env.docker.example .env
mkdir -p data
id -u
id -g
```

If your uid/gid is not `1000:1000`, set these values in `.env`:

```text
SCIENCE_AGENT_UID=<your uid>
SCIENCE_AGENT_GID=<your gid>
```

The `data/` directory stores projects, sessions, workspaces, credentials, and other runtime state.

### 2. Build and start

```bash
docker compose build
docker compose up -d
```

Check the service:

```bash
docker compose ps
curl -fsS http://127.0.0.1:4310/health
```

A healthy installation reports top-level `status: ok`.

If it reports `degraded`, inspect logs first:

```bash
docker compose logs --tail=200
```

### 3. Open the Web UI

Find the sign-in URL in the logs:

```bash
docker compose logs | grep -A 2 'Open to sign in'
```

Open the printed `Open to sign in` URL in your browser.

You can also open <http://127.0.0.1:4310> directly and paste the local service access token when prompted.

Treat the sign-in URL and token like a password.

### 4. Routine operations

| Action | Command |
| --- | --- |
| Check status | `docker compose ps` |
| Follow logs | `docker compose logs -f` |
| Stop | `docker compose down` |
| Restart | `docker compose restart` |
| Rebuild after code changes | `docker compose up -d --build` |
| Enter the container | `docker compose exec sciencediscovery sh` |

`docker compose down` does not delete the host `data/` directory.

### 5. Remote access

For a remote host, prefer SSH port forwarding instead of exposing the service directly to the public network:

```bash
ssh -N -L 4310:127.0.0.1:4310 <user>@<remote-host>
```

Then open <http://127.0.0.1:4310> locally.

---

## First-run troubleshooting for binary and local mode

### No `Open to sign in` URL appears

Read the earliest startup error first. Later failures are often consequences of the first one.

### The browser rejects the token

Open the `Open to sign in` URL from the latest startup output again.

If entering a token manually, use the **local service access token**, not the model provider API key.

### `/health` reports `degraded`

Run:

```bash
curl -fsS http://127.0.0.1:4310/health
```

A `degraded` status usually means the code-execution side did not start correctly. Check the startup log and confirm the sandbox prerequisites are available.

### Linux reports missing `bwrap`

Install Bubblewrap:

```bash
sudo apt-get install -y bubblewrap
# Or
sudo dnf install -y bubblewrap
```

If Bubblewrap is installed but still fails, the host may restrict unprivileged user namespaces. See [Sandbox execution](../developer-docs/sandbox-execution.md).

### macOS reports Seatbelt is unavailable

Check:

```bash
test -x /usr/bin/sandbox-exec
```

ScienceDiscovery does not silently fall back to unsandboxed execution when Seatbelt is unavailable.

### Where are the logs?

Logs are stored under `logs/` in the data directory by default. See the [configuration reference](../reference/configuration.md#storage-layout) for exact paths and overrides.

---

## Docker FAQ

### `data/` is not writable

Make sure the directory exists before `docker compose up` and that uid/gid match the `.env` configuration:

```bash
ls -ld data
id -u
id -g
```

### The container is running but `/health` is `degraded`

Inspect:

```bash
docker compose logs --tail=200
```

A common cause is missing host support for the sandbox capabilities required inside the container.

### The model or external resources are unreachable

The container needs outbound access to model providers, literature sources, and other external services. If your environment requires a proxy, configure [network proxy settings](../advanced-setup/configure-network-proxy.md).

---

## After deployment succeeds

Once the service is running, stop reading deployment details and return to the [Quick Start](quick-start.md):

1. configure a model;
2. create a Project and Session;
3. run the first scientific task;
4. confirm code execution and the Artifact work.

## Further reading

- CLI commands and exact behavior: [CLI reference](../reference/cli.md)
- Exact environment variables, ports, and storage: [Configuration reference](../reference/configuration.md)
- How single-file releases are built: [Developer docs: Binary packaging and releases](../developer-docs/binary-packaging.md)
- Local/Docker/remote Runner deployment internals: [Developer docs: Deployment runtime internals](../developer-docs/deployment-runtime.md)
- Sandbox isolation and execution internals: [Developer docs: Sandbox execution](../developer-docs/sandbox-execution.md)
- Internal processes and module boundaries: [Developer docs: Architecture](../developer-docs/architecture.md)
- Repository structure and source entry points: [Developer docs: Repository layout](../developer-docs/repository-layout.md)
