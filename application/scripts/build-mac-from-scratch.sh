#!/usr/bin/env bash
# build-mac-from-scratch.sh — one command from a bare checkout to a signed-able
# macOS DMG, with NO reliance on any prior local state (mac-desktop, W29).
#
# WHY THIS EXISTS
#   build-mac.sh is the pre-release GATE, but it deliberately "checks and
#   tells, does not provision" — it assumes the machine was prepared. This
#   script is that preparation, in order, from a fresh `git clone`:
#
#     root workspace deps + build  →  application/ own workspace deps
#     →  jw source + venv (clone + uv)  →  shared sd-services venv
#     →  micromamba binary (pinned release, SHA256-verified)
#     →  build-mac.sh (the full gate: tests, assemble, payload checks,
#        patch-chain verify, electron-builder + afterPack locale trim)
#
#   Verified end-to-end on a cold directory (2026-11-14): the two gaps a
#   fresh machine hits are application/ being its OWN pnpm workspace (the
#   root install never populates it) and micromamba having no provisioner
#   outside the Docker image path (assemble expects it, nothing fetches it).
#   Both are handled here; both fail with clear messages if skipped.
#
# USAGE
#   cd sciencediscovery                       # a fresh clone, any branch
#   bash application/scripts/build-mac-from-scratch.sh    # provision + full ad-hoc build
#
#   # Provision ONLY (skip packaging — do this once per machine):
#   FROM_SCRATCH_SKIP_BUILD=1 bash application/scripts/build-mac-from-scratch.sh
#
#   # Reuse an existing micromamba binary instead of downloading (offline
#   # friendliness; the script still verifies its SHA256 against the pinned
#   # manifest):
#   MICROMAMBA_SOURCE=/path/to/micromamba bash application/scripts/build-mac-from-scratch.sh
#
#   # Then the release build itself (signing credentials live in the keychain):
#   SD_MAC_SIGN=1 bash application/scripts/build-mac.sh
#
# NOTES / GOTCHAS (read before running on a new machine)
#   1. Toolchain prerequisites, checked up front: node ≥ 22, pnpm, git, uv
#      (`curl -LsSf https://astral.sh/uv/install.sh | sh` installs uv to
#      ~/.local/bin — if that dir is not on PATH, this script exports it).
#   2. Network: PyPI is reached DIRECTLY by uv (a mirror env var only helps
#      if you export it yourself; see step 3). The full jw venv is ~966 MB
#      across 300+ wheels — on a plain home network expect 30-90 minutes for
#      this step alone on the first run. Subsequent runs hit the uv cache
#      (~/.cache/uv) and finish in seconds.
#   3. Optional mirrors (export BEFORE running, both are respected):
#        export SCIENCE_AGENT_PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
#        export ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR are
#          pre-set by build-mac.sh to npmmirror; export your own to override.
#   4. Signing: this script only produces an AD-HOC smoke build. The
#      Developer ID + notarize chain is a build-mac.sh mode (SD_MAC_SIGN=1)
#      and needs the login-keychain identity + notary profile (D4 §3).
#   5. AGENTS/CI: run this OUTSIDE sandboxed brokered shells — electron-
#      builder's staging writes and vite builds misbehave under file-system
#      shims (lessons W11/L9). If you must, export
#      CODEBUDDY_SAFE_DELETE_ENABLED=0 in the environment that spawns it.
#   6. Disk: the repo + venvs + payload staging together take ~8 GB.
#      Everything lands inside the checkout (.sciencediscovery-data/,
#      application/build/, application/release/) — deleting the checkout
#      cleans it all.
#
# Provisioning steps are idempotent: every one is skipped when its artifact
# already exists, so reruns are cheap and incremental.

set -euo pipefail

# This script lives in application/scripts/ — the REPO root is two levels up
# (application/ is the shell workspace; the root workspace owns services/).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="$REPO_ROOT/.sciencediscovery-data"

