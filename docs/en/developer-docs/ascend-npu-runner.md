# Ascend NPU Host Broker Design

This page records the problem background, design boundary, and documentation entry points for the Ascend NPU Broker. Deployment variables, tool contracts, and Runner security boundaries live in the existing topic documents so operational reference and design rationale do not duplicate each other.

## 1. Background

On the verified Ascend 910B3 host, MindSpore can use the NPU directly on the host. The same probe inside the Runner Bubblewrap namespace fails with a typical error:

```text
Container ID verify failed (session ct_id=0; device ct_id=...)
```

That measurement was taken with the host's whole `/dev` visible, and it is what the driver does in that situation rather than a limit on device passthrough: inside a mount namespace the driver enumerates the cards visible under the caller's `/dev`, all-or-nothing, so a single card claimed by another tenant fails the call for every card.

Chips selected by an operator are therefore handed to the sandbox after all — a fresh `/dev` carrying only those chips, renumbered from 0 — and `npu-smi info` and MindSpore both run inside it on this host. See [Sandbox execution](sandbox-execution.md) §3.2 for how that launch is built and how a chip is judged usable.

The Broker below is a separate, opt-in path that remains for allowlisted host workloads which are not ordinary Agent executions.

## 2. Design boundary

- Normal execution uses `run_shell` in a fresh sandbox (Bubblewrap and seccomp on Linux), including `python -m`, Python files, and `Rscript`; interpreter state does not persist between calls.
- NPU model jobs do not use the persistent kernel REPL.
- Host NPU Broker is disabled by default; only `SCIENCE_AGENT_NPU_BROKER=1` exposes `run_npu_job` to the Agent.
- The Broker runs only fixed entry points from the workload allowlist and does not provide arbitrary host shell.
- Built-in NPU workloads, including the smoke test, require a managed Python environment. The Agent selects `environment_id`; the API resolves its latest Revision for the Broker's internal receipt. The Broker rejects missing or unusable Python runtimes before enqueue. Historical Revision selection is not exposed to the Agent.
- Workload children run in the host namespace to access CANN, MindSpore, and Ascend devices; Runner still validates paths, Session ownership, and job lifecycle.
- Agent-writable `config.json` files describe only workspace inputs, presets, and run parameters. Python, helper scripts, CANN, HMMER, MindScience, model weights, and database directories come only from administrator environment variables or the workload manifest. They may live under `/home`, a shared filesystem, or another deployment path, but the Agent cannot rewrite them through `config.json`.
- The antibody adapter does not execute helper scripts from the Session workspace. If a manager emits a `<workspace>/helpers/...` script path or a `--scripts-dir <workspace>/helpers` directory argument, the adapter rewrites it to the host skill/bundle `scripts/` directory and rejects any remaining workspace-helper execution path.
- Protenix model code, weights, databases, HMMER, CANN, and MindScience checkouts are deployment or skill assets. They do not belong in generic Runner code.

## 3. Documentation map

| Need | Document |
|---|---|
| Enable/disable Broker and `.env` variables | [Configuration reference](../reference/configuration.md#environment-variables-local-mode) |
| Model-visible NPU tool and parameters | [Built-in tools](../reference/builtin-tools.md#other-conditional-tools) |
| How selected chips reach the sandbox and how usability is judged | [Sandbox execution](sandbox-execution.md#32-ascend-npu-inside-the-sandbox) |
| Why the Broker is a sandbox exception and how it is constrained | [Sandbox execution](sandbox-execution.md#33-ascend-npu-broker-optional-host-execution) |
| Broker placement in the runtime model | [Runtime architecture](architecture.md#25-responsibility-split) |
| Default workload allowlist | `services/runner/workloads/npu-workloads.default.json` |

## 4. Extension principles

Broker extensibility comes from registering workload manifests, not from opening arbitrary commands. A new model should add or deploy an allowlist entry while preserving:

- fixed entry point;
- `shell: false`;
- default Python resolution from the latest managed environment selected by `run_npu_job(environment_id=...)`, with the resolved Revision retained internally for audit; `SCIENCE_AGENT_NPU_PYTHON` is only read by custom manifests that explicitly use `${python}`;
- `realpath` boundary checks for workspace and repository paths;
- explicit environment variables or site asset references;
- Session-scoped status, logs, result, and cancel;
- job states shaped as `queued -> running -> succeeded | failed | cancelled | interrupted`.

Direct NPU passthrough into bwrap may be a future optimization only after a real Ascend operation probe succeeds on that deployment. Probe failure should fall back to the Broker.

## 5. Known limitations

- Phase 1 uses a single global Broker worker: jobs are FIFO across Sessions, so a long or stuck job in one Session can keep later jobs from other Sessions queued.
- NPU Broker jobs do not have a wall-clock timeout yet; operators should keep workload entry points bounded or cancel jobs explicitly.
- The persisted catalog at `.sciencediscovery-data/npu-jobs/jobs.json` is not garbage-collected yet and is rewritten in full when job output is appended. Catalog load is best-effort so a corrupt file does not prevent the Runner from starting.

## 6. Test entry point

Runner-side NPU Broker tests:

```bash
pnpm --filter @sciencediscovery/runner build
node --test --test-name-pattern "NPU Broker" services/runner/dist/server.test.js
```

Coverage includes default-off behavior, explicit enablement, HMAC submit, workload allowlist, workspace path escape rejection, `${repo:...}` realpath boundaries, Protenix workload execution, AF3-intent rejection for the Protenix entry point, artifact collection, and interrupted state after Runner restart.
