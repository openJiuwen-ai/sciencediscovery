#!/usr/bin/env bash
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Shared ScienceDiscovery stack launcher.
# Local mode provisions host dependencies as needed; Docker mode only validates
# its prebuilt image and bind-mounted runtime paths. Both modes reuse the same
# process ordering, health waits, and shutdown handling.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/start-stack.sh --mode local|docker [--no-build]

  --mode local    read .env, optionally install/build, and use data/envs
  --mode docker   use the prebuilt image environments and container checks
  --no-build      skip install/build work (implicit in docker mode)
EOF
}

mode=""
mode_seen=0
no_build=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ "$#" -lt 2 ]]; then
        echo "--mode requires local or docker." >&2
        exit 2
      fi
      if [[ "$mode_seen" -eq 1 ]]; then
        echo "--mode may only be specified once." >&2
        exit 2
      fi
      mode="$2"
      mode_seen=1
      shift 2
      ;;
    --mode=*)
      if [[ "$mode_seen" -eq 1 ]]; then
        echo "--mode may only be specified once." >&2
        exit 2
      fi
      mode="${1#--mode=}"
      mode_seen=1
      shift
      ;;
    --no-build)
      no_build=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$mode" != "local" && "$mode" != "docker" ]]; then
  echo "--mode must be local or docker." >&2
  usage >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repository_root"

pids=()
health_attempts=50
gateway_python=""
memory_graph_python=""
runner_url=""
data_dir=""
runner_command=()
api_command=()
api_foreground=0

cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]:-}"; do wait "$pid" 2>/dev/null || true; done
}

wait_healthy() { # <name> <url>
  local attempt
  for ((attempt = 1; attempt <= health_attempts; attempt++)); do
    if curl --silent --fail "$2" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "$1 did not become healthy at $2." >&2
  return 1
}

require_command() { # <command> <failure message>
  command -v "$1" >/dev/null || { echo "$2" >&2; exit 1; }
}

# The repository default moved from `data` to `.sciencediscovery-data`. Move an
# existing default once so a checkout keeps its projects, tokens and service
# environments, and never replace a directory that already exists.
migrate_legacy_data_dir() { # <target-data-dir>
  local target="$1"
  local legacy="$repository_root/data"
  [[ -n "${SCIENCE_DISCOVERY_DATA_DIR:-}" ]] && return 0
  [[ -e "$legacy" ]] || return 0
  if [[ ! -d "$legacy" ]]; then
    echo "[compat] Skipped moving legacy data directory $legacy to $target: source is not a directory." >&2
    return 0
  fi
  if [[ -e "$target" ]]; then
    echo "[compat] Skipped moving legacy data directory $legacy to $target: target already exists." >&2
    return 0
  fi
  mv "$legacy" "$target"
  echo "[compat] Moved legacy data directory $legacy to $target." >&2
}

