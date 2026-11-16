// darwin shell adaptation (macOS adaptation, D2 §1). Every constant and
// function here answers "what does the macOS shell do" — nothing in this
// module may mention win32, and win32.ts may not mention darwin. The shared
// dispatch and platform-agnostic decisions live in index.ts; consumers import
// ONLY index.ts (same contract as packages/cas/src/platform/).

import type { RoleMenuSpec, ShellLogPaths, VenvLayout } from "./types.ts";

// --- tiny path joins with EXPLICIT separator choice ----------------------------
// node:path's join follows the HOST platform; these decision functions must
// return the same string for the same fixture on any test machine — so the
// separator is a decision, not an accident.

function joinPosix(a: string, b: string): string {
  return `${a.replace(/\/+$/, "")}/${b}`;
}

// --- shell.log location (darwin side of D-mac-01) --------------------------------

/**
 * Packaged darwin shell.log lives at app.getPath("logs") =
 * ~/Library/Logs/<productName>. A notarized .app bundle breaks its signature
 * on any internal write, so the Windows-style <install> sidecar would be a
 * hard defect, not a style choice. The "open logs" affordance follows the
 * same function and is correct on both platforms for free. Dev runs stay on
 * userData on both platforms (decided in index.ts).
 */
export function shellLogDirPackagedDarwin(paths: ShellLogPaths): string {
  return paths.logs;
}

/** POSIX venv path helper, exported for bootstrap.ts reuse. */
export function joinPosixPath(a: string, b: string): string {
  return joinPosix(a, b);
}

// --- bundled payload layout (bootstrap.ts path families, darwin side) ------------

export function venvLayoutDarwin(): VenvLayout {
  return {
    // The darwin payload bundles the uv python INSTALL ROOT (assemble §7
    // copies the parent of pyvenv.cfg's home), so the interpreter keeps its
    // bin/ layout — unlike win32 where python.exe sits at the payload-python
    // root. Keep in lockstep with replaceVenvSymlinks' hop target
    // (python/bin/python3) and assemble's bundledBasePythonPath.
    basePython: "bin/python3",
    venvBin: "bin",
    venvPython: "python3",
    venvLib: minor => `lib/python3.${minor}`,
    sitePackages: minor => `lib/python3.${minor}/site-packages`,
    stdlibLib: minor => `lib/python3.${minor}`,
    micromamba: "micromamba",
  };
}

// --- tray / window-all-closed / menu (darwin decisions) ---------------------------

/**
 * macOS has no system-tray culture (top-level v1 decision): quitting and
 * window management live in the Dock + application menu, so `tray` stays
 * null and the close handler's `tray`-guarded hide branch naturally falls
 * through on darwin.
 */
export function wantsTrayDarwin(): boolean {
  return false;
}

/**
 * Stay alive on the last window close — the Dock icon remains, the backend
 * stack keeps serving "close the page, the task keeps running" (same SD
 * backend contract as the tray-resident Windows build; window-all-closed +
 * activate recreate the window on demand).
 */
export function shouldQuitOnAllWindowsClosedDarwin(): boolean {
  return false;
}

/**
 * On darwin the menu bar is not cosmetic: without it Cmd+Q/Cmd+W have no
 * binding, copy/paste/undo die in every text field (the system menu owns
 * the key equivalents), and there is no "bring all to front".
 */
export function shouldInstallRoleMenuDarwin(): boolean {
  return true;
}

/**
 * The minimal darwin role-menu template: app (quit) / edit (clipboard) /
 * view (dev only) / window (minimize/zoom/front). Window management roles
 * give the "全部置于顶层" affordance that pairs with Dock-click activate.
 */
export function darwinRoleMenu(dev: boolean): RoleMenuSpec {
  return {
    appMenu: {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { separator: true },
        { role: "hide" },
        { role: "hideOthers" },
        { separator: true },
        { role: "quit" },
      ],
    },
    editMenu: {
      role: "editMenu",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { separator: true },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "delete" }, { role: "selectAll" },
      ],
    },
    viewMenu: dev
      ? {
          role: "viewMenu",
          submenu: [
            { role: "reload" },
            { role: "toggleDevTools" },
            { separator: true },
            { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
            { separator: true },
            { role: "togglefullscreen" },
          ],
        }
      : null,
    windowMenu: {
      role: "windowMenu",
      submenu: [
        { role: "minimize" }, { role: "zoom" },
        { separator: true },
        { role: "front" },
      ],
    },
    // Uninstall & data cleanup lives here (D4 §8 companion): mac convention is
    // drag-to-trash with data kept, but the deep-clean entry must not depend
    // on an external FAQ — see uninstall-data.ts + main.ts wiring.
    helpMenu: {
      label: "帮助",
      submenu: [
        { role: "__sd_uninstall_data__" },
      ],
    },
  };
}
