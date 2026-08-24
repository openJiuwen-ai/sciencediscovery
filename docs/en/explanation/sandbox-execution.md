# Sandbox Execution: `services/runner`

Runner is a rootless executor. `run_python`, `run_r`, and `run_shell` run in a Bubblewrap/seccomp sandbox that sees only the Session workspace and, by default, has no network. Sandbox network access is a configurable policy that defaults to `none`; see §3.1. Runner also manages micromamba environments and persistent kernels, listens only on `127.0.0.1:4311`, and accepts API as its sole client.

## 1. Source structure

| File | Responsibility |
|---|---|
| `server.ts` | Routes, bearer/HMAC auth, one-worker queue, startup preflight |
| `executor.ts` | Ephemeral Bubblewrap construction, quota/timeout, workspace snapshots |
| `kernel-manager.ts` | Persistent JSON-line Python/R workers and lifecycle |
| `shell-session-manager.ts` | Persistent Bash preserving cwd/export |
| `session-env-profile.ts` | Safe environment/cwd transfer from shell to later execution |
| `environment-store.ts` | micromamba catalog and immutable revisions |
| `npu-broker.ts` | Optional Host NPU Broker that starts allowlisted host NPU workloads under Runner control |
| `workloads/` | Broker default workload allowlist, Ascend smoke probe, and controlled adapters |
| `seccomp.ts` | x86_64/aarch64 BPF generated under runner runtime; baseline and network profiles |
| `egress-gateway.ts` | Host-side exit for sandbox network access: a UDS HTTP service reused per policy revision, allowed domains and address classification |
| `egress-bridge.ts` | In-sandbox TCP→UDS bridge script, host interpreter probe, and bwrap bind arguments |
| `request-auth.ts` | HMAC-SHA256 token/timestamp/body hash with 30-second freshness |

## 2. HTTP surface

`GET /health` is unauthenticated. Status, environments/revisions/setup, and kernel teardown require bearer auth. `/execute` and `/execute-shell` additionally require timestamp/signature headers. When the NPU Broker is enabled, `GET /npu/workloads` uses bearer auth; `GET /npu/jobs?session_id=...` and job status/log/result endpoints use bearer auth plus Session checks; `POST /npu/jobs` and job cancel also require the freshness signature. Reusing an `executionId` within 60 seconds returns 409.

## 3. Sandbox construction

Startup checks required Bubblewrap options and executes a probe. Two parts of the sandbox shape can be refused by the environment, and both are settled by probing rather than guessing. `/proc` is settled first and `--disable-userns` second, on whichever `/proc` shape was chosen, so neither can be misdiagnosed as the other.

`/proc` defaults to `--proc /proc`, giving the sandbox its own procfs so it sees only its own processes. Docker's default readonlyPaths/maskedPaths make the kernel refuse that mount in the sandbox's own pid namespace (`Can't mount proc on /newroot/proc: Operation not permitted`); the runner then falls back to `--ro-bind /proc /proc` and warns. Executions still run, but the sandbox sees the container's process list. The official Compose file keeps the stronger shape with `systempaths=unconfined`; the fallback is never the default, and `privileged` is not the way to avoid it.

`--disable-userns` is added only when a probe proves it usable here, not based on the version or on `--help`: the option works by writing `user.max_user_namespaces`, so under LXC and container runtimes that mount `/proc/sys` read-only it fails and aborts the whole launch even on Bubblewrap 0.8+. The probe runs a minimal sandbox with the option, then without it, which separates an old Bubblewrap that rejects the unknown option from an environment that refuses the sysctl write, and both from a host where no sandbox builds at all. Whenever the option is omitted the runner warns and every other protection — namespaces, seccomp, the mount allowlist — is unchanged, so executions still run. The launcher preflight and the runner share this detection (`packages/sandbox-capability`), so preflight cannot pass a sandbox the runner then fails to build.

```text
--die-with-parent --new-session --unshare-all --unshare-user [--disable-userns]
--cap-drop ALL
read-only /usr plus system links, /dev; tmpfs /tmp
--proc /proc, or --ro-bind /proc /proc when a fresh procfs is refused
hide host Python/R when managed environments are enabled
read-only revision at /opt/science-env
bind Session workspace read-write at /workspace
--clearenv plus runner baseline and safe Session profile
--seccomp 3
```

Disconnect or Stop run propagates Abort and `SIGKILL`.

### 3.1 Sandbox network access

