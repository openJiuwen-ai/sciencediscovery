# Configuration, Ports, Quotas, and Storage Reference

This page lists local and Docker environment variables, default ports, workspace-related quotas, and storage locations. See [Deployment](../how-to/deployment.md) for operational steps.

## Environment variables (local mode)

```bash
cp .env.example .env
set -a && source .env && set +a
./scripts/run-local.sh
```

| Variable | Default | Purpose |
|---|---|---|
| `SCIENCE_AGENT_HOST` | `127.0.0.1` | HTTP bind address; another interface requires explicit configuration |
| `SCIENCE_AGENT_PORT` | `4310` | HTTP port |
| `SCIENCE_AGENT_AUTH_TOKEN` | generated on first start | Browser/API bearer token; unset means the value stored in `<data-dir>/secrets/auth-token` |
| `SCIENCE_DISCOVERY_DATA_DIR` | `.sciencediscovery-data`, resolved from the repository root or from the working directory of the single-file launcher | Projects, sessions, workspaces, keys, and service environments. The former `SCIENCE_AGENT_DATA_DIR` remains a logged compatibility fallback. |
| `SCIENCE_AGENT_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR` threshold |
| `SCIENCE_AGENT_LOG_DIR` | `<data-dir>/logs` | Optional log directory override |
| `SCIENCE_AGENT_LOG_MAX_BYTES` | `10485760` | Maximum bytes in one category log before rotation |
| `SCIENCE_AGENT_LOG_BACKUP_COUNT` | `5` | Rotated files retained per category |
| `SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS` | `240000` | Initial no-output/no-progress timeout (`0` is unlimited) |
| `SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS` | `0` | Initial whole-turn timeout (`0` is unlimited) |
| `SCIENCE_AGENT_RUNNER_HOST` | `127.0.0.1` | Runner bind address |
| `SCIENCE_AGENT_RUNNER_PORT` | `4311` | Runner port |
| `SCIENCE_AGENT_RUNNER_URL` | `http://127.0.0.1:4311` | Runner endpoint used by the API |
| `SCIENCE_AGENT_RUNNER_TOKEN` | `sciencediscovery-runner-local` | API-to-runner token |
| `SCIENCE_AGENT_BWRAP_PATH` | `bwrap` resolved from `PATH` | Bubblewrap executable; runner startup validates required options |
| `SCIENCE_AGENT_NPU_BROKER` | `0` | Enables the host Ascend NPU Broker. Disabled by default; only `1`, `true`, or `yes` exposes `run_npu_job` to the Agent |
| `SCIENCE_AGENT_NPU_WORKLOAD_CONFIG` | empty | NPU workload allowlist JSON; empty uses `services/runner/workloads/npu-workloads.default.json` |
| `SCIENCE_AGENT_NPU_PYTHON` | `python3` | Compatibility Python only for custom allowlisted workloads that explicitly use `${python}`; built-in NPU workloads use the Agent-selected scientific environment revision instead |
| `SCIENCE_AGENT_NPU_SMOKE_SCRIPT` | empty | Optional administrator-owned Ascend smoke probe; empty uses `services/runner/workloads/npu-smoke-test.py` |
| `SCIENCE_AGENT_NPU_PROTENIX_SCRIPT` | empty | Host manager entry point for the Protenix antibody pipeline, usually a deployed skill `scripts/antibody_pipeline_manager.py`. The manager is launched with the Python resolved from the ScienceDiscovery scientific environment revision |
| `SCIENCE_AGENT_NPM_REGISTRY` | empty (official registry) | Build-only registry passed to `pnpm install --registry`; does not alter user/global npm configuration |
| `SCIENCE_AGENT_PYPI_INDEX` | empty (official PyPI) | Build-only `UV_DEFAULT_INDEX` for `uv sync`; the script backs up and restores `uv.lock` if the mirror causes re-resolution |
| `SCIENCE_AGENT_MEMORY_GRAPH_HOST` | `127.0.0.1` | Memory-graph service bind address |
| `SCIENCE_AGENT_MEMORY_GRAPH_PORT` | `17674` | Memory-graph port |
| `SCIENCE_AGENT_MEMORY_GRAPH_URL` | `http://127.0.0.1:17674` | Memory-graph endpoint used by the API |
| `SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN` | `sciencediscovery-memory-graph-local` | API-to-memory-graph token |
| `SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL` | `INFO` | Memory-graph log level |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `0` | Initial sandbox wall-clock timeout (`0` is unlimited) |
| `SCIENCE_AGENT_MAX_WORKSPACE_BYTES` | `10737418240` (10 GiB) | Runner workspace quota (`0` is unlimited); also seeds system settings |
| `SCIENCE_AGENT_MAX_OUTPUT_BYTES` | `1073741824` (1 GiB) | Retained stdout+stderr per execution; excess is truncated (`0` disables truncation) |
| `SCIENCE_AGENT_WORKSPACE_MAX_BYTES` | `10737418240` (10 GiB) | API cumulative upload-workspace limit |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_FILE_BYTES` | `1073741824` (1 GiB) | API per-uploaded-file limit, independent of runner output |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES` | `10737418240` (10 GiB) | API multipart request limit |
| `SCIENCE_AGENT_PERMISSION_WAIT_TIMEOUT_MS` | `0` | Initial permission-decision timeout (`0` is unlimited) |
| `SCIENTIFIC_ENVS` | `1` | Expose managed Python/R and persistent kernels; runner can start before setup completes |
| `SCIENCE_AGENT_PROVISIONER_PATH` | — | Optional administrator provisioner override |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | — | Optional pre-populated offline cache; source safety checks still apply |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | Comma-separated allowed channels; built-in TUNA/USTC presets are always recognized |
| `SCIENCE_AGENT_KERNEL_IDLE_MS` | `0` | Initial persistent-kernel idle timeout (`0` is unlimited) |
| `SCIENCE_AGENT_WEB_DIR` | `apps/web/dist` | Static UI assets |
| `SCIENCE_AGENT_PAPER_PYTHON_PATH` | `<data-dir>/envs/paper/bin/python` | PDF-worker Python |
| `SCIENCE_AGENT_PAPER_WORKER_PATH` | `services/paper/paper_worker.py` | PDF-worker entry point |

