#!/usr/bin/env bash
# build-mac.sh — local Mac build gate (macOS adaptation, D3 §4 / D5 §2).
#
# No CI in this repo (2026-11-10 decision): this script IS the pre-release
# gate, run manually in a TERMINAL on the local arm64 Mac (not from inside
# sandboxed agent environments — the brokered-fs shim denies electron-
# builder's staging writes there; problems W11). When CI arrives, this moves
# to a macos-14+ runner unchanged (lessons L1).
#
# Steps (each gates the next; any failure aborts with exit 1):
#   0. environment preflight  — uv present, python provisioned, mirrors set
#   1. darwin shell unit tests — node --test over application/test
#   2. assemble --platform darwin-arm64 — full payload + its own gates
#      (A1 import smoke / A1b runtime probe / A2 required files / A6 bytecode)
#   3. payload spot checks     — darwin path markers, patch manifest, jw deep
#      file, symlink targets (the B3-2 acceptance items)
#   4. swarm-patches verify    — payload patch chain integrity (f25 lesson)
#   5. electron-builder --mac  — TWO modes (B4-1):
#      default: ad-hoc smoke. mac.identity is PINNED to "-" on the CLI —
#      identity auto-discovery is on by default and would silently pick the
#      real Developer ID certificate from the keychain (W12), which is not
#      what a smoke build means. Asserts Signature=adhoc afterwards.
#      SD_MAC_SIGN=1: full Developer ID sign + notarize chain. electron-
#      builder signs and notarizes (+staples) the .app via keychain profile
#      sd-notary; this script then notarizes + staples the DMG itself
#      (notarizing a DMG does not notarize the app inside — both need their
#      own ticket, Apple TN3125), and gates on spctl -a -vv.
#
# Usage:
#   ./build-mac.sh             # full gate, ad-hoc smoke packaging
#   SD_MAC_SIGN=1 ./build-mac.sh   # full gate, signed + notarized release
#   SKIP_EB=1 ./build-mac.sh    # everything except electron-builder (step 5)
#
# Signing-mode credentials (kept out of git; naming per the account doc §4):
#   SD_MAC_SIGN=1 requires all of the signing material below; the default
#   (no env) build is ad-hoc and needs NONE of it:
#   SD_MAC_IDENTITY      REQUIRED when SD_MAC_SIGN=1 — signing identity
#                         string (bare certificate name; no default, inject
#                         from the release runner's keychain / CI secret)
#   SD_NOTARY_PROFILE    notarytool keychain profile (default: sd-notary)
#   SD_MAC_P8 + SD_MAC_KEY_ID + SD_MAC_ISSUER_ID
#                         notarize via the p8 API key directly instead of
#                         the keychain profile (paths/ids only, no secrets)
#   SD_MAC_P12 + SD_MAC_P12_PASS
#                         CI / relocated-machine mode: import the p12 into a
#                         TEMPORARY keychain (created on the fly, deleted on
#                         exit, search list restored) instead of using the
#                         login keychain. NOTE: the notary profile does NOT
#                         travel with the p12 — pair this with SD_MAC_P8, or
#                         store the profile on that machine's keychain first.
#
# Preconditions (the script checks and tells you, it does not provision):
#   - repo built: pnpm build ran at the repo root, services/*/dist exist
#     (the SHELL bundle itself is rebuilt automatically by step 1b — W16)
#   - .sciencediscovery-data provisioned ON THIS MACHINE (uv venvs with
#     darwin python): the repo's setup scripts do this; assemble sanity-
#     checks every input before copying.
set -euo pipefail

# --- locate the shell root from this script's own location -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SHELL_ROOT/.." && pwd)"
DATA_DIR="$REPO_ROOT/.sciencediscovery-data"
OUT_DIR="$SHELL_ROOT/build/resources"