absolute_from_repository() { # <path>
  if [[ "$1" == /* ]]; then
    printf '%s\n' "$1"
  else
    printf '%s/%s\n' "$repository_root" "$1"
  fi
}

configure_endpoints() {
  local runner_host="${SCIENCE_AGENT_RUNNER_HOST:-127.0.0.1}"
  local runner_port="${SCIENCE_AGENT_RUNNER_PORT:-4311}"
  runner_url="${SCIENCE_AGENT_RUNNER_URL:-http://$runner_host:$runner_port}"
}

# Sync one uv project into its service environment. With a custom PyPI index
# (SCIENCE_AGENT_PYPI_INDEX), `--locked` fails and uv re-resolves because
# uv.lock records index URLs; back up and restore the checked-in lockfile so
# the mirror never dirties the working tree.
uv_sync_project() { # <project-dir> <env-dir> <locked: 0|1>
  local project_dir="$1" env_dir="$2" locked="$3"
  if [[ -n "${SCIENCE_AGENT_PYPI_INDEX:-}" ]]; then
    cp "$project_dir/uv.lock" "$project_dir/uv.lock.stack-backup"
    local sync_failed=0
    (cd "$project_dir" && UV_PROJECT_ENVIRONMENT="$env_dir" uv sync) || sync_failed=1
    mv "$project_dir/uv.lock.stack-backup" "$project_dir/uv.lock"
    [[ "$sync_failed" -eq 0 ]]
  elif [[ "$locked" -eq 1 ]]; then
    (cd "$project_dir" && UV_PROJECT_ENVIRONMENT="$env_dir" uv sync --locked)
  else
    (cd "$project_dir" && UV_PROJECT_ENVIRONMENT="$env_dir" uv sync)
  fi
}

prepare_local() {
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi

  if [[ -n "${SCIENCE_DISCOVERY_DATA_DIR:-}" ]]; then
    if [[ -n "${SCIENCE_AGENT_DATA_DIR:-}" ]]; then
      echo "[compat] Both SCIENCE_DISCOVERY_DATA_DIR and SCIENCE_AGENT_DATA_DIR are set; SCIENCE_DISCOVERY_DATA_DIR takes precedence." >&2
    fi
    SCIENCE_AGENT_DATA_DIR="$SCIENCE_DISCOVERY_DATA_DIR"
    export SCIENCE_AGENT_DATA_DIR
  elif [[ -n "${SCIENCE_AGENT_DATA_DIR:-}" ]]; then
    echo "[compat] SCIENCE_AGENT_DATA_DIR is deprecated; using its value as SCIENCE_DISCOVERY_DATA_DIR." >&2
    SCIENCE_DISCOVERY_DATA_DIR="$SCIENCE_AGENT_DATA_DIR"
    export SCIENCE_DISCOVERY_DATA_DIR
  fi

  require_command node "Node.js 22.19+ is required."
  require_command pnpm "pnpm 11.1.2 is required."
  require_command python3 "Python 3 is required for workspace analysis."
  require_command uv "uv 0.9+ is required for the Python service environments."
  require_command bwrap "bubblewrap is required for isolated Python execution."
  require_command curl "curl is required for local service startup checks."

  data_dir="$(absolute_from_repository "${SCIENCE_DISCOVERY_DATA_DIR:-.sciencediscovery-data}")"
  migrate_legacy_data_dir "$data_dir"
  local envs_dir="$data_dir/envs"

  if [[ "$no_build" -eq 0 ]]; then
    # Optional package mirrors, scoped to this script's install commands only
    # (never written to user/global npm or uv config). Example (Huawei Cloud):
    #   SCIENCE_AGENT_NPM_REGISTRY=https://mirrors.huaweicloud.com/repository/npm/
    #   SCIENCE_AGENT_PYPI_INDEX=https://mirrors.huaweicloud.com/repository/pypi/simple
    local pnpm_registry_args=()
    if [[ -n "${SCIENCE_AGENT_NPM_REGISTRY:-}" ]]; then
      pnpm_registry_args=(--registry "$SCIENCE_AGENT_NPM_REGISTRY")
    fi
    if [[ -n "${SCIENCE_AGENT_PYPI_INDEX:-}" ]]; then
      export UV_DEFAULT_INDEX="$SCIENCE_AGENT_PYPI_INDEX"
    fi
    if [[ ! -d node_modules ]]; then
      pnpm install --frozen-lockfile --ignore-scripts "${pnpm_registry_args[@]}"
    fi
    uv_sync_project services/paper "$envs_dir/paper" 1
    # Pinned to Python 3.12 via services/gateway/.python-version.
    uv_sync_project services/gateway "$envs_dir/gateway" 0
    pnpm build
  fi

  # Same two locations `resolveMcpPython()` knows about, in the same order, so
  # a standalone `uv sync` in services/gateway is also a usable interpreter.
  gateway_python="$envs_dir/gateway/bin/python"
  if [[ ! -x "$gateway_python" && -x "$repository_root/services/gateway/.venv/bin/python" ]]; then
    gateway_python="$repository_root/services/gateway/.venv/bin/python"
  fi
  if [[ ! -x "$gateway_python" ]]; then
    echo "$envs_dir/gateway is missing (needed for the bundled Python MCP servers). Run without --no-build once to provision it." >&2
    exit 1
  fi

  # Provision the memory-graph Python sidecar environment unconditionally.
  # It is small (~38 MB, fastapi/uvicorn/neo4j driver/pydantic) and the
  # feature toggle now lives in System Settings → Memory graph, not env, so
  # the environment must be ready for the user to flip the switch without a
  # rebuild. Docker mode leaves this unset because the image does not
  # provision that service environment.
  memory_graph_python="$envs_dir/memory-graph/bin/python"
  if [[ ! -x "$memory_graph_python" ]]; then
    echo "Provisioning the memory-graph Python environment..." >&2
    (cd services/memory-graph && UV_PROJECT_ENVIRONMENT="$envs_dir/memory-graph" uv sync)
  fi

  local runner_environment=(
    "SCIENCE_AGENT_BWRAP_PATH=${SCIENCE_AGENT_BWRAP_PATH:-bwrap}"
    "SCIENCE_AGENT_DATA_DIR=$data_dir"
    "SCIENCE_AGENT_RUNNER_HOST=${SCIENCE_AGENT_RUNNER_HOST:-127.0.0.1}"
    "SCIENCE_AGENT_RUNNER_PORT=${SCIENCE_AGENT_RUNNER_PORT:-4311}"
    "SCIENCE_AGENT_RUNNER_TOKEN=${SCIENCE_AGENT_RUNNER_TOKEN:-sciencediscovery-runner-local}"
    "SCIENTIFIC_ENVS=${SCIENTIFIC_ENVS:-1}"
  )
  # Keep SCIENCE_AGENT_NPU_PYTHON passthrough for custom allowlists that still
  # use ${python}. Built-in NPU workloads resolve ${managedPython} from the
  # ScienceDiscovery managed scientific environment revision.
  local passthrough value
  for passthrough in SCIENCE_AGENT_PROVISIONER_PATH \
                     SCIENCE_AGENT_PACKAGE_CACHE_DIR SCIENCE_AGENT_SCIENTIFIC_CHANNELS \
                     SCIENCE_AGENT_KERNEL_IDLE_MS SCIENCE_AGENT_EXEC_TIMEOUT_MS \
                     SCIENCE_AGENT_NPU_BROKER SCIENCE_AGENT_NPU_WORKLOAD_CONFIG \
                     SCIENCE_AGENT_NPU_PYTHON \
                     SCIENCE_AGENT_NPU_SMOKE_SCRIPT SCIENCE_AGENT_NPU_PROTENIX_SCRIPT; do
    if [[ -n "${!passthrough:-}" ]]; then
      value="${!passthrough}"
      if [[ "$passthrough" == *_PATH || "$passthrough" == *_DIR ]]; then
        value="$(absolute_from_repository "$value")"
      fi
      runner_environment+=("$passthrough=$value")
    fi
  done
  # `pnpm api` runs the API with its own package directory as the working
  # directory, so the two settings the API otherwise resolves relative to the
  # process cwd would miss: the repository-root MCP registry, and the
  # interpreter for the bundled stdio MCP servers (biomed, UniProt), whose
  # fallback probes `data/envs/gateway/bin/python` and would degrade to a bare
  # `python` from PATH. Name both explicitly; an operator value still wins.
  export SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH="$(absolute_from_repository "${SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH:-extensions_config.json}")"
  export SCIENCE_AGENT_GATEWAY_PYTHON_PATH="${SCIENCE_AGENT_GATEWAY_PYTHON_PATH:-$gateway_python}"

  runner_command=(env "${runner_environment[@]}" node services/runner/dist/server.js)
  api_command=(pnpm api)
  api_foreground=1
  health_attempts=50
}

prepare_docker() {
  local envs_root="${SCIENCE_AGENT_ENVS_ROOT:-/opt/sciencediscovery/envs}"
  gateway_python="${SCIENCE_AGENT_GATEWAY_PYTHON_PATH:-$envs_root/gateway/bin/python}"

  data_dir="${SCIENCE_AGENT_DATA_DIR:-/app/data}"
  data_dir="$(absolute_from_repository "$data_dir")"
  export SCIENCE_AGENT_DATA_DIR="$data_dir"

  # A uid/gid mismatch on the host bind mount is the most common first-run
  # failure. Report it before any service starts.
  mkdir -p "$data_dir" 2>/dev/null || true
  if [[ ! -w "$data_dir" ]]; then
    cat >&2 <<EOF
The data directory $data_dir is not writable by uid $(id -u), gid $(id -g).

It is bind-mounted from the host (./data by default). Either chown the host
directory to those ids, or set SCIENCE_AGENT_UID / SCIENCE_AGENT_GID in .env to
your own ids (id -u / id -g) and recreate the container.
EOF
    exit 1
  fi

  # The image carries a build-time verified micromamba outside /app/data. Seed
  # a fresh bind mount unless an administrator path explicitly overrides it.
  "$script_dir/seed-managed-micromamba.sh" "$data_dir"

  local package_cache_dir="${SCIENCE_AGENT_PACKAGE_CACHE_DIR:-}"
  if [[ -n "$package_cache_dir" ]]; then
    package_cache_dir="$(absolute_from_repository "$package_cache_dir")"
    if ! mkdir -p "$package_cache_dir"; then
      echo "The scientific package cache directory $package_cache_dir could not be created." >&2
      exit 1
    fi
    export SCIENCE_AGENT_PACKAGE_CACHE_DIR="$package_cache_dir"
  fi

  if [[ -z "${HOME:-}" || ! -w "${HOME:-/}" ]]; then
    HOME="$data_dir/.home"
    mkdir -p "$HOME"
    export HOME
  fi

  if [[ ! -x "$gateway_python" ]]; then
    echo "The Python MCP server environment is missing at $gateway_python. Rebuild the image." >&2
    exit 1
  fi

  # This is an early warning for host/container user-namespace restrictions,
  # not a replacement for the runner's full sandbox argument validation.
  if ! "${SCIENCE_AGENT_BWRAP_PATH:-bwrap}" \
        --unshare-all --unshare-user --die-with-parent \
        --ro-bind /usr /usr \
        --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
        /usr/bin/true >/dev/null 2>&1; then
    cat >&2 <<'EOF'
WARNING: bubblewrap cannot create a sandbox in this container. run_python /
run_shell will fail; the API and UI are unaffected. Check that the Compose
service keeps security_opt seccomp=unconfined and apparmor=unconfined, and that
the host allows unprivileged user namespaces:
  sysctl kernel.unprivileged_userns_clone            # 1 where the knob exists
  sysctl kernel.apparmor_restrict_unprivileged_userns # 0 on Ubuntu 24.04+
EOF
  fi
  runner_command=(node services/runner/dist/server.js)
  api_command=(node services/api/dist/server.js)
  api_foreground=0
  health_attempts=300
}

start_stack() {
  configure_endpoints
  trap cleanup EXIT INT TERM

  echo "Starting the bubblewrap runner daemon (rootless)..." >&2
  "${runner_command[@]}" &
  pids+=("$!")
  wait_healthy "runner" "$runner_url/health"

  # Start the memory-graph sidecar unconditionally. The System Settings
  # toggle gates whether the API actually mirrors reads/writes; the sidecar
  # idles cheaply when the toggle is off and never blocks chat. The Bolt URI
  # below is the sidecar's pre-push default only — the API pushes the real
  # Bolt/user/password (from System Settings → Memory graph) over the loopback,
  # Bearer-protected endpoint, so the plaintext credentials never live in this
  # process's env. Business events use the service's size-rotated operational
  # logger; uvicorn startup/shutdown output remains on the process console.
  if [[ -x "$memory_graph_python" ]]; then
    echo "Starting the memory-graph service..." >&2
    SCIENCE_AGENT_DATA_DIR="$data_dir" \
    SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP="${SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP:-http://127.0.0.1:7474}" \
    SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN="${SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN:-sciencediscovery-memory-graph-local}" \
    "$memory_graph_python" -m sciencediscovery_memory_graph.server &
    pids+=("$!")
    wait_healthy "memory-graph" "http://127.0.0.1:17674/health"
  fi

  echo "Starting the control API..." >&2
  if [[ "$api_foreground" -eq 1 ]]; then
    "${api_command[@]}"
    return
  fi

  "${api_command[@]}" &
  pids+=("$!")

  # Any Docker process exiting means the single-container stack is broken.
  set +e
  wait -n
  local status=$?
  set -e
  echo "A ScienceDiscovery process exited with status $status; stopping the stack." >&2
  return "$status"
}

case "$mode" in
  local) prepare_local ;;
  docker) prepare_docker ;;
esac
start_stack
