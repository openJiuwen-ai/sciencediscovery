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

# Assemble the runtime payload embedded in one release binary.
#
# The payload carries the product's own pieces: Node, CPython, the built Web
# assets, the deployed Node services and micromamba. It deliberately does NOT
# carry uv or the gateway's third-party Python dependencies — the launcher
# restores those on the user's machine at first launch, from a configurable
# package index (Huawei Cloud mirror by default), pinned here to exact
# versions: a hash-locked requirements export of services/gateway/uv.lock and
# a sha256-pinned uv wheel.
# Docker is never involved: every architecture-specific piece is downloaded
# from a pinned manifest, so both architectures build on any x86_64 or
# aarch64 host.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/../.." && pwd)"

architecture=""
output=""
version=""
shared_dir=""

usage() {
  cat <<'EOF'
Usage: scripts/binary-release/build-payload.sh --arch <x86_64|aarch64> --output <dir> --version <version> [--shared <dir>]

  --shared <dir>  Reuse architecture-independent stages (workspace deploy, Web
                  assets, Python wheels) prepared by a previous invocation.
EOF
}

while (($#)); do
  case "$1" in
    --arch) architecture="${2:?--arch requires a value}"; shift 2 ;;
    --output) output="${2:?--output requires a value}"; shift 2 ;;
    --shared) shared_dir="${2:?--shared requires a value}"; shift 2 ;;
    --version) version="${2:?--version requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$architecture" in
  x86_64) runtime_architecture=x64; python_platform=x86_64-unknown-linux-gnu ;;
  aarch64) runtime_architecture=arm64; python_platform=aarch64-unknown-linux-gnu ;;
  *) echo "--arch must be x86_64 or aarch64" >&2; exit 2 ;;
esac
[[ -n "$output" ]] || { echo "--output is required" >&2; exit 2; }
[[ -n "$version" ]] || { echo "--version is required" >&2; exit 2; }

for tool in node pnpm uv tar; do
  command -v "$tool" >/dev/null || { echo "$tool is required to build a release payload." >&2; exit 1; }
done

# Every stage runs from the repository root or a sub-shell inside a package, so
# the caller's relative paths are resolved once, up front.
absolute_path() { # <path>
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "${1#./}" ;;
  esac
}
output="$(absolute_path "$output")"
shared_dir="$(absolute_path "${shared_dir:-$(dirname -- "$output")/shared}")"

cd "$repository_root"
mkdir -p "$shared_dir"

# --------------------------------------------------------------------------
# Architecture-independent stages. The workspace is pure TypeScript and the
# two local Python distributions are py3-none-any, so these are built once and
# reused for every architecture.
# --------------------------------------------------------------------------

# The requirements export ships to users, so prove it carries nothing it must
# not: no index or artifact URLs (mirror choice stays with the user) and no
# build-machine paths of any form.
#
# The set itself is not asserted here. `uv export --frozen` derives it from the
# committed services/gateway/uv.lock, so it cannot change without a lockfile
# change, which is visible in review. A hardcoded pin and hash count was tried
# and only rotted: it was written against a 201-package tree, the gateway's
# dependencies moved into the Node control plane, and every release build then
# failed on the count until someone noticed.
assert_requirements_clean() { # <requirements file>
  local requirements="$1"
  if grep -nE '(^|[[:space:]])(--index-url|--extra-index-url|--find-links|-e)([[:space:]]|$)|[[:alpha:]][[:alnum:]+.-]*://|[[:space:]]@[[:space:]]' "$requirements" >&2; then
    echo "The requirements export must not contain registry, artifact, direct, or editable URLs." >&2
    exit 1
  fi
  if grep -nE '/home/|/root/|/Users/|/tmp/|[[:alpha:]]:\\Users\\|\.missioncrew|MissionCrew|\.worktrees' "$requirements" >&2; then
    echo "The requirements export leaks a build-machine path." >&2
    exit 1
  fi
  # Reported, not asserted: the numbers make a dependency change visible in
  # the build log without turning one into a build failure.
  echo "Requirements export verified: $(grep -Ec '^[A-Za-z0-9._-]+==' "$requirements" || true) pins,"\
    "$(grep -c -- '--hash=sha256:' "$requirements" || true) hashes, no URLs, no local paths." >&2
}

# Shipped bytes must not reference this build machine. Text files across the
# whole payload are scanned for the repository root and the builder's HOME;
# a hit fails the build instead of leaking a private path to every user.
assert_no_build_paths() { # <payload root>
  local root="$1" needle leaks=""
  # Exact current-machine roots avoid treating valid runtime constants such as
  # /tmp or URL paths containing /home/ as build-machine disclosure.
  for needle in "$repository_root" "$shared_dir" "$output" "${HOME:-}" "${USERPROFILE:-}"; do
    if [[ -n "$needle" ]]; then
      leaks+="$(grep -rIlF -- "$needle" "$root" || true)"$'\n'
    fi
  done
  leaks+="$(grep -rIlE '\.missioncrew|MissionCrew|\.worktrees' "$root" || true)"
  leaks="$(printf '%s\n' "$leaks" | sed '/^$/d' | sort -u)"
  if [[ -n "$leaks" ]]; then
    echo "Payload files leak build-machine paths:" >&2
    echo "$leaks" | head -20 >&2
    exit 1
  fi
  echo "Payload scan: no build-machine paths found." >&2
}

