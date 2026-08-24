---
name: deploy
description: >
  Deploy or run the ScienceDiscovery stack, either as host processes
  (scripts/start-stack.sh) or with Docker Compose. Use when the user asks to
  deploy, start, run, or containerize ScienceDiscovery, or asks for the UI URL,
  SSH port forwarding, or start/stop/restart/log commands.
---

# Deploy ScienceDiscovery (local or Docker)

Project-local skill for **ScienceDiscovery**. Authoritative facts live in
[`README.md`](../../../README.md) → **Quick start**, in
[`docs/zh/how-to/deployment.md`](../../../docs/zh/how-to/deployment.md) (Chinese) → local
mode and Docker deployment, and in [`docs/zh/reference/configuration.md`](../../../docs/zh/reference/configuration.md) → variable tables. Read the matching section before
improvising; never invent ports, tokens, flags, or paths.

You **assist** the user through a deployment. You do not silently reconfigure
their machine.

## Rules

1. **Ask the deployment form first** (Docker Compose vs. host processes). Do not
   install, build, or start anything before the user answers.
2. **Detect before deploying.** Environment checks are read-only commands only.
   Report what is missing; do not fix it on your own initiative.
3. **Never run `sudo`** on the user's behalf unless they explicitly ask for that
   specific command in this conversation.
4. **Never install global software** (`apt`/`dnf`/`brew`/`npm -g`, persistent
   `sysctl`, systemd units, editing files outside the repository). List the gap
   and the command *you suggest the user run themselves*. After written consent
   you may assist, still preferring project-local installs
   (`uv`/`pnpm`/`corepack`) over system-wide ones.
5. **Environment must pass before deploying.** On any failed check, stop, report,
   and wait for the user's decision.
6. Repository-local writes are fine (`.env`, `.sciencediscovery-data/`),
   but say what you are writing before you write it.
7. After a successful start, always report the **URL and the bearer token
   source**, then the management commands for the mode actually used.

## Step 1 — Ask the form

> Docker Compose, or host processes?

| | Docker Compose | Host processes |
|---|---|---|
| Host needs | Docker Engine 24+ and Compose v2 only | Node 22.19+, pnpm, Python 3, uv, bubblewrap |
| Entry point | `docker compose up -d` → `scripts/start-stack.sh --mode docker` | `./scripts/start-stack.sh --mode local` |
| Runs | Detached, restarts on failure | Foreground terminal (Ctrl-C stops it) |
| State | Host bind mount `./data` (no named volume) | `./data` (`SCIENCE_AGENT_DATA_DIR`) |
| Published on | `127.0.0.1:4310` by default | `0.0.0.0:4310` by default |

Both need Linux x86_64 or aarch64 with unprivileged user namespaces — the bubblewrap
sandbox is not optional and Docker Desktop on macOS/Windows is unsupported.

## Step 2 — Detect (read-only)

Run from the repository root. Report each check as pass/fail with the value seen.

**Common**

```bash
uname -s -m                              # expect: Linux x86_64 or aarch64
ss -ltn | grep -E ':(4310|4311)' || echo "ports free"
sysctl kernel.unprivileged_userns_clone             2>/dev/null   # 1, where the knob exists
sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null   # 0, required on Ubuntu 24.04+
```

**Host-process mode** (mirrors `README.md` → Quick start → Requirements)

```bash
node --version    # v22.19+
pnpm --version    # 11.1.2
python3 --version
uv --version      # 0.9+
bwrap --version   # 0.6+; 0.8+ recommended (adds --disable-userns where the environment allows it; otherwise the runner logs a startup warning and omits it)
curl --version | head -1
```

Sandbox preflight — the same probe `scripts/start-stack.sh` runs, harmless and
read-only:

```bash
bwrap --unshare-all --unshare-user --die-with-parent \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 /usr/bin/true && echo "sandbox ok"
```

**Docker mode**

```bash
docker version --format '{{.Server.Version}}'   # 24+
docker compose version                          # v2.x
docker info >/dev/null && echo "daemon reachable"
id -u; id -g                                    # → SCIENCE_AGENT_UID / _GID
```

## Step 3 — Report gaps, do not close them yourself