The Ascend NPU Broker is for deployments that need host Ascend devices, and administrators must enable it explicitly. Keep `SCIENCE_AGENT_NPU_BROKER=0` when the host has no Ascend NPU, lacks CANN/MindSpore, or should not expose NPU jobs to the Agent; then `run_npu_job` is absent from the tool table. Enabling it does not change the normal local-mode startup command. Before enabling the Broker, create and verify at least one ScienceDiscovery managed Python scientific environment revision that can import the required CANN/MindSpore stack. Built-in NPU workloads, including `npu.smoke_test`, require `environment_revision_id`; when the Agent does not pass one explicitly, the API uses the current Session revision. When `SCIENCE_AGENT_NPU_WORKLOAD_CONFIG` is empty, the built-in allowlist currently contains `npu.smoke_test` and `antibody.protenix.v1`. Add models through a custom JSON allowlist with fixed entry points, not arbitrary Agent-supplied commands. `SCIENCE_AGENT_NPU_PYTHON` is kept only for custom allowlists that explicitly use `${python}`; the built-in allowlist uses `${managedPython}` and ignores it. Changing the allowlist is equivalent to changing executable host-code entry points and should be reviewed as a deployment change. Model weights, databases, HMMER, CANN, MindScience checkouts, and similar site assets stay outside the repository and are normally referenced through the environment variables or workload configuration above.

The browser stores only the API token in local storage. Model credentials stay in backend storage.

### Quota levels

These defaults come from `services/api/src/workspace-upload.ts`, `services/runner/src/executor.ts`, and `.env.example`. They have different meanings and are not interchangeable:

| Level | Default | Scope |
|---|---|---|
| API uploaded file | 1 GiB | Each multipart file at the upload boundary |
| API upload request | 10 GiB | Combined multipart request body |
| API cumulative upload workspace | 10 GiB | Workspace total checked before accepting another upload |
| Runner workspace | 10 GiB | Workspace before and after execution, including uploads and generated files |
| Runner stdout + stderr | 1 GiB | Combined retained output for one execution; excess is truncated |
| Runner execution file | no separate limit | `MAX_RUNNER_FILE_BYTES=0`; files still count against the runner workspace total |

In `GET /health`, `workspace.maxFileBytes`, `maxRequestBytes`, and `maxWorkspaceBytes` report the API file, API request, and runner workspace limits. The endpoint does not report the stdout/stderr limit.

## Docker environment variables