# pnpm's deploy metadata names its content-addressable store, and generated
# command shims can embed the staging directory in NODE_PATH. Node's library
# resolution does not consume .modules.yaml, and the only regular-file shim in
# this payload is yaml's optional CLI (the API imports the library directly).
prune_pnpm_build_metadata() { # <deployed app root>
  local root="$1" shim
  find "$root" -name .modules.yaml -type f -delete
  while IFS= read -r -d '' shim; do
    if grep -IqF -- "$shared_dir" "$shim"; then
      rm -f -- "$shim"
    fi
  done < <(find "$root" -path '*/node_modules/.bin/*' -type f -print0)
}

prepare_shared() {
  if [[ -f "$shared_dir/.complete" ]]; then
    echo "Reusing the architecture-independent stage in $shared_dir" >&2
    return
  fi
  rm -rf -- "$shared_dir"
  mkdir -p "$shared_dir/app/apps/web" "$shared_dir/wheels"

  echo "Building the workspace..." >&2
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm build

  # `pnpm deploy` writes a self-contained tree whose node_modules symlinks stay
  # inside the deployed directory. Placing each service at its repository path
  # keeps the API's `repositoryRoot` (four levels above dist/http) pointing at
  # the payload's app root, so Web assets and the paper worker resolve unchanged.
  # `pnpm deploy --prod` records the workspace as production-only, after which
  # every later pnpm command wants to reconcile and prompts before purging
  # node_modules. CI=true answers that prompt, and the full install afterwards
  # puts the checkout back the way the developer had it.
  echo "Deploying the Node services..." >&2
  for service in api runner; do
    rm -rf -- "$shared_dir/app/services/$service"
    CI=true pnpm deploy --filter "@sciencediscovery/$service" --prod --legacy "$shared_dir/app/services/$service"
  done
  CI=true pnpm install --frozen-lockfile --ignore-scripts

  cp -a apps/web/dist "$shared_dir/app/apps/web/dist"
  # Runtime URL loaders resolve this repository-level authority from the
  # payload app root; keep it alongside the deployed Node services and skills.
  mkdir -p "$shared_dir/app/config"
  cp config/external-urls.json "$shared_dir/app/config/external-urls.json"
  # The control API launches the paper worker by repository-relative path; the
  # optional PDF environment is provisioned into the data directory at runtime.
  mkdir -p "$shared_dir/app/services/paper"
  cp -a services/paper/. "$shared_dir/app/services/paper/"
  rm -rf -- "$shared_dir/app/services/paper/.venv"
  # The skill catalog reads the built-in packages from the repository root, and
  # the API refuses to start when they are missing.
  cp -a skills "$shared_dir/app/skills"

  echo "Building the gateway wheel and the first-launch bootstrap inputs..." >&2
  # The gateway is our own code and ships as a prebuilt wheel; the third-party
  # tree is restored on the user's machine instead.
  uv build --wheel --out-dir "$shared_dir/wheels" services/gateway

  # Export the locked third-party set with hashes. At first launch the
  # launcher feeds this to `uv pip install --require-hashes --index-url`, so
  # the versions stay exactly those of services/gateway/uv.lock while the
  # download goes through whatever package index the user configured —
  # uv.lock itself records pypi.org URLs and would bypass a mirror.
  # --no-header: the generated header would record this build's command line,
  # including build-machine absolute paths, inside a shipped artifact.
  (cd services/gateway && uv export --frozen --no-dev --no-emit-project --no-header \
    --format requirements.txt -o "$shared_dir/requirements-gateway.txt")

  touch "$shared_dir/.complete"
}

# --------------------------------------------------------------------------
# Architecture-specific assembly.
# --------------------------------------------------------------------------