Present a short table: check / expected / actual / suggested fix. Suggested
fixes are **for the user to run**, quoted as such:

- Missing Node/pnpm/uv → suggest user-level installs that need no sudo and touch
  nothing outside `$HOME`: Node 22 tarball extracted to `~/opt/node22` (add its
  `bin` to PATH), `corepack enable --install-directory ~/.local/bin && corepack
  prepare $(node -p "require('./package.json').packageManager") --activate` for
  the pinned pnpm, and the official uv installer script (installs to
  `~/.local/bin`). Missing bubblewrap has no user-level path — it is a distro
  package the user must install.
- `kernel.apparmor_restrict_unprivileged_userns` is `1` → the documented fix is
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Quote it,
  explain it needs root and is not persistent, and stop.
- Port already in use → offer `SCIENCE_AGENT_PORT` (host mode) or
  `SCIENCE_AGENT_PUBLISH_PORT` (Docker) instead of killing the other process.
  When moving the runner port, also update the explicit
  `SCIENCE_AGENT_RUNNER_URL` in `.env` — it does not follow `*_PORT`
  automatically.
- npm / PyPI unreachable or very slow → set `SCIENCE_AGENT_NPM_REGISTRY` /
  `SCIENCE_AGENT_PYPI_INDEX` in `.env` (e.g. the Huawei Cloud mirrors; see the
  variable table in `docs/zh/reference/configuration.md`). Both are scoped to
  `start-stack.sh`'s install commands and never touch user or global
  npm/uv config.

If user namespaces stay restricted, the API and UI still start and `/health`
still reports the runner, but every `run_python` / `run_shell` fails. Say this
plainly and let the user choose whether to continue.

## Step 4a — Deploy: host processes

```bash
cp .env.example .env                               # first time only; never overwrite an existing .env
./scripts/start-stack.sh --mode local              # install + build + start
./scripts/start-stack.sh --mode local --no-build   # start only, after a previous build
```

- Runs in the **foreground**; it starts the runner (127.0.0.1:4311) in the
  background and the API (0.0.0.0:4310) in front. Those two are the whole
  resident stack.
- First run provisions `.sciencediscovery-data/envs/gateway` and `.sciencediscovery-data/envs/paper` through `uv`
  and needs outbound network.
- `./scripts/run-local.sh [--no-build]` is the compatibility wrapper; `pnpm start`
  and `pnpm server` go through it.
- Never launch it with `sudo`. For unattended operation, hand the user a
  supervisor option (tmux, or a systemd **user** unit) — do not install one.

## Step 4b — Deploy: Docker Compose

```bash
cp .env.docker.example .env      # or merge its keys into an existing .env
# set SCIENCE_AGENT_UID / SCIENCE_AGENT_GID to `id -u` / `id -g` when they are not 1000
mkdir -p data
docker compose build             # first build is long and needs network
docker compose up -d
curl -fsS http://127.0.0.1:4310/health
```

- `./data` is bind-mounted to `/app/data` and is the only persisted location; it
  survives `docker compose down` and rebuilds.
- A uid/gid mismatch is the most common first-run failure: the entry point exits
  with an explicit "not writable" message. Fix it via `SCIENCE_AGENT_UID` /
  `SCIENCE_AGENT_GID` and recreate the container.
- The service already sets `seccomp=unconfined`, `apparmor=unconfined` and
  `systempaths=unconfined` for bubblewrap. Do not add capabilities or
  `privileged: true`. Dropping `systempaths=unconfined` still works, but the
  runner then falls back to binding the container's `/proc` and warns at
  startup: sandboxed code sees the container's process list.

## Step 5 — Report the URL

- Default: <http://127.0.0.1:4310>
- Sign in with `SCIENCE_AGENT_AUTH_TOKEN`. There is no shipped default: when
  the variable is unset, the stack generates a token on its first start, prints
  it at startup, and stores it in `<data dir>/secrets/auth-token`. Read the value
  from the user's `.env` or that file — do not print a token into a shared
  channel.
- Host-process mode binds all interfaces by default, so `http://<machine-ip>:4310`
  also works. Docker publishes on `127.0.0.1` unless `SCIENCE_AGENT_PUBLISH_HOST`
  is changed. Auth is one bearer token with no TLS: recommend loopback plus SSH
  forwarding over exposing the port, and tell the user to change the token first
  if they do expose it.
