// nsh-syntax-check: compile build/installer.nsh through makensis WITHOUT running
// a full electron-builder package (which takes ~20 min). Catches the class of bug
// that is invisible to every other test: NSIS syntax errors, undefined macros,
// missing plugin DLLs, and wrong include resolution.
//
// What it proves and what it does NOT:
//   PROVES: the script compiles to exit 0 with no "Error" line.
//   DOES NOT PROVE: runtime behaviour (install path, registry reads, etc.) —
//                   those are covered by the static assertions in
//                   test/installer-nsh.test.ts.
//
// Discovery order (first hit wins):
//   makensis   1. MAKENSIS env var
//              2. electron-builder cache: %LOCALAPPDATA%/electron-builder/Cache/nsis-*/nsis-*/Bin/makensis.exe
//   templates  1. SD_NSI_TEMPLATES env var
//              2. resolve('app-builder-lib/templates/nsis/multiUser.nsh') via electron-builder
//   plugins    1. SD_NSI_PLUGINS env var
//              2. electron-builder cache: %LOCALAPPDATA%/electron-builder/Cache/nsis-resources-*/nsis-resources-*/plugins/x86-unicode
//
// Usage (from win_desktop/):
//   node scripts/nsh-syntax-check.mjs
//   node scripts/nsh-syntax-check.mjs --keep   (leave the .exe in the output dir)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const winDesktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stubPath = join(winDesktopDir, "build", "nsh-syntax-check-stub.nsi");
const keepOutput = process.argv.includes("--keep");

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

function ebCacheRoot() {
  const local = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? "";
  return local ? join(local, "electron-builder", "Cache") : "";
}

/** First subdirectory matching `prefix` under `root`, or null. */
function firstSubdir(root, prefix) {
  if (!root || !existsSync(root)) return null;
  const entries = readdirSync(root).sort();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) return full;
  }
  return null;
}

