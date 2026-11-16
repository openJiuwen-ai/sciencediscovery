// Shell-side platform dispatch — the single entry consumers import (macOS
// adaptation, D2 §1; same contract as packages/cas/src/platform/index.ts).
// Platform files (win32.ts / darwin.ts) are never imported directly, and no
// `process.platform === "win32"` branches may appear in consumer code.
//
// Everything here is pure so the darwin branches get full fixture coverage
// on any machine (same philosophy as the Windows F12 tag rule: inject, don't skip).

import type { ShellLogPaths, ShellPlatform, VenvLayout } from "./types.ts";
import {
  shouldInstallRoleMenuWin32,
  shouldQuitOnAllWindowsClosedWin32,
  shellLogDirPackagedWin32,
  venvLayoutWin32,
  wantsTrayWin32,
} from "./win32.ts";
import {
  darwinRoleMenu,
  shouldInstallRoleMenuDarwin,
  shouldQuitOnAllWindowsClosedDarwin,
  shellLogDirPackagedDarwin,
  venvLayoutDarwin,
  wantsTrayDarwin,
} from "./darwin.ts";

export type { RoleMenuEntry, RoleMenuSpec, ShellPlatform, VenvLayout } from "./types.ts";
export { darwinRoleMenu } from "./darwin.ts";

// --- host platform, resolved once at module load --------------------------------

export function shellPlatform(platform: NodeJS.Platform): ShellPlatform | null {
  if (platform === "win32" || platform === "darwin") return platform;
  return null;
}

/** Host platform, resolved once at module load (main.ts consumes this). */
export const IS_DARWIN = shellPlatform(process.platform) === "darwin";

/** The shell platform this process runs on, pre-narrowed. Callers that
 * want injectable platform decisions take a ShellPlatform parameter and
 * default it to this (tests inject the other side explicitly). */
export const CURRENT_SHELL_PLATFORM: "win32" | "darwin" = IS_DARWIN ? "darwin" : "win32";

// --- shared pure decisions (platform-agnostic, dispatch-free) -------------------

/** Parse the CPython minor version ("12" for 3.12) out of a pyvenv.cfg
 *  `version_info = 3.12.x` line. Pure; null when absent/unreadable. */
export function pythonMinorFromPyvenvCfg(cfgText: string): string | null {
  const m = cfgText.match(/^version_info\s*=\s*(\d+)\.(\d+)/m);
  return m ? m[2] : null;
}

// --- shell.log location (D-mac-01) -----------------------------------------------

/**
 * Where shell.log lives. Dev runs stay on userData on both platforms.
 * Packaged builds differ per platform — see win32.ts / darwin.ts for the
 * platform rationale.
 */
export function shellLogDirFor(
  platform: "win32" | "darwin",
  packaged: boolean,
  paths: ShellLogPaths,
): string {
  if (!packaged) {
    const base = paths.userData.replace(/\/+$/, "");
    return `${base}/logs`;
  }
  return platform === "darwin"
    ? shellLogDirPackagedDarwin(paths)
    : shellLogDirPackagedWin32(paths);
}

// --- bundled payload layout (bootstrap.ts path families) -------------------------

export function venvLayoutFor(platform: "win32" | "darwin"): VenvLayout {
  return platform === "darwin" ? venvLayoutDarwin() : venvLayoutWin32();
}

// --- tray -------------------------------------------------------------------------

export function wantsTray(platform: "win32" | "darwin"): boolean {
  return platform === "win32" ? wantsTrayWin32() : wantsTrayDarwin();
}

// --- window-all-closed --------------------------------------------------------------

export function shouldQuitOnAllWindowsClosed(platform: "win32" | "darwin", hasTray: boolean): boolean {
  return platform === "darwin"
    ? shouldQuitOnAllWindowsClosedDarwin()
    : shouldQuitOnAllWindowsClosedWin32(hasTray);
}

// --- application menu ----------------------------------------------------------------

export function shouldInstallRoleMenu(platform: "win32" | "darwin"): boolean {
  return platform === "darwin" ? shouldInstallRoleMenuDarwin() : shouldInstallRoleMenuWin32();
}
