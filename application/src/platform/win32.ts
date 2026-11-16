// win32 shell adaptation (macOS adaptation, D2 §1). Every constant and
// function here answers "what does the Windows shell do" — nothing in this
// module may mention darwin, and darwin.ts may not mention win32. The shared
// dispatch and platform-agnostic decisions live in index.ts; consumers import
// ONLY index.ts (same contract as packages/cas/src/platform/).

import type { ShellLogPaths, VenvLayout } from "./types.ts";

// --- tiny path joins with EXPLICIT separator choice ----------------------------
// node:path's join follows the HOST platform; these decision functions must
// return the same string for the same fixture on any test machine — so the
// separator is a decision, not an accident.

export function joinWindows(a: string, b: string): string {
  return `${a.replace(/[\\/]+$/, "")}\\${b}`;
}

function dirnameWindows(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx <= 0 ? p.slice(0, 1) : p.slice(0, idx);
}

// --- shell.log location (win32 side of D-mac-01) ---------------------------------

/**
 * Packaged win32 shell.log lives in <install>\logs — the same folder NSIS
 * writes install-diagnostics.log into, so one folder answers "where are the
 * logs". Dev runs stay on userData on both platforms (decided in index.ts).
 */
export function shellLogDirPackagedWin32(paths: ShellLogPaths): string {
  return joinWindows(dirnameWindows(paths.exe), "logs");
}

// --- bundled payload layout (bootstrap.ts path families, win32 side) ------------

export function venvLayoutWin32(): VenvLayout {
  return {
    basePython: "python.exe",
    venvBin: "Scripts",
    venvPython: "python.exe",
    venvLib: () => "Lib",
    sitePackages: () => joinWindows("Lib", "site-packages"),
    stdlibLib: () => "Lib",
    micromamba: "micromamba.exe",
  };
}

// --- tray / window-all-closed / menu (win32 decisions) ----------------------------

/**
 * Windows keeps the tray: quitting lives on the tray icon's context menu
 * (the shipped Windows UX), the close button hides into it, and the backend
 * keeps serving "close the page, the task keeps running".
 */
export function wantsTrayWin32(): boolean {
  return true;
}

/**
 * With the tray alive, the last window closing hides into the tray, so the
 * process must stay. Without it (defensive fallback when Tray construction
 * failed), quitting is the only way to avoid an unreachable process.
 */
export function shouldQuitOnAllWindowsClosedWin32(hasTray: boolean): boolean {
  return !hasTray;
}

/** win32 production users need no menu bar; quitting stays on the tray. */
export function shouldInstallRoleMenuWin32(): boolean {
  return false;
}
