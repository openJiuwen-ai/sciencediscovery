# Deploy ScienceDiscovery

If this is your first time using ScienceDiscovery, start with the [Quick Start](quick-start.md). This page is for users who need another deployment path, want to run the service long-term, or need startup troubleshooting.

## Choose a deployment path

| Mode | Supported platforms | Best for | Recommendation |
| --- | --- | --- | --- |
| Prepackaged single file | glibc-based Linux x86_64 / aarch64, Windows x64 (WSL 2 with a glibc-based distribution, experimental) | Users who want the shortest startup path | **Recommended on native Linux** |
| Local source mode | Linux x86_64 / aarch64, macOS 13+ x64 / arm64, Windows x64 (WSL 2, experimental) | macOS users, development, source changes | Recommended on macOS |
| Docker | Linux x86_64 / aarch64, macOS (Docker Desktop or an existing Docker engine, experimental), Windows (Docker Desktop, experimental) | Existing container environments and operational isolation | As needed |

macOS Docker and all Windows installation paths are **experimental** because
Agent behavior there has not been fully validated.

The three paths are independent. Choose one. Once the service is running, return to the [Quick Start](quick-start.md) for model configuration and the first task.

---

## Prepackaged single-file deployment (Linux)

### Prerequisites

- glibc-based Linux on x86_64 or aarch64, including a suitable WSL 2
  distribution on Windows x64. The bundled Node.js runtime requires
  glibc 2.28+ and a compatible libstdc++;
- Bubblewrap and usable unprivileged user namespaces in the Linux environment;
- network access for first-launch dependency preparation;
- at least one model provider API key.

This release binary does not run directly on musl-based distributions such as Alpine Linux.

On Windows, run the commands in this section inside your WSL 2 Linux distribution.
Keep the downloaded file in the distribution's Linux filesystem, such as your home directory.
If you downloaded it in a Windows browser, open your WSL 2 Linux terminal
(for example, Ubuntu) and run `cd ~ && explorer.exe .` there. Windows File
Explorer opens your Linux home directory; copy the download into it.

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

You can run the downloaded file directly or rename it first. In the directory
containing the download, use the following commands if you have one matching
binary for your architecture:

```bash
mv ScienceDiscovery-*-linux-"$(uname -m)" ScienceDiscovery
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
- you are on Windows and want to run the Linux source steps inside WSL 2;
- you need to modify or debug the source;
- you do not want the prepackaged Linux binary.

### Prerequisites

All supported local environments require:

- Node.js 22.19+;
- pnpm 11.1.2;
- `python3` 3.9+;
- uv 0.9+;
- Git;
- curl.

The setup script calls `python3` before uv creates its Python 3.12 environment.

Sandbox requirements differ:

- Linux, including WSL 2: Bubblewrap 0.6+ and unprivileged user namespaces, 0.8+ recommended;
- macOS: the built-in Seatbelt sandbox; Bubblewrap is not required.

On macOS, use version 13 or newer for local source mode, as required by the
current [uv platform policy](https://docs.astral.sh/uv/reference/policies/platforms/#macos-versions).

### Clone and start

On Windows, run these commands inside your WSL 2 Linux distribution.
In WSL 2, clone into the distribution's Linux filesystem, such as your home directory,
rather than under `/mnt/c`. Dependency installation is much faster there, and
Linux file permissions behave as expected. Run `cd ~` before the commands below.

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery

scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

Source mode now starts JiuwenSwarm by default. To run the older native Node loop instead, use `./scripts/start-stack.sh --mode local --no-jiuwenswarm` or set `SCIENCE_AGENT_EXECUTOR=native` in `.env`. See [Agent backends](../reference/agent-backends.md) for behavior differences and an active-backend check.

The first run installs dependencies and builds the project, so it needs network access.

After a successful build, later starts can use:

```bash
./scripts/start-stack.sh --mode local --no-build
```

A successful startup prints the same `Open to sign in` URL.

### macOS notes

If local source mode reports that Seatbelt is unavailable, check:

```bash
test -x /usr/bin/sandbox-exec
```

If this fails, or your terminal is itself inside a stricter sandbox, fix the host restriction first.

---

## Docker deployment (Linux containers)

Docker is intended for users who already operate containerized services and want the runtime isolated from the host.

### Prerequisites

- Linux on x86_64 or aarch64, macOS with Docker Desktop (check its
  [current macOS requirements](https://docs.docker.com/desktop/setup/install/mac-install/#system-requirements))
  or an existing Docker engine,
  or Windows with Docker Desktop;
- Docker Engine 24+ and Docker Compose v2.15+ for non-Desktop setups;
- Docker Desktop in Linux container mode on Windows;
- support for Bubblewrap and unprivileged user namespaces inside the Linux container;
- enough disk space for the image, build cache, and scientific environments;
- build-time access to Docker Hub, npm, PyPI, and other dependency sources.

### 1. Prepare configuration and storage

If you do not have a local checkout yet, clone the repository first:

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery
```

