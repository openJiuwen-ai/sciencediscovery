# Ascend NPU Host Broker Design

This page records the problem background, design boundary, and documentation entry points for the Ascend NPU Broker. Deployment variables, tool contracts, and Runner security boundaries live in the existing topic documents so operational reference and design rationale do not duplicate each other.

## 1. Background

On the verified Ascend 910B3 host, MindSpore can use the NPU directly on the host. The same probe inside the Runner Bubblewrap namespace fails with a typical error:

```text
Container ID verify failed (session ct_id=0; device ct_id=...)
```

This is not just Unix permission on `/dev/davinci*`. The Ascend runtime also checks driver/container identity, so `--dev-bind` device passthrough into bwrap is not enough to guarantee NPU access.

The current design therefore does not keep pushing NPU devices into bwrap. Normal tools keep their sandbox isolation, and long jobs that need Ascend initialization run through a Runner-managed host Broker.

## 2. Design boundary

- `run_python`, `run_r`, `run_shell`, and persistent kernels still run inside Bubblewrap and seccomp.
- NPU model jobs do not use the persistent kernel REPL.
- Host NPU Broker is disabled by default; only `SCIENCE_AGENT_NPU_BROKER=1` exposes `run_npu_job` to the Agent.
- The Broker runs only fixed entry points from the workload allowlist and does not provide arbitrary host shell.
- Built-in NPU workloads, including the smoke test, require a verified ScienceDiscovery managed scientific environment revision. Submit rejects these workloads before enqueue when `environment_revision_id` is missing or cannot resolve to a Python runtime.
- Workload children run in the host namespace to access CANN, MindSpore, and Ascend devices; Runner still validates paths, Session ownership, and job lifecycle.
- Agent-writable `config.json` files describe only workspace inputs, presets, and run parameters. Python, helper scripts, CANN, HMMER, MindScience, model weights, and database directories come only from administrator environment variables or the workload manifest. They may live under `/home`, a shared filesystem, or another deployment path, but the Agent cannot rewrite them through `config.json`.
- The antibody adapter does not execute helper scripts from the Session workspace. If a manager emits a `<workspace>/helpers/...` script path or a `--scripts-dir <workspace>/helpers` directory argument, the adapter rewrites it to the host skill/bundle `scripts/` directory and rejects any remaining workspace-helper execution path.
- Protenix model code, weights, databases, HMMER, CANN, and MindScience checkouts are deployment or skill assets. They do not belong in generic Runner code.

## 3. Documentation map

| Need | Document |
|---|---|
| Enable/disable Broker and `.env` variables | [Configuration reference](../reference/configuration.md#environment-variables-local-mode) |
| Model-visible NPU tool and parameters | [Built-in tools](../reference/builtin-tools.md#other-conditional-tools) |
| Why NPU is a sandbox exception and how it is constrained | [Sandbox execution](sandbox-execution.md#32-ascend-npu-broker-optional-host-execution) |
| Broker placement in the runtime model | [Runtime architecture](architecture.md#25-responsibility-split) |
| Default workload allowlist | `services/runner/workloads/npu-workloads.default.json` |

## 4. Extension principles

Broker extensibility comes from registering workload manifests, not from opening arbitrary commands. A new model should add or deploy an allowlist entry while preserving:

- fixed entry point;
- `shell: false`;
- default Python resolution through the ScienceDiscovery scientific environment revision carried by `run_npu_job`; `SCIENCE_AGENT_NPU_PYTHON` is only read by custom manifests that explicitly use `${python}`;
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
