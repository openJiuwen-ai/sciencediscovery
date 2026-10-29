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

# Only SD's documented controls may cross the embedded runtime boundary, and
# only after an explicit opt-in. Unknown SDK controls must not leak through.
#
# This list governs what the *scripts* may read. It is deliberately wider than
# what the SDK *child processes* see: see swarm_runtime below for that second,
# narrower list.
configure_swarm_environment() {
  local name
  for name in ${!JIUWENSWARM_@}; do
    case "$name" in
      JIUWENSWARM_TAG|JIUWENSWARM_GIT_URL|JIUWENSWARM_ROOT|JIUWENSWARM_SRC|JIUWENSWARM_INSTANCE|JIUWENSWARM_HOME|JIUWENSWARM_CONTEXT_WINDOW_TOKENS|JIUWENSWARM_GATEWAY_URL|JIUWENSWARM_MGMT_URL)
        [[ "${SCIENCE_AGENT_JIUWENSWARM_OVERRIDES:-0}" == 1 ]] && continue ;;
    esac
    unset "$name"
  done
}

# The environment an SDK child process actually inherits. It is not the list
# above: a name being readable by the scripts does not make it visible to the
# SDK. Only the runtime paths SD owns and the locale/proxy settings reach it.
# The other documented names are consumed by the scripts themselves (the
# install root, the instance name, the context window written into the
# instance config) or belong to the adapter's endpoints, so forwarding them
# would leak exactly what the opt-in is meant to contain.
swarm_runtime() {
  local name
  local inherited=()
  for name in LANG LC_ALL TZ SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
    [[ -n "${!name:-}" ]] && inherited+=("$name=${!name}")
  done
  env -i PATH="$PATH" HOME="$JIUWENSWARM_HOME" JIUWENSWARM_HOME="$JIUWENSWARM_HOME" "${inherited[@]}" "$@"
}
