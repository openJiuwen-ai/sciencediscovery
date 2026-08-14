---
name: deploy
description: >
  Run the preprovided science_agent binary (./ScienceDiscovery serve). Use when
  the user asks to deploy, start, run, or stop science_agent, or asks for the
  UI URL, SSH port forwarding, or start/stop/restart/log/health commands.
---

# Run science_agent from the preprovided binary

Project-local skill for **science_agent**. Authoritative facts live in
[`README.md`](../../../README.md) → **Quick start**, in
[`docs/zh/how-to/deployment.md`](../../../docs/zh/how-to/deployment.md) (and the
English [deployment guide](../../../docs/en/how-to/deployment.md)), and in
[`docs/zh/reference/configuration.md`](../../../docs/zh/reference/configuration.md)
→ variable tables. Read the matching section before improvising; never invent
ports, tokens, flags, or paths.

This branch ships ScienceDiscovery only as a **preprovided binary**. There is no
source build, no `start-stack.sh` / `run-local.sh` host-process mode, and no
Docker Compose path to assist with — do not coach the user through them.

You **assist** the user through a deployment. You do not silently reconfigure
their machine.

## Rules

1. **Confirm the binary first.** Ask where the preprovided `ScienceDiscovery`
   executable for the host architecture is. Do not start anything before the
   user points to it.
2. **Detect before deploying.** Environment checks are read-only commands only.
   Report what is missing; do not fix it on your own initiative.
3. **Never run `sudo`** on the user's behalf unless they explicitly ask for that
   specific command in this conversation.
4. **Never install global software** (`apt`/`dnf`/`brew`/`npm -g`, persistent
   `sysctl`, systemd units, editing files outside the data directory). List the
   gap and the command *you suggest the user run themselves*. After written
   consent you may assist, still preferring project-local options over
   system-wide ones. (Bubblewrap is a distro package the user must install.)
5. **Environment must pass before deploying.** On any failed check, stop,
   report, and wait for the user's decision.
6. Writes inside the runtime data directory (`./science-agent-data` by default)
   are fine, and setting `SCIENCE_AGENT_*` variables or `--env-file` is fine,
   but say what you are doing before you do it.
7. After a successful start, always report the **URL and the bearer token
   source**, then the management commands.

## Step 1 — Confirm the binary

> Where is the preprovided `ScienceDiscovery` executable for this host's
> architecture?

The executable is a normal ELF file named `ScienceDiscovery`. It
needs Linux x86_64 or aarch64 and Bubblewrap. Do not download or invent a URL;
use the file the user already has.

## Step 2 — Detect (read-only)

Run from the directory containing the executable. Report each check as
pass/fail with the value seen.

```bash
uname -s -m                              # expect: Linux x86_64 or aarch64
ls -l ./ScienceDiscovery                 # the preprovided executable must exist and be executable
ss -ltn | grep -E ':(4310|4311|4312)' || echo "ports free"
sysctl kernel.unprivileged_userns_clone             2>/dev/null   # 1, where the knob exists
sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null   # 0, required on Ubuntu 24.04+
bwrap --version   # 0.6+; 0.8+ recommended (adds --disable-userns; on older versions the runner logs a startup warning and omits it)
curl --version | head -1
```

Sandbox preflight — a harmless, read-only probe:

```bash
bwrap --unshare-all --unshare-user --die-with-parent \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 /usr/bin/true && echo "sandbox ok"
```

## Step 3 — Report gaps, do not close them yourself

Present a short table: check / expected / actual / suggested fix. Suggested
fixes are **for the user to run**, quoted as such:

- Missing Bubblewrap → it is a distro package the user must install
  (`sudo apt-get install -y bubblewrap`, `sudo dnf install -y bubblewrap`,
  `sudo pacman -S bubblewrap`, or `sudo apk add bubblewrap`). Quote the command
  for the user's distro; do not run it without explicit consent.
- `kernel.apparmor_restrict_unprivileged_userns` is `1` → the documented fix is
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Quote it,
  explain it needs root and is not persistent, and stop.
- Port already in use → offer `--port` (and, if moving the runner/gateway ports,
  also update `SCIENCE_AGENT_RUNNER_URL` / `SCIENCE_AGENT_GATEWAY_URL` in
  `--env-file`; they do not follow the `*_PORT` values automatically).
- PyPI unreachable or slow for the first-launch dependency install → set
  `SCIENCE_AGENT_PYPI_INDEX` (e.g. the Huawei Cloud mirror) in `--env-file`.
  See the variable table in `docs/zh/reference/configuration.md`.

If user namespaces stay restricted, the API and UI still start and `/health`
still reports the runner, but every `run_python` / `run_shell` fails. Say this
plainly and let the user choose whether to continue (or start with
`--skip-sandbox-check` to inspect the UI without sandbox execution).

