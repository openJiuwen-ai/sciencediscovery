import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryFootprints, uninstallFootprints } from "../src/uninstall-data.ts";

// userData/logs are runtime-injected (app.getPath) — these tests pin the
// pass-through contract, not baked paths. Note Electron names userData after
// package.json's name even in packaged builds: the REAL packaged userData is
// ~/Library/Application Support/sd-shell, not the productName (verified on a
// real install 2026-11-16; see scripts/uninstall-mac.command guards below).
const RUNTIME = {
  userDataDir: "/Users/tester/Library/Application Support/ScienceDiscovery",
  logsDir: "/Users/tester/Library/Logs/ScienceDiscovery",
};

test("darwin library footprints: the four ~/Library scatter locations", () => {
  const fps = libraryFootprints("/Users/tester", "darwin", RUNTIME);
  assert.equal(fps.length, 4);
  assert.deepEqual(
    fps.map(f => f.id),
    ["app-support", "logs", "prefs", "saved-state"],
  );
  assert.equal(fps[0].path, RUNTIME.userDataDir);
  assert.equal(fps[1].path, RUNTIME.logsDir);
  assert.equal(fps[2].path, "/Users/tester/Library/Preferences/cn.sciencediscovery.desktop.plist");
  assert.equal(fps[3].path, "/Users/tester/Library/Saved Application State/cn.sciencediscovery.desktop.savedState");
});

test("darwin footprints: runtime paths are passed through verbatim (no hardcoding)", () => {
  const custom = { userDataDir: "/custom/user-data", logsDir: "/custom/logs" };
  const fps = libraryFootprints("/Users/tester", "darwin", custom);
  assert.equal(fps[0].path, "/custom/user-data");
  assert.equal(fps[1].path, "/custom/logs");
});

test("darwin footprints: null runtime paths list as unknown (dialog shows placeholder)", () => {
  const fps = libraryFootprints("/Users/tester", "darwin", { userDataDir: null, logsDir: null });
  assert.equal(fps[0].path, null);
  assert.equal(fps[1].path, null);
});

test("win32: no library footprints — the NSIS uninstaller owns that flow", () => {
  assert.deepEqual(libraryFootprints("C:\\Users\\tester", "win32", RUNTIME), []);
});

test("uninstallFootprints: wizard data dir leads the list, Library scatter follows", () => {
  const fps = uninstallFootprints("/Users/tester/ScienceDiscovery", "/Users/tester", "darwin", RUNTIME);
  assert.equal(fps.length, 5);
  assert.equal(fps[0].id, "data-dir");
  assert.equal(fps[0].path, "/Users/tester/ScienceDiscovery");
  assert.equal(fps[0].label.includes("主数据目录"), true);
  assert.equal(fps[4].id, "saved-state");
});

test("uninstallFootprints: null data dir (dev, no wizard) → Library-only list", () => {
  const fps = uninstallFootprints(null, "/Users/tester", "darwin", RUNTIME);
  assert.equal(fps.length, 4);
  assert.equal(fps.every(f => f.path !== null), true);
});

test("every footprint carries a zh label (dialog renders them raw)", () => {
  const fps = uninstallFootprints("/data", "/Users/tester", "darwin", RUNTIME);
  for (const f of fps) {
    assert.equal(typeof f.label, "string");
    assert.ok(f.label.length > 0);
  }
});

// --- scripts/uninstall-mac.command guards (offline cleanup companion) ---------
// The .command is bash (not importable); guard its INVENTORIES so a path
// or mode rename inside the script cannot silently drift from the in-app
// dialog (uninstall-data.ts). Same style as installer-nsh.test.cjs, which
// guards another non-TS packaged artifact.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "uninstall-mac.command");

test("uninstall-mac.command: syntax-clean under macOS bash 3.2 (bash -n)", async () => {
  const { execFileSync } = await import("node:child_process");
  // bash -n parses without executing; /bin/bash on macOS IS 3.2.
  execFileSync("/bin/bash", ["-n", SCRIPT]);
});

