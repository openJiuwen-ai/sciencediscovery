// Shell-side platform decisions (macOS adaptation, D2 §1). Pure fixtures —
// these tests pass identically on a Windows or a macOS dev machine; the
// platform differences are injected, never skipped (F12 philosophy).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  darwinRoleMenu,
  shellLogDirFor,
  shellPlatform,
  shouldInstallRoleMenu,
  shouldQuitOnAllWindowsClosed,
  wantsTray,
} from "../src/shell-platform.ts";

// --- shellLogDirFor (D-mac-01: never write inside a .app bundle) ----------------

const PATHS = {
  exe: "C:\\Program Files\\ScienceDiscovery\\ScienceDiscovery.exe",
  userData: "C:\\Users\\u\\AppData\\Roaming\\sd-shell",
  logs: "/Users/u/Library/Logs/ScienceDiscovery",
};

test("shellLogDirFor dev runs stay on userData on both platforms", () => {
  assert.equal(shellLogDirFor("win32", false, PATHS), `${PATHS.userData}/logs`);
  assert.equal(shellLogDirFor("darwin", false, PATHS), `${PATHS.userData}/logs`);
});

test("shellLogDirFor packaged win32 keeps <install>\\logs (NSIS diagnostics folder)", () => {
  assert.equal(
    shellLogDirFor("win32", true, PATHS),
    "C:\\Program Files\\ScienceDiscovery\\logs",
  );
});

test("shellLogDirFor packaged darwin uses ~/Library/Logs, never the .app bundle", () => {
  // D-mac-01: a notarized bundle breaks its signature on internal writes.
  assert.equal(shellLogDirFor("darwin", true, PATHS), "/Users/u/Library/Logs/ScienceDiscovery");
  assert.ok(!shellLogDirFor("darwin", true, PATHS).includes(".app"));
});

test("shellLogDirFor joins are separator-explicit (same fixture, any host)", () => {
  // The win32 branch always uses backslashes even when run on macOS, and
  // the darwin/dev branches always use forward slashes even on Windows.
  assert.match(shellLogDirFor("win32", true, PATHS), /logs$/);
  assert.ok(shellLogDirFor("win32", true, PATHS).includes("\\"));
  assert.ok(!shellLogDirFor("darwin", true, PATHS).includes("\\"));
});

// --- tray ------------------------------------------------------------------------

test("wantsTray: win32 yes, darwin no (no system-tray culture on macOS)", () => {
  assert.equal(wantsTray("win32"), true);
  assert.equal(wantsTray("darwin"), false);
});

// --- window-all-closed -----------------------------------------------------------

test("shouldQuitOnAllWindowsClosed: darwin never quits (Dock + backend keep running)", () => {
  assert.equal(shouldQuitOnAllWindowsClosed("darwin", false), false);
  assert.equal(shouldQuitOnAllWindowsClosed("darwin", true), false);
});

test("shouldQuitOnAllWindowsClosed: win32 quits only without a tray", () => {
  assert.equal(shouldQuitOnAllWindowsClosed("win32", true), false);
  assert.equal(shouldQuitOnAllWindowsClosed("win32", false), true);
});

// --- application menu ------------------------------------------------------------

test("shouldInstallRoleMenu: darwin only (win32 keeps its null menu)", () => {
  assert.equal(shouldInstallRoleMenu("darwin"), true);
  assert.equal(shouldInstallRoleMenu("win32"), false);
});

test("darwinRoleMenu: app menu owns quit; edit menu owns clipboard roles", () => {
  const spec = darwinRoleMenu(false);
  const appRoles = spec.appMenu.submenu.filter(e => "role" in e).map(e => e.role);
  assert.ok(appRoles.includes("quit"), "Cmd+Q must have a binding");
  assert.ok(appRoles.includes("about"));
  assert.ok(appRoles.includes("hide"));
  const editRoles = spec.editMenu.submenu.filter(e => "role" in e).map(e => e.role);
  for (const r of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
    assert.ok(editRoles.includes(r), `clipboard role ${r} missing — text fields would be dead`);
  }
});

test("darwinRoleMenu: window menu has bring-all-to-front; view menu is dev-only", () => {
  const packaged = darwinRoleMenu(false);
  assert.equal(packaged.viewMenu, null, "no reload/devtools affordances for production users");
  const winRoles = packaged.windowMenu.submenu.filter(e => "role" in e).map(e => e.role);
  assert.deepEqual(winRoles, ["minimize", "zoom", "front"]);

  const dev = darwinRoleMenu(true);
  assert.ok(dev.viewMenu, "dev builds keep reload/devtools");
  const viewRoles = dev.viewMenu!.submenu.filter(e => "role" in e).map(e => e.role);
  assert.ok(viewRoles.includes("reload"));
  assert.ok(viewRoles.includes("toggleDevTools"));
  // Window roles must NOT leak into the dev view menu (they live in windowMenu).
  for (const r of ["minimize", "zoom", "front"]) {
    assert.ok(!viewRoles.includes(r), `${r} belongs to windowMenu, not viewMenu`);
  }
});

// --- host platform narrowing ------------------------------------------------------

test("shellPlatform narrows to the shipped shells and rejects everything else", () => {
  assert.equal(shellPlatform("win32"), "win32");
  assert.equal(shellPlatform("darwin"), "darwin");
  assert.equal(shellPlatform("linux"), null);
  assert.equal(shellPlatform("freebsd"), null);
});