## Step 4 — Deploy: run the binary

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

- Runs in the **foreground**; the launcher starts gateway (127.0.0.1:4312) and
  runner (127.0.0.1:4311) in the background and the API (127.0.0.1:4310) in
  front. Ctrl-C stops all of them in reverse order.
- The first `serve` extracts the embedded runtime, then installs uv, deer-flow,
  and the gateway Python dependencies into the data directory; it needs outbound
  network. Later starts reuse them.
- Runtime data defaults to `./science-agent-data`; change it with `--data-dir`
  (or `SCIENCE_AGENT_DATA_DIR`).
- To inspect the UI without sandbox execution, start with
  `--skip-sandbox-check`; `run_python` and `run_shell` will fail while other
  functions remain available.
- Never launch it with `sudo`. For unattended operation, hand the user a
  supervisor option (tmux, or a systemd **user** unit) — do not install one.

## Step 5 — Report the URL

- Default: <http://127.0.0.1:4310>
- Sign in with `SCIENCE_AGENT_AUTH_TOKEN`. There is no shipped default: when the
  variable is unset, `serve` generates a token on first start, prints it at
  startup, and stores it in `<data dir>/secrets/auth-token`. Read the value from
  the user's `--env-file` or that file — do not print a token into a shared
  channel.
- The API binds to `127.0.0.1` by default. To expose it, first replace
  `SCIENCE_AGENT_AUTH_TOKEN`, then explicitly use `--host 0.0.0.0` only on a
  trusted, protected network. Auth is one bearer token with no TLS: recommend
  loopback plus SSH forwarding over exposing the port, and tell the user to
  change the token first if they do expose it.
- There is no built-in model. A usable session needs a profile plus credential
  under **System configuration → Model registry**
  (`docs/zh/reference/runtime-behavior.md` → 模型).

## Remote host, browser on a laptop

When the stack runs on a remote development machine, forward the port instead of
exposing it. Run from the **laptop**:

```bash
remote_user="alice"; remote_host="science-host.example"
ssh -N -L 4310:127.0.0.1:4310 "${remote_user}@${remote_host}"

local_port=4310; remote_port=4310
ssh -f -N -o ServerAliveInterval=30 \
  -L "${local_port}:127.0.0.1:${remote_port}" "${remote_user}@${remote_host}"
```

Then open `http://127.0.0.1:<local-port>` locally. `<remote-port>` is the
serving port (`--port` / `SCIENCE_AGENT_PORT`, default `4310`). Pick a different
`<local-port>` if 4310 is taken locally. Stop the tunnel by closing the session,
or by killing the backgrounded `ssh -f` process.

Forward only the API port. The gateway (4312) and runner (4311) are
loopback-only by design.

## Management commands

| Action | Command |
|---|---|
| Start | `./ScienceDiscovery serve` (add `--env-file <path>` to inject settings) |
| Stop | Ctrl-C in that terminal (also stops gateway and runner) |
| Restart | Ctrl-C, then start again |
| Logs | stdout/stderr of the foreground terminal (or the supervisor's log) |
| State | `ss -ltn \| grep 4310` |
| Health | `curl -fsS http://127.0.0.1:4310/health` |

Component health endpoints: gateway `http://127.0.0.1:4312/health`, runner
`http://127.0.0.1:4311/health` (loopback only).

## Troubleshooting

| Symptom | Cause / next step |
|---|---|
| `WARNING: bubblewrap cannot create a sandbox` in logs | Host restricts user namespaces → quote the `sysctl` fix, let the user run it |
| API up but every run fails | Usually the sandbox warning above, or no model profile configured |
| Port already bound | Change `--port` / `SCIENCE_AGENT_PORT` |
| `does not support --disable-userns` warning at runner startup | Expected on bwrap < 0.8 (e.g. Ubuntu 22.04's 0.6): nested-userns hardening is skipped, everything else isolates normally. Upgrade bubblewrap for the stronger profile |
| First `serve` fails on network | The first start installs uv, deer-flow, and the gateway Python dependencies through the configured PyPI index; retry with network available, or set `SCIENCE_AGENT_PYPI_INDEX` to a reachable mirror |

## Checklist

1. Confirmed the preprovided executable for the host architecture with the user
2. Ran the read-only checks; reported pass/fail values
3. Reported gaps with suggested user-run commands — no `sudo`, no global install
4. Started `./ScienceDiscovery serve` only after the user confirmed the environment
5. Verified `/health`, then reported URL + token source
6. Gave SSH forwarding instructions when the stack is not on the user's own machine
7. Gave the management command table

**Policy**: this skill assists; it does not change host configuration on its own.
Writes inside the runtime data directory need a heads-up, host-level changes
need the user's explicit go-ahead, and root-level changes are always executed by
the user.