test("uninstall-mac.command: covers every libraryFootprints location (aligned, not hardcoded)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // The offline script cannot read runtime-injected paths, so it hardcodes
  // runtime-shaped guesses. Derive the expected needles from
  // libraryFootprints() itself: a rename/move in uninstall-data.ts must
  // fail here until the script follows — no silent drift (F20).
  const RUNTIME_GUESS = {
    // Electron names userData after package.json's name, NOT productName.
    userDataDir: "/Users/tester/Library/Application Support/sd-shell",
    logsDir: "/Users/tester/Library/Logs/ScienceDiscovery",
  };
  for (const f of libraryFootprints("/Users/tester", "darwin", RUNTIME_GUESS)) {
    if (!f.path) throw new Error(`footprint ${f.id} unexpectedly null`);
    const parts = f.path.split("/");
    const parent = parts[parts.length - 2] ?? "";
    const base = parts[parts.length - 1] ?? "";
    // prefs is built from $BUNDLE_ID in bash — match the id, not "…/<id>.plist".
    const needle = f.id === "prefs" ? base.replace(/\.plist$/, "") : `${parent}/${base}`;
    assert.ok(src.includes(needle),
      `script must clear footprint ${f.id} (expected "${needle}" from libraryFootprints)`);
  }
  // logsDir is runtime-injected and the script cannot know which name
  // Electron actually used — BOTH candidates must be probed (F20). The
  // loop above pins the productName candidate via logsDir; pin the
  // package-name one here.
  assert.ok(src.includes("Library/Logs/sd-shell"),
    "script must probe BOTH log-dir candidates (package name sd-shell AND productName ScienceDiscovery)");
});

test("uninstall-mac.command: data-dir discovery chain (wizard record first)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(src.includes("wizard-state.json"),
    "script must read the wizard-recorded data dir (same source of truth as the in-app dialog)");
  assert.ok(src.includes("data-dir.txt"),
    "script must fall back to the persisted data-dir marker");
});

test("uninstall-mac.command: safe-delete semantics (trash not rm, backup before delete)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(src.includes(".Trash/"),
    "deletions must move to Trash with a stamp suffix, never rm (recoverable)");
  assert.ok(!/\brm[ \t]+-[rf]/.test(src),
    "script must not contain rm -rf — recovery guarantee");
  assert.ok(src.includes("model-secrets.key"),
    "critical data (model key) must be backed up before any deletion");
  assert.ok(src.includes("Backup")
    || src.includes("备份"),
    "backup step must exist");
});

test("uninstall-mac.command: trash targets carry a source prefix + collision counter (F19 no-nesting)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // Two SCATTER basenames collide (sd-shell under Caches AND Logs,
  // cn.sciencediscovery.desktop under HTTPStorages AND WebKit); with a
  // single STAMP the second mv would nest INSIDE the first Trash dir.
  // Guard 1: the mv target interpolates a parent-derived prefix.
  assert.ok(src.includes(".Trash/${prefix}-${base}-${STAMP}"),
    "to_trash target must be <parent>-<base>-<stamp> so same-basename sources diverge");
  // Guard 2 (bot round 10): /Applications and ~/Applications BOTH have the
  // parent basename "Applications", so the prefix alone still collides —
  // an exists-check loop with a counter suffix must take the next free slot.
  assert.ok(/while \[ -e "\$target" \]; do[\s\S]{0,150}?n=\$\(\(n \+ 1\)\)[\s\S]{0,150}?target="[^"]*\$\{prefix\}-\$\{base\}-\$\{STAMP\}-\$\{n\}"/.test(src),
    "to_trash must probe for an existing target and append a counter instead of nesting into it");
});

test("uninstall-mac.command: ANSI colors baked into variables at definition (F18)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // '\\033[...' in single quotes is a literal backslash that only a printf
  // FORMAT string would interpret; echo and printf '%s' args print it raw
  // (bot reproduced; cat -v confirms). Baking the bytes with printf at
  // definition time makes EVERY consumer correct.
  assert.ok(/GREEN="\$\(\(printf '\033\[0;32m'\)\)"|GREEN="\$\(\(printf '\\033\[0;32m'\)\)"/.test(src) || src.includes('GREEN="$(printf \'\\033[0;32m\')"'),
    "color vars must be built with $(printf ...) so the escape bytes are in the VALUE, not interpreted per-consumer");
  assert.ok(!/^(RED|GREEN|YELLOW|CYAN|BOLD|OFF)='\\033/m.test(src),
    "no color var may keep the literal '\\033' in single quotes (raw-backslash trap)");
});

