#!/usr/bin/env bash
# perf-smoke-mac.sh — packaged .app first-launch smoke run for the timing
# gate (P3-1: build-mac.sh's missing "step 6").
#
# macOS FACTS this design is built on (learned the hard way, live run
# 2026-11-25): Electron resolves ~ via getpwuid, NOT $HOME — so a throwaway
# HOME does NOT relocate app.getPath("userData") or ("logs"). The smoke
# therefore works in the REAL home with three containment rails instead:
#
#   rail 1 — the data dir: the wizard state is (backed up,) seeded with
#     step=done + a throwaway dataDir, and restored on exit. Every heavy
#     first-run write (unpack 14k files, venv symlink rewrite, jw home)
#     lands in the dataDir — the throwaway keeps the real one untouched.
#     (The live run that taught this lesson rewrote the real venv python
#     symlinks to the smoke's .app copy because the seeded state was never
#     read and the real dataDir was used. Never again: seed the REAL
#     userData, restore it after.)
#   rail 2 — the log: shell.log is appended in the real
#     ~/Library/Logs/<name>/; the smoke records the byte offset before
#     launch and judges only the appended delta (rotation-safe: if the
#     file shrank past the offset, the whole file is the delta).
#   rail 3 — the single-instance lock: if a ScienceDiscovery is already
#     running the smoke instance would exit instantly (Electron lock) —
#     detect it up front and die with a clear message instead.
#
# The .app itself IS copied to a throwaway dir (first-launch shape, away
# from release/), and the launch env is minimal (env -i: strips the CI
# harness's ELECTRON_* vars; the stack runs on Electron's own binary so
# clean-machine needs nothing from PATH).
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
#   2  usage error (bad .app path / copy failed / instance already running)
#   3  gate: sessions exist but none judged (F1)
#   6  the app produced no judgable log delta at all
# (Timeout and mid-window crashes do NOT get their own codes: the partial
# log is handed to the gate so the HANG is judged from the log with full
# attribution — that is the smoke's whole point.)
#
# Environment:
#   SD_SMOKE_APP          override the .app path (same as argv[1])
#   SD_SMOKE_TIMEOUT_MS   AGENT-READY wait budget, default 300000 (5min —
#                         the agent-ready hang line is 180s, so the smoke
#                         outlives it and the gate gets to JUDGE the hang)
#   SD_SMOKE_KEEP=1       keep the throwaway dirs for debugging (paths
#                         printed on exit; default: wiped)
#   SD_SMOKE_LOG_OUT=path ALSO copy the judged delta to <path> (parent
#                         dirs created). CI sets this to a fixed path so
#                         first-run measurements upload as the P3-2
#                         baseline-collection artifact.
set -euo pipefail

# --- locate everything from this script's own location ------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SHELL_ROOT/scripts/perf-gate.mjs"

step() { printf '\n\033[1;36m[perf-smoke] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[perf-smoke] FAIL: %s\033[0m\n' "$*" >&2; exit "$2"; }

# Electron's app.name — and therefore BOTH ~/Library/{Logs,Application
# Support}/<name> — comes from package.json inside the asar. Observed live
# (2026-11-25 real-machine run): the packaged app writes
# ~/Library/Application Support/sd-shell/ and ~/Library/Logs/sd-shell/.
# The design doc's W1 leftover expects the productName (ScienceDiscovery);
# whichever way W1 lands, seeding/reading BOTH candidates keeps the smoke
# correct without it caring.
NAME_CANDIDATES=(sd-shell ScienceDiscovery)

REAL_HOME="$(/usr/bin/python3 -c 'import os,sys; sys.stdout.write(os.path.expanduser("~"))')"
AS_DIR="$REAL_HOME/Library/Application Support"
LOGS_ROOT="$REAL_HOME/Library/Logs"

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

# --- rail 3: single-instance lock preflight -----------------------------------
if pgrep -f "ScienceDiscovery.app/Contents/MacOS" >/dev/null 2>&1; then
  die "a ScienceDiscovery instance is already running — the smoke instance would lose the Electron single-instance lock and exit instantly. Quit it first." 2