On Windows, use PowerShell in the repository root:

```powershell
Copy-Item .env.docker.example .env
New-Item -ItemType Directory -Force data
```

On Windows, Docker Desktop must be running Linux containers. Its WSL 2 engine is normally
enabled by default; check [Docker's WSL 2 settings](https://docs.docker.com/desktop/features/wsl/)
if Docker reports that it cannot start Linux containers.

On Linux or macOS, use a Unix shell in the repository root:

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

```text
docker compose build
docker compose up -d
```

Check the service:

```text
docker compose ps
docker compose exec sciencediscovery curl -fsS http://127.0.0.1:4310/health
```

You can also open <http://127.0.0.1:4310/health> in a browser.
Top-level `status: ok` confirms that the API can reach the Runner. It does not
prove that the code-execution sandbox works. After signing in, run the small
Python calculation in the [Quick Start](quick-start.md#3-run-your-first-scientific-task)
to check that part of the installation.

If it reports `degraded`, inspect logs first:

```bash
docker compose logs --tail=200
```

### 3. Open the Web UI

View the logs and find the `Open to sign in` URL:

```text
docker compose logs -f
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

A `degraded` status means the API cannot reach the Runner. Check the startup log.
On Linux or WSL 2, a warning containing `could not build a sandbox` means code
execution will fail, even when `/health` reports `ok`. Follow the sandbox steps
below in that case.

### Linux reports missing `bwrap`

Install Bubblewrap:

```bash
sudo apt-get install -y bubblewrap
# Or
sudo dnf install -y bubblewrap
```

If Bubblewrap is installed but still fails, follow the sandbox checks below.

### Bubblewrap is installed, but code execution fails

If the startup log says `could not build a sandbox`, check the error before
changing system settings. On Linux or inside WSL 2, run:

```bash
bwrap --version
sysctl kernel.unprivileged_userns_clone
sysctl kernel.apparmor_restrict_unprivileged_userns
```

A missing sysctl key is normal on some kernels. If `kernel.unprivileged_userns_clone`
exists and is `0`, unprivileged user namespaces are disabled on that host.
Ask the host administrator to enable them before retrying.
If the AppArmor key is `1` and the error is a permission denial, check whether
AppArmor is active with `sudo aa-status`. On Ubuntu 24.04+, use a bwrap profile
only when this restriction is present; see
[Ubuntu's AppArmor guidance](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007#define-bwrap-profile).
WSL 2 installations do not all use the same kernel policy. Enable systemd only
if your chosen profile-loading method needs `systemctl` and it is unavailable;
see [Microsoft's WSL instructions](https://learn.microsoft.com/en-us/windows/wsl/systemd/).
See [Sandbox execution](../developer-docs/sandbox-execution.md) for the probe details.

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

### Compose rejects `systempaths=unconfined`

Run `docker compose version`. This option requires Compose v2.15+.
Update the Compose plugin, or update Docker Desktop if it supplies Compose.

### macOS Docker Desktop cannot mount the project directory

If Docker Desktop reports `Mounts denied` or `file is not shared from the host`,
open **Settings → Resources → File sharing** and add the directory containing
the checkout. See [Docker's file-sharing settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#file-sharing).

### `data/` is not writable

Make sure `data/` exists before `docker compose up`.
If the logs show a permission error, test the bind mount from inside a container:

```text
docker compose run --rm --entrypoint sh sciencediscovery -c 'id; ls -ld /app/data; touch /app/data/.write-test && rm /app/data/.write-test'
```

On Linux or macOS, use a Unix shell to check that uid/gid match the `.env` configuration:

```bash
ls -ld data
id -u
id -g
```

On Windows, check that your account can write to the host `data/` directory
and that Docker Desktop can share it. Windows accounts do not have Linux uid/gid
values to enter in `.env`. If the Windows bind mount remains unwritable, move the
checkout into a WSL 2 distribution's Linux filesystem, enable Docker Desktop's
[WSL integration](https://docs.docker.com/desktop/features/wsl/#enable-docker-in-a-wsl-2-distribution),
and run Compose there. Then use that Linux user's `id -u` and `id -g` values
in `.env` and create `data/` as that user.

### The container is running but `/health` is `degraded`

Inspect:

```bash
docker compose logs --tail=200
```

Check the Runner startup error and the `data/` mount first. A sandbox failure
can also occur while `/health` remains `ok`.

If `/health` is `ok` but a code task fails, inspect the logs for
`could not build a sandbox` and check the Linux-container requirements above.
On Windows, check Docker Desktop and WSL updates if its sandbox probe fails.

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