test("uninstall-mac.command: data-dir gate before grep -F pid match (F24 no wide-dir kills)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // DATA_DIR comes from an unvalidated wizard record; pointing it at / or
  // $HOME makes the literal grep -F match EVERY python process under that
  // tree and kill -9 sweeps unrelated user tasks. The grep arm must sit
  // behind a safety gate; the pgrep bundle-signature arm stays unconditional.
  assert.ok(src.includes("data_dir_safe_for_match"),
    "a data-dir validity gate must exist");
  const gateIdx = src.indexOf("data_dir_safe_for_match()");
  const grepIdx = src.indexOf('grep -F -- "$DATA_DIR"');
  assert.ok(gateIdx > 0 && grepIdx > gateIdx,
    "the grep -F arm must be gated behind data_dir_safe_for_match");
  for (const guard of ['[ "$DATA_DIR" = "/" ]', '[ "$DATA_DIR" = "$HOME" ]', "case \"$DATA_DIR\" in /*)"]) {
    assert.ok(src.includes(guard),
      `gate must reject this wide-dir shape: ${guard}`);
  }
});

test("uninstall-mac.command: final audit covers SCATTER (F23 honest verdict)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // 3/4 moves SCATTER items but the 4/4 audit only checked app/data/state —
  // a failed mv still ended in "全部清理完成". The audit loop must include
  // SCATTER so the end-of-run verdict is honest.
  const auditIdx = src.indexOf("== 4/4 复核 ==");
  assert.ok(auditIdx > 0, "the 4/4 audit stage must exist");
  const auditSlice = src.slice(auditIdx, auditIdx + 1600);
  assert.ok(auditSlice.includes('for p in "${SCATTER[@]}"; do check_gone "$p"; done'),
    "the 4/4 audit must re-check every SCATTER item");
  assert.ok(src.includes("分发定位"),
    "F21: the header must state the distribution decision (repo-side script, Release-asset channel)");
});

test("uninstall-mac.command: graceful-quit window covers the app's own stack.stop grace (F22)", async () => {
  const src = readFileSync(SCRIPT, "utf8");
  const { execFileSync } = await import("node:child_process");
  // The app's stack.stop() waits up to 15s (stack.ts stop(timeoutMs=15_000))
  // before SIGKILLing the backend group. The script must wait at least that
  // long before force-killing, or it kills mid-shutdown and orphans the
  // detached backend it was trying to reap.
  const m = src.match(/-lt (\d+) \]; do[\s\S]{0,120}sleep 0\.5/);
  assert.ok(m, "quit_app must have a bounded poll loop sleeping 0.5s");
  const waitSecs = Number(m[1]) * 0.5;
  assert.ok(waitSecs >= 15,
    `graceful-quit window ${waitSecs}s must be >= the app's own 15s stack.stop grace`);
  // And after the app exits, leftover detached backends must be checked
  // (kill -9 does not cascade; the loop resweeps) before touching data.
  assert.ok(src.includes("kill_leftover_backend"),
    "leftover-backend sweep must exist and run after quit_app");
  assert.ok(src.includes("start-stack") || src.includes("ScienceDiscovery[.]app/Contents"),
    "leftover detection must key on the packaged backend's argv signature");
});

test("uninstall-mac.command: all four modes present and numbered consistently", () => {
  const src = readFileSync(SCRIPT, "utf8");
  for (const mode of ["完全卸载", "只卸载软件", "数据重置", "查看路径"]) {
    assert.ok(src.includes(mode), `mode ${mode} must appear in the menu`);
  }
  assert.ok(src.includes('[0-4]'), "menu prompt must accept 0-4");
});
