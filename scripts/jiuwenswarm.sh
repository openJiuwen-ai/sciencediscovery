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

# Install and run the JiuwenSwarm instance the adapter drives
# (SCIENCE_AGENT_EXECUTOR=jiuwenswarm). Everything the migration measured against
# JiuwenSwarm 0.2.6 lives here so a fresh host reproduces it:
#
#   scripts/jiuwenswarm.sh setup     clone the pinned tag, install it, create the instance, apply the config
#   scripts/jiuwenswarm.sh start     start the instance and wait for its gateway
#   scripts/jiuwenswarm.sh stop
#   scripts/jiuwenswarm.sh status
#   scripts/jiuwenswarm.sh env       print the exports the adapter needs (eval "$(scripts/jiuwenswarm.sh env)")
#
# JIUWENSWARM_CONTEXT_WINDOW_TOKENS=<n> (optional) sets the window JiuwenSwarm compresses conversations against.
#
# JiuwenSwarm is installed into its own directory and virtualenv; it is never
# installed into the ScienceDiscovery environments. Its instance workspace is
# created by JiuwenSwarm under ~/.jiuwenswarm-instances/<name> (it has no option to
# place it elsewhere), separate from a default ~/.jiuwenswarm.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"

# The baseline the migration is measured against (issue 84).
jw_tag="${JIUWENSWARM_TAG:-workswarm0.2.6}"
jw_git_url="${JIUWENSWARM_GIT_URL:-https://gitcode.com/openJiuwen/jiuwenswarm.git}"
jw_root="${JIUWENSWARM_ROOT:-$repository_root/.sciencediscovery-data/jiuwenswarm}"
jw_instance="${JIUWENSWARM_INSTANCE:-sciencediscovery}"
# Independent of jw_root: the Docker image bakes the install under /opt at
# build time (read-only, no git clone at container start) while jw_root still
# points at the bind-mounted data directory, so the instance's own state
# (created below by cmd_setup, same as local mode) lands on the persisted
# volume instead of inside the image.
jw_src="${JIUWENSWARM_SRC:-$jw_root/src}"
jw_bin="$jw_src/.venv/bin"
jw_data_dir="$jw_root/data"
jw_log="$jw_root/jiuwenswarm.log"
apply_compatibility_patches() {
  python3 "$script_dir/swarm-patches.py" apply "$jw_src" "$jw_tag"
}

verify_compatibility_patches() {
  local package_root
  package_root="$("$jw_bin/python" -c 'import importlib.util,pathlib; print(pathlib.Path(importlib.util.find_spec("jiuwenswarm").origin).parent.parent)')"
  "$jw_bin/python" "$script_dir/swarm-patches.py" verify "$package_root" "$jw_tag"
}

usage() {
  sed -n '15,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOT'

Environment:
  JIUWENSWARM_TAG        git tag to install (default workswarm0.2.6)
  JIUWENSWARM_GIT_URL    where to clone it from
  JIUWENSWARM_ROOT       install directory (default .sciencediscovery-data/jiuwenswarm)
  JIUWENSWARM_SRC        where the .venv lives (default <root>/src); set apart
                         from JIUWENSWARM_ROOT when the venv is pre-baked
                         read-only (the Docker image does this) and only the
                         instance's own state should live under the root
  JIUWENSWARM_INSTANCE   instance name (default sciencediscovery)
  SCIENCE_AGENT_PYPI_INDEX  PyPI mirror for uv, as start-stack.sh uses it
  UV_HTTP_TIMEOUT        seconds uv waits on a download (default 300; the default 30 fails on slow links)
EOT
}

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "$1 is required: $2" >&2; exit 1; }
}

# JiuwenSwarm keeps its instance table under JIUWENSWARM_DATA_DIR.
jw() {
  JIUWENSWARM_DATA_DIR="$jw_data_dir" "$jw_bin/$1" "${@:2}"
}

instance_workspace() { echo "$HOME/.jiuwenswarm-instances/$jw_instance"; }