step() { printf '\n\033[1;36m[from-scratch] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[from-scratch] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- 0. toolchain preflight ---------------------------------------------------
step "0. toolchain preflight"
have node || die "node not found — install Node ≥ 22 (nvm/brew)"
have pnpm || die "pnpm not found — corepack enable, or: npm i -g pnpm"
have git || die "git not found"
# uv lives in ~/.local/bin on default installs, which is often NOT on PATH
# in non-interactive shells — add it before the check.
export PATH="$HOME/.local/bin:$PATH"
have uv || die "uv not found — curl -LsSf https://astral.sh/uv/install.sh | sh"
echo "node $(node --version) / pnpm $(pnpm --version) / uv $(uv --version | cut -d' ' -f2) — OK"

# --- 1. root workspace: deps + build ------------------------------------------
step "1. root workspace deps + build (pnpm --recursive)"
( cd "$REPO_ROOT" && pnpm install --frozen-lockfile --ignore-scripts \
  ) || die "root pnpm install failed"
( cd "$REPO_ROOT" && pnpm --recursive build \
  ) || die "root pnpm --recursive build failed (services/*/dist is required by build-mac.sh)"
echo "services built"

# --- 2. application/ own workspace deps (W29 gap #1) ---------------------------
# application/ is NOT a member of the root pnpm workspace: it has its own
# pnpm-lock.yaml. A fresh machine that only installs at the root gets a green
# root build and then an ERR_MODULE_NOT_FOUND (esbuild) inside build-mac.sh
# step 1b — the least helpful place to discover it. build-mac.sh's preflight
# checks the data dir and services dist but not application/node_modules.
step "2. application/ workspace deps (own pnpm-lock, root install misses it)"
( cd "$REPO_ROOT/application" && pnpm install --frozen-lockfile \
  ) || die "application pnpm install failed"
echo "application deps OK"

# --- 3. jw source + venv (idempotent: cmdSetup skips a finished clone) ---------
step "3. jw source + venv (first run downloads ~966 MB from PyPI)"
( cd "$REPO_ROOT" && node scripts/jiuwenswarm.mjs setup \
  ) || die "jw setup failed (check network to gitcode.com and PyPI; SCIENCE_AGENT_PYPI_INDEX can speed this up)"
echo "jw ready: $DATA_DIR/jiuwenswarm/src/.venv"

# --- 4. shared sd-services venv (same command start-stack runs) ---------------
step "4. shared sd-services venv (uv sync --locked --extra candidates)"
if [ -f "$DATA_DIR/envs/sd-services/pyvenv.cfg" ]; then
  echo "exists, re-syncing (uv resolves incrementally)"
fi
( cd "$REPO_ROOT" \
  && UV_PROJECT_ENVIRONMENT="$DATA_DIR/envs/sd-services" \
     uv sync --locked --extra candidates \
  ) || die "sd-services venv sync failed"
echo "venv OK: $DATA_DIR/envs/sd-services"

# --- 5. micromamba (W29 gap #2) ------------------------------------------------
# Nothing provisions this outside the Docker image: the seed script targets
# bind-mounted images, assemble-backend expects the binary to exist. Fetch it
# from the pinned GitHub release (SHA256 verified by the fetch script), or
# take an existing binary via MICROMAMBA_SOURCE (still SHA256-verified).
step "5. micromamba binary (pinned release, SHA256-verified)"
MICROMAMBA_BIN="$DATA_DIR/scientific-envs/bin/micromamba"
if [ -x "$MICROMAMBA_BIN" ]; then
  echo "exists, skipping ($MICROMAMBA_BIN)"
else
  ARCH="$(uname -m)"   # arm64 on Apple Silicon, x86_64 under Rosetta
  SRC_ARGS=()
  [ -n "${MICROMAMBA_SOURCE:-}" ] && SRC_ARGS=(--source "$MICROMAMBA_SOURCE")
  # --output is the FULL target file path (fetch renames onto it atomically).
  # ${SRC_ARGS[@]+...} guard: /bin/bash on macOS is 3.2, where "set -u" +
  # empty-array expansion "${SRC_ARGS[@]}" is a fatal unbound-variable error
  # (fixed upstream in bash 4.4) — the guard expands only when non-empty.
  ( cd "$REPO_ROOT" && node scripts/fetch-managed-micromamba.mjs \
      --arch "$ARCH" --platform darwin \
      --output "$MICROMAMBA_BIN" ${SRC_ARGS[@]+"${SRC_ARGS[@]}"} \
  ) || die "micromamba fetch failed (GitHub releases 502 in bursts — retry; or MICROMAMBA_SOURCE=/path/to/micromamba to reuse a local copy)"
  [ -x "$MICROMAMBA_BIN" ] || die "fetch claimed success but $MICROMAMBA_BIN is missing"
  echo "micromamba OK: $($MICROMAMBA_BIN --version)"
fi

# --- 6. the full release gate --------------------------------------------------
if [ -n "${FROM_SCRATCH_SKIP_BUILD:-}" ]; then
  step "provision complete (FROM_SCRATCH_SKIP_BUILD set — skipping packaging)"
  echo "Machine is ready. Next:  SD_MAC_SIGN=1 bash scripts/build-mac.sh   (release)"
  echo "                   or:   bash scripts/build-mac.sh                 (ad-hoc smoke)"
  exit 0
fi

step "6. build-mac.sh (tests → assemble → payload gates → electron-builder)"
( cd "$REPO_ROOT/application" && bash scripts/build-mac.sh \
  ) || die "build-mac.sh failed — see its output above for the failing gate"

step "DONE — DMG + zip + latest-mac.yml in application/release/"
ls -lh "$REPO_ROOT/application/release/"*.dmg "$REPO_ROOT/application/release/"*.zip 2>/dev/null || true
echo ""
echo "Ad-hoc smoke build (unsigned). For the release build:"
echo "  SD_MAC_SIGN=1 bash scripts/build-mac.sh"