step() { printf '\n\033[1;36m[build-mac] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[build-mac] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. environment preflight -----------------------------------------------
step "0. environment preflight"

# Downloads from GitHub releases 502 through some networks; the npmmirror
# mirrors are the verified path (problems W11 — measured both ways).
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
echo "mirrors: ELECTRON_MIRROR=$ELECTRON_MIRROR"

command -v node >/dev/null 2>&1 || die "node not found on PATH"
echo "node $(node --version)"

# Headroom, not a fix: the real EMFILE fix is the @electron/osx-sign patch
# (patches/@electron__osx-sign@1.3.3.patch — W15). Upstream's pre-signing
# walkAsync fires unbounded concurrent isbinaryfile probes (each holds a raw
# fd across awaits); on this ~92k-file payload that exceeded even
# kern.maxfilesperproc (10240), so NO ulimit raise can fix it. The patch caps
# the probes at 64. This raise just keeps the soft limit comfortably above
# the residual peak (probe cap + codesign child fds + graceful-fs queues).
ulimit -n 4096 2>/dev/null || true
FD_LIMIT="$(ulimit -n)"
if [ "$FD_LIMIT" -lt 1024 ]; then
  die "file-descriptor limit is $FD_LIMIT — too low for packaging. Run: launchctl limit maxfiles 4096 unlimited (and restart the terminal), then rerun"
fi
echo "fd limit: $FD_LIMIT (headroom; EMFILE fix is the osx-sign patch, W15)"

# assemble takes the payload's base interpreter from the venv's realpath'd
# pyvenv.cfg home — the data dir must have been provisioned with a darwin
# python (uv-managed) on THIS machine. Missing dir = provision first.
[ -f "$DATA_DIR/envs/sd-services/pyvenv.cfg" ] \
  || die "missing $DATA_DIR/envs/sd-services/pyvenv.cfg — provision the data dir on this Mac first (uv venvs with darwin python), then rerun"
echo "data dir OK: $DATA_DIR"

[ -f "$REPO_ROOT/services/api/dist/server.js" ] \
  || die "missing services/api/dist — run the repo build (pnpm build) first, then rerun"
echo "repo build OK"

# --- 1. darwin shell unit tests ---------------------------------------------
step "1. darwin shell unit tests"
( cd "$SHELL_ROOT" && node --experimental-strip-types --no-warnings --test test/*.test.ts ) \
  || die "shell unit tests failed"
echo "unit tests green"

# --- 1b. shell bundle rebuild ------------------------------------------------
# W16: the packaged main.cjs must match the src/ that the payload was
# assembled against. A stale dist/ (shell built before a src change, then
# only assemble rerun) ships a new payload with the OLD path layout baked
# into main.cjs — observed live: basePython "python3" (pre-4fa8098) in the
# bundle vs "bin/python3" in src, so SCIENCE_AGENT_PYTHON_PATH pointed at a
# nonexistent file and start-stack fail-fasted. esbuild rebuilds both
# entries in seconds, so the gate owns the shell build instead of trusting
# the "pnpm build ran first" precondition (which the script cannot verify).
step "1b. shell bundle rebuild (esbuild)"
( cd "$SHELL_ROOT" && node scripts/build.mjs ) \
  || die "shell bundle rebuild failed"
[ -f "$SHELL_ROOT/dist/main.cjs" ] || die "shell rebuild produced no dist/main.cjs"
echo "shell bundle fresh: $(stat -f '%Sm' "$SHELL_ROOT/dist/main.cjs")"

# --- 2. assemble darwin-arm64 payload ---------------------------------------
step "2. assemble --platform darwin-arm64"
( cd "$SHELL_ROOT" && node scripts/assemble-backend.mjs --platform darwin-arm64 ) \
  || die "assemble-backend failed"
[ -f "$OUT_DIR/version.json" ] || die "assemble produced no version.json"

# --- 3. payload spot checks (B3-2 acceptance) --------------------------------
step "3. payload darwin spot checks"

# 3a. darwin path-family markers: POSIX interpreter layout, no win32
# trampolines/DLLs anywhere in the payload python trees.
[ -x "$OUT_DIR/python/bin/python3" ] || die "3a: missing <payload>/python/bin/python3"
[ -d "$OUT_DIR/python/lib" ]          || die "3a: missing <payload>/python/lib (POSIX stdlib layout)"
if find "$OUT_DIR/envs-template" -name "python.exe" -print -quit | grep -q .; then
  die "3a: win32 python.exe found in envs-template — payload is not darwin-shaped"
fi
if find "$OUT_DIR/python" -name "*.dll" -print -quit | grep -q .; then
  die "3a: win32 runtime DLLs found in bundled python — payload is not darwin-shaped"
fi
echo "3a. darwin path markers OK (bin/python3, lib/, no python.exe/.dll)"

# 3b. patch manifest: the jw tree carries the patch-state json assemble's
# required-files gate just verified; restate it here for the log.
[ -f "$OUT_DIR/backend/jw/.sciencediscovery-patches.json" ] \
  || die "3b: missing payload patch manifest (.sciencediscovery-patches.json)"
echo "3b. patch manifest present"

# 3c. jw deep file + venv python symlink targets rewritten to the RELATIVE
# bundled hop (W10: shipped venv symlinks must not point at build paths).
JW_DEEP="$OUT_DIR/backend/jw/jiuwenswarm/common/config.py"
[ -f "$JW_DEEP" ] || die "3c: missing deep jw file: $JW_DEEP"
for venv in "$OUT_DIR/backend/jw/.venv" "$OUT_DIR/envs-template/sd-services"; do
  [ -e "$venv/bin/python" ] || die "3c: missing $venv/bin/python"
  target="$(readlink "$venv/bin/python" 2>/dev/null || true)"
  [ -n "$target" ] || die "3c: $venv/bin/python is not a symlink — venv shape changed"
  case "$target" in
    ../*python*) ;;   # relative hop at the bundled interpreter — the W10 fix
    *) die "3c: $venv/bin/python -> $target (not a relative bundled hop — W10 regression?)";;
  esac
done
echo "3c. jw deep file + venv python symlinks OK (relative bundled hops)"

# --- 4. swarm-patches verify (f25 lesson: apply/verify double exit 0) --------
step "4. swarm-patches verify (payload patch chain)"
# Direct swarm-patches.py invocation (same as scripts/jiuwenswarm.mjs does):
# verify <target> <tag> over the PAYLOAD's jw tree with the payload's own
# venv python — proves the shipped tree matches the patch manifest.
JW_VENV_PY="$OUT_DIR/backend/jw/.venv/bin/python"
JW_TAG="${JIUWENSWARM_TAG:-workswarm0.2.6}"
if [ -e "$JW_VENV_PY" ]; then
  "$JW_VENV_PY" "$REPO_ROOT/scripts/swarm-patches.py" verify "$OUT_DIR/backend/jw" "$JW_TAG" \
    || die "swarm-patches verify failed on the payload jw tree"
  echo "patch chain verify OK (tag=$JW_TAG)"
else
  die "payload jw venv python missing at $JW_VENV_PY (assemble step should have failed first)"
fi

# --- 5. electron-builder packaging (B3-3 smoke / B4-1 sign+notarize) --------
step "5. electron-builder --mac"
if [ "${SKIP_EB:-0}" = "1" ]; then
  echo "SKIP_EB=1 — skipping electron-builder (gate reduced to payload checks)"
else
  # --- 5a. resolve the signing mode ----------------------------------------
  # Default is ad-hoc SMOKE. Identity auto-discovery (CSC_IDENTITY_AUTO_DISCOVERY,
  # on by default) would silently pick the real Developer ID certificate now
  # living in the login keychain (W12) — so ad-hoc is PINNED via the CLI
  # dot-config override; setting CSC_NAME=- instead would NOT work (env var
  # is consumed by the inner findIdentity, which misses "-" and falls through
  # to reportError → signing silently skipped; qualifier "-" is only honored
  # from mac.identity — verified against app-builder-lib@26.15.3 sources).
  # NOTE: 26.15.3 REJECTS a "Developer ID Application:" prefix in
  # mac.identity ("Please remove prefix ... appropriate certificate will be
  # chosen automatically" — first SD_MAC_SIGN=1 run, 2026-11-12). The bare
  # cert name (e.g. "Haowen Zhong (UGV44NUA6W)") is what findIdentity matches.
  # Review F2/F5: NO personal default — the signing identity MUST be injected
  # (SD_MAC_IDENTITY env, e.g. from a CI secret or the release runner's
  # keychain) so an "official" build can never silently sign as an
  # individual contributor's certificate. The requirement is enforced INSIDE
  # the SD_MAC_SIGN=1 branch only: ad-hoc smoke builds (the default) and
  # build-mac-from-scratch.sh never need an identity and must keep running
  # without any SD_MAC_* env.
  SD_MAC_IDENTITY="${SD_MAC_IDENTITY:-}"
  SD_NOTARY_PROFILE="${SD_NOTARY_PROFILE:-sd-notary}"

  # --- 5b. temporary-keychain lifecycle (CI / relocated machine mode) --------
  # Trap-based cleanup: delete the keychain and restore the search list no
  # matter how the script exits (AppleDeveloper账号.md §4 discipline: p12
  # material lives in a throwaway keychain, never persisted in the login one).
  TEMP_KEYCHAIN=""
  TEMP_KEYCHAIN_SAVED_ARGS=()
  restore_temp_keychain() {
    if [ -n "$TEMP_KEYCHAIN" ]; then
      security delete-keychain "$TEMP_KEYCHAIN" >/dev/null 2>&1 || true
      if [ "${#TEMP_KEYCHAIN_SAVED_ARGS[@]}" -gt 0 ]; then
        security list-keychain -d user -s "${TEMP_KEYCHAIN_SAVED_ARGS[@]}" >/dev/null 2>&1 || true
      fi
    fi
  }
  trap restore_temp_keychain EXIT

  if [ "${SD_MAC_SIGN:-0}" = "1" ]; then
    # Full signed release. electron-builder does: .app sign (hardened runtime
    # + entitlements) → notarize via keychain profile → staple — all before
    # DMG/zip packaging, so the zip update carrier embeds the notarized state
    # (D4 §5). The DMG itself is signed by dmg.sign:true; its notarization
    # ticket + staple happen in 5e (TN3125: DMG and app tickets are separate).
    # Review F2/F5: the identity requirement lives HERE — only the signed
    # release needs it. Ad-hoc smoke builds never read SD_MAC_IDENTITY.
    if [ -z "$SD_MAC_IDENTITY" ]; then
      die "SD_MAC_SIGN=1 requires SD_MAC_IDENTITY (bare certificate name, no 'Developer ID Application:' prefix) — inject it from the release runner's keychain or CI secret; there is deliberately no default"
    fi
    case "$SD_MAC_IDENTITY" in
      "Developer ID Application:"*|"Developer ID Installer:"*) \
        die "SD_MAC_IDENTITY must be the bare certificate name (26.15.3 rejects the 'Developer ID Application:' prefix): $SD_MAC_IDENTITY" ;;
    esac
    unset CSC_NAME || true
    unset CSC_KEYCHAIN || true
    if [ -n "${SD_MAC_P12:-}" ]; then
      # CI/relocation mode: import the p12 into a throwaway keychain.
      [ -f "$SD_MAC_P12" ] || die "SD_MAC_P12 set but file not found: $SD_MAC_P12"
      [ -n "${SD_MAC_P12_PASS:-}" ] || die "SD_MAC_P12 set but SD_MAC_P12_PASS missing"
      TEMP_KEYCHAIN="build-sd-$$.keychain"
      # save the WHOLE search list (multi-keychain setups) and restore it
      # verbatim. macOS ships bash 3.2 — no mapfile; read into a plain string
      # and let word-splitting do its thing inside the quoted-array expansion.
      KEYCHAIN_SAVED_STR="$(security list-keychain -d user | tr -d ' "')"
      TEMP_KEYCHAIN_SAVED_ARGS=($KEYCHAIN_SAVED_STR)
      security create-keychain -p "$SD_MAC_P12_PASS" "$TEMP_KEYCHAIN" \
        || die "failed to create temporary keychain $TEMP_KEYCHAIN"
      security import "$SD_MAC_P12" -k "$TEMP_KEYCHAIN" -P "$SD_MAC_P12_PASS" \
        -T /usr/bin/codesign -T /usr/bin/security \
        || die "failed to import p12 into $TEMP_KEYCHAIN"
      # order matters: keychain-name LAST (account doc §4 template)
      security set-key-partition-list -S apple-tool:,apple:,codesign: \
        -s -k "$SD_MAC_P12_PASS" "$TEMP_KEYCHAIN" >/dev/null \
        || die "failed to set-key-partition-list on $TEMP_KEYCHAIN"
      security list-keychain -d user -s "$TEMP_KEYCHAIN" ${TEMP_KEYCHAIN_SAVED_ARGS[@]+"${TEMP_KEYCHAIN_SAVED_ARGS[@]}"} \
        || die "failed to add $TEMP_KEYCHAIN to the keychain search list"
      export CSC_KEYCHAIN="$TEMP_KEYCHAIN"
      export CSC_NAME="$SD_MAC_IDENTITY"
      echo "CI mode: temporary keychain $TEMP_KEYCHAIN imported (auto-deleted on exit)"
    else
      # This-machine mode: identity lives in the login keychain (B0-1); the
      # yml-level identity pin is handled by the CLI dot-config below.
      export CSC_NAME="$SD_MAC_IDENTITY"
    fi

    # Notarization credentials for the .app (electron-builder native path):
    # APPLE_KEYCHAIN_PROFILE matches getNotarizeOptions() priority — Apple ID
    # group > API key group > keychain profile. Clear the higher-priority
    # groups so a stale env can't hijack the mode (they'd also throw on
    # partial sets).
    unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID || true
    unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER || true
    if [ -n "${SD_MAC_P8:-}" ]; then
      [ -f "$SD_MAC_P8" ] || die "SD_MAC_P8 set but file not found: $SD_MAC_P8"
      [ -n "${SD_MAC_KEY_ID:-}" ] || die "SD_MAC_P8 set but SD_MAC_KEY_ID missing"
      [ -n "${SD_MAC_ISSUER_ID:-}" ] || die "SD_MAC_P8 set but SD_MAC_ISSUER_ID missing"
      export APPLE_API_KEY="$SD_MAC_P8"
      export APPLE_API_KEY_ID="$SD_MAC_KEY_ID"
      export APPLE_API_ISSUER="$SD_MAC_ISSUER_ID"
      echo "notary credentials: p8 API key ($SD_MAC_KEY_ID)"
    else
      export APPLE_KEYCHAIN_PROFILE="$SD_NOTARY_PROFILE"
      # Fail fast if the profile is missing (Agent-sandboxed probes can't see
      # keychain items, but the user terminal runs this — a hard die with the
      # recovery path is the honest gate here).
      if ! xcrun notarytool history --keychain-profile "$SD_NOTARY_PROFILE" >/dev/null 2>"$SHELL_ROOT/.notarytool-probe.err"; then
        cat "$SHELL_ROOT/.notarytool-probe.err" >&2 || true
        rm -f "$SHELL_ROOT/.notarytool-probe.err"
        die "notarytool profile '$SD_NOTARY_PROFILE' not usable — store it first:
  xcrun notarytool store-credentials $SD_NOTARY_PROFILE --key <p8> --key-id <key-id> --issuer <issuer-id>
(notary credentials doc lives outside this repo)"
      fi
      rm -f "$SHELL_ROOT/.notarytool-probe.err"
      echo "notary credentials: keychain profile $SD_NOTARY_PROFILE"
    fi

    EB_ARGS=(--mac --config.mac.identity="$SD_MAC_IDENTITY")
  else
    # Ad-hoc smoke: pin identity to "-" so auto-discovery can't pick the
    # real certificate (W12). Asserts Signature=adhoc after packaging.
    unset CSC_NAME CSC_KEYCHAIN || true
    unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID || true
    unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_KEYCHAIN_PROFILE || true
    EB_ARGS=(--mac --config.mac.identity=-)
  fi

  ( cd "$SHELL_ROOT" && npx electron-builder "${EB_ARGS[@]}" ) \
    || die "electron-builder --mac failed"

  # --- 5b-bis. version-pinned artifact discovery (review F11) ----------------
  # A glob over release/ can pick up STALE artifacts from earlier builds
  # (the dir is not wiped between runs) — an older DMG/zip would then be
  # signed, notarized and listed as "the" release. Pin the discovery to
  # THIS build's version from package.json and assert exactly one match.
  APP_VERSION="$(node -p "require('$SHELL_ROOT/package.json').version")"
  [ -n "$APP_VERSION" ] || die "could not read version from $SHELL_ROOT/package.json"
  # macOS ships bash 3.2 — no mapfile; find|grep into newline-split strings,
  # count with wc, index with sed (same style as the keychain list above).
  DMG_LIST="$(find "$SHELL_ROOT/release" -maxdepth 1 -name "*-${APP_VERSION}-*.dmg" 2>/dev/null || true)"
  DMG_COUNT="$(printf '%s' "$DMG_LIST" | grep -c . || true)"
  [ "$DMG_COUNT" = "1" ] \
    || die "expected exactly 1 DMG matching *-${APP_VERSION}-*.dmg, found ${DMG_COUNT}:
$DMG_LIST"
  DMG="$(printf '%s\n' "$DMG_LIST" | sed -n '1p')"
  ZIP_LIST="$(find "$SHELL_ROOT/release" -maxdepth 1 -name "*-${APP_VERSION}-mac-*.zip" 2>/dev/null | grep -v '\.blockmap$' || true)"
  ZIP_COUNT="$(printf '%s' "$ZIP_LIST" | grep -c . || true)"
  [ "$ZIP_COUNT" = "1" ] \
    || die "expected exactly 1 zip matching *-${APP_VERSION}-mac-*.zip, found ${ZIP_COUNT}:
$ZIP_LIST"
  ZIP="$(printf '%s\n' "$ZIP_LIST" | sed -n '1p')"
  APP="$SHELL_ROOT/release/mac-arm64/ScienceDiscovery.app"
  [ -d "$APP" ] || die "no packed .app at $APP"
  echo "artifacts: $(basename "$DMG"), $(basename "$ZIP")"

  # --- 5c. signature assertion (both modes gate here) -----------------------
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 \
    || die "codesign verify failed on the packed .app"
  SIGN_INFO="$(codesign -dv --verbose=2 "$APP" 2>&1 || true)"
  if [ "${SD_MAC_SIGN:-0}" = "1" ]; then
    # Authority must carry the Developer ID Application chain AND match the
    # exact identity requested (SD_MAC_IDENTITY) — a different signer would
    # fail the "migration-period dual-signer" rule (D4 §4) upstream anyway.
    printf '%s\n' "$SIGN_INFO" | grep -q '^Authority=Developer ID Application' \
      || die ".app is not Developer ID-signed — expected Authority=Developer ID Application, got:
$SIGN_INFO"
    printf '%s\n' "$SIGN_INFO" | grep -q "Authority=.*$SD_MAC_IDENTITY" \
      || die ".app signed by a different identity than requested:
  requested: $SD_MAC_IDENTITY
$SIGN_INFO"
    printf '%s\n' "$SIGN_INFO" | grep -q '^TeamIdentifier=.\+' \
      || die ".app TeamIdentifier is empty:
$SIGN_INFO"
    echo "codesign verify OK (Developer ID + hardened runtime, identity match)"
  else
    printf '%s\n' "$SIGN_INFO" | grep -q '^Signature=adhoc' \
      || die ".app is NOT ad-hoc signed — identity pin failed (W12 regression?):
$SIGN_INFO"
    echo "codesign verify OK (ad-hoc pinned)"
  fi

  # --- 5d. notarization gate on the .app (sign mode only) -------------------
  if [ "${SD_MAC_SIGN:-0}" = "1" ]; then
    # electron-builder's notarizeIfProvided() already notarized + STAPLED the
    # .app during packaging (retry x3). The staple lives INSIDE the .app, and
    # the DMG/zip artifacts were built from those exact bytes — post-hoc
    # patching cannot repair a stale zip, so a failed validation is a hard
    # die (rerun the gate), never a silent local re-staple.
    xcrun stapler validate "$APP" 2>/dev/null \
      || die ".app notarization staple missing/invalid — the DMG and zip embed
these bytes, do NOT hand-fix; rerun this gate after checking the notary log
  xcrun notarytool log <submission-id> --keychain-profile $SD_NOTARY_PROFILE
(a rebuild fixes the zip; a hand re-staple would leave stale bytes inside DMG/zip)"
    echo ".app notarized + staple validated"
  fi

  # --- 5e. DMG notarization + Gatekeeper gate (sign mode only) --------------
  if [ "${SD_MAC_SIGN:-0}" = "1" ]; then
    # The DMG carries its own ticket (TN3125: stapling the DMG does NOT cover
    # the app inside; the app inside was already notarized+stapled in 5d).
    # notarytool accepts the DMG bundle directly; submit then staple the DMG.
    if [ -n "${SD_MAC_P8:-}" ]; then
      xcrun notarytool submit "$DMG" --key "$SD_MAC_P8" \
        --key-id "$SD_MAC_KEY_ID" --issuer "$SD_MAC_ISSUER_ID" --wait \
        || die "notarytool submit (DMG) failed"
    else
      xcrun notarytool submit "$DMG" --keychain-profile "$SD_NOTARY_PROFILE" --wait \
        || die "notarytool submit (DMG) failed"
    fi
    xcrun stapler staple "$DMG" || die "stapler staple (DMG) failed"
    xcrun stapler validate "$DMG" || die "stapler validate (DMG) failed"
    # The M4 exit criterion, gated per release: Gatekeeper assessment must
    # accept both the installer and the app. (Command substitution instead
    # of a pipe: `spctl | grep -q` under pipefail dies on SIGPIPE once grep
    # exits early — capture once, grep the string.)
    # [mac-desktop] W24 — a DMG needs --context context:primary-signature:
    # without it Gatekeeper answers "Insufficient Context" (observed on the
    # first fully-notarized DMG, 2026-11-13: staple+validate both green,
    # plain `spctl -a -t open` rejected, the context-flagged form accepted
    # "source=Notarized Developer ID"). The .app assesses fine without a
    # context; the flag is DMG-only.
    SPCTL_DMG="$(spctl -a -vv -t open --context context:primary-signature "$DMG" 2>&1 || true)"
    printf '%s\n' "$SPCTL_DMG" | grep -q 'accepted' \
      || die "spctl rejected the DMG: $SPCTL_DMG"
    SPCTL_APP="$(spctl -a -vv -t execute "$APP" 2>&1 || true)"
    printf '%s\n' "$SPCTL_APP" | grep -q 'accepted' \
      || die "spctl rejected the .app: $SPCTL_APP"
    echo "spctl accepted DMG + .app — notarized release OK"

    # --- 5f. release asset manifest (B4-2: upload is manual, this gates) ---
    # The zip target emits latest-mac.yml + .blockmap alongside the carrier
    # zip (ArchiveTarget isWriteUpdateInfo=true — requires the publish
    # section to exist, which is why electron-builder.yml carries it).
    # Gate: all four assets must exist; upload itself is MANUAL (gh CLI or
    # the GitHub web UI) — commands printed below, run after review.
    LATEST_YML="$SHELL_ROOT/release/latest-mac.yml"
    [ -f "$LATEST_YML" ] || die "5f: missing latest-mac.yml (zip target did not write update info — is the publish section present in electron-builder.yml?)"
    BLOCKMAP="${ZIP%.zip}.blockmap"
    [ -f "$BLOCKMAP" ] || die "5f: missing ${BLOCKMAP##*/} (differential update data)"
    # F11: the update feed must describe THIS build. A stale yml from an
    # earlier run (or a mismatched version) would push the wrong update to
    # every user — gate the version and the exact carrier filename.
    # (electron-builder writes `url:` entries + a `path:` carrier field.)
    YML_VERSION="$(sed -n 's/^version: *//p' "$LATEST_YML" | head -1)"
    [ "$YML_VERSION" = "$APP_VERSION" ] \
      || die "5f: latest-mac.yml version '$YML_VERSION' != this build's $APP_VERSION — stale update info, rerun the gate"
    grep -q "url: $(basename "$ZIP")" "$LATEST_YML" \
      || die "5f: latest-mac.yml does not list this build's zip '$(basename "$ZIP")' — stale update info, rerun the gate"
    echo ""
    echo "=== release asset manifest (upload manually, D4 §1) ==================="
    for asset in "$DMG" "$ZIP" "$LATEST_YML" "$BLOCKMAP"; do
      printf '  %s  (%s bytes)\n' "$(basename "$asset")" "$(stat -f%z "$asset")"
    done
    echo "======================================================================="
    echo "Create a draft release (v${SD_RELEASE_TAG:-<version>}), upload all four assets,"
    echo "verify Gatekeeper on a clean machine, then publish. gh CLI:"
    echo "  gh release create v<version> \\"
    echo "    '$DMG' '$ZIP' '$LATEST_YML' '$BLOCKMAP' --draft --title 'v<version>'"
    echo "or with the API token electron-builder knows:"
    if [ "${SD_MAC_SIGN:-0}" = "1" ]; then
      echo "  GH_TOKEN=<token> npx electron-builder --mac --publish always \\"
      echo "    --config.mac.identity='$SD_MAC_IDENTITY'"
    else
      echo "  (this ad-hoc smoke build has no signing identity — for a signed"
      echo "   release rerun with SD_MAC_SIGN=1 + SD_MAC_IDENTITY)"
    fi
    echo "(update-source URL is frozen from first public release — D4 §5 iron rule;"
    echo " the publish block in electron-builder.yml IS that source of truth)"
  fi
fi

step "gate passed — payload at $OUT_DIR"