/** Find makensis.exe: env var → electron-builder cache → PATH (Windows only). */
function findMakensis() {
  if (process.env.MAKENSIS) {
    const p = resolve(process.env.MAKENSIS);
    if (existsSync(p)) return p;
    throw new Error(`MAKENSIS=${process.env.MAKENSIS} not found`);
  }
  const cache = ebCacheRoot();
  const nsisDir = firstSubdir(cache, "nsis-3");
  if (nsisDir) {
    // The archive extracts into a hash-suffixed subdirectory.
    const inner = firstSubdir(nsisDir, "nsis-3");
    const bin = inner ? join(inner, "Bin", "makensis.exe") : join(nsisDir, "Bin", "makensis.exe");
    if (existsSync(bin)) return bin;
    // Some cache layouts put makensis.exe directly under the version dir.
    const direct = join(nsisDir, "makensis.exe");
    if (existsSync(direct)) return direct;
  }
  // Last resort: PATH lookup (works when NSIS is installed system-wide).
  // The catch is narrow on purpose. It used to be a bare `catch {}`, which also
  // swallowed a ReferenceError from execFileSync never having been imported —
  // so the third discovery tier was dead code that reported itself as
  // "makensis not found" (agent-ci-infra-bot F10). Only "not on PATH" and a
  // non-zero exit from where/which mean that; anything else is a bug here.
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(which, ["makensis"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return out.split("\n")[0].trim();
  } catch (err) {
    // Measured shape of the two "not on PATH" outcomes (logs/probe-execfilesync.mjs):
    //   where/which ran and found nothing → Error, code undefined, status 1
    //   where/which itself missing        → Error, code "ENOENT", status null
    //   a programming error here          → e.g. ReferenceError, status undefined
    // The whitelist below is the first two and nothing else, so the third kind
    // surfaces instead of being relabelled as "makensis not found".
    const isPathMiss =
      err?.code === "ENOENT" ||
      (err?.name === "Error" && typeof err?.status === "number");
    if (!isPathMiss) throw err;
  }
  throw new Error(
    "makensis not found. Set MAKENSIS=<path> or install NSIS 3.x, " +
    "or let electron-builder populate its cache (run `pnpm dist` once).",
  );
}

/** Find app-builder-lib's templates/nsis directory. */
function findTemplates() {
  if (process.env.SD_NSI_TEMPLATES) {
    const p = resolve(process.env.SD_NSI_TEMPLATES);
    if (existsSync(join(p, "multiUser.nsh"))) return p;
    throw new Error(`SD_NSI_TEMPLATES=${process.env.SD_NSI_TEMPLATES} does not contain multiUser.nsh`);
  }
  // app-builder-lib is a transitive dep of electron-builder; resolve through it.
  try {
    const req = createRequire(join(winDesktopDir, "_probe.js"));
    const ebPkg = req.resolve("electron-builder/package.json");
    const req2 = createRequire(ebPkg);
    const multiUser = req2.resolve("app-builder-lib/templates/nsis/multiUser.nsh");
    return dirname(multiUser);
  } catch { /* fall through */ }
  throw new Error(
    "app-builder-lib templates not found. Set SD_NSI_TEMPLATES=<abs path to templates/nsis>, " +
    "or run `pnpm install` in win_desktop/ first.",
  );
}

/** Find nsis-resources plugins/x86-unicode (StdUtils.dll lives here). */
function findPlugins() {
  if (process.env.SD_NSI_PLUGINS) {
    const p = resolve(process.env.SD_NSI_PLUGINS);
    if (existsSync(join(p, "StdUtils.dll"))) return p;
    throw new Error(`SD_NSI_PLUGINS=${process.env.SD_NSI_PLUGINS} does not contain StdUtils.dll`);
  }
  const cache = ebCacheRoot();
  const resDir = firstSubdir(cache, "nsis-resources-");
  if (resDir) {
    const inner = firstSubdir(resDir, "nsis-resources-");
    const candidate = inner
      ? join(inner, "plugins", "x86-unicode")
      : join(resDir, "plugins", "x86-unicode");
    if (existsSync(join(candidate, "StdUtils.dll"))) return candidate;
  }
  throw new Error(
    "nsis-resources plugins not found. Set SD_NSI_PLUGINS=<abs path to plugins/x86-unicode>, " +
    "or let electron-builder populate its cache (run `pnpm dist` once).",
  );
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

if (!existsSync(stubPath)) {
  console.error(`stub not found: ${stubPath}`);
  process.exit(1);
}

const makensis = findMakensis();
const templates = findTemplates();
const plugins = findPlugins();
const outFile = keepOutput
  ? join(tmpdir(), "sd-nsh-syntax-check.exe")
  : join(tmpdir(), `sd-nsh-syntax-check-${Date.now()}.exe`);

console.log(`makensis  : ${makensis}`);
console.log(`templates : ${templates}`);
console.log(`plugins   : ${plugins}`);
console.log(`stub      : ${stubPath}`);
console.log(`output    : ${outFile}`);
console.log();

// MSYS_NO_PATHCONV prevents Git Bash from rewriting -INPUTCHARSET as a path.
const args = [
  "-INPUTCHARSET", "UTF8",
  `-DSD_NSI_TEMPLATES=${templates}`,
  `-DSD_NSI_PLUGINS=${plugins}`,
  `-DSD_NSI_OUT=${outFile}`,
  stubPath,
];

let result;
try {
  result = spawnSync(makensis, args, {
    cwd: winDesktopDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    timeout: 120_000,
  });
} catch (err) {
  console.error(`could not run makensis: ${err.message}`);
  process.exit(1);
}
if (result.error) {
  console.error(`could not run makensis: ${result.error.message}`);
  process.exit(1);
}

// spawnSync, not execFileSync: the inline `warning: ...` lines go to STDERR and
// execFileSync discards stderr on success, so a success-path verdict built on
// its return value would be reading half the output.
const exitCode = result.status ?? 1;
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

// Print makensis output verbatim so warnings are visible.
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (!output.endsWith("\n")) process.stdout.write("\n");

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
//
// THE EXIT CODE IS NOT SUFFICIENT, and proving that cost a mutation run: NSIS
// treats an undefined variable/constant as `warning 6000 ... detected, ignoring`
// and still exits 0. That is precisely the W17 failure mode — reading
// ${UNINSTALL_REGISTRY_KEY} for InstallLocation silently yields "" because the
// define never existed in that scope. A check that only looked at the exit code
// reported PASS on it (measured: substituting ${SD_NO_SUCH_KEY} into
// installer.nsh still exited 0 with a 95.4 KiB artefact).
//
// So the verdict is: exit 0, AND no warning outside the stub's known set.
// A whitelist rather than a 6000-blocklist, because the artefact of any new
// warning class is also "the stub does not model the real build", which is the
// one thing this script exists to detect.
const KNOWN_WARNINGS = [
  // The stub inserts MUI_LANGUAGE before the page macros because it has to
  // expand customPageAfterChangeDir (a page) after including installer.nsh.
  /MUI_LANGUAGE\[EX\] should be inserted after the MUI_\[UN\]PAGE_\* macros/,
  // The stub declares an uninstaller section but never writes the uninstaller.
  /6020: Uninstaller script code found but WriteUninstaller never used/,
  // No instfiles page in the stub; the sections are only there to expand the
  // custom* macros so their bodies get compiled.
  /8000: Page instfiles not used, no sections will be executed/,
  // multiUser.nsh's own state variables, set by initMultiUser — which the stub
  // deliberately does not call, because calling it would run the real
  // multi-user detection over this machine.
  /6001: Variable "(installMode|hasPerUserInstallation|hasPerMachineInstallation|PerUserInstallationFolder)" not referenced or never set/,
];

const lines = output.split(/\r?\n/);

// makensis splits a single failure across several lines, and the one that names
// the cause is not always the one starting with "Error". Measured with a
// mutation harness (logs/neg-nsh-syntax-check.mjs, N2: an undefined macro):
//   !insertmacro: macro named "SDNoSuchMacro" not found!   ← the actual cause
//   Error in macro customInit on macroline 75              ← where it expanded
//   Error in script "...stub.nsi" on line 103 -- aborting  ← where it gave up
// A filter on ^Error alone reported the two locations and dropped the cause.
const DIAGNOSTIC_PATTERNS = [
  /^Error\b/i,
  /^!error\b/i,
  /^!\w[\w-]*:/,                    // !insertmacro: / !define: / !include: ...
  /\bnot found!/i,
  /\bunbalanced\b/i,
  /^invalid\b/i,
  /^unexpected\b/i,
  /\baborting creation process\b/i,
];
const errorLines = lines.filter((l) => {
  const t = l.trim();
  if (!t) return false;
  // Warnings are judged by the whitelist below, not here — including the
  // `!warning: ...` entries inside makensis's trailing summary block.
  if (/^!?warning\b/i.test(t)) return false;
  return DIAGNOSTIC_PATTERNS.some((re) => re.test(t));
});

// Take makensis's trailing summary block (`N warnings:` + indented entries),
// not the inline `warning ...` lines: the inline ones duplicate each other
// (one per macro expansion) and the summary is the deduplicated authoritative
// list. Falls back to inline scanning if no summary block is present, e.g. when
// the compile died before reaching it.
const summaryAt = lines.findIndex((l) => /^\d+ warnings?:\s*$/.test(l.trim()));
const warningLines = summaryAt >= 0
  ? (() => {
      const out = [];
      for (let i = summaryAt + 1; i < lines.length; i += 1) {
        if (!/^\s+\S/.test(lines[i])) break;
        out.push(lines[i].trim());
      }
      return out;
    })()
  : lines.filter((l) => /^\s*(warning\b|!warning\b)/i.test(l)).map((l) => l.trim());

const unexpectedWarnings = warningLines.filter(
  (l) => !KNOWN_WARNINGS.some((re) => re.test(l)),
);

const exitOk = exitCode === 0;
// Size BEFORE deleting, and only on the path where makensis got far enough to
// write it. "Can't open output file" exits non-zero with no artefact at all.
const outBytes = existsSync(outFile) ? statSync(outFile).size : 0;

if (!keepOutput && outBytes > 0) {
  try { rmSync(outFile); } catch { /* best effort */ }
}

console.log();
console.log(`exit ${exitCode}, ${errorLines.length} error line(s), `
  + `${warningLines.length} warning(s) of which ${unexpectedWarnings.length} unexpected`);

if (exitOk && errorLines.length === 0 && unexpectedWarnings.length === 0) {
  console.log(`PASS  installer.nsh compiles clean, output ${(outBytes / 1024).toFixed(1)} KiB`);
  process.exit(0);
}

console.error(`FAIL  installer.nsh does not compile clean`);
for (const l of errorLines) console.error(`      error  : ${l.trim()}`);
for (const l of unexpectedWarnings) console.error(`      warning: ${l.trim()}`);
if (!exitOk && errorLines.length === 0 && unexpectedWarnings.length === 0) {
  console.error(`      (exit ${exitCode} with no error/warning line — see makensis output above)`);
}
process.exit(1);
