// Shell platform layer types (macOS adaptation, D2 §1). Shared by the win32
// and darwin adaptation modules and re-exported through index.ts — the only
// module consumers may import.
//
// Everything in the platform layer is pure so the darwin branches get full
// fixture coverage on any machine (same philosophy as the Windows F12 tag
// rule: inject, don't skip).

/** Node platform string, narrowed to the shells we actually ship. */
export type ShellPlatform = "win32" | "darwin";

/** The bundled-payload venv layout keys that differ between the win32 and
 *  darwin payloads. Python itself: win32 ships python-build-standalone's
 *  python.exe with Lib\ and Scripts\; darwin ships the same distribution's
 *  POSIX layout (python3, bin/, lib/python3.<minor>/). */
export interface VenvLayout {
  /** Base interpreter executable name in <resources>/python. */
  basePython: string;
  /** Executable directory inside a venv. */
  venvBin: string;
  /** Main venv python executable (bin/python3 on darwin, python.exe on win32). */
  venvPython: string;
  /** Library directory name inside a venv ("Lib" vs "lib/python3.<minor>"). */
  venvLib: (pythonMinor: string) => string;
  /** Site-packages path inside a venv. */
  sitePackages: (pythonMinor: string) => string;
  /** stdlib lib directory in the bundled base interpreter. */
  stdlibLib: (pythonMinor: string) => string;
  /** micromamba executable name. */
  micromamba: string;
}

/** One entry of a role-menu template: a named role, or a separator. */
export type RoleMenuEntry = { role: string } | { separator: true };

export interface RoleMenuSpec {
  appMenu: { role: "appMenu"; submenu: RoleMenuEntry[] };
  editMenu: { role: "editMenu"; submenu: RoleMenuEntry[] };
  /** DEV-only (reload/devtools are developer affordances, same call as win32); null in packaged builds. */
  viewMenu: { role: "viewMenu"; submenu: RoleMenuEntry[] } | null;
  windowMenu: { role: "windowMenu"; submenu: RoleMenuEntry[] };
  /** darwin-only: hosts the uninstall & data-cleanup entry (D4 §8 companion);
   *  null on win32 (no menu bar — the NSIS uninstaller owns that flow).
   *  Plain label, not a role: Electron has no "helpMenu" role in its union. */
  helpMenu: { label: string; submenu: RoleMenuEntry[] } | null;
}

/** Inputs shared by both platform adaptations' shellLogDirFor. */
export interface ShellLogPaths {
  exe: string;
  userData: string;
  logs: string;
}
