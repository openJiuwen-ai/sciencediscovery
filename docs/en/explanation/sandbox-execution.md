# Sandbox Execution: `services/runner`

Runner is a rootless executor. Ordinary Agent execution uses `run_shell`, including `python -m`, Python files and `Rscript`, inside a Bubblewrap/seccomp sandbox with its Agent×Runner Workspace. Each call starts a fresh process; cwd, exports and interpreter memory do not carry across calls. Sandbox network access defaults to `none`; see §3.1. Runner also manages micromamba environments. Its default listener is `127.0.0.1:4311`, with API as its client.

## 1. Source structure

| File | Responsibility |
|---|---|
| `server.ts` | Routes, bearer/HMAC auth, Workspace admission and execution queue, startup preflight |
| `executor.ts` | Ephemeral Bubblewrap construction, quota/timeout, workspace snapshots |
| `execution-manager.ts` | Managed Shell lifetime, status/logs/cancel and committed Workspace receipts |
| `kernel-manager.ts`, `shell-session-manager.ts`, `session-env-profile.ts` | Legacy internal primitives; HTTP execution no longer starts persistent workers or injects saved profiles |
| `environment-store.ts` | micromamba catalog, in-place named environments and revision records |
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
read-only selected environment at /opt/science-env
bind Agent×Runner Workspace read-write at /workspace
--clearenv plus runner baseline; cwd selected explicitly for this call
--seccomp 3
```

Legacy synchronous requests abort on disconnect. Managed Shell Executions survive a client waiting deadline or disconnect; cancellation is explicit through the Execution management endpoint.

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
- The bridge listens before it forks and runs the real workload as its child with inherited stdio; the child's exit status is passed through.
- seccomp switches to the network profile: it allows only the socket family (`socket/connect/bind/listen/accept/accept4/socketpair`) and keeps denying ptrace, mount, setns, bpf, keyring, io_uring and the rest. Raw and packet sockets need `CAP_NET_RAW`, which `--cap-drop ALL` already removes.
- Entries are `example.org` or `*.example.org` (label-boundary match, never the apex), optionally with `:443` to pin a port. IP literals are rejected both as entries and as request targets.
- The gateway resolves the name, classifies the addresses, rejects loopback, link-local and private space by default, and connects to the approved address so DNS cannot change between check and connect. An internal mirror can be enabled explicitly.
- Boundary: **TLS is not intercepted**. Filtering is by CONNECT / absolute-URI host name, so a broad entry remains a broad grant.
- Changing the policy rotates the Permission Epoch; new executions use the new policy snapshot.
- Scientific environment install networking (conda channels, pip index, offline cache) is independent of this policy.

### 3.2 Ascend NPU inside the sandbox

Selected Ascend chips are handed to the sandbox. An earlier revision of this document said they could not be, because a probe inside the bwrap namespace failed with `Container ID verify failed (session ct_id=0; device ct_id=...)`. That was measured while the host's whole `/dev` was visible, and it is what the driver does in that situation rather than a limit on device passthrough: inside a mount namespace the driver enumerates the cards it can see under the caller's `/dev`, all-or-nothing, so one card claimed by another tenant fails the call for every card. Exposing only the selected chips removes the condition, and `npu-smi info` and MindSpore both run inside the sandbox on a 910B3.

What the launch does:

- Keeps bubblewrap's fresh `--dev /dev` and adds one `--dev-bind` per selected chip, plus the management nodes the host actually has (`davinci_manager`, `devmm_svm`, `hisi_hdc`). A chip nobody selected is not present in the sandbox at all.
- Renumbers the selection from 0 in ascending device order, so rank 0..n-1 is `/dev/davinci0..n-1` whatever the host numbering is.
- Restates the CANN environment that `--clearenv` would otherwise wipe, including `/usr/local/Ascend/driver/lib64/common` on `LD_LIBRARY_PATH` (it holds the `libc_sec.so` that `libascend_hal.so` links), and binds `/etc/ascend_install.info` read-only when present.
- Prefixes `/usr/local/bin` to `PATH` only for a launch that carries chips, so `npu-smi` resolves as a command there and a non-NPU sandbox keeps the PATH it always had.
- Changes nothing else: `--unshare-all --unshare-user --cap-drop ALL`, the seccomp filter and the network policy are the same as any other execution.

What may be selected is decided per chip by a real probe, not by the host listing: a throwaway sandbox shaped like a real launch binds that one chip and runs `npu-smi info` in it. The host reports cards as healthy that a sandbox cannot open, so only a chip whose probe succeeded can be ticked, and every execution re-probes the chips it names before launching — a chip claimed by another tenant in the meantime fails the execution by name instead of failing deep inside a framework. Scope is the Ascend 910 series; other chips are listed and refused with the chip name in the reason.

Machine state is read through the driver's own DCMI interface (via the host Python, no compiled addon), falling back to `npu-smi info -m` plus `npu-smi info` when that is unavailable. Device identity is the chip logic id — the `N` in `/dev/davinciN` — never the card number, because a card can carry more than one compute die.

### 3.3 Ascend NPU Broker (optional host execution)

Separately from the above, Runner still exposes an opt-in Host NPU Broker for allowlisted host workloads that are not ordinary Agent executions:

- Ordinary Shell commands (including Python/R launched by Shell) and the legacy ephemeral language endpoints run inside Bubblewrap; NPU support does not loosen namespaces, seccomp, or network policy.
- The API exposes `run_npu_job` only when `SCIENCE_AGENT_NPU_BROKER=1`.
- Broker job children run in the host namespace so CANN, MindSpore, and Ascend device initialization can succeed.
- The Broker accepts only `workloadId` values from a JSON allowlist and starts commands with `shell: false`; the Agent cannot submit arbitrary host commands.
- `${repo:...}` and `${input:configPath}` templates are checked after `realpath`; repository paths must stay under the ScienceDiscovery checkout and input configs must stay under the current Session workspace.
- Protenix adapters also validate paths inside Agent-authored config files, including `workspace`, `run_dir`, `target_pdb`, and `framework_pdb`; only Session workspace paths and explicit read-only skill/deployment resource roots are allowed.
- status, logs, result, and cancel operations verify the Session id. Phase 1 marks active jobs as `interrupted` on Runner restart.

The exception is “allowlisted host model job,” not “host shell for the Agent.” NPU deployment variables live in [Configuration reference](../reference/configuration.md#environment-variables-local-mode), and the model-visible tool contract lives in [Built-in tools](../reference/builtin-tools.md#other-conditional-tools).

## 4. Execution model and quotas

- Writes to the same physical Workspace serialize across processes. Different Workspaces can execute concurrently. The lease remains held until the workload exits and CAS snapshot/ref publication completes; status and logs do not take the write lease.
- Runner workspace defaults to 10 GiB and is checked before and every 100 ms during execution; `0` is unlimited.
- Runner has no per-file execution quota (`maxFileBytes=0`).
- Retained stdout+stderr defaults to 1 GiB; excess is head/tail truncated but does not fail the run; `0` disables truncation.
- API upload limits are separate: 1 GiB per file and 10 GiB per multipart request.
- Legacy synchronous endpoints support a wall-clock execution limit (unlimited by default). Managed Shell Executions have no automatic kill at the client waiting deadline.
- There is no CPU or memory cgroup quota.

### Inspect or modify quotas

```bash
curl -s http://127.0.0.1:4310/health | jq '.workspace, .runner.maxWorkspaceBytes, .runner.maxFileBytes, .runner.maxOutputBytes'
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:4310/api/quota-settings
```

The Web Quotas settings persist values for new executions. Environment seeds are `SCIENCE_AGENT_MAX_WORKSPACE_BYTES`, `SCIENCE_AGENT_MAX_OUTPUT_BYTES`, `SCIENCE_AGENT_WORKSPACE_MAX_BYTES`, and the upload file/request limits; `0` means unlimited for the relevant dimension.

## 5. Language runtimes

| Entry | Process |
|---|---|
| Ordinary `run_shell` | Fresh strict Bash; may launch Python modules/files, Rscript and other selected-environment tools |
| Legacy Python HTTP execution | Ephemeral `python3 -I -` |
| Legacy R HTTP execution | Ephemeral `R --vanilla --slave` |

Interpreters come from host `/usr/bin` or managed `/opt/science-env/bin`.

## 6. Scientific environments

- A fixed micromamba release and SHA256 are shared by runner, Docker, and packaging. Host mode downloads/caches on setup; Docker bakes and seeds it, so runtime need not fetch GitHub. Administrators may override the path.
- Bootstrap is asynchronous after health becomes available. Setup endpoints report phase/state/error and trigger serialized retry without terminating runner.
- Cold start creates only a read-only Python 3.12 base with numpy/pandas/scipy/matplotlib. The first explicit R named environment lazily creates an R 4.4 base with tidyverse/data.table.
- Catalog and source settings are instance-global. Bases are read-only; named environments update in place under an environment lock. Revision records support tracing, not selection of an old runnable prefix.
- Pip presets are upstream, TUNA, USTC, and Huawei Cloud; conda omits Huawei. Precedence is explicit request, global preset, upstream. Conda uses override/strict priority and an operator channel allowlist; exact built-in mirror URLs are accepted. Offline cache validates sources but uses local no-index/offline operation; CRAN/Bioconductor are rejected offline.
- Layout includes catalog, provisioner, micromamba, named environment prefixes, revision snapshots, and SHA256-addressed wheel copies under `.sciencediscovery-data/scientific-envs/`.
- Pip `indexUrl` must be credential-free HTTPS, at most 2048 characters, without query/fragment/whitespace/control characters. Package lists reject option injection and remote URLs. A Session-relative wheel is copied to persistent hash storage and its source/hash/distribution/version enter the revision snapshot.
- Direct package-manager mutation in `run_shell` is unsupported and the managed prefix is read-only in the sandbox.

## 7. Execution lifetime and migration

HTTP `/execute`, `/execute-shell` and `/shell-executions` reject `kernelMode=persistent` before creating a Workspace or starting code. Once-scoped permission does not silently downgrade that request. Omit the field or use `ephemeral`; use a managed Shell Execution for a long-running task.

A resident interpreter could otherwise leave a thread or subprocess writing after a call returned and the Workspace lease was released. On Linux, ephemeral executions end their Bubblewrap PID namespace before the final snapshot and lease release. A managed background Execution instead retains ownership while its workload runs; it is not a reusable interactive Shell.

Historical Session profiles are not injected. Select cwd and environment on every call; put required exports and commands in the same script. Python/R memory is not retained between calls. Notebook-style shared memory is outside this implementation.

## Related documentation

- [Control plane](control-plane.md)
- [Runtime architecture](architecture.md)
- [Configuration reference](../reference/configuration.md)
- [Ascend NPU Host Broker](ascend-npu-runner.md)
