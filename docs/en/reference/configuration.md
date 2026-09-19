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
| `SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS` | `10` | Maximum concurrency for explicitly parallel-safe tool calls in one Agent step; positive integer, and `1` makes tool execution serial |
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
| `SCIENCE_AGENT_MEMORY_GRAPH_BACKEND` | `local` | Storage backend the memory-graph service starts with (`local` or `neo4j`); the API overrides it from System Settings → Memory |
| `SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR` | `~/.science-agent/memory-graph` | Where the local backend keeps `nodes.jsonl` and `edges.jsonl` |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `0` | Initial sandbox wall-clock timeout (`0` is unlimited) |
| `SCIENCE_AGENT_MAX_WORKSPACE_BYTES` | `10737418240` (10 GiB) | Runner workspace quota (`0` is unlimited); also seeds system settings |
| `SCIENCE_AGENT_MAX_OUTPUT_BYTES` | `1073741824` (1 GiB) | Retained stdout+stderr per execution; excess is truncated (`0` disables truncation) |
| `SCIENCE_AGENT_WORKSPACE_MAX_BYTES` | `10737418240` (10 GiB) | API cumulative upload-workspace limit |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_FILE_BYTES` | `1073741824` (1 GiB) | API per-uploaded-file limit, independent of runner output |
| `SCIENCE_AGENT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES` | `10737418240` (10 GiB) | API multipart request limit |
| `SCIENCE_AGENT_PERMISSION_WAIT_TIMEOUT_MS` | `0` | Initial permission-decision timeout (`0` is unlimited) |
| `SCIENTIFIC_ENVS` | `1` | Expose managed Python/R and persistent kernels; runner can start before setup completes |
| `SCIENCE_AGENT_PROVISIONER_PATH` | — | Optional administrator provisioner override |
| `SCIENCE_AGENT_MICROMAMBA_BASE_URL` | — | Optional mirror directory URL serving the pinned micromamba release under the same file names; empty uses the upstream release host. The pinned SHA-256 is enforced wherever the file comes from |
| `SCIENCE_AGENT_NPU_PYTHON_PATH` | auto-detected | Host Python used to read NPU state through the driver's DCMI interface; empty tries `/usr/bin/python3` then `/usr/local/bin/python3`, and falls back to `npu-smi` when neither works |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | — | Optional pre-populated offline cache; source safety checks still apply |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | Comma-separated allowed channels; built-in TUNA/USTC presets are always recognized |
| `SCIENCE_AGENT_KERNEL_IDLE_MS` | `0` | Initial persistent-kernel idle timeout (`0` is unlimited) |
| `SCIENCE_AGENT_WEB_DIR` | `apps/web/dist` | Static UI assets |
| `SCIENCE_AGENT_PAPER_PYTHON_PATH` | `<data-dir>/envs/paper/bin/python` | PDF-worker Python |
| `SCIENCE_AGENT_PAPER_WORKER_PATH` | `services/paper/paper_worker.py` | PDF-worker entry point |

The Ascend NPU Broker is for deployments that need host Ascend devices, and administrators must enable it explicitly. Keep `SCIENCE_AGENT_NPU_BROKER=0` when the host has no Ascend NPU, lacks CANN/MindSpore, or should not expose NPU jobs to the Agent; then `run_npu_job` is absent from the tool table. Enabling it does not change the normal local-mode startup command. Before enabling the Broker, create and verify at least one ScienceDiscovery managed scientific environment with Python that can import the required CANN/MindSpore stack. For built-in NPU workloads, including `npu.smoke_test`, select `environment_id` from `environment_list`; when omitted, the API resolves the Session-selected environment. The API selects that environment's latest Revision for the Broker's internal execution/audit receipt. The Agent cannot select a historical revision: `environment_revision_id` is rejected. When `SCIENCE_AGENT_NPU_WORKLOAD_CONFIG` is empty, the built-in allowlist currently contains `npu.smoke_test` and `antibody.protenix.v1`. Add models through a custom JSON allowlist with fixed entry points, not arbitrary Agent-supplied commands. `SCIENCE_AGENT_NPU_PYTHON` is kept only for custom allowlists that explicitly use `${python}`; the built-in allowlist uses `${managedPython}` and ignores it. Changing the allowlist is equivalent to changing executable host-code entry points and should be reviewed as a deployment change. Model weights, databases, HMMER, CANN, MindScience checkouts, and similar site assets stay outside the repository and are normally referenced through the environment variables or workload configuration above.

The browser stores only the local service access token in local storage. Model credentials stay in backend storage.

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

Compose reads the root `.env` (template: `.env.docker.example`) and interpolates the keys below into `docker-compose.yml`. They form two layers: the orchestration layer only affects how Compose starts the container; the container layer is forwarded into the container, key by key, through the service's `environment` block, and an empty value means the built-in default. Procedures and the layering are explained under [Docker deployment](../how-to/deployment.md#docker-deployment).

### Orchestration layer

| Variable | Default | Purpose |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | current directory name | Prefix of the container and default network names; what keeps several instances apart, equivalent to `docker compose -p` |
| `SCIENCE_AGENT_IMAGE` | `sciencediscovery:local` | Image tag that is built and run |
| `SCIENCE_AGENT_DATA_HOST_DIR` | `./data` | Host directory bind-mounted at `/app/data`; create it first |
| `SCIENCE_AGENT_UID` / `SCIENCE_AGENT_GID` | `1000` | Container uid/gid; must be able to write the host data directory |
| `SCIENCE_AGENT_PUBLISH_HOST` | `127.0.0.1` | Host interface publishing the UI/API |
| `SCIENCE_AGENT_PUBLISH_PORT` | `4310` | Host port mapped to container `4310` |

### Container layer

| Variable | Default | Purpose |
|---|---|---|
| `SCIENCE_AGENT_AUTH_TOKEN` | generated on first start | Browser/API bearer token; unset means the value stored in `/app/data/secrets/auth-token` (`./data/secrets/auth-token` on the host) |
| `SCIENCE_AGENT_LOG_LEVEL` | `INFO` | Operational log threshold (`DEBUG` / `INFO` / `WARNING` / `ERROR`) |
| `SCIENCE_AGENT_LOG_DIR` | `/app/data/logs` | Log directory; the default keeps logs inside the data directory |
| `SCIENCE_AGENT_LOG_MAX_BYTES` | `10485760` | Maximum bytes per log category before rotation |
| `SCIENCE_AGENT_LOG_BACKUP_COUNT` | `5` | Rotated files kept per category |
| `SCIENCE_AGENT_CONTEXT_MODE` | `dynamic` | Context-assembly mode; `legacy` and `shadow` exist for debugging and regression comparison |
| `SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS`, `…_SECTION_MAX_CHARS`, `…_DATA_BUDGET_CHARS`, `…_ATTACHMENT_MAX_CHARS`, `…_CONTRIBUTED_MESSAGE_BUDGET_CHARS`, `…_MAX_CONTRIBUTED_MESSAGES`, `…_WINDOW_MESSAGES`, `…_WINDOW_ROUNDS`, `…_WINDOW_TOKENS` | see `.env.docker.example` | Context-assembly budgets and windows; see [Context assembly](../../architecture/context-assembly.md) |
| `SCIENCE_AGENT_CONTEXT_TRACE` / `SCIENCE_AGENT_CONTEXT_TRACE_DIR` | `0` / `/app/data/context-traces` | Context-assembly tracing switch and output directory |
| `SCIENCE_AGENT_RUNNER_TOKEN` | `sciencediscovery-runner-local` | API-to-runner token on container loopback |
| `SCIENTIFIC_ENVS` | `1` | Managed Python/R environments and persistent kernels; the first start creates the starter Python automatically |
| `SCIENCE_AGENT_EXEC_TIMEOUT_MS` | `7200000` | Sandbox wall-clock timeout |
| `SCIENCE_AGENT_KERNEL_IDLE_MS` | `1800000` | Persistent-kernel idle timeout (minimum 1000 ms) |
| `SCIENCE_AGENT_SCIENTIFIC_CHANNELS` | `conda-forge` | Comma-separated channel allowlist |
| `SCIENCE_AGENT_PROVISIONER_PATH` | — | Optional administrator micromamba path; empty uses the verified copy baked into the image and seeded into the data directory |
| `SCIENCE_AGENT_PACKAGE_CACHE_DIR` | — | Optional pre-populated offline cache |
| `SCIENCE_AGENT_BWRAP_PATH` | `/usr/bin/bwrap` | Bubblewrap in the image |
| `SCIENCE_AGENT_SSH_CONFIG_PATH` | — | SSH configuration for remote runners (a container path); files under host `./data/ssh` are already visible at `/app/data/ssh` |
| `SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED` | `true` | Enables usage-dashboard display currency conversion; disabled keeps each model's original estimate currency |
| `SCIENCE_AGENT_USAGE_EXCHANGE_RATE_URL` | `https://api.frankfurter.dev/v2/rate/USD/CNY` | USD/CNY source for the usage dashboard; default is no-key Frankfurter; custom URLs are labeled by their host |
| `SCIENCE_AGENT_USAGE_EXCHANGE_RATE_TTL_MS` | `21600000` | Usage-dashboard exchange-rate cache TTL; defaults to 6 hours |
| `SCIENCE_AGENT_USAGE_EXCHANGE_RATE_TIMEOUT_MS` | `2500` | Usage-dashboard exchange-rate request timeout |