Sandbox network access is a system setting. API snapshots it into every Permission Epoch (`networkPolicy` plus `networkAccess`, including a content-derived `revision`) and Runner shapes the sandbox from that snapshot. It is unrelated to the Network proxies settings, which govern the API/Gateway/MCP's own outbound calls and never affect sandbox code.

| Mode | Sandbox |
|---|---|
| `none` (default) | Exactly the historical behavior: `--unshare-all`, no `--share-net`, baseline seccomp denying every socket syscall, no channel mounted, no outbound environment injected |
| `domain-allowlist` | **Still** `--unshare-all` and **still no** `--share-net`. The only exit is a bind-mounted Unix domain socket |

The `domain-allowlist` data path:

```text
sandbox process (own netns, no interface)
  └─ HTTP_PROXY=http://127.0.0.1:18118
       └─ egress bridge (inside the sandbox, on the sandbox's own loopback)
            └─ /run/sciencediscovery/egress.sock (bind mount)
                 └─ egress gateway (in the runner process, runner's own user)
                      └─ allowed domains only → internet
```

Properties:

- **No root, no CAP_NET_ADMIN, no socat dependency.** The bridge is a product-owned stdlib Python script; its interpreter and standard library are bind-mounted read-only under `/opt/sciencediscovery-net/`. When the host has no usable python3 the mode fails closed and `/health.sandboxNetwork` reports why.
- The bridge listens before it forks and runs the real workload as its child with inherited stdio, so the persistent kernel and shell line protocols are unaffected; the child's exit status is passed through.
- seccomp switches to the network profile: it allows only the socket family (`socket/connect/bind/listen/accept/accept4/socketpair`) and keeps denying ptrace, mount, setns, bpf, keyring, io_uring and the rest. Raw and packet sockets need `CAP_NET_RAW`, which `--cap-drop ALL` already removes.
- Entries are `example.org` or `*.example.org` (label-boundary match, never the apex), optionally with `:443` to pin a port. IP literals are rejected both as entries and as request targets.
- The gateway resolves the name, classifies the addresses, rejects loopback, link-local and private space by default, and connects to the approved address so DNS cannot change between check and connect. An internal mirror can be enabled explicitly.
- Boundary: **TLS is not intercepted**. Filtering is by CONNECT / absolute-URI host name, so a broad entry remains a broad grant.
- Changing the policy rotates the Permission Epoch and reclaims that Session's persistent kernels and shell, because the epoch id is part of the reuse key.
- Scientific environment install networking (conda channels, pip index, offline cache) is independent of this policy.

### 3.2 Ascend NPU Broker (optional host execution)

Ascend NPU access is not modeled as ordinary device passthrough into bwrap. On the verified 910B3 deployment, host MindSpore can use the NPU, but the same probe inside the bwrap namespace fails with `Container ID verify failed (session ct_id=0; device ct_id=...)`. That points to Ascend runtime/container identity checks, not only Unix permissions on `/dev/davinci*`.

Runner therefore keeps the normal sandbox boundary and exposes an opt-in Host NPU Broker:

- `run_python`, `run_r`, `run_shell`, and persistent kernels still run inside Bubblewrap; NPU support does not loosen namespaces, seccomp, or network policy.
- The API exposes `run_npu_job` only when `SCIENCE_AGENT_NPU_BROKER=1`.
- Broker job children run in the host namespace so CANN, MindSpore, and Ascend device initialization can succeed.
- The Broker accepts only `workloadId` values from a JSON allowlist and starts commands with `shell: false`; the Agent cannot submit arbitrary host commands.
- `${repo:...}` and `${input:configPath}` templates are checked after `realpath`; repository paths must stay under the ScienceDiscovery checkout and input configs must stay under the current Session workspace.
- Protenix adapters also validate paths inside Agent-authored config files, including `workspace`, `run_dir`, `target_pdb`, and `framework_pdb`; only Session workspace paths and explicit read-only skill/deployment resource roots are allowed.
- status, logs, result, and cancel operations verify the Session id. Phase 1 marks active jobs as `interrupted` on Runner restart.

