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
#
# The agent loop runs on JiuwenSwarm in packaged and Docker deployments (see
# docs/en/getting-started/deployment.md):
# in local mode, install it once with `scripts/jiuwenswarm.sh setup`, then pass
# --jiuwenswarm below.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/start-stack.sh --mode local --jiuwenswarm [--no-build] [--no-node-build]
       ./scripts/start-stack.sh --mode docker [--no-jiuwenswarm] [--no-build]

  --mode local    read .env, optionally install/build, and use data/envs
                  (native loop by default; --jiuwenswarm opts in)
  --mode docker   use the prebuilt image environments and container checks
                  (JiuwenSwarm by default, since the image always bakes it
                  in; --no-jiuwenswarm opts out)
  --no-build      skip install/build work (implicit in docker mode)
  --no-node-build skip only the Node install/build; still provision the Python
                  service environments, whose editable installs record absolute
                  paths and cannot be prepared elsewhere
  --jiuwenswarm   run agent turns on JiuwenSwarm: puts the adapter in front of
                  the API (SCIENCE_AGENT_ADAPTER=1), selects the executor
                  (SCIENCE_AGENT_EXECUTOR=jiuwenswarm) and starts the
                  JiuwenSwarm instance if it is not already running. In local
                  mode, install JiuwenSwarm once with scripts/jiuwenswarm.sh
                  setup first; the Docker image bakes it in and already
                  defaults to it, so this flag is redundant there — first
                  start still creates the instance under the bind-mounted
                  data directory. See docs/en/getting-started/deployment.md.
  --no-jiuwenswarm
                  run agent turns on the native loop instead. Only meaningful
                  in Docker mode, where it overrides the default; local mode
                  is already native unless --jiuwenswarm is passed. Also
                  settable as SCIENCE_AGENT_EXECUTOR=native.

Environment:
  SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS
                  seconds to wait for each service's health endpoint, replacing
                  the mode's default (10s local, 60s docker). Raise it on a slow
                  or emulated host.
EOF
}

mode=""
mode_seen=0
no_build=0
no_node_build=0
use_jiuwenswarm=0
# Tracks whether the operator made a deliberate choice (flag or a
# pre-set SCIENCE_AGENT_EXECUTOR), so the Docker-mode default below never
# overwrites one.
jiuwenswarm_explicit=0
[[ -n "${SCIENCE_AGENT_EXECUTOR:-}" ]] && jiuwenswarm_explicit=1
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
    --no-node-build)
      no_node_build=1
      shift
      ;;
    --no-build)
      no_build=1
      shift
      ;;
    --jiuwenswarm)
      use_jiuwenswarm=1
      jiuwenswarm_explicit=1
      export SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm
      shift
      ;;
    --no-jiuwenswarm)
      use_jiuwenswarm=0
      jiuwenswarm_explicit=1
      unset SCIENCE_AGENT_ADAPTER SCIENCE_AGENT_EXECUTOR
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

# The Docker image bakes JiuwenSwarm and the adapter in unconditionally (see
# Dockerfile), so — unlike local mode, which stays on the native loop unless
# asked — Docker mode defaults to running on JiuwenSwarm too, the same
# default the release binary uses. --no-jiuwenswarm (or a pre-set
# SCIENCE_AGENT_EXECUTOR) opts back out.
if [[ "$mode" == "docker" && "$jiuwenswarm_explicit" -eq 0 ]]; then
  use_jiuwenswarm=1
  export SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repository_root"

pids=()
health_attempts=50
gateway_python=""
memory_graph_python=""
evolve_python=""
adapter_python=""
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
  # The poll interval is 0.2s, so the built-in budgets are 10s locally and 60s
  # under Docker -- both sized for a machine that runs at native speed. A cold
  # uvicorn import on an emulated CPU needs far more than that, and giving up
  # here does not just skip one sidecar: the failure trips `set -e` and cleanup
  # takes the whole stack down, so the caller only ever sees "never healthy".
  local attempts="$health_attempts"
  if [[ -n "${SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS:-}" ]]; then
    attempts=$((SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS * 5))
  fi
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --silent --fail "$2" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "$1 did not become healthy at $2 after $((attempts / 5))s." >&2
  return 1
}