port_of() { # agent_server | web | gateway
  jw jiuwenswarm-start --status "$jw_instance" 2>/dev/null \
    | sed -n "s/^  $1: *//p" | head -n1
}

# The three settings the adapter depends on, applied idempotently to the instance config.
apply_config() {
  local config
  config="$(instance_workspace)/config/config.yaml"
  [[ -f "$config" ]] || { echo "$config not found; run setup first." >&2; exit 1; }
  python3 - "$config" "${JIUWENSWARM_CONTEXT_WINDOW_TOKENS:-}" <<'PY'
import re, sys
path = sys.argv[1]
window = sys.argv[2].strip()
text = open(path, encoding="utf-8").read()
# MCP tools must be direct tools: the adapter reaches the model through its own proxy under
# the tool names ScienceDiscovery defined, and a deferred tool would need tool_search first.
text, count = re.subn(r"^progressive_tool_enabled:.*$", "progressive_tool_enabled: false", text, flags=re.M)
if count == 0:
    text = "progressive_tool_enabled: false\n" + text
# The size JiuwenSwarm compresses a conversation against (at 80% of it). JiuwenSwarm 0.2.6 has no per-model or
# per-run setting that takes effect (a model entry's window is ignored for a non-built-in model), only this
# global one; unset it keeps JiuwenSwarm's own default (200000 tokens).
marker = "  # set by scripts/jiuwenswarm.sh"
text = re.sub(r"^    context_window_tokens:.*" + re.escape(marker) + r"\n", "", text, flags=re.M)
if window:
    if not window.isdigit() or int(window) <= 0:
        sys.exit("JIUWENSWARM_CONTEXT_WINDOW_TOKENS must be a positive integer")
    text, count = re.subn(r"^(  context_engine_config:\n)", r"\1    context_window_tokens: " + window + marker + "\n", text, count=1, flags=re.M)
    if count == 0:
        sys.exit("context_engine_config not found in " + path)
open(path, "w", encoding="utf-8").write(text)
print("config: progressive_tool_enabled: false" + (f", context_window_tokens: {window}" if window else ""))
# JiuwenSwarm registers its free search only at start-up, from these two switches. ScienceDiscovery's web settings
# set them (config.set) and default to on; until the API has applied them once, start with that default.
import os
env_path = os.path.join(os.path.dirname(path), ".env")
env = open(env_path, encoding="utf-8").read() if os.path.exists(env_path) else ""
missing = [name for name in ("FREE_SEARCH_DDG_ENABLED", "FREE_SEARCH_BING_ENABLED")
           if not re.search(r"^" + name + r"=", env, flags=re.M)]
if missing:
    with open(env_path, "a", encoding="utf-8") as handle:
        handle.write(("" if not env or env.endswith("\n") else "\n") + "".join(f'{name}="true"\n' for name in missing))
PY
}

cmd_setup() {
  if [[ -x "$jw_bin/jiuwenswarm-start" && ! -d "$jw_src/.git" ]]; then
    # Pre-baked, not git-managed (the Docker image installs it this way at
    # build time, from a patched wheel — see Dockerfile). Nothing to clone or
    # sync; only the instance below is this container's own state to create.
    echo "Using the pre-installed JiuwenSwarm at $jw_src." >&2
    verify_compatibility_patches
  else
    require git "install git"
    require uv "https://docs.astral.sh/uv/"
    mkdir -p "$jw_root"
    if [[ ! -d "$jw_src/.git" ]]; then
      echo "Cloning JiuwenSwarm $jw_tag..." >&2
      git clone --quiet --depth 1 --branch "$jw_tag" "$jw_git_url" "$jw_src"
    else
      local have
      have="$(git -C "$jw_src" describe --tags --exact-match 2>/dev/null || true)"
      [[ "$have" == "$jw_tag" ]] || {
        echo "$jw_src is at '${have:-an untagged commit}', not $jw_tag. Remove it or set JIUWENSWARM_ROOT." >&2
        exit 1
      }
    fi
    # Apply source compatibility fixes before syncing the editable installation.
    apply_compatibility_patches
    echo "Installing JiuwenSwarm (Python 3.12, its own virtualenv)..." >&2
    (
      cd "$jw_src"
      export UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-300}"
      [[ -n "${SCIENCE_AGENT_PYPI_INDEX:-}" ]] && export UV_DEFAULT_INDEX="$SCIENCE_AGENT_PYPI_INDEX"
      uv sync --python 3.12
    )
  fi
  mkdir -p "$jw_data_dir"
  if [[ ! -d "$(instance_workspace)" ]]; then
    echo "Creating instance $jw_instance..." >&2
    jw jiuwenswarm-init --name "$jw_instance" >/dev/null
  fi
  apply_config
  echo "Done. Start it with: scripts/jiuwenswarm.sh start" >&2
}