fi

# --- throwaway dirs ------------------------------------------------------------
KEEP="${SD_SMOKE_KEEP:-0}"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sd-perf-smoke.XXXXXX")"
DATA_DIR="$SMOKE_DIR/data"
APP_DIR="$SMOKE_DIR/Applications"
mkdir -p "$DATA_DIR" "$APP_DIR"
trap 'if [ "$KEEP" = "1" ]; then printf "[perf-smoke] KEEP=1 — kept for debugging: %s\n" "$SMOKE_DIR" >&2; else rm -rf "$SMOKE_DIR"; fi' EXIT

# REALPATH FORM for the data dir: on macOS $TMPDIR is the /var/folders/...
# spelling while Electron's process.resourcesPath is realpath'd to
# /private/var/folders/... . bootstrap's fixVenvLaunchers computes the venv
# python symlink as posixRelative(<venvBinDir>, <resourcesPath python>) —
# with MISMATCHED spellings relpath finds no common prefix and emits
# "hop-to-root + absolute" links that resolve to /private/private/... and
# DIE (observed live, run 2: start-stack fail-fasted on the broken venv).
# Seeding the dataDir in the SAME /private spelling the app sees makes the
# relative hop correct. (This is also an app-side latent bug worth an issue:
# any dataDir/.app spelling mismatch breaks the first-run venv fix.)
DATA_DIR="$(/usr/bin/python3 -c 'import os,sys; sys.stdout.write(os.path.realpath(sys.argv[1]))' "$DATA_DIR")"

# --- rail 1: wizard state — backup, seed, restore-on-exit -----------------------
# The REAL userData is used (Electron ignores $HOME on macOS): back up any
# existing wizard-state.json under BOTH name candidates, seed ours, and
# restore on exit — the trap above runs AFTER this restore trap (LIFO).
BACKUPS=()
cleanup_wizard() {
  for spec in "${BACKUPS[@]}"; do
    UD="${spec%%|*}"; BAK="${spec#*|}"
    if [ -f "$BAK" ]; then mv "$BAK" "$UD/wizard-state.json"; else rm -f "$UD/wizard-state.json"; fi
  done
}
trap cleanup_wizard EXIT
for NAME in "${NAME_CANDIDATES[@]}"; do
  UD="$AS_DIR/$NAME"
  mkdir -p "$UD"
  BAK="$SMOKE_DIR/wizard-state-backup-$NAME.json"
  if [ -f "$UD/wizard-state.json" ]; then cp "$UD/wizard-state.json" "$BAK"; fi
  BACKUPS+=("$UD|$BAK")
  # step=done routes past the interactive data-dir wizard (an interactive UI
  # flow never reaches the packaged bootstrap, never emits the kind flag —
  # the gate would exit 3, F1 shape); dataDir pins the throwaway so first-run
  # provisioning (unpack/venv/jw) cannot touch the real data.
  printf '{"step":"done","dataDir":"%s","completedAt":"%s"}\n' \
    "$DATA_DIR" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$UD/wizard-state.json"
done
step "wizard state seeded (step=done, dataDir=$DATA_DIR, real userData, backups taken)"

# --- rail 2: log offset BEFORE launch (rotation-safe delta) --------------------
LOG_PATH=""; LOG_OFFSET=0
for NAME in "${NAME_CANDIDATES[@]}"; do
  L="$LOGS_ROOT/$NAME/shell.log"
  if [ -f "$L" ]; then
    LOG_PATH="$L"
    LOG_OFFSET=$(stat -f%z "$L")
    break
  fi
done
if [ -z "$LOG_PATH" ]; then
  # nothing exists yet — the first candidate the app creates is the one
  LOG_PATH="$LOGS_ROOT/${NAME_CANDIDATES[0]}/shell.log"
fi
step "log: $LOG_PATH (pre-launch offset $LOG_OFFSET bytes; judging only the delta)"

