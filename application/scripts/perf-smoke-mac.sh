#!/usr/bin/env bash
# perf-smoke-mac.sh — packaged .app first-launch smoke run for the timing
# gate (P3-1: build-mac.sh's missing "step 6").
#
# The CI runner (and any fresh Mac) has never run the app, so the smoke
# provisions everything the packaged bootstrap expects, then judges the
# log it produces:
#   1. throwaway HOME + data dir (nothing the smoke does may touch the
#      runner's real home — logs, userData and the backend data dir all
#      land inside the quarantine dir, wiped on exit)
#   2. pre-seed the wizard state (step=done + the throwaway data dir):
#      without it a packaged first launch opens the interactive data-dir
#      wizard, which never reaches the packaged bootstrap, never emits
#      the bootstrapPackaged-enter kind flag — the gate would exit 3
#      (measured nothing, F1). Seeding routes the shell straight down
#      the path the budgets judge.
#   3. copy the packed .app into the throwaway home (a fresh copy is the
#      user's first-launch shape) and launch it with a minimal env
#   4. wait for AGENT-READY in the smoke's OWN shell.log, let warmup
#      finish, then quit gently (SIGTERM) and let the stack drain
#   5. hand the log to perf-gate.mjs; its exit code is this script's
#
# Usage:
#   application/scripts/perf-smoke-mac.sh [path-to-.app] [gate-args...]
#
#   .app defaults to application/release/mac-arm64/ScienceDiscovery.app
#   (where build-mac.sh step 5 leaves it). Gate args pass through
#   (--hang-only on CI machines with no local baseline, P3-2).
#
# Exit codes (gate codes pass through; smoke-specific ones beyond them):
#   0  smoke ran AND the gate passed
#   1  gate: hang found (or --fail-on-regression escalated)
#   2  usage error (bad .app path / copy failed)
#   3  gate: sessions exist but none judged (F1)
#   6  no shell.log was produced at all
# (4/5 are reserved: a timeout or a crash mid-window does NOT abort the
# smoke — the partial log is handed to the gate so the HANG is judged from
# the log with full attribution, which is the whole point of the gate.)
#
# Environment:
#   SD_SMOKE_APP          override the .app path (same as argv[1])
#   SD_SMOKE_TIMEOUT_MS   AGENT-READY wait budget, default 300000 (5min —
#                         the agent-ready hang line is 180s, so the smoke
#                         outlives it and the gate gets to JUDGE the hang
#                         with full attribution from the log)
#   SD_SMOKE_KEEP=1       keep the throwaway home for debugging (path
#                         printed on exit; default: wiped)
#   SD_SMOKE_LOG_OUT=path  ALSO copy the judged log to <path> (parent dirs
#                         created). CI sets this to a fixed path so the
#                         first-run measurements can be uploaded as the
#                         P3-2 baseline-collection artifact.
set -euo pipefail

# --- locate everything from this script's own location ------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SHELL_ROOT/scripts/perf-gate.mjs"

step() { printf '\n\033[1;36m[perf-smoke] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[perf-smoke] FAIL: %s\033[0m\n' "$*" >&2; exit "$2"; }

# Electron's app.name (and therefore ~/Library/{Logs,Application Support}/
# <name>) is read from the package.json inside the asar: today that is the
# package name (sd-shell — observed live, 2026-11-24 packaged log), while
# the design doc's W1 leftover expects the productName (ScienceDiscovery).
# Whichever way W1 lands, seeding/checking BOTH candidates keeps the smoke
# correct without it caring.
NAME_CANDIDATES=(sd-shell ScienceDiscovery)

# --- argv ---------------------------------------------------------------------
APP="${1:-${SD_SMOKE_APP:-$SHELL_ROOT/release/mac-arm64/ScienceDiscovery.app}}"
[ $# -gt 0 ] && shift
GATE_ARGS=("$@")

[ -d "$APP" ] || die "no .app at $APP (pass the path or set SD_SMOKE_APP; \
build-mac.sh step 5 packs it at application/release/mac-arm64/)" 2
EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
EXE_NAME="${EXE_NAME:-ScienceDiscovery}"
[ -x "$APP/Contents/MacOS/$EXE_NAME" ] || die "no executable in .app at $APP/Contents/MacOS/$EXE_NAME" 2
step "smoke target: $APP"

# --- 1. throwaway HOME (userData / logs / data dir all inside it) -------------
KEEP="${SD_SMOKE_KEEP:-0}"
SMOKE_HOME="${SD_SMOKE_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/sd-perf-smoke.XXXXXX")}"
DATA_DIR="${SD_SMOKE_DATA_DIR:-$SMOKE_HOME/sd-smoke-data}"
mkdir -p "$SMOKE_HOME/Library/Logs" "$SMOKE_HOME/Library/Application Support" "$DATA_DIR"

# --- 2. pre-seed wizard state (route past the interactive first-run UI) -------
for NAME in "${NAME_CANDIDATES[@]}"; do
  UD="$SMOKE_HOME/Library/Application Support/$NAME"
  mkdir -p "$UD"
  printf '{"step":"done","dataDir":"%s","completedAt":"%s"}\n' \
    "$DATA_DIR" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$UD/wizard-state.json"
