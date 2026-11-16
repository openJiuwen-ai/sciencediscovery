// assemble-backend platform dialect (macOS adaptation, D3 §2).
//
// Same layering convention as the shell's src/shell-platform.ts: the
// platform decisions live ONLY here (pure) and at the thin call sites in
// assemble-backend.mjs that consume them. The dialect shape deliberately
// mirrors venvLayoutFor() in shell-platform.ts — the payload this script
// produces is exactly what bootstrap.ts's layout functions expect to find,
// so the two tables must stay in lockstep (consumer-shape-first: the
// .mjs table was written against the TS consumer, not invented).

export const ASSEMBLE_PLATFORMS = ["win32-x64", "darwin-arm64", "darwin-x64"];

/**
 * Parse `--platform <value>` out of an argv array. Returns
 * { platform, error } — never throws; the caller decides whether an error
 * is fatal (assemble fails fast, tests assert on it).
 */
export function parseAssemblePlatform(argv) {
  const i = argv.indexOf("--platform");
  if (i < 0) return { platform: "win32-x64", error: null }; // default: current behaviour, byte-for-byte
  const value = argv[i + 1];
  if (!value) return { platform: null, error: "--platform requires a value" };
  if (!ASSEMBLE_PLATFORMS.includes(value)) {
    return { platform: null, error: `unknown platform "${value}" (expected one of: ${ASSEMBLE_PLATFORMS.join(", ")})` };
  }
  return { platform: value, error: null };
}

/** The platform family an assemble platform belongs to. */
export function assemblePlatformFamily(platform) {
  return platform.startsWith("darwin") ? "darwin" : "win32";
}

/**
 * Venv/payload layout dialect for one assemble platform. Mirrors
 * venvLayoutFor() in shell-platform.ts (the runtime consumer):
 *   - win32 venvs: Scripts\python.exe, Lib\site-packages
 *   - darwin venvs: bin/python (symlink), lib/python3.<minor>/site-packages
 */
export function assembleDialect(platform) {
  const family = assemblePlatformFamily(platform);
  if (family === "darwin") {
    return {
      family,
      basePythonName: "python3",
      /** Path of the bundled base interpreter UNDER <out>/python once the
       * install root is copied there. POSIX roots keep their bin/ layout
       * (<out>/python/bin/python3); win32 roots carry python.exe at the root
       * itself. Consumed by the precompile step and the A2 manifest so they
       * agree with replaceVenvSymlinks' hop target (python/bin/python3). */
      bundledBasePythonPath: "bin/python3",
      venvBin: "bin",
      venvPythonName: "python",
      /** lib dir inside a venv, with the Python minor injected. */
      venvLib: (minor) => `lib/python3.${minor}`,
      sitePackages: (minor) => `lib/python3.${minor}/site-packages`,
      /** stdlib dir inside the bundled base interpreter. */
      stdlibLib: (minor) => `lib/python3.${minor}`,
      micromambaName: "micromamba",
      /** Path separator used in placeholder'ed .pth files (target-platform
       * dialect — Windows .pth files carry backslashes, POSIX forward
       * slashes; the runtime rewrite in bootstrap.ts only substitutes the
       * placeholder, so the separator must already be right at assemble). */
      pthSeparator: "/",
      /** Path separator used in finder rewrites (same reasoning). */
      finderSeparator: "/",
      /** uv trampolines / runtime DLLs / CREATE_NO_WINDOW sitecustomize are
       * Windows-only artefacts; POSIX venvs need none of them (D3 §2 §7b). */
      hasTrampolines: false,
      /** stdlib target for compileall, under <out>/python. */
      stdlibCompileTarget: (minor) => ["lib", `python3.${minor}`],
    };
  }
  return {
    family: "win32",
    basePythonName: "python.exe",
    bundledBasePythonPath: "python.exe",
    venvBin: "Scripts",
    venvPythonName: "python.exe",
    venvLib: () => "Lib",
    sitePackages: () => joinWin("Lib", "site-packages"),
    stdlibLib: () => "Lib",
    micromambaName: "micromamba.exe",
    pthSeparator: "\\",
    finderSeparator: "\\",
    hasTrampolines: true,
    stdlibCompileTarget: () => ["Lib"],
  };
}

function joinWin(a, b) {
  return `${a}\\${b}`;
}

/**
 * How many `parents[..]` hops an editable finder file sits from the venv's
 * owning source root, given the venv's site-packages depth (segments from
 * venv root to site-packages). Windows venvs: Lib\site-packages = depth 2,
 * so site-packages → .venv → src means parents[3]. POSIX venvs nest one
 * deeper (lib\python3.<minor>\site-packages = depth 3), so the same anchor
 * needs parents[4]. Expressed depth-relative so the rewrite survives future
 * layout changes (D3 §2 risk row: "按 .venv 锚定动态数").
 */
export function finderAnchorLevel(sitePackagesDepthValue) {
  return sitePackagesDepthValue + 1;
}

/** Number of path segments from venv root down to site-packages for this
 *  dialect's venv layout. Windows: Lib\site-packages = 2. POSIX:
 *  lib\python3.<minor>\site-packages = 3. Split on BOTH separators — the
 *  win32 dialect spells site-packages with a backslash. */
export function sitePackagesDepth(dialect, minor) {
  return dialect.sitePackages(minor).split(/[\\/]/).length;
}