prune_escaping_symlinks() { # <root>
  local root="$1" link target
  while IFS= read -r -d '' link; do
    target="$(readlink -- "$link")"
    if [[ "$target" == /* ]] || [[ ! -e "$link" ]]; then
      echo "Pruning payload symlink that does not resolve inside the tree: ${link#"$root"/} -> $target" >&2
      rm -f -- "$link"
    fi
  done < <(find "$root" -type l -print0)
}

# A runtime downloaded for the wrong platform would only fail at start-up on
# the user's host, so the bundled interpreter's extension modules are checked
# here instead. (Third-party wheels are no longer embedded; first launch
# resolves them natively on the user's machine.)
verify_extension_architecture() { # <python prefix> <expected `file` fragment>
  local site="$1" expected="$2" mismatches
  # -type f skips the versioned .so symlinks CPython ships, which `file`
  # reports as links rather than ELF objects.
  mismatches="$(find "$site" -type f \( -name '*.so' -o -name '*.so.*' \) -print0 \
    | xargs -0 --no-run-if-empty file | grep -v "$expected" || true)"
  if [[ -n "$mismatches" ]]; then
    echo "Bundled Python extensions do not match $architecture:" >&2
    echo "$mismatches" | head -20 >&2
    exit 1
  fi
}

prepare_shared
assert_requirements_clean "$shared_dir/requirements-gateway.txt"

echo "Assembling the $architecture payload in $output" >&2
rm -rf -- "$output"
mkdir -p "$output"

node "$script_dir/fetch-runtime.mjs" --runtime node --arch "$architecture" --output "$output/node-dist"
mkdir -p "$output/node/bin"
cp "$output/node-dist/bin/node" "$output/node/bin/node"
cp "$output/node-dist/LICENSE" "$output/node/LICENSE"
# Only the interpreter is needed; npm and the C++ headers are build-host tools.
rm -rf -- "$output/node-dist"

node "$script_dir/fetch-runtime.mjs" --runtime python --arch "$architecture" --output "$output/python"

mkdir -p "$output/provisioner"
node "$repository_root/scripts/fetch-managed-micromamba.mjs" \
  --arch "$architecture" --output "$output/provisioner/micromamba"
chmod 0755 "$output/provisioner/micromamba"

# -a keeps the executable bits and the pnpm store symlinks intact.
cp -a "$shared_dir/app" "$output/app"
prune_escaping_symlinks "$output/app"
prune_pnpm_build_metadata "$output/app"

# The gateway's dependency tree is not embedded. The payload instead carries
# the inputs the first-launch bootstrap needs: the hash-locked requirements
# export, the prebuilt gateway wheel, and (in the manifest below) the pinned
# uv wheel identity. At run time
# the dependencies land in the interpreter's own site directory of a venv
# built on the bundled CPython — the gateway starts stdio MCP servers through
# the MCP SDK, which forwards only an allow-listed environment, so a
# PYTHONPATH-based layout would break exactly there.
site_packages="python/lib/python3.12/site-packages"
echo "Staging the first-launch bootstrap inputs..." >&2
mkdir -p "$output/bootstrap/wheels"
cp "$shared_dir/requirements-gateway.txt" "$output/bootstrap/requirements-gateway.txt"
cp "$shared_dir"/wheels/sciencediscovery_gateway-*.whl "$output/bootstrap/wheels/"
gateway_wheel_name="$(basename "$(ls "$output"/bootstrap/wheels/sciencediscovery_gateway-*.whl)")"

# A pyvenv.cfg makes site.py treat the prefix as an environment, which disables
# the host user site directory (~/.local/lib/pythonX.Y/site-packages). Omitting
# the `home` key keeps the file relocatable: CPython then derives the prefix
# from the executable, so the payload works at whatever path it is unpacked to.
cat >"$output/python/pyvenv.cfg" <<'PYVENV'
# Isolates the bundled interpreter from host-installed Python packages.
include-system-site-packages = false
PYVENV

case "$architecture" in
  x86_64) verify_extension_architecture "$output/python" "x86-64" ;;
  aarch64) verify_extension_architecture "$output/python" "ARM aarch64" ;;
esac

micromamba_version="$(node "$repository_root/scripts/fetch-managed-micromamba.mjs" \
  --arch "$architecture" --print-tsv | cut -f1)"
read_version() { # <runtime>
  node "$script_dir/fetch-runtime.mjs" --runtime "$1" --arch "$architecture" --print-json \
    | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).version)'
}
node_version="$(read_version node)"
python_version="$(read_version python)"

# The uv wheel pin for this architecture, from the shared runtimes manifest.
read -r uv_version uv_project uv_wheel_filename uv_wheel_sha256 < <(node -e '
  const manifest = require(process.argv[1]);
  const entry = manifest.uv.architectures[process.argv[2]];
  if (!entry) throw new Error(`uv is not pinned for ${process.argv[2]}`);
  console.log([manifest.uv.version, manifest.uv.project, entry.filename, entry.sha256].join(" "));
' "$script_dir/runtimes.json" "$architecture")

cat >"$output/manifest.json" <<EOF
{
  "formatVersion": 2,
  "product": "sciencediscovery",
  "version": "$version",
  "architecture": "$architecture",
  "runtimeArchitecture": "$runtime_architecture",
  "node": { "version": "$node_version", "path": "node/bin/node" },
  "python": {
    "version": "$python_version",
    "path": "python/bin/python3",
    "sitePackages": "$site_packages"
  },
  "micromamba": { "version": "$micromamba_version", "path": "provisioner/micromamba" },
  "app": {
    "root": "app",
    "apiEntry": "app/services/api/dist/server.js",
    "runnerEntry": "app/services/runner/dist/server.js",
    "webDir": "app/apps/web/dist"
  },
  "bootstrap": {
    "uv": {
      "version": "$uv_version",
      "project": "$uv_project",
      "wheelFilename": "$uv_wheel_filename",
      "wheelSha256": "$uv_wheel_sha256"
    },
    "requirementsPath": "bootstrap/requirements-gateway.txt",
    "gatewayWheelPath": "bootstrap/wheels/$gateway_wheel_name"
  }
}
EOF

assert_no_build_paths "$output"

echo "Payload assembled: $(du -sh "$output" | cut -f1) in $output" >&2