# --- fresh copy of the .app (first-launch shape) --------------------------------
step "copying .app -> $APP_DIR"
BIN="$APP_DIR/$(basename "$APP")/Contents/MacOS/$EXE_NAME"
# realpath the source too: keep the /private spelling everywhere so the
# app's resourcesPath and the seeded dataDir share one prefix (see the
# DATA_DIR realpath note above — the venv symlink hop depends on it).
APP_SRC="$(/usr/bin/python3 -c 'import os,sys; sys.stdout.write(os.path.realpath(sys.argv[1]))' "$APP")"
cp -R "$APP_SRC" "$APP_DIR/" || die "failed to copy .app into $APP_DIR" 2
[ -x "$BIN" ] || die "copied .app lost its executable at $BIN" 2

# --- launch + wait for AGENT-READY ------------------------------------------------
TIMEOUT_MS="${SD_SMOKE_TIMEOUT_MS:-300000}"
step "launching (${TIMEOUT_MS}ms budget for AGENT-READY)"

# env -i: minimal env, strips the harness's ELECTRON_* vars. The stack runs
# on Electron's own binary (ELECTRON_RUN_AS_NODE) and the payload carries
# its own python — nothing from PATH is needed beyond system tools.
env -i \
  HOME="$REAL_HOME" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="en_US.UTF-8" \
  ELECTRON_NO_ATTACH_CONSOLE=1 \
  "$BIN" > "$SMOKE_DIR/app-stdout.log" 2>&1 &
APP_PID=$!
printf '[perf-smoke] app pid %s\n' "$APP_PID" >&2

log_delta_ready() {  # true once the app appended perf lines past the offset
  [ -f "$LOG_PATH" ] || return 1
  local size; size=$(stat -f%z "$LOG_PATH" 2>/dev/null || printf 0)
  [ "$size" -gt "$LOG_OFFSET" ]
}

DEADLINE=$(( $(date +%s) * 1000 + TIMEOUT_MS ))
STATE="timeout"    # ready | exited | timeout
while :; do
  if log_delta_ready && tail -c +"$((LOG_OFFSET + 1))" "$LOG_PATH" 2>/dev/null | grep -q 'AGENT-READY'; then
    STATE="ready"
    break
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
# and misreport it missing. Settle first (or drain what there is if the
# app died).
case "$STATE" in
  ready)
    step "AGENT-READY seen — settling (warmup window)"
    for _ in $(seq 1 20); do
      tail -c +"$((LOG_OFFSET + 1))" "$LOG_PATH" 2>/dev/null | grep -q '\[warmup\] first-chat .*-> 200' && break
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

# --- extract the delta and judge --------------------------------------------------
JUDGE_LOG="$SMOKE_DIR/smoke-shell.log"
if [ -f "$LOG_PATH" ]; then
  SIZE=$(stat -f%z "$LOG_PATH")
  if [ "$SIZE" -lt "$LOG_OFFSET" ]; then
    # rotation happened mid-smoke: the whole file is this run's
    cp "$LOG_PATH" "$JUDGE_LOG"
  else
    tail -c +"$((LOG_OFFSET + 1))" "$LOG_PATH" > "$JUDGE_LOG"
  fi
fi
[ -s "$JUDGE_LOG" ] || die "app produced no log delta at $LOG_PATH (offset was $LOG_OFFSET; see $SMOKE_DIR/app-stdout.log)" 6

if [ -n "${SD_SMOKE_LOG_OUT:-}" ]; then
  mkdir -p "$(dirname "$SD_SMOKE_LOG_OUT")"
  cp "$JUDGE_LOG" "$SD_SMOKE_LOG_OUT" || true   # best effort, never fails the smoke
  printf '[perf-smoke] log copied for collection: %s\n' "$SD_SMOKE_LOG_OUT" >&2
fi

step "judging $JUDGE_LOG (gate args: ${GATE_ARGS[*]:-none})"
# The gate's own exit code passes through untouched (0/1/3 are its verdicts).
# set -e must not eat it: run the gate with +e and forward the code.
set +e
node "$GATE" "$JUDGE_LOG" "${GATE_ARGS[@]}"
GATE_RC=$?
set -e
exit "$GATE_RC"