# A missing dependency is the first thing a new user meets, so the report says
# what is missing, what was found, and one concrete way to fix it — the same
# shape the binary launcher already prints for bubblewrap (BWRAP_INSTALL_HINT in
# services/launcher/src/preflight.ts). Problems are collected rather than
# fatal on sight: a bare host learns everything it needs from one run instead
# of discovering the list one failed start at a time.
dependency_problems=()

note_dependency_problem() { # <headline> <remedy line>...
  local entry="$1"
  shift
  local line
  for line in "$@"; do entry+=$'\n'"    $line"; done
  dependency_problems+=("$entry")
}

# Records rather than exits, so `set -e` call sites stay plain statements and
# every missing dependency reaches the same report.
require_command() { # <command> <headline> <remedy line>...
  command -v "$1" >/dev/null && return 0
  shift
  note_dependency_problem "$@"
}

report_dependency_problems() {
  [[ "${#dependency_problems[@]}" -eq 0 ]] && return 0
  {
    echo "ScienceDiscovery cannot start from source: ${#dependency_problems[@]} host dependency problem(s)."
    echo
    local problem
    for problem in "${dependency_problems[@]}"; do
      echo "  - $problem"
      echo
    done
    echo "  Requirements table: README.md#requirements"
    echo "  Local source mode:  docs/en/how-to/deployment.md#local-mode-host-processes"
  } >&2
  exit 1
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

  require_command node \
    "Node.js 22.19+ is required for the control API and the runner, but no 'node' is on PATH." \
    "Install it with a version manager (nvm install 22) or your distribution's nodejs package."
  if command -v node >/dev/null && ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
    note_dependency_problem \
      "Node.js 22.19+ is required; found $(node --version)." \
      "Upgrade it, for example: nvm install 22 && nvm use 22"
  fi
  require_command pnpm \
    "pnpm 11.1.2 is required to install and build the workspace, but no 'pnpm' is on PATH." \
    "Enable it through the bundled corepack: corepack enable && corepack prepare pnpm@11.1.2 --activate" \
    "Or install it globally: npm install -g pnpm@11.1.2"
  require_command python3 \
    "Python 3 is required for workspace analysis, but no 'python3' is on PATH." \
    "Install your distribution's python3 package (Debian/Ubuntu: sudo apt-get install -y python3)."
  require_command uv \
    "uv 0.9+ is required to build the Python service environments, but no 'uv' is on PATH." \
    "Install it: curl -LsSf https://astral.sh/uv/install.sh | sh" \
    "It is needed only for source mode; the prepackaged binary fetches its own."
  require_command curl \
    "curl is required for the local service startup checks, but no 'curl' is on PATH." \
    "Install your distribution's curl package (Debian/Ubuntu: sudo apt-get install -y curl)."

  export SCIENCE_AGENT_PYTHON_PATH="${SCIENCE_AGENT_PYTHON_PATH:-$(command -v python3)}"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    export SCIENCE_AGENT_SHELL_PATH="${SCIENCE_AGENT_SHELL_PATH:-/bin/bash}"
  else
    export SCIENCE_AGENT_SHELL_PATH="${SCIENCE_AGENT_SHELL_PATH:-/usr/bin/bash}"
  fi

  local sandbox_provider="${SCIENCE_AGENT_SANDBOX_PROVIDER:-auto}"
  if [[ "$sandbox_provider" == "auto" ]]; then
    case "$(uname -s)" in
      Darwin) sandbox_provider="seatbelt" ;;
      Linux) sandbox_provider="bubblewrap" ;;
      *) echo "Native sandbox execution is unsupported on $(uname -s)." >&2; exit 1 ;;
    esac
  fi
  case "$sandbox_provider" in
    bubblewrap)
      # The package is called bubblewrap; the executable it installs is bwrap.
      # Naming only one of the two sends people searching for the wrong thing.
      require_command "${SCIENCE_AGENT_BWRAP_PATH:-bwrap}" \
        "bubblewrap is required for isolated Linux execution, but its 'bwrap' executable is not on PATH." \
        "Install the bubblewrap package — the binary it provides is named bwrap:" \
        "  Debian / Ubuntu   sudo apt-get install -y bubblewrap" \
        "  Fedora / RHEL     sudo dnf install -y bubblewrap" \
        "  openEuler         sudo dnf install -y bubblewrap" \
        "  Arch              sudo pacman -S bubblewrap" \
        "  Alpine            sudo apk add bubblewrap" \
        "Already installed elsewhere? Point SCIENCE_AGENT_BWRAP_PATH at it."
      ;;
    seatbelt)
      if [[ "$(uname -s)" != "Darwin" ]]; then
        echo "Seatbelt sandbox is available only on macOS." >&2
        exit 1
      fi
      require_command "${SCIENCE_AGENT_SEATBELT_PATH:-/usr/bin/sandbox-exec}" \
        "macOS Seatbelt is required for isolated execution, but sandbox-exec was not found." \
        "sandbox-exec ships with macOS, so this usually means the current terminal or a" \
        "parent sandbox is blocking it rather than something to install." \
        "See docs/en/how-to/deployment.md#local-mode-host-processes"
      ;;
    *) echo "SCIENCE_AGENT_SANDBOX_PROVIDER must be auto, bubblewrap, or seatbelt." >&2; exit 1 ;;
  esac

  report_dependency_problems

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
    # Always reconcile workspace links with the lockfile. A repository update
    # can add a workspace dependency while leaving an old node_modules folder
    # in place; checking only for the directory would then fail later at build
    # or API startup with ERR_MODULE_NOT_FOUND.
    if [[ "$no_node_build" -eq 0 ]]; then
      if [[ "${#pnpm_registry_args[@]}" -gt 0 ]]; then
        pnpm install --frozen-lockfile --ignore-scripts "${pnpm_registry_args[@]}"
      else
        pnpm install --frozen-lockfile --ignore-scripts
      fi
    fi
    uv_sync_project services/paper "$envs_dir/paper" 1
    # Pinned to Python 3.12 via services/gateway/.python-version.
    uv_sync_project services/gateway "$envs_dir/gateway" 0
    if [[ "$no_node_build" -eq 0 ]]; then
      pnpm build
      if [[ "$(uname -s)" == Linux ]]; then pnpm runner:binary; fi
    fi
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
  # rebuild. Docker bakes the same environment into the image.
  memory_graph_python="$envs_dir/memory-graph/bin/python"
  if [[ ! -x "$memory_graph_python" ]]; then
    echo "Provisioning the memory-graph Python environment..." >&2
    (cd services/memory-graph && UV_PROJECT_ENVIRONMENT="$envs_dir/memory-graph" uv sync)
  fi

  # Provision the evolve search sidecar environment. Same rationale as the
  # memory-graph one above: the feature is reached from the UI, so it must be
  # ready without a rebuild. Docker bakes the same environment into the image.
  #
  # `--extra candidates` installs the candidate's runtime, not the sidecar's: a
  # candidate is executed with this environment's interpreter, and the AST gate
  # admits pandas/numpy/scipy/sklearn. Without them every candidate fails with
  # ModuleNotFoundError. Set SCIENCE_AGENT_EVOLVE_STUB_ONLY=1 to skip the ~200MB
  # when only the stub engine will ever run.
  evolve_python="$envs_dir/evolve/bin/python"
  if [[ ! -x "$evolve_python" ]]; then
    echo "Provisioning the evolve Python environment..." >&2
    if [[ "${SCIENCE_AGENT_EVOLVE_STUB_ONLY:-0}" == "1" ]]; then
      (cd services/evolve && UV_PROJECT_ENVIRONMENT="$envs_dir/evolve" uv sync)
    else
      (cd services/evolve && UV_PROJECT_ENVIRONMENT="$envs_dir/evolve" uv sync --extra candidates)
    fi
  fi

  # Opt-in front door (SCIENCE_AGENT_ADAPTER=1): the Python adapter takes the
  # public port and proxies every route it has not migrated to the legacy API,
  # which moves to SCIENCE_AGENT_LEGACY_PORT (public port + 100 by default).
  if [[ "${SCIENCE_AGENT_ADAPTER:-0}" == "1" ]]; then
    adapter_python="$envs_dir/adapter/bin/python"
    if [[ ! -x "$adapter_python" ]]; then
      echo "Provisioning the adapter Python environment..." >&2
      (cd services/adapter && UV_PROJECT_ENVIRONMENT="$envs_dir/adapter" uv sync)
    fi
  fi

  local runner_environment=(
    "SCIENCE_AGENT_BWRAP_PATH=${SCIENCE_AGENT_BWRAP_PATH:-bwrap}"
    "SCIENCE_AGENT_SANDBOX_PROVIDER=$sandbox_provider"
    "SCIENCE_AGENT_SEATBELT_PATH=${SCIENCE_AGENT_SEATBELT_PATH:-/usr/bin/sandbox-exec}"
    "SCIENCE_AGENT_PYTHON_PATH=$SCIENCE_AGENT_PYTHON_PATH"
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
  memory_graph_python="${SCIENCE_AGENT_MEMORY_GRAPH_PYTHON_PATH:-$envs_root/memory-graph/bin/python}"
  evolve_python="${SCIENCE_AGENT_EVOLVE_PYTHON_PATH:-$envs_root/evolve/bin/python}"

  data_dir="${SCIENCE_AGENT_DATA_DIR:-/app/data}"
  data_dir="$(absolute_from_repository "$data_dir")"
  export SCIENCE_AGENT_DATA_DIR="$data_dir"

  # Opt-in front door (SCIENCE_AGENT_ADAPTER=1, set by --jiuwenswarm above):
  # same baked-environment convention as gateway_python, the adapter's own
  # venv the Dockerfile syncs into $envs_root/adapter.
  if [[ "${SCIENCE_AGENT_ADAPTER:-0}" == "1" ]]; then
    adapter_python="${SCIENCE_AGENT_ADAPTER_PYTHON_PATH:-$envs_root/adapter/bin/python}"
    if [[ ! -x "$adapter_python" ]]; then
      echo "The adapter Python environment is missing at $adapter_python. Rebuild the image." >&2
      exit 1
    fi
  fi

  # JiuwenSwarm's own venv is baked read-only under /opt (JIUWENSWARM_SRC,
  # set by the Dockerfile); only its instance state belongs on the persisted
  # volume, so JIUWENSWARM_ROOT points there instead of the image-relative
  # default scripts/jiuwenswarm.sh otherwise assumes.
  export JIUWENSWARM_ROOT="${JIUWENSWARM_ROOT:-$data_dir/jiuwenswarm}"

  # Docker includes the sidecar, while the System Settings toggle still
  # controls whether the API mirrors any application data into it.
  export SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE="${SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE:-1}"

  # Native JiuwenSwarm sub-agents do not receive ScienceDiscovery's workspace
  # or sandbox tools. In the product image use the task bridge so specialists
  # can actually inspect and hand back workspace results.
  export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS="${SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS:-task}"

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

  # JiuwenSwarm creates its instance workspace under $HOME/.jiuwenswarm-instances/
  # with no option to place it elsewhere (see scripts/jiuwenswarm.sh), so when
  # it is in play HOME is forced onto the persisted volume even if the
  # container's own HOME already happens to be writable: skills, permission
  # grants and conversation state need to survive a container recreation,
  # not just this one process.
  if [[ -z "${HOME:-}" || ! -w "${HOME:-/}" || "${SCIENCE_AGENT_ADAPTER:-0}" == "1" ]]; then
    HOME="$data_dir/.home"
    mkdir -p "$HOME"
    export HOME
  fi

  if [[ ! -x "$gateway_python" ]]; then
    echo "The Python MCP server environment is missing at $gateway_python. Rebuild the image." >&2
    exit 1
  fi
  if [[ ! -x "$memory_graph_python" ]]; then
    echo "The memory-graph Python environment is missing at $memory_graph_python. Rebuild the image." >&2
    exit 1
  fi
  if [[ ! -x "$evolve_python" ]]; then
    echo "The evolve Python environment is missing at $evolve_python. Rebuild the image." >&2
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
run_shell will fail; the API and UI are unaffected. Check, in this order:
  1. The Compose service still sets all three security_opt entries:
     seccomp=unconfined, apparmor=unconfined, systempaths=unconfined.
  2. The host AppArmor configuration. Ubuntu 24.04+ restricts unprivileged user
     namespaces per profile, so a host can allow them without changing a sysctl.
  3. Only then the kernel switches, which need root and do not persist:
       sysctl kernel.unprivileged_userns_clone             # 1 where the knob exists
       sysctl kernel.apparmor_restrict_unprivileged_userns # read with step 2, not alone
EOF
  fi
  runner_command=(node services/runner/dist/server.js)
  api_command=(node services/api/dist/server.js)
  api_foreground=0
  health_attempts=300
}