is_up() {
  local gateway
  gateway="$(port_of gateway)"
  [[ -n "$gateway" ]] && (exec 3<>"/dev/tcp/127.0.0.1/$gateway") 2>/dev/null
}

cmd_start() {
  [[ -x "$jw_bin/jiuwenswarm-start" ]] || { echo "Not installed; run: scripts/jiuwenswarm.sh setup" >&2; exit 1; }
  apply_config >/dev/null
  if is_up; then echo "JiuwenSwarm instance $jw_instance is already up." >&2; return; fi
  verify_compatibility_patches
  # Detach completely (stdin, stdout, stderr): a background job that keeps the caller's stdout open
  # makes `scripts/jiuwenswarm.sh start | tee ...`, or any script capturing its output, wait forever.
  cd "$jw_root"
  # Web search is configured from ScienceDiscovery's web settings, which the API applies with config.set.
  # Put our guarded sitecustomize hook in every JiuwenSwarm Python process. It applies JiuwenSwarm's
  # own MCP call-timeout patch before startup prewarming can create a client with the 30-second fallback.
  local bootstrap_path="$repository_root/services/adapter/src/sciencediscovery_adapter"
  SCIENCE_AGENT_JIUWENSWARM_BOOTSTRAP=1 \
    PYTHONPATH="$bootstrap_path${PYTHONPATH:+:$PYTHONPATH}" \
    JIUWENSWARM_DATA_DIR="$jw_data_dir" nohup "$jw_bin/jiuwenswarm-start" --name "$jw_instance" app \
    >"$jw_log" 2>&1 </dev/null &
  disown
  local attempt
  for attempt in $(seq 1 90); do
    if is_up; then
      # The gateway accepts connections a few seconds before the agent server answers.
      sleep 6
      echo "JiuwenSwarm instance $jw_instance is up (gateway $(port_of gateway), web $(port_of web))." >&2
      return
    fi
    sleep 2
  done
  echo "JiuwenSwarm did not come up within 180s; see $jw_log" >&2
  exit 1
}

cmd_stop() {
  [[ -x "$jw_bin/jiuwenswarm-start" ]] || return 0
  jw jiuwenswarm-start --stop "$jw_instance" || true
}

cmd_status() {
  [[ -x "$jw_bin/jiuwenswarm-start" ]] || { echo "not installed"; return 1; }
  jw jiuwenswarm-start --status "$jw_instance"
  is_up && echo "gateway: reachable" || { echo "gateway: not reachable"; return 1; }
}

cmd_env() {
  [[ -x "$jw_bin/jiuwenswarm-start" ]] || { echo "Not installed; run: scripts/jiuwenswarm.sh setup" >&2; exit 1; }
  local gateway web
  gateway="$(port_of gateway)"
  web="$(port_of web)"
  [[ -n "$gateway" && -n "$web" ]] || { echo "Could not read the instance ports." >&2; exit 1; }
  # Chats use the gateway's /tui route; management calls (mcp.*, models.*) the web channel's /ws.
  echo "export JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:$gateway/tui"
  echo "export JIUWENSWARM_MGMT_URL=ws://127.0.0.1:$web/ws"
}

case "${1:-}" in
  setup) cmd_setup ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  env) cmd_env ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
