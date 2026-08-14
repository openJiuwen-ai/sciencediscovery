# Deploy ScienceDiscovery

The root [README](../../../README.md) provides the shortest startup path. This guide covers deployment operations; see [Configuration reference](../reference/configuration.md) for environment variables, default ports, quotas, and storage layout.

## Use the preprovided binary

ScienceDiscovery is distributed as a preprovided executable matching the host architecture. This section explains how to install and run the `ScienceDiscovery` executable. This release does not provide source-build steps; use the provided executable.

ScienceDiscovery does not bundle Neo4j. Science Memory needs an external Neo4j server and remains disabled when it is not configured; this does not affect the web or conversation path.

### Start the service

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

`serve` starts the agent-loop gateway, Bubblewrap runner, and control API with the Web UI in that order, then prints the UI URL. It listens on <http://127.0.0.1:4310> by default. Sign in with `SCIENCE_AGENT_AUTH_TOKEN`; when it is unset, `serve` prints the token generated on first start. Ctrl-C stops all services in reverse order.

In a second terminal, verify the service:

```bash
curl -fsS http://127.0.0.1:4310/health
```

The first `serve` extracts the embedded runtime to `~/.cache/science-agent/payload/<payload-id>` (change it with `XDG_CACHE_HOME` or `SCIENCE_AGENT_PAYLOAD_CACHE_DIR`). Later runs reuse it. The directory contains the payload digest, so an upgrade does not overwrite an older extraction.

### Dependencies installed on first launch

The artifact deliberately does not package uv, deer-flow, or the gateway's third-party Python dependency tree. After extraction, the first `serve` installs them into the data directory (later launches reuse them; an upgrade rebuilds only what became stale):

1. **uv** — the wheel pinned at build time (version and SHA256) is downloaded from a PyPI index, Huawei Cloud mirror `https://mirrors.huaweicloud.com/repository/pypi/simple` by default, verified, and its binary is placed under `<data-dir>/tools/uv/`.
2. **deer-flow** — fetched at the exact commit this repository's submodule gitlink records, trying in order: the GitCode mirror (`git fetch` by commit, needs `git` on the host), the GitHub repository, and a GitHub archive URL that works without `git`. Every download is verified against the pinned commit or content digest before it lands in `<data-dir>/vendor/deer-flow`. If every source fails, the error spells out the manual placement path, the expected commit, and the exact steps.
3. **The gateway Python environment** — uv creates a venv at `<data-dir>/envs/gateway` on the bundled CPython and installs the hash-pinned requirements exported from `services/gateway/uv.lock` at build time (`--require-hashes`), so the versions match the lockfile exactly while the download goes through the configured mirror.

Related environment variables (usable in `--env-file`):

| Variable | Default | Purpose |
|---|---|---|
| `SCIENCE_AGENT_PYPI_INDEX` | Huawei Cloud PyPI mirror | Package index for Python dependencies |
| `SCIENCE_AGENT_UV_INSTALL_INDEX` | same as `SCIENCE_AGENT_PYPI_INDEX` | Separate index for the uv wheel download |
| `SCIENCE_AGENT_UV_PATH` | — | Use an existing uv executable, skipping the download |
| `SCIENCE_AGENT_DEERFLOW_GIT_URL` | GitCode mirror | Git URL tried first for deer-flow (GitHub remains the fallback) |
| `SCIENCE_AGENT_DEERFLOW_DIR` | `<data-dir>/vendor/deer-flow` | Where the deer-flow checkout lives; also the manual-placement target |

For air-gapped hosts, run the first launch once on a connected machine and copy the whole data directory over, or follow the failure message to place deer-flow manually and point `SCIENCE_AGENT_UV_PATH` at a pre-installed uv.

### Host dependency: Bubblewrap

Bubblewrap is the **only** host dependency users install. It cannot be bundled because the sandbox needs host-kernel user namespaces. When it is absent, `serve` fails immediately and prints installation commands:

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
sudo pacman -S bubblewrap            # Arch
sudo apk add bubblewrap              # Alpine
```

To inspect the UI without sandbox execution, start with `--skip-sandbox-check`; `run_python` and `run_shell` will fail while other functions remain available. If Bubblewrap exists but unprivileged user namespaces are restricted, `serve` warns and continues: the API and UI still start and `GET /health` reports runner state, but every `run_python` and `run_shell` fails. On Ubuntu 24.04+, the usual fix is:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### Commands and options

```text
ScienceDiscovery serve [options]       Start the Web UI, control API, agent-loop gateway, and runner
ScienceDiscovery extract --to <dir>    Extract the embedded runtime without starting it
ScienceDiscovery version               Print the version and embedded Node, CPython, and micromamba versions
ScienceDiscovery help                  Show help
```

| Option | Default | Purpose |
|---|---|---|
| `--data-dir <path>` | `./science-agent-data` | Runtime data; see [Storage layout](../reference/configuration.md#storage-layout) |
| `--host <address>` | `127.0.0.1` | Web UI/API bind address |
| `--port <port>` | `4310` | Web UI/API port |
| `--runner-port <port>` | `4311` | Runner port (loopback only) |
| `--gateway-port <port>` | `4312` | Gateway port (loopback only) |
| `--env-file <path>` | — | Read `KEY=VALUE` settings before startup; existing environment values win |
| `--bwrap <path>` | `bwrap` on `PATH` | Bubblewrap executable |
| `--skip-sandbox-check` | off | Start without Bubblewrap; sandbox execution is unavailable |
| `--no-scientific-envs` | off | Do not initialize managed scientific environments |

The variables in [Configuration reference](../reference/configuration.md#environment-variables) also apply and can be exported or placed in `--env-file`. The API, gateway, and runner bind to loopback by default. To expose the API, first replace `SCIENCE_AGENT_AUTH_TOKEN`, then explicitly use `--host 0.0.0.0` only on a trusted, protected network.

### What the binary contains

| Component | Description |
|---|---|
| Launcher | Node single-executable application with a fixed Node binary; the artifact is a normal ELF executable |
| Node runtime | Runs the control API and runner |
| CPython 3.12 | Relocatable distribution; no host Python needed, and it is the base interpreter for the first-launch gateway venv |
| Web assets | Prebuilt `apps/web/dist` |
| Gateway wheel and bootstrap pins | The `science-agent-gateway` wheel (our own code), the hash-locked dependency export, and the uv wheel and deer-flow version pins |
| micromamba | Fixed version, seeded to `<data-dir>/scientific-envs/bin/micromamba` on first `serve`, then checked by the runner against the same release manifest |

It does not contain uv, deer-flow, or the gateway's third-party Python dependencies (see [Dependencies installed on first launch](#dependencies-installed-on-first-launch)), nor Neo4j, starter Python/R scientific environments, or a conda package cache. Creating a starter environment for the first time still needs access to permitted package channels.

### Data directory

`serve` writes runtime data to `./science-agent-data` in the current directory by default; change it with `--data-dir <path>` (or `SCIENCE_AGENT_DATA_DIR`). This directory is the only runtime root: projects, sessions, workspaces, keys, service environments, and logs all live in it, so back it up as a unit. Deleting it removes all projects, sessions, credentials, and audit records. See [Storage layout](../reference/configuration.md#storage-layout) for the full layout.