done
step "wizard state seeded (step=done, dataDir=$DATA_DIR)"

# --- 3. fresh copy of the .app (the user's first-launch shape) ----------------
INSTALL_DIR="$SMOKE_HOME/Applications"
mkdir -p "$INSTALL_DIR"
BIN="$INSTALL_DIR/$(basename "$APP")/Contents/MacOS/$EXE_NAME"
cp -R "$APP" "$INSTALL_DIR/" || die "failed to copy .app into $INSTALL_DIR" 2
[ -x "$BIN" ] || die "copied .app lost its executable at $BIN" 2

# --- 4. launch with a minimal env + wait for AGENT-READY ----------------------
TIMEOUT_MS="${SD_SMOKE_TIMEOUT_MS:-300000}"
step "launching (HOME=$SMOKE_HOME; ${TIMEOUT_MS}ms budget for AGENT-READY)"

# env -i plus the minimum: strip the CI harness's electron vars
# (ELECTRON_RUN_AS_NODE from a parent would neuter the GUI) and point
# HOME at the quarantine dir. ELECTRON_NO_ATTACH_CONSOLE keeps stdout
# from hanging on an inherited tty the runner no longer reads.
env -i \
  HOME="$SMOKE_HOME" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="en_US.UTF-8" \
  ELECTRON_NO_ATTACH_CONSOLE=1 \
  "$BIN" &
APP_PID=$!
printf '[perf-smoke] app pid %s\n' "$APP_PID" >&2

# find the smoke's log dir (first candidate that exists after launch)
smoke_log_file() {
  for NAME in "${NAME_CANDIDATES[@]}"; do
    F="$SMOKE_HOME/Library/Logs/$NAME/shell.log"
    [ -f "$F" ] && { printf '%s' "$F"; return 0; }
  done
  return 1
}

DEADLINE=$(( $(date +%s) * 1000 + TIMEOUT_MS ))
STATE="timeout"    # ready | exited | timeout
LOG_FILE=""
while :; do
  if LOG_FILE="$(smoke_log_file || true)" && [ -n "$LOG_FILE" ]; then
    if grep -q 'AGENT-READY' "$LOG_FILE" 2>/dev/null; then
      STATE="ready"
      break
    fi
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    STATE="exited"
    break
  fi
  [ "$(date +%s)" -lt $((DEADLINE / 1000)) ] || break
  sleep 2
done

# warmup-done pairs AGENT-READY with the first-chat 200 several seconds
# later; judging the instant AGENT-READY appears would chop that pair off
# and misreport it missing. Give it a short settle window (or drain what
# there is if the app died).
case "$STATE" in
  ready)
    step "AGENT-READY seen — settling (warmup window)"
    for _ in $(seq 1 20); do
      grep -q '\[warmup\] first-chat .*-> 200' "$LOG_FILE" 2>/dev/null && break
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 1
    done
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$APP_PID" 2>/dev/null || true
    ;;
  exited)
    step "app exited during the smoke window — judging whatever it logged"
    ;;
  timeout)
    step "no AGENT-READY within ${TIMEOUT_MS}ms — judging the log (a hang the gate should name)"
    kill -TERM "$APP_PID" 2>/dev/null || true
    sleep 3
    kill -KILL "$APP_PID" 2>/dev/null || true
    ;;
esac
wait "$APP_PID" 2>/dev/null || true

# --- 5. cleanup + judge ---------------------------------------------------------
# Copy the log OUT of the quarantine dir first: the cleanup trap below wipes
# SMOKE_HOME on exit, and the gate must be able to read the log after it.
JUDGE_LOG="$SMOKE_HOME/smoke-shell.log"
LOG_FILE="$(smoke_log_file || true)"
if [ -n "$LOG_FILE" ]; then
  cp "$LOG_FILE" "$JUDGE_LOG"
else
  die "app never wrote a shell.log under $SMOKE_HOME/Library/Logs" 6
fi

# P3-2 hook: a fixed-path copy for CI artifact upload (the quarantine home
# is wiped on exit, so runners need the log somewhere stable to collect
# first-run measurements from — see SD_SMOKE_LOG_OUT above).
if [ -n "${SD_SMOKE_LOG_OUT:-}" ]; then
  mkdir -p "$(dirname "$SD_SMOKE_LOG_OUT")"
  cp "$JUDGE_LOG" "$SD_SMOKE_LOG_OUT" || true   # best effort; never fails the smoke
  printf '[perf-smoke] log copied for collection: %s\n' "$SD_SMOKE_LOG_OUT" >&2
fi

if [ "$KEEP" = "1" ]; then
  printf '[perf-smoke] KEEP=1 — quarantine home kept for debugging: %s\n' "$SMOKE_HOME" >&2
else
  # Wipe AFTER the gate has read the copy — trap guarantees it even on die.
  trap 'rm -rf "$SMOKE_HOME"' EXIT
fi

step "judging $JUDGE_LOG (gate args: ${GATE_ARGS[*]:-none})"
# Pass the gate's own exit code through untouched (0/1/3 are the gate's
# verdicts — the smoke adds nothing on top of its report).
set +e
node "$GATE" "$JUDGE_LOG" "${GATE_ARGS[@]}"
GATE_RC=$?
set -e
exit "$GATE_RC"