Compose reads the root `.env` and interpolates these keys into `docker-compose.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID` | `1000` | Container uid/gid; must write host `./data` |
| `SCIENCE_AGENT_PUBLISH_HOST` | `127.0.0.1` | Host interface publishing the UI/API |
| `SCIENCE_AGENT_PUBLISH_PORT` | `4310` | Host port mapped to container `4310` |
| `SCIENCE_AGENT_AUTH_TOKEN` | generated on first start | Browser/API bearer token; unset means the value stored in `<data-dir>/secrets/auth-token` |
| `SCIENCE_AGENT_RUNNER_TOKEN` | `sciencediscovery-runner-local` | API-to-runner token on container loopback |
| `SCIENTIFIC_ENVS` | `1` | Managed Python/R environments and persistent kernels |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `7200000` | Sandbox wall-clock timeout |
| `SCIENCE_AGENT_KERNEL_IDLE_MS` | `1800000` | Persistent-kernel idle timeout (minimum 1000 ms) |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | Comma-separated channel allowlist |
| `SCIENCE_AGENT_PROVISIONER_PATH` | — | Optional administrator micromamba path |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | — | Optional pre-populated offline cache |
| `SCIENCE_AGENT_BWRAP_PATH` | `/usr/bin/bwrap` | Bubblewrap in the image |

The API explicitly listens on `0.0.0.0:4310` **inside the container**, while runner `4311` remains on container loopback. Only the API port is published, and its host-side default is `127.0.0.1`. See [Docker deployment](../how-to/deployment.md#docker-deployment).

## Storage layout

Unless overridden, persistent application data is kept in the repository:

| Location | Contents |
|---|---|
| `.sciencediscovery-data/` (`SCIENCE_DISCOVERY_DATA_DIR`) | All runtime state; back it up as a unit |
| `.sciencediscovery-data/catalog.sqlite` | Projects, sessions, settings, model configuration, permissions, and specialists; legacy `catalog.json` is imported |
| `.sciencediscovery-data/mcp-result-cache.sqlite` | MCP result cache |
| `.sciencediscovery-data/web-cache.sqlite`, `.sciencediscovery-data/web-audit.sqlite` | Web cache and `WebInvocation` audit |
| `.sciencediscovery-data/model-secrets.key` | Owner-readable AES-256-GCM key for provider tokens |
| `.sciencediscovery-data/projects/<project-id>/sessions/<session-id>/workspace/` | Per-session uploaded/generated files and `papers/<paper-id>/` extraction results |
| `.sciencediscovery-data/cas/`, `execution-runs/`, `prompt-manifests/`, `reviews/`, `messages/` | Content-addressed blobs, execution records, prompt manifests, reviews, and chat |
| `.sciencediscovery-data/claims/`, `evidence-items/`, `evidence-links/`, `mcp-invocations/`, `artifact-derivations/` | Claim/evidence provenance and MCP audit |
| `.sciencediscovery-data/session-runs/`, `run-events/<session>/<run>/main.jsonl` plus tool/subagent streams, `model-usage/`, `connector-invocations/` | Run records, lossless append-only timelines, usage, and connector audit |
| `.sciencediscovery-data/artifact-plans/`, `artifact-jobs/`, `artifact-extraction-jobs/` | Download and PDF-extraction job state |
| `.sciencediscovery-data/scientific-envs/`, `runner-runtime/` | Managed environments and runner temporary state |
| `.sciencediscovery-data/skills/` | Managed skill packages and revisions |
| `.sciencediscovery-data/envs/paper/`, `.sciencediscovery-data/envs/gateway/` | Rebuildable uv service environments |
| `.sciencediscovery-data/logs/{api,run,gateway,runner,memory-graph}.log` | Rotating category logs; Science Memory exists only when enabled |
| Browser local storage | API bearer token only; model credentials never leave the backend |

The data directory is the only runtime root. `SCIENCE_DISCOVERY_DATA_DIR=/srv/science-discovery ./scripts/run-local.sh` moves state and service environments together. The former `SCIENCE_AGENT_DATA_DIR` is still read as a compatibility fallback and produces a log; when both are set, `SCIENCE_DISCOVERY_DATA_DIR` wins and the choice is logged. For the repository launcher, an existing default `data` directory is moved once into `.sciencediscovery-data`. For the single-file launcher, an existing default `./science-discovery-data` or the older `./science-agent-data` is imported once into `./.sciencediscovery-data`, newest first; an existing target is never overwritten and the skip is logged. Deleting the active data directory removes projects, sessions, credentials, and audit records. Under [Docker deployment](../how-to/deployment.md#docker-deployment), it is the host `./data` bind mount; only service `envs/` live in the image. `services/paper/.venv` and `services/gateway/.venv` are used only by standalone development or smoke commands.

The single-file payload overrides follow the same naming and precedence rule: use `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR` for the extraction cache or `SCIENCE_DISCOVERY_PAYLOAD_DIR` for a pre-extracted payload. The corresponding `SCIENCE_AGENT_*` names remain logged compatibility fallbacks.