The exception is “allowlisted host model job,” not “host shell for the Agent.” NPU deployment variables live in [Configuration reference](../reference/configuration.md#environment-variables-local-mode), and the model-visible tool contract lives in [Built-in tools](../reference/builtin-tools.md#other-conditional-tools).

## 4. Execution model and quotas

- A Promise chain serializes all execution globally; an aborted queued item is removed before start.
- Runner workspace defaults to 10 GiB and is checked before and every 100 ms during execution; `0` is unlimited.
- Runner has no per-file execution quota (`maxFileBytes=0`).
- Retained stdout+stderr defaults to 1 GiB; excess is head/tail truncated but does not fail the run; `0` disables truncation.
- API upload limits are separate: 1 GiB per file and 10 GiB per multipart request.
- Execution wall clock defaults to unlimited and kills on expiry.
- There is no CPU or memory cgroup quota.

### Inspect or modify quotas

```bash
curl -s http://127.0.0.1:4310/health | jq '.workspace, .runner.maxWorkspaceBytes, .runner.maxFileBytes, .runner.maxOutputBytes'
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:4310/api/quota-settings
```

The Web Quotas settings persist values for new executions. Environment seeds are `SCIENCE_AGENT_MAX_WORKSPACE_BYTES`, `SCIENCE_AGENT_MAX_OUTPUT_BYTES`, `SCIENCE_AGENT_SHELL_IDLE_MS`, `SCIENCE_AGENT_WORKSPACE_MAX_BYTES`, and the upload file/request limits; `0` means unlimited for the relevant dimension.

## 5. Language runtimes

| Language | Ephemeral | Persistent |
|---|---|---|
| Python | `python3 -I -` | isolated unbuffered worker with persistent namespace |
| R | `R --vanilla --slave` | R JSON-line worker |
| Shell | strict Bash stdin | Bash driver loop preserving state |

Interpreters come from host `/usr/bin` or managed `/opt/science-env/bin`.

## 6. Scientific environments

- A fixed micromamba release and SHA256 are shared by runner, Docker, and packaging. Host mode downloads/caches on setup; Docker bakes and seeds it, so runtime need not fetch GitHub. Administrators may override the path.
- Bootstrap is asynchronous after health becomes available. Setup endpoints report phase/state/error and trigger serialized retry without terminating runner.
- Cold start creates only a read-only Python 3.12 base with numpy/pandas/scipy/matplotlib. The first explicit R named environment lazily creates an R 4.4 base with tidyverse/data.table.
- Catalog and source settings are instance-global. Bases are read-only; named environment mutations create immutable revisions.
- Pip presets are upstream, TUNA, USTC, and Huawei Cloud; conda omits Huawei. Precedence is explicit request, global preset, upstream. Conda uses override/strict priority and an operator channel allowlist; exact built-in mirror URLs are accepted. Offline cache validates sources but uses local no-index/offline operation; CRAN/Bioconductor are rejected offline.
- Layout includes catalog, provisioner, micromamba, immutable revision prefixes/snapshots, and SHA256-addressed wheel copies under `.sciencediscovery-data/scientific-envs/`.
- Pip `indexUrl` must be credential-free HTTPS, at most 2048 characters, without query/fragment/whitespace/control characters. Package lists reject option injection and remote URLs. A Session-relative wheel is copied to persistent hash storage and its source/hash/distribution/version enter the revision snapshot.
- Direct package-manager mutation in `run_shell` is unsupported and the managed prefix is read-only in the sandbox.

## 7. Persistent kernels

A kernel is one resident Bubblewrap Python/R worker using JSON lines. Each result reports exit code, output, cwd, and environment; output uses the same truncation. Reuse key is Session, language, revision, and permission epoch, so environment/permission changes replace it. Idle expiry records memory loss; kernels can be reclaimed by Session, ID, or revision.

## 8. Persistent shell and Session environment profile

`run_shell` defaults to a persistent shell (once-only permission downgrades to ephemeral). A Session Bash preserves `cd`, `export`, and `source`. A command failure reports its code without ending the shell; explicit `set -e` termination or `exit` ends it and the next call reports lost state. Shells use Session/system-shell revision/permission-epoch identity and share idle refresh with other Session execution.

After each shell evaluation, safe variables and `/workspace` cwd become the Session/permission-epoch profile for later Python/R/ephemeral shell. Names must be valid; runner-reserved and dangerous keys such as `LD_*`, `BASH_ENV`, `IFS`, `PYTHONHOME`, and startup hooks are removed. Values above 32 KiB and total above 256 KiB are dropped; cwd must still exist under `/workspace`. Host environment never enters the profile and cannot override runner baseline. Profile dies with shell teardown/idle/exit/epoch change; already-running Python/R kernels do not receive later changes.

## Related documentation

- [Control plane](control-plane.md)
- [Runtime architecture](architecture.md)
- [Configuration reference](../reference/configuration.md)
- [Ascend NPU Host Broker](ascend-npu-runner.md)