start_stack() {
  configure_endpoints
  # Explicit local composition seam for integration fixtures; the normal entry
  # point is unchanged. Never load this override in distributed Docker mode.
  if [[ -n "${SCIENCE_AGENT_API_ENTRYPOINT:-}" ]]; then
    [[ "$mode" == "local" && -f "$SCIENCE_AGENT_API_ENTRYPOINT" ]] || {
      echo "SCIENCE_AGENT_API_ENTRYPOINT requires a local existing module" >&2; exit 2;
    }
    api_command=(node "$SCIENCE_AGENT_API_ENTRYPOINT")
  fi
  trap cleanup EXIT INT TERM

  echo "Starting the sandbox runner daemon..." >&2
  "${runner_command[@]}" &
  pids+=("$!")
  wait_healthy "runner" "$runner_url/health"

  # Start the memory-graph sidecar when the feature is available. An explicit
  # SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE=0 keeps isolated test stacks from
  # starting the service. The System Settings toggle controls application
  # reads and writes when the service is available. The Neo4j HTTP
  # URI below is the sidecar's pre-push default only — the API pushes the real
  # Neo4j HTTP URI/user/password (from System Settings → Memory graph) over the
  # loopback, Bearer-protected endpoint, so the plaintext credentials never
  # live in this process's env. Business events use the service's size-rotated
  # operational logger; uvicorn startup/shutdown output remains on the process
  # console.
  if [[ "${SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE:-1}" != "0" && -x "$memory_graph_python" ]]; then
    echo "Starting the memory-graph service..." >&2
    SCIENCE_AGENT_DATA_DIR="$data_dir" \
    SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP="${SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP:-http://127.0.0.1:7474}" \
    SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN="${SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN:-sciencediscovery-memory-graph-local}" \
    "$memory_graph_python" -m sciencediscovery_memory_graph.server &
    pids+=("$!")
    wait_healthy "memory-graph" "http://127.0.0.1:${SCIENCE_AGENT_MEMORY_GRAPH_PORT:-17674}/health"
  fi

  # Start the evolve search sidecar. It holds no persistent business state and
  # never sees a model key: model calls go back through the API's loopback
  # proxy with a one-shot run token, and everything needed to replay or resume
  # a run lives in the API's data/evolution/runs/<runId>/events.ndjson.
  if [[ -x "$evolve_python" ]]; then
    echo "Starting the evolve service..." >&2
    SCIENCE_AGENT_DATA_DIR="$data_dir" \
    SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN="${SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN:-sciencediscovery-evolve-local}" \
    "$evolve_python" -m sciencediscovery_evolve.server &
    pids+=("$!")
    wait_healthy "evolve" "http://127.0.0.1:${SCIENCE_AGENT_EVOLVE_PORT:-4313}/health"
  fi

  if [[ "${SCIENCE_AGENT_EXECUTOR:-}" == "jiuwenswarm" ]]; then
    if [[ -z "$adapter_python" ]]; then
      echo "SCIENCE_AGENT_EXECUTOR=jiuwenswarm needs the adapter: also set SCIENCE_AGENT_ADAPTER=1." >&2
      exit 1
    fi
    # Docker mode has no separate shell to run a one-time `jiuwenswarm.sh
    # setup` in before the container ever starts (unlike local mode, which
    # documents that as a deliberate first step): the image bakes the venv,
    # so setup here is cheap and idempotent, and only creates this
    # container's own instance under the bind-mounted data directory on its
    # actual first run.
    if [[ "$mode" == "docker" && "$use_jiuwenswarm" -eq 1 ]]; then
      "$script_dir/jiuwenswarm.sh" setup >&2 || exit 1
    fi
    # Where the JiuwenSwarm instance listens; scripts/jiuwenswarm.sh knows its ports.
    if [[ -z "${JIUWENSWARM_GATEWAY_URL:-}" || -z "${JIUWENSWARM_MGMT_URL:-}" ]]; then
      eval "$("$script_dir/jiuwenswarm.sh" env)" || {
        echo "Could not read the JiuwenSwarm instance; run scripts/jiuwenswarm.sh setup and start." >&2
        exit 1
      }
    fi
    local gateway_port="${JIUWENSWARM_GATEWAY_URL##*:}"; gateway_port="${gateway_port%%/*}"
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$gateway_port") 2>/dev/null; then
      if [[ "$use_jiuwenswarm" -eq 1 ]]; then
        echo "JiuwenSwarm is not running; starting it (scripts/jiuwenswarm.sh start)..." >&2
        "$script_dir/jiuwenswarm.sh" start >&2 || exit 1
      fi
      if ! (exec 3<>"/dev/tcp/127.0.0.1/$gateway_port") 2>/dev/null; then
        echo "JiuwenSwarm is not reachable at $JIUWENSWARM_GATEWAY_URL; start it with scripts/jiuwenswarm.sh start." >&2
        exit 1
      fi
    fi
    export JIUWENSWARM_GATEWAY_URL JIUWENSWARM_MGMT_URL
  fi

  if [[ -n "$adapter_python" ]]; then
    local public_port="${SCIENCE_AGENT_PORT:-4310}"
    local legacy_port="${SCIENCE_AGENT_LEGACY_PORT:-$((public_port + 100))}"
    echo "Starting the adapter on port $public_port (legacy API on $legacy_port)..." >&2
    SCIENCE_AGENT_LEGACY_PORT="$legacy_port" \
    "$adapter_python" -m sciencediscovery_adapter.server &
    pids+=("$!")
    # The legacy API binds the legacy port; the adapter owns the public one. The
    # API reaches the adapter here when SCIENCE_AGENT_EXECUTOR=jiuwenswarm.
    export SCIENCE_AGENT_ADAPTER_URL="${SCIENCE_AGENT_ADAPTER_URL:-http://127.0.0.1:$public_port}"
    # The sign-in link names the port users open: the adapter's.
    api_command=(env "SCIENCE_AGENT_PORT=$legacy_port" "SCIENCE_AGENT_PUBLIC_PORT=$public_port" "${api_command[@]}")
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