Values fixed in the image are not changed through `.env`: `SCIENCE_AGENT_DATA_DIR=/app/data`, `SCIENCE_AGENT_HOST=0.0.0.0`, `SCIENCE_AGENT_PORT=4310`, `SCIENCE_AGENT_RUNNER_HOST=127.0.0.1`, `SCIENCE_AGENT_RUNNER_PORT=4311`, `SCIENCE_AGENT_RUNNER_URL`, and the paths of the baked Python environments, the model catalog snapshot, and the micromamba seed. The API listens on `0.0.0.0:4310` **inside the container**, while runner `4311` remains on container loopback; only the API port is published. Local mode's `SCIENCE_AGENT_MICROMAMBA_BASE_URL` is not needed under Docker: the image carries and seeds the pinned micromamba, so nothing is downloaded at run time. Other local-mode variables (such as `HTTP_PROXY`) are not forwarded; add them to the service's `environment` block in a `docker-compose.override.yml` when needed.

## Storage layout

Unless overridden, persistent application data is kept in the repository:

| Location | Contents |
|---|---|
| `.sciencediscovery-data/` (`SCIENCE_DISCOVERY_DATA_DIR`) | All runtime state; back it up as a unit |
| `.sciencediscovery-data/catalog.sqlite` | Projects, sessions, settings, model configuration, permissions, and specialists; legacy `catalog.json` is imported |
| `.sciencediscovery-data/mcp-result-cache.sqlite` | MCP result cache |
| `.sciencediscovery-data/web-cache.sqlite`, `.sciencediscovery-data/web-audit.sqlite` | Web cache and `WebInvocation` audit |
| `.sciencediscovery-data/model-secrets.key` | Owner-readable AES-256-GCM key for provider tokens |
| `.sciencediscovery-data/exchange-rates/usage-display-rates.json` | Display exchange-rate cache for the usage dashboard; refresh failures can fall back to stale cache and the page labels stale-cache use |
| `.sciencediscovery-data/projects/<project-id>/sessions/<session-id>/workspace/` | Per-session uploaded/generated files and `papers/<paper-id>/` extraction results |
| `.sciencediscovery-data/cas/`, `execution-runs/`, `prompt-manifests/`, `reviews/`, `messages/` | Content-addressed blobs, execution records, prompt manifests, reviews, and chat |
| `.sciencediscovery-data/claims/`, `evidence-items/`, `evidence-links/`, `mcp-invocations/`, `artifact-derivations/` | Claim/evidence provenance and MCP audit |
| `.sciencediscovery-data/session-runs/`, `run-events/<session>/<run>/main.jsonl` plus tool/subagent streams, `model-usage/`, `connector-invocations/` | Run records, lossless append-only timelines, usage, and connector audit |
| `.sciencediscovery-data/artifact-plans/`, `artifact-jobs/`, `artifact-extraction-jobs/` | Download and PDF-extraction job state |
| `.sciencediscovery-data/scientific-envs/`, `runner-runtime/` | Managed environments and runner temporary state |
| `.sciencediscovery-data/skills/` | Managed skill packages and revisions |
| `.sciencediscovery-data/envs/paper/`, `.sciencediscovery-data/envs/gateway/` | Rebuildable uv service environments |
| `.sciencediscovery-data/logs/{api,run,gateway,runner,memory-graph}.log` | Rotating category logs; ScienceMemory exists only when enabled |
| Browser local storage | Local service access token only; model credentials never leave the backend |

The data directory is the only runtime root. `SCIENCE_DISCOVERY_DATA_DIR=/srv/science-discovery ./scripts/run-local.sh` moves state and service environments together. The former `SCIENCE_AGENT_DATA_DIR` is still read as a compatibility fallback and produces a log; when both are set, `SCIENCE_DISCOVERY_DATA_DIR` wins and the choice is logged. For the repository launcher, an existing default `data` directory is moved once into `.sciencediscovery-data`. For the single-file launcher, an existing default `./science-discovery-data` or the older `./science-agent-data` is imported once into `./.sciencediscovery-data`, newest first; an existing target is never overwritten and the skip is logged. Deleting the active data directory removes projects, sessions, credentials, and audit records. Under [Docker deployment](../how-to/deployment.md#docker-deployment), it is the host `./data` bind mount; only service `envs/` live in the image. `services/paper/.venv` and `services/gateway/.venv` are used only by standalone development or smoke commands.

The single-file payload overrides follow the same naming and precedence rule: use `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR` for the extraction cache or `SCIENCE_DISCOVERY_PAYLOAD_DIR` for a pre-extracted payload. The corresponding `SCIENCE_AGENT_*` names remain logged compatibility fallbacks.