- There is no built-in model. A usable session needs a profile plus credential
  under **System configuration → Model registry**
  (`docs/zh/reference/runtime-behavior.md` → 模型).

## Remote host, browser on a laptop

When the stack runs on a remote development machine, forward the port instead of
publishing it. Run from the **laptop**:

```bash
remote_user="alice"; remote_host="science-host.example"
ssh -N -L 4310:127.0.0.1:4310 "${remote_user}@${remote_host}"

local_port=4310; remote_port=4310
ssh -f -N -o ServerAliveInterval=30 \
  -L "${local_port}:127.0.0.1:${remote_port}" "${remote_user}@${remote_host}"
```

Then open `http://127.0.0.1:<local-port>` locally. `<remote-port>` is the
published port: `SCIENCE_AGENT_PORT` in host-process mode,
`SCIENCE_AGENT_PUBLISH_PORT` in Docker mode. Pick a different `<local-port>` if
4310 is taken locally. Stop the tunnel by closing the session, or by killing the
backgrounded `ssh -f` process.

Forward only the API port. The runner (4311) is loopback-only by design.

## Management commands

| Action | Host processes | Docker Compose |
|---|---|---|
| Start | `./scripts/start-stack.sh --mode local [--no-build]` | `docker compose up -d` |
| Stop | Ctrl-C in that terminal (also stops the runner) | `docker compose down` (`./data` survives) |
| Restart | Ctrl-C, then start again | `docker compose restart` |
| Rebuild + restart | start once without `--no-build` | `docker compose up -d --build` |
| Logs | stdout/stderr of the foreground terminal (or the supervisor's log) | `docker compose logs -f` |
| State | `ss -ltn \| grep 4310` | `docker compose ps` (includes the health check) |
| Health | `curl -fsS http://127.0.0.1:4310/health` | same, against the published host/port |

Component health endpoint in both modes: runner `http://127.0.0.1:4311/health`
(reachable from inside the container in Docker mode). The API's own `/health`
echoes the runner status, so it is usually the only one worth checking.

## Troubleshooting

| Symptom | Cause / next step |
|---|---|
| `data ... is not writable by uid ...` | Docker uid/gid mismatch → set `SCIENCE_AGENT_UID` / `_GID`, recreate |
| `WARNING: bubblewrap cannot create a sandbox` in logs | Host restricts user namespaces → quote the `sysctl` fix, let the user run it |
| `.sciencediscovery-data/envs/gateway is missing` | Started with `--no-build` before a build → run once without it (that venv holds the interpreter for the bundled Python MCP servers) |
| API up but every run fails | Usually the sandbox warning above, or no model profile configured |
| Port already bound | Change `SCIENCE_AGENT_PORT` / `SCIENCE_AGENT_PUBLISH_PORT` |
| `does not support --disable-userns` warning at runner startup | Expected on bwrap < 0.8 (e.g. Ubuntu 22.04's 0.6): nested-userns hardening is skipped, everything else isolates normally. Upgrade bubblewrap for the stronger profile |
| `supports --disable-userns but cannot use it here` warning at runner startup | Expected under LXC and container runtimes that mount `/proc/sys` read-only, so bubblewrap cannot write `user.max_user_namespaces`. The option is omitted and executions run; everything else isolates normally. Do not grant `privileged` or `systempaths=unconfined` to silence it |
| First `docker compose build` fails on network | The build resolves pnpm and both uv environments; retry with network available |

## Checklist

1. Asked the user which form, and got an answer
2. Ran the read-only checks for that form; reported pass/fail values
3. Reported gaps with suggested user-run commands — no `sudo`, no global install
4. Deployed only after the user confirmed the environment is acceptable
5. Verified `/health`, then reported URL + token source
6. Gave SSH forwarding instructions when the stack is not on the user's own machine
7. Gave the management command table for the mode used

**Policy**: this skill assists; it does not change host configuration on its own.
Repository-local writes need a heads-up, host-level changes need the user's
explicit go-ahead, and root-level changes are always executed by the user.
