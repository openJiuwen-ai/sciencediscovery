// Packaged bootstrap: first-run provisioning of the bundled payload.
// The installer ships venvs as a read-only template under <resources>; the
// stack expects them under <dataDir>\envs (writable, uv-extensible later).
// This module unpacks that template once per data dir and rewrites each
// venv's pyvenv.cfg `home` to the bundled base interpreter, so the venvs run
// from any installation directory the user picked.
// Pure decisions are exported for unit tests; the IO is thin and fire-and-forget-safe.
//
// Speed of the first two steps: (a) the envs-template copy now runs through
// a bounded-concurrency pool — fs.cp is serial per file and tens of
// thousands of small venv files made unpack I/O-latency bound; (b)
// precompile targets are split into a "template" phase (stdlib + jw venv,
// both live in the read-only resources) that STARTS before the copy and
// overlaps it, and an "unpacked" phase (the five copied venvs) that all run
// in parallel instead of the former serial for-loop.

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, posix } from "node:path";
import { promisify } from "node:util";
// @ts-expect-error — plain .mjs helper shared with scripts/assemble-backend.mjs (no .d.mts in scope)
import { copyVenvRuntimeDlls, replaceVenvTrampolines, replaceVenvSymlinks, pythonNamesFor } from "../scripts/lib/venv-launchers.mjs";
// @ts-expect-error — plain .mjs helper shared with scripts/assemble-backend.mjs (no .d.mts in scope)
import { payloadCompileEnv, unpackedBytecodeVerdict } from "../scripts/lib/pyc-budget.mjs";
import { CURRENT_SHELL_PLATFORM, pythonMinorFromPyvenvCfg, venvLayoutFor, type ShellPlatform, type VenvLayout } from "./shell-platform.ts";

const execFileAsync = promisify(execFile);

/** Placeholder the assemble script writes into the venvs' editable .pth
 * files; it stands in for the (build-time unknown) install backend path. */
const BACKEND_PLACEHOLDER = "@@SD_BACKEND_ROOT@@";

export interface PackagedPaths {
  /** Install resources root (identity recorded in the unpack stamp). */
  resourcesPath: string;
  /** Backend payload tree (= repoRoot for start-stack.mjs). */
  backend: string;
  /** Bundled base interpreter directory (pyvenv.cfg `home` target). */
  python: string;
  /** Bundled pinned micromamba.exe (runner provisioner). */
  micromamba: string;
  /** Read-only venv template the first run copies into <dataDir>\envs. */
  envsTemplate: string;
  /** The per-venv names expected inside the template (sanity check). */
  venvNames: string[];
  /** JiuwenSwarm's baked-in src tree (venv fixed in place; per-user dir is writable). */
  jwSrc: string;
}

export function packagedPaths(resourcesPath: string, platform: ShellPlatform = CURRENT_SHELL_PLATFORM): PackagedPaths {
  const layout = venvLayoutFor(platform);
  return {
    resourcesPath,
    backend: join(resourcesPath, "backend"),
    python: join(resourcesPath, "python"),
    micromamba: join(resourcesPath, "micromamba", layout.micromamba),
    envsTemplate: join(resourcesPath, "envs-template"),
    // SIZEOPT W2: the five Python sidecars share one venv ("sd-services",
    // staged by assemble-backend from the uv workspace lock) — see
    // sizeopt\agent-knowledge\design\D1 for the 6→2 merge decision.
    venvNames: ["sd-services"],
    // SIZEOPT W6 / design D11: short payload layout backend\jw (was
    // backend\.sciencediscovery-data\jiuwenswarm\src) — the deep path burned
    // all MAX_PATH headroom under the default install root (problems W6).
    jwSrc: join(resourcesPath, "backend", "jw"),
  };
}

/** Stamp written into the unpacked envs; a mismatch (different install dir,
 *  e.g. reinstall to another location) forces a fresh unpack. */
export interface UnpackStamp {
  installRoot: string;
  at: string;
  /** Identity of the payload whose bytecode was judged when this stamp was
  *  written (payloadIdentity()). Optional on purpose: stamps written before
  *  this field existed carry none, and an unidentified predecessor is judged
  *  again rather than trusted — the upgrade path is exactly what the first-launch
  *  check exists for (see needsBytecodeJudgement). */
  payload?: string | null;
}

export function stampPath(dataDir: string): string {
  return join(dataDir, "envs", ".shell-unpacked");
}

/** Env vars the packaged shell injects into every stack spawn. */
export function packagedEnv(paths: PackagedPaths, dataDir: string, platform: ShellPlatform = CURRENT_SHELL_PLATFORM): NodeJS.ProcessEnv {
  const layout = venvLayoutFor(platform);
  // When running venvs in-place, the stack and paper service need to
  // know where the actual venvs live. Otherwise we keep the historical default
  // of <dataDir>\envs so existing paths/tests keep working.
  const inPlaceEnvs = process.env.SCIENCE_AGENT_IN_PLACE_ENVS === "1";
  const envsRoot = inPlaceEnvs ? paths.envsTemplate : join(dataDir, "envs");
  const env: NodeJS.ProcessEnv = {
    SCIENCE_AGENT_PACKAGED: "1",
    SCIENCE_AGENT_PYTHON_PATH: join(paths.python, layout.basePython),
    SCIENCE_AGENT_PROVISIONER_PATH: paths.micromamba,
    // No PYTHONPYCACHEPREFIX: the payload's __pycache__ is precompiled at
    // build time with content-hash invalidation (assemble-backend.mjs), so
    // Python must read the caches IN PLACE. A prefix would hide them and
    // re-tax every import. The per-user install dir is writable; a read-only
    // install only loses lazy writes for modules the precompile missed.
    // JiuwenSwarm: code+venv stay in the (read-only-ish) payload; runtime data
    // belongs in the data dir per the "never write user data into the install
    // tree" discipline.
    JIUWENSWARM_ROOT: join(dataDir, "jiuwenswarm"),
    // HOME-class anchor for the jw workspace/registry/logs (.jiuwenswarm-instances,
    // .jiuwenswarm, jiuwenswarm-<instance>.log all hang off it). Without this,
    // scripts/jiuwenswarm.mjs jwConfig falls back to process.env.HOME and the
    // instance workspace lands in ~/.jiuwenswarm-instances — violating the data
    // dir discipline on both Windows (P2 legacy) and macOS (W1). Shaped after
    // services/launcher's embedded form (dataDir/jiuwenswarm-home) so both
    // deployment modes put the dot-dirs under the same subdirectory.
    JIUWENSWARM_HOME: join(dataDir, "jiuwenswarm-home"),
    JIUWENSWARM_SRC: paths.jwSrc,
    // The api defaults paper's interpreter to a POSIX-style venv path that
    // never exists on Windows; point it at the shared sidecar venv
    // (SIZEOPT W2: one "sd-services" venv for all five Python sidecars).
    SCIENCE_AGENT_PAPER_PYTHON_PATH: join(envsRoot, "sd-services", layout.venvBin, layout.venvPython),
    // Tell the stack where to find the sidecar venvs (in-place or copied).
    SCIENCE_AGENT_ENVS_DIR: envsRoot,
    // Ship the new desktop UI as the renderer payload.
    SCIENCE_AGENT_WEB_DIR: "apps/desktop/dist",
  };
  // Windows has no bubblewrap or Seatbelt, so program evolution would be
  // refused outright. This opts the installation into direct candidate
  // execution — which is *not* a sandbox: a candidate runs with the user's
  // own file, network and environment access. The API still refuses any run
  // whose goal does not carry the user's confirmation, collected by the
  // create dialog's warning switch. Set here and nowhere else, so a server
  // deployment cannot pick it up by accident.
  // darwin NEVER sets it: Seatbelt answers there without any opt-in
  // (services/api sandboxForPlatform returns "seatbelt" before reading
  // this flag), and defense in depth keeps the unisolated escape hatch a
  // Windows-only contract even if that branch ever changes.
  if (platform === "win32") env.SCIENCE_AGENT_EVOLVE_UNISOLATED = "1";
  // [mac-desktop] W22: the jw venv runs straight out of the sealed .app
  // bundle. Python writes __pycache__/.pyc next to imported sources on
  // first import — inside the bundle, each write breaks the codesign seal
  // (measured: 118 runtime-written .pyc files under backend/jw/.venv on the
  // W19 adhoc install, incl. beartype's tagged caches). DMG runs never see
  // this (EROFS); /Applications installs do. CPython honours
  // PYTHONDONTWRITEBYTECODE by skipping ALL bytecode writes, so the bundle
  // tree stays byte-identical to what was signed. Cost: jw modules that the
  // build's precompile missed re-compile in memory on every launch (the
  // payload ships 99.9% coverage, so this is measured noise).
  if (platform === "darwin") env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

/** Rewrite a pyvenv.cfg `home = ...` line to point at the bundled base
 * interpreter. Pure; returns the new file text. */
export function rewritePyvenvHome(cfgText: string, pythonHome: string): string {
  const replaced = cfgText.replace(/^home\s*=.*$/m, `home = ${pythonHome}`);
  if (replaced === cfgText && !/^home\s*=/m.test(cfgText)) {
    // venv without a home line (unusual): make one explicit.
    return `home = ${pythonHome}\n${cfgText}`;
  }
  return replaced;
}

/** Replace the backend placeholder in an editable .pth body. Pure. */
export function rewriteEditablePth(pthText: string, backendRoot: string): string {
  return pthText.split(BACKEND_PLACEHOLDER).join(backendRoot);
}

/**
 * Compileall argv for one precompile target. Pure.
 * Base stdlib: target = <python>\Lib; venv deps: target = site-packages.
 * checked-hash (PEP 552): validity is keyed to the SOURCE CONTENT hash, so
 * the copy chains between build → win-unpacked → NSIS install → dataDir can
 * restamp mtimes freely without invalidating the caches we ship.
 */
export function compileallArgs(targetDir: string): string[] {
  return ["-m", "compileall", "-q", "--invalidation-mode", "checked-hash", targetDir];
}

export interface PrecompileTarget {
  label: string;
  python: string;
  target: string;
  /** "template": source tree lives in the read-only resources (stdlib, the
   *  in-place jw venv) — safe to run WHILE the envs copy is in flight.
   *  "unpacked": the freshly copied per-data-dir venvs — start after copy. */
  phase: "template" | "unpacked";
}

/**
 * The compileall target list for this install, derived from what
 * actually exists on disk right now. Call once before the unpack (yields the
 * template-phase targets) and once after it (also yields the unpacked venvs).
 * Pure w.r.t. the filesystem state it observes.
 *
 * darwin: venv site-packages live under lib/python3.<minor> — the minor is
 * read from each venv's own pyvenv.cfg version_info (never hardcoded), so a
 * payload Python bump needs no shell change. The bundled base interpreter
 * has no pyvenv.cfg; its stdlib minor is discovered by listing the lib/
 * directory (python-build-standalone ships lib/python3.<minor>/).
 */
export function precompileTargets(
  paths: PackagedPaths,
  envsDir: string,
  platform: ShellPlatform = CURRENT_SHELL_PLATFORM,
): PrecompileTarget[] {
  const layout = venvLayoutFor(platform);
  const out: PrecompileTarget[] = [];
  const basePython = join(paths.python, layout.basePython);
  if (existsSync(basePython)) {
    const stdlibMinor = platform === "darwin" ? bundledStdlibMinor(paths.python) : null;
    out.push({
      label: "python stdlib",
      python: basePython,
      target: join(paths.python, layout.stdlibLib(stdlibMinor ?? "12")),
      phase: "template",
    });
  }
  for (const name of paths.venvNames) {
    const venvDir = join(envsDir, name);
    const venvPython = join(venvDir, layout.venvBin, layout.venvPython);
    if (existsSync(venvPython)) {
      const minor = venvPythonMinor(venvDir);
      if (minor) {
        out.push({
          label: `${name} venv`,
          python: venvPython,
          target: join(venvDir, ...layout.sitePackages(minor).split("/")),
          phase: "unpacked",
        });
      }
    }
  }
  const jwVenv = join(paths.jwSrc, ".venv");
  const jwPython = join(jwVenv, layout.venvBin, layout.venvPython);
  if (existsSync(jwPython)) {
    const minor = venvPythonMinor(jwVenv);
    if (minor) {
      out.push({
        label: "jiuwenswarm venv",
        python: jwPython,
        target: join(jwVenv, ...layout.sitePackages(minor).split("/")),
        phase: "template",
      });
    }
  }
  return out;
}

/** CPython minor ("12" for 3.12) of a venv, from its own pyvenv.cfg. Pure
 *  read; null when the cfg is missing or unreadable (target skipped). */
function venvPythonMinor(venvDir: string): string | null {
  try {
    return pythonMinorFromPyvenvCfg(readFileSync(join(venvDir, "pyvenv.cfg"), "utf8"));
  } catch {
    return null;
  }
}

/** CPython minor of the bundled base interpreter's stdlib, discovered from
 *  the actual lib/python3.<minor> directory (the base has no pyvenv.cfg). */
function bundledStdlibMinor(pythonHome: string): string | null {
  try {
    const entries = readdirSync(join(pythonHome, "lib"), { withFileTypes: true });
    for (const entry of entries) {
      const m = entry.name.match(/^python3\.(\d+)$/);
      if (entry.isDirectory() && m) return m[1];
    }
  } catch { /* no lib/ dir: darwin payload shape mismatch */ }
  return null;
}

/** Relative POSIX path from one directory to a target (W17: venv symlink
 * hop target when the venv has been copied out of the payload — computed
 * from the venv's CURRENT location, never a baked hop count). */
function posixRelative(fromDir: string, toPath: string): string {
  return posix.relative(fromDir, toPath);
}

/** Whether a directory is writable, by probe (a real create+delete of a
 *  unique temp file — access(W_OK) lies on macOS: it checks the READ-ONLY
 *  mount flag path but not sandbox/ACL reality, and DMG volumes report
 *  writable while rejecting writes with EROFS). Exported for unit tests.
 *  W16: running the app straight off a mounted DMG hits exactly this. */
export async function dirWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.sd-write-probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "", "utf8");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface BootstrapResult {
  unpacked: boolean;
  jwFixed: boolean;
  /** How many bytecode precompile runs succeeded (0 when skipped). */
  precompiled: number;
}

/** True when the envs under this data dir must be (re)unpacked. Pure decision.
 *  NOTE: this is the UNPACK decision and compares install location only. It must
 *  not be repurposed as "is this payload new" — a same-location upgrade keeps
 *  the install root, and answering that question here would silently start
 *  re-copying trees (see needsBytecodeJudgement). */
export function needsUnpack(dataDir: string, installRoot: string): boolean {
  const stampFile = stampPath(dataDir);
  if (!existsSync(stampFile)) return true;
  try {
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as Partial<UnpackStamp>;
    return stamp.installRoot !== installRoot;
  } catch {
    return true; // unreadable stamp: treat as not unpacked
  }
}

/** Identity of the payload an install is running from, or null when version.json
 *  does not carry one. Built from the two fields assemble-backend.mjs already
 *  writes: repoCommit (what was built) and builtAt (which build of it). One small
 *  synchronous read, so calling it once per launch costs nothing measurable.
 *
 *  This exists because install location cannot tell two payloads apart. An
 *  upgrade replaces <install>\resources while keeping the install root (the
 *  installer reads it back from the registry) and the data dir (pinned to
 *  %LOCALAPPDATA%\ScienceDiscovery), so a stamp keyed on location alone survives
 *  the very event that puts a new payload on disk. */
export function payloadIdentity(resourcesPath: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(resourcesPath, "version.json"), "utf8")) as {
      repoCommit?: unknown;
      builtAt?: unknown;
    };
    const commit = typeof v.repoCommit === "string" ? v.repoCommit : null;
    const built = typeof v.builtAt === "string" ? v.builtAt : null;
    if (commit === null && built === null) return null;
    return `${commit ?? "?"}@${built ?? "?"}`;
  } catch {
    return null; // no manifest: nothing to compare, and the caller degrades safely
  }
}

/** True when the first-launch bytecode judgement must run again. Deliberately a
 *  SEPARATE predicate from needsUnpack, because the two questions differ:
 *  needsUnpack asks "is there an unpacked tree for this install location" and
 *  gates a ~7s copy, while this asks "has THIS PAYLOAD been judged here yet".
 *  Folding the payload check into needsUnpack would silently change the unpack
 *  decision — a same-location upgrade would start re-copying — which is a
 *  behaviour change nobody asked for and would be invisible in this file.
 *
 *  Both halves of the stamp's identity are preserved across an upgrade (the
 *  installer keeps $INSTDIR from the registry, and the data dir is pinned), so
 *  gating on needsUnpack alone let every upgrade skip the judgement:
 *  the payload is read-only between launches of ONE payload, but an upgrade
 *  swaps it, and the swapped-in payload is the one whose bytecode can be
 *  incomplete (problems W25). Judging it once per payload costs the measured
 *  ~750ms walk on the upgrade launch and nothing on any later launch. */
export function needsBytecodeJudgement(
  dataDir: string,
  installRoot: string,
  payloadId: string | null,
): boolean {
  // No stamp for this location, or an unreadable one: judge.
  if (needsUnpack(dataDir, installRoot)) return true;
  try {
    const stamp = JSON.parse(readFileSync(stampPath(dataDir), "utf8")) as Partial<UnpackStamp>;
    // A stamp predating the `payload` field describes a payload that cannot be
    // identified. Trusting it would inherit an unknown predecessor's verdict;
    // judging costs one walk. The unsafe direction is trusting (lesson L62).
    if (stamp.payload === undefined) return true;
    return stamp.payload !== payloadId;
  } catch {
    return true;
  }
}

// existsSync/readFileSync keep the pure helpers above free of async plumbing.

interface CopyTask {
  src: string;
  dest: string;
  kind: "file" | "symlink";
}

async function collectTree(src: string, dest: string, tasks: CopyTask[]): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const childSrc = join(src, entry.name);
    const childDest = join(dest, entry.name);
    if (entry.isDirectory()) {
      await collectTree(childSrc, childDest, tasks);
    } else if (entry.isSymbolicLink()) {
      tasks.push({ src: childSrc, dest: childDest, kind: "symlink" });
    } else {
      tasks.push({ src: childSrc, dest: childDest, kind: "file" });
    }
  }
}

export interface CopyTreeOptions {
  /** Worker count for file copies (default 16 — SSD small-file sweet spot). */
  concurrency?: number;
  /** Called after every completed file; throttle on the caller's side. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * True when the tree contains at least one __pycache__ directory with a .pyc
 * inside — the signal that the build-time precompile shipped with the copy
 * and the first-run compileall can be skipped. Bounded: stops at the first
 * hit; empty trees return false.
 */
export async function treeHasPycache(root: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        try {
          const cached = await readdir(child);
          if (cached.some((f) => f.endsWith(".pyc"))) return true;
        } catch { /* unreadable dir: keep walking */ }
      } else if (await treeHasPycache(child)) {
        return true;
      }
    }
  }
  return false;
}

/** Shape of the `bytecode` block assemble writes into resources/version.json
 *  (issue #897 section 2, first half). Absent in payloads built before it. */
interface PayloadBytecodeManifest {
  py: number;
  pyc: number;
  byRegion: Record<string, { py: number; pyc: number }>;
}

/**
 * Read the build's own bytecode count for the region bootstrap unpacks
 * (envs-template -> <dataDir>\envs). Returns null when version.json is missing,
 * unreadable, or predates the `bytecode` field, so the caller degrades to the
 * absolute coverage limit rather than passing blind on a missing input
 * (lesson L51). Synchronous and tiny (the manifest is ~300 bytes), matching
 * needsUnpack's stamp read.
 */
export function readPayloadBytecodeManifest(resourcesPath: string): { py: number; pyc: number } | null {
  try {
    const manifest = JSON.parse(readFileSync(join(resourcesPath, "version.json"), "utf8")) as { bytecode?: PayloadBytecodeManifest };
    const region = manifest.bytecode?.byRegion?.["envs-template"];
    if (region && Number.isFinite(region.py) && Number.isFinite(region.pyc)) {
      return { py: region.py, pyc: region.pyc };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Count .py / .pyc under a tree — the full walk behind the first-launch
 * bytecode check. Unlike treeHasPycache() this visits EVERY directory (no
 * short-circuit on the first hit), because the question is "how much coverage
 * survived the copy", not "is there any". Measured on the release6 env tree:
 * ~750ms for ~6,100 modules across ~1,700 dirs, paid once on first launch only
 * — every later start short-circuits on the unpack stamp before reaching this.
 *
 * The walk is iterative (explicit stack), matching the build-side A6 walk in
 * assemble-backend.mjs: the venv tree is thousands of directories in aggregate,
 * and an async recursion that awaits per level is both slower and stack-fragile.
 */
export async function countBytecode(root: string): Promise<{ py: number; pyc: number }> {
  let py = 0;
  let pyc = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: count what is reachable, never crash first launch
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
      } else if (entry.name.endsWith(".py")) {
        py += 1;
      } else if (entry.name.endsWith(".pyc")) {
        pyc += 1;
      }
    }
  }
  return { py, pyc };
}

/**
 * Judge the env tree bootstrap will run Python from against the build's own
 * recorded count (#897 §2, second half) and log the outcome. Returns the verdict
 * so each branch can decide what to compile; the walk and the wording live here
 * so the two branches cannot drift apart.
 *
 * BOTH branches must call this. SCIENCE_AGENT_IN_PLACE_ENVS=1 is what a packaged
 * install actually runs with — main.ts sets it before bootstrapPackaged so a cold
 * start reaches the UI in ~10-20s — so wiring the check only into the copy
 * branch would leave it unreachable on every real install. That is exactly what
 * the first version of this guard did (lesson L55: the code existing is not the
 * code running), and it is why test/bootstrap.test.ts drives this branch for
 * real instead of asserting on source text.
 *
 * `treeName` only shapes the log line ("in-place" / "copied"), so a field report
 * says WHICH tree was judged — the two fail differently: a partial copy loses
 * whole directories, while the read-only payload cannot, but can ship
 * uncompiled (problems W4).
 */
async function judgeBytecodeCoverage(
  treeName: string,
  envsDir: string,
  resourcesPath: string,
  log: (line: string) => void,
): Promise<{ ok: boolean; ratio: number; reason: string; expectedPyc: number | null; kind: string | null }> {
  const counts = await countBytecode(envsDir);
  const expectedRegion = readPayloadBytecodeManifest(resourcesPath);
  const verdict = unpackedBytecodeVerdict(counts, expectedRegion);
  // Name BOTH recorded counts. The suffix used to report only the .pyc, which
  // contradicted the reason on the source-loss shape ("3,062 of the 6,124 .py"
  // followed by "the build recorded 6,119 .pyc") and sent a field report
  // looking at the wrong number.
  const recorded = expectedRegion
    ? ` (the build recorded ${expectedRegion.py} .py and ${expectedRegion.pyc} .pyc for this region)`
    : " (no build manifest to compare against)";
  if (verdict.ok) {
    log(`first run: bytecode coverage verified (${treeName}) — ${counts.pyc} .pyc for ${counts.py} .py`
      + ` = ${(verdict.ratio * 100).toFixed(1)}%${recorded}; no remedial compile needed`);
  } else {
    // §2's "names itself at first launch": say WHICH tree, HOW incomplete, and
    // WHY it matters, before any ImportError can. The remedial compile each
    // branch runs next is best-effort — under the default install root the
    // deepest venv path already breaches MAX_PATH (63 + 1 + 192 + 14 > 259,
    // problems W6/W15), so it may only recover part of the set. Naming it is
    // the load-bearing half; the compile is the recovery attempt.
    // What the remedial compile below can actually do depends on which limit
    // fired, so promise only that. Missing caches are recompilable; missing
    // SOURCES are not — compileall has nothing to read — and claiming otherwise
    // would be a log that reports a recovery which never happened (the defect
    // recorded in problems W25 item 5).
    const recovery = verdict.kind === "py-count"
      ? " A first-launch compile cannot restore files that are gone from the payload, so the affected modules will"
        + " keep failing to import until this installation is repaired or reinstalled; compiling now to recover"
        + " whatever caches the surviving sources are missing."
      : " Attempting a first-launch compile to recover it; if that cannot finish, some Python modules"
        + " will fail to import until the payload is rebuilt.";
    log(`first run: WARNING — the ${treeName} env tree has incomplete bytecode: ${verdict.reason}${recorded}.` + recovery);
  }
  return { ok: verdict.ok, ratio: verdict.ratio, reason: verdict.reason, expectedPyc: verdict.expectedPyc, kind: verdict.kind };
}

/**
 * Recursive tree copy with bounded concurrency. fs.cp copies files
 * strictly one-by-one; the venv template is tens of thousands of small files,
 * so the serial version was I/O-latency bound (measured minutes on Defender-
 * heavy machines). Directories are created during collection; symlinks are
 * re-created as symlinks (never followed).
 */
export async function copyTreeConcurrent(src: string, dest: string, options: CopyTreeOptions = {}): Promise<void> {
  const tasks: CopyTask[] = [];
  await collectTree(src, dest, tasks);
  const concurrency = options.concurrency ?? 16;
  let done = 0;
  let active = 0;
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    const pump = () => {
      while (active < concurrency && next < tasks.length) {
        const task = tasks[next++];
        active++;
        const finish = () => {
          active--;
          done++;
          options.onProgress?.(done, tasks.length);
          pump();
        };
        if (task.kind === "file") {
          void copyFile(task.src, task.dest).then(finish, fail);
        } else {
          void readlink(task.src)
            .then((link) => symlink(link, task.dest))
            .then(finish, fail);
        }
      }
      if (active === 0 && next >= tasks.length) resolve();
    };
    pump();
  });
}

/** Run one compileall target; resolves to success. Logging kept identical to
 * the former serial loop (the wizard surfaces these lines as progress text). */
async function runCompileall(target: PrecompileTarget, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<boolean> {
  const started = Date.now();
  try {
    await execFileAsync(target.python, compileallArgs(target.target), {
      // PYTHONWARNINGS=ignore: the jw venv ships SyntaxWarning-emitting
      // sources (pysbd, playwright probes); without this some Python
      // versions exit non-zero and the whole venv stays un-precompiled —
      // cold starts then pay the compile tax every launch.
      env,
      windowsHide: true,
      timeout: 600_000,
      // maxBuffer: compileall prints one line per un-compileable file; the jw
      // venv emits >1MB (default cap) and the whole precompile used to fail
      // with "stdout maxBuffer length exceeded" — silently losing the cache
      // and re-taxing every cold start.
      maxBuffer: 64 * 1024 * 1024,
    });
    log(`first run: precompiled bytecode for ${target.label} (${Math.round((Date.now() - started) / 1000)}s)`);
    return true;
  } catch (error) {
    // compileall exits 1 when SOME files fail — on Windows typically the
    // 260-char path limit skipping a slice of long-path files while the rest
    // of the venv does get cached. That is a partial success, not a failure;
    // the old "failed" wording made a normal install look broken. Real
    // failures (python missing / timeout) keep the hard warning.
    const partial = typeof error === "object" && error !== null
      && "code" in error && typeof error.code === "number"
      && !("killed" in error && error.killed);
    const message = typeof error === "object" && error !== null && "message" in error ? error.message : error;
    if (partial) {
      log(`first run: precompile partially done for ${target.label} (${Math.round((Date.now() - started) / 1000)}s; skipped files compile lazily on first launch — normal on Windows)`);
    } else {
      log(`first run: warning — bytecode precompile failed for ${target.label}: ${String(message)}`);
    }
    return false;
  }
}

/**
 * Fallback compile for one target whose tree carries no __pycache__. The
 * payload normally ships precompiled (assemble-backend.mjs step 7c), but
 * that build step only warns on failure — a skipped compile once shipped a
 * cache-less JiuwenSwarm venv and the gateway then paid a ~50s cold import
 * on EVERY launch (lazy pyc writes cannot persist into the effectively
 * read-only install tree, so nothing ever healed the gap). Detect per
 * target: caches present → no-op. True when a compile actually ran.
 */
async function compileIfCacheless(target: PrecompileTarget, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<boolean> {
  if (await treeHasPycache(target.target)) return false;
  log(`first run: no bytecode caches found for ${target.label}; compiling (one-time, speeds up every later launch)`);
  return runCompileall(target, env, log);
}

/**
 * First-run provisioning for a packaged install:
 *  1. start precompiling the template-phase targets (stdlib + jiuwenswarm venv) —
 *     they read the read-only resources and overlap the copy below,
 *  2. copy <resources>\envs-template → <dataDir>\envs concurrently (delete
 *     stale partials first), reporting percentage progress,
 *  3. point every venv's pyvenv.cfg home at the bundled interpreter,
 *  4. precompile the copied venvs in parallel,
 *  5. write the stamp.
 * Idempotent: a valid stamp short-circuits everything.
 */
export async function bootstrapPackaged(
  paths: PackagedPaths,
  dataDir: string,
  log: (line: string) => void,
  platform: ShellPlatform = CURRENT_SHELL_PLATFORM,
): Promise<BootstrapResult> {
  const bootstrapStarted = Date.now();
  log("[perf] bootstrapPackaged start");
  const perfB = (event: string, extra = ""): void => {
    log(`[perf] bootstrap ${event} +${Date.now() - bootstrapStarted}ms${extra ? ` ${extra}` : ""}`);
  };
  perfB("enter");
  // Optionally run venvs straight from the read-only payload.
  // Packaged mode never mutates venvs at runtime, so copying them into the
  // data directory is pure overhead on first start.
  // W16: in-place mode still FIXES venvs in the payload (pyvenv.cfg home +
  // editable .pth placeholders) — on a read-only payload volume (running
  // straight off the mounted DMG) those writes fail EROFS with no catch and
  // the promise dies silently, freezing the loading page forever. Probe the
  // payload root once; not writable → fall back to the copy mode, which
  // only ever writes <dataDir>. The env is cleared on THIS process so
  // packagedEnv() (reads process.env) degrades in lockstep. The jw venv
  // stays runnable either way: its python launchers are relative symlinks
  // (W15), so the stale build-machine `home` in pyvenv.cfg is inert.
  const payloadWritable = await dirWritable(paths.resourcesPath);
  let inPlaceEnvs = process.env.SCIENCE_AGENT_IN_PLACE_ENVS === "1";
  if (inPlaceEnvs && !payloadWritable) {
    log("payload volume is read-only (running from a mounted DMG?); falling back to copied envs");
    process.env.SCIENCE_AGENT_IN_PLACE_ENVS = undefined;
    inPlaceEnvs = false;
  }
  // [mac-desktop] W22 —— darwin 上可写 payload（/Applications 安装）也强制走
  // 拷贝模式。in-place 的全部修复（pyvenv.cfg home / .pth / 补编译 __pycache__）
  // 都写进 bundle 内部，任何一次写入都击穿 codesign 封条（CodeResources 哈希
  // 不再匹配）：下一启 amfid 拒载主二进制（零输出瞬死，实测），notarization
  // 票据作废，M4 的 spctl 门禁必挂。Windows 的 NSIS 目录没有封条概念，维持
  // in-place 不变。拷贝模式实测 ~3.1s（W19 包），首启成本可忽略。
  if (inPlaceEnvs && platform === "darwin") {
    log("darwin payload must stay sealed (codesign/notarization): falling back to copied envs");
    process.env.SCIENCE_AGENT_IN_PLACE_ENVS = undefined;
    inPlaceEnvs = false;
  }
  const envsDir = inPlaceEnvs ? paths.envsTemplate : join(dataDir, "envs");
  // Which payload this launch is running from. Stamped below so an upgrade is
  // told apart from a relaunch of the same payload (needsBytecodeJudgement).
  const payloadId = payloadIdentity(paths.resourcesPath);

  if (!inPlaceEnvs && !needsUnpack(dataDir, paths.resourcesPath)) {
    // A same-location reinstall keeps a valid unpack stamp, so
    // dataDir\envs may still hold pre-fix trampoline launchers copied from
    // an older payload. The fix is idempotent and cheap — always run it.
    await fixVenvLaunchers(paths, envsDir, log, platform);
    // The reinstall also refreshed the payload's in-place jw venv,
    // re-shipping the build machine's pyvenv.cfg home — fix that too, or the
    // next jw spawn (init/precompile) runs against a nonexistent interpreter.
    // W16: skip on a read-only payload (DMG run) — the fix writes into
    // <resources>; jw stays runnable via its relative python symlinks (W15).
    // [mac-desktop] W22: skip on darwin too — a WRITABLE /Applications install
    // is exactly where the seal matters most; jw runs fine on its relative
    // symlinks with the build-machine home left inert (same reasoning as the
    // read-only DMG case).
    if (payloadWritable && platform !== "darwin") {
      const jwVenv = join(paths.jwSrc, ".venv");
      if (existsSync(join(jwVenv, "pyvenv.cfg"))) {
        await fixVenvHome(jwVenv, paths.python, log);
      }
    }
    perfB("short-circuit", `unpackNeeded=false`);
    log(`[perf] bootstrapPackaged short-circuit elapsed=${Date.now() - bootstrapStarted}ms`);
    return { unpacked: false, jwFixed: false, precompiled: 0 };
  }

  // The remedial compile must not inherit a bytecode redirect from the USER's
  // environment either. assemble-backend.mjs filters its build environment for
  // exactly this reason (problems W25): PYTHONPYCACHEPREFIX makes compileall
  // write every .pyc into a mirror tree OUTSIDE the target while still exiting
  // 0, so an unfiltered {...process.env} here would let the first-launch
  // recovery "succeed" without caching anything, and the stamp written below
  // would freeze the gap in for every later launch. Same defence, same library.
  const compileEnv: NodeJS.ProcessEnv = payloadCompileEnv(process.env, { warn: log });

  // Fix the in-place jw venv launchers + runtime DLLs and its pyvenv.cfg
  // home BEFORE anything spawns it (on a fresh data dir envsDir doesn't
  // exist yet, so only jw matches — the idempotent full pass after the copy
  // picks up the five copied venvs). Ordering matters: the jw home fix used
  // to run only AFTER the ~7s unpack, so the overlapping precompile spawned
  // against the build machine's burned-in home.
  // W16: on a read-only payload both fixes write into <resources> — skip
  // them and keep the jw venv running on its relative symlinks (W15) with
  // the build-machine home left inert in pyvenv.cfg. (fixVenvLaunchers is a
  // no-op on darwin anyway; the guard also covers a win32 read-only case.)
  // [mac-desktop] W22: on darwin a writable payload is NOT licence to write
  // — fixVenvHome(jwVenv) writes pyvenv.cfg INSIDE the sealed .app bundle,
  // breaking the codesign seal for every later launch (see the W22 note at
  // the in-place guard above). jw runs fine without the fix (relative
  // symlinks, inert build-machine home). fixVenvLaunchers over envsDir is
  // harmless on darwin (it targets dataDir envs or no-ops in-place) and is
  // kept unguarded.
  if (payloadWritable && platform !== "darwin") {
    await fixVenvLaunchers(paths, envsDir, log, platform);
    const jwVenv = join(paths.jwSrc, ".venv");
    if (existsSync(join(jwVenv, "pyvenv.cfg"))) {
      await fixVenvHome(jwVenv, paths.python, log);
      log("first run: pointed the bundled JiuwenSwarm venv at the bundled interpreter");
    }
  } else if (platform === "darwin") {
    // darwin: only the (harmless) envsDir launchers pass; never the jw fix.
    await fixVenvLaunchers(paths, envsDir, log, platform);
  }
  perfB("jw-venv-fix-done");

  // In-place path — skip the expensive copy and just fix the bundled
  // venvs in their read-only template. The payload normally ships
  // precompiled __pycache__; the fallback below compiles whatever arrived
  // cache-less so one bad payload cannot tax every launch.
  if (inPlaceEnvs) {
    const inPlaceFixStarted = Date.now();
    perfB("in-place-fix-enter");
    for (const name of paths.venvNames) {
      await fixVenvHome(join(envsDir, name), paths.python, log);
      await fixEditablePths(join(envsDir, name), paths.backend, log, platform);
    }
    // Second pass catches any venv that was missed because the directory did not
    // exist during the first pass above.
    await fixVenvLaunchers(paths, envsDir, log, platform);
    perfB("in-place-fix-done", `self=${Date.now() - inPlaceFixStarted}ms`);
    log(`[perf] in-place venv fix elapsed=${Date.now() - inPlaceFixStarted}ms`);

    // Bytecode: verify the payload's coverage instead of trusting "is there any
    // .pyc". This branch is the packaged DEFAULT (main.ts sets
    // SCIENCE_AGENT_IN_PLACE_ENVS=1), so §2's promise is only kept if the check
    // runs here — see judgeBytecodeCoverage.
    //
    // Gated so the walk is not paid on every launch: this branch runs on EVERY
    // start (the copy branch short-circuits on a valid stamp above, this one
    // does not), and the walk is ~750ms on the real envs-template region
    // (measured), which the "first run must not get slower" constraint only
    // allows on a first run.
    //
    // The gate is needsBytecodeJudgement, NOT needsUnpack. The distinction is
    // the whole fix: needsUnpack compares install location, and an upgrade keeps
    // it (the installer restores $INSTDIR from the registry and the data dir is
    // pinned), so gating on location judged each payload exactly once per
    // INSTALL and never judged the payload an upgrade just put on disk — the one
    // launch where bytecode can be incomplete. The payload is read-only between
    // launches of one payload; an upgrade replaces it. Now the walk is paid on
    // the first launch of each PAYLOAD, which is the launch that needs it.
    const compileStarted = Date.now();
    perfB("in-place-bytecode-fallback-enter");
    const needsJudgement = needsBytecodeJudgement(dataDir, paths.resourcesPath, payloadId);
    const targets = precompileTargets(paths, envsDir);
    let results: boolean[];
    if (!needsJudgement) {
      // This exact payload was already judged here, and the resources are
      // read-only, so nothing it ships can have changed since: skip the ~750ms
      // walk. The per-target probe stays as a cheap safety net (a target the
      // build skipped still self-heals).
      perfB("in-place-bytecode-skip", "same payload already judged");
      results = await Promise.all(targets.map((t) => compileIfCacheless(t, compileEnv, log)));
    } else {
      const verdict = await judgeBytecodeCoverage("in-place", envsDir, paths.resourcesPath, log);
      if (verdict.ok) {
        // Coverage proven for the judged region (envs-template). The read-only
        // targets OUTSIDE it — the stdlib and the jw venv — are not covered by
        // that verdict, so they keep their own first-hit probe: a W4-style skip
        // of one target must still self-heal even when the region looks whole.
        results = await Promise.all(targets.map((t) => compileIfCacheless(t, compileEnv, log)));
      } else {
        // Named incomplete: compile EVERY target unconditionally. compileIfCacheless
        // would skip most of them, because its treeHasPycache probe answers "is
        // there ANY .pyc" — the very first-hit question that let release6's
        // 1,384-of-37,000 tree through.
        results = await Promise.all(targets.map((t) => runCompileall(t, compileEnv, log)));
      }
    }
    perfB("in-place-bytecode-fallback-done", `self=${Date.now() - compileStarted}ms precompiled=${results.filter(Boolean).length}`);

    const stamp: UnpackStamp = { installRoot: paths.resourcesPath, at: new Date().toISOString(), payload: payloadId };
    // The stamp still lives under <dataDir>\envs even when venvs are in-place,
    // so tooling can find it and needsUnpack keeps working if we ever switch back.
    await mkdir(join(dataDir, "envs"), { recursive: true });
    await writeFile(stampPath(dataDir), JSON.stringify(stamp, null, 2), "utf8");
    log(`[perf] bootstrapPackaged total=${Date.now() - bootstrapStarted}ms`);
    log("first run: in-place environments ready");
    return { unpacked: true, jwFixed: true, precompiled: results.filter(Boolean).length };
  }

  // Template-phase fallback (stdlib + jiuwenswarm venv), overlapped with the
  // copy below: both read the read-only resources while the copy writes
  // dataDir\envs, and each self-skips when the payload already ships its
  // caches. Must be awaited in BOTH branches of the compile section.
  // [mac-desktop] W22: on darwin the template-phase targets live INSIDE the
  // sealed bundle (stdlib under <resources>\python, the jw venv) — a
  // cache-less target would compile .pyc INTO the bundle and break the
  // codesign seal (see the W22 guard at the in-place branch). The payload
  // ships precompiled caches; a gap self-heals in memory per launch
  // (PYTHONDONTWRITEBYTECODE) instead of by writing into the seal.
  // precompileTargets() keeps listing them (win32 still compiles them in
  // place) — the filter is darwin-only, right here at the consumption site.
  const templateRuns = precompileTargets(paths, envsDir)
    .filter((t) => t.phase === "template")
    .filter((t) => platform !== "darwin")
    .map((t) => compileIfCacheless(t, compileEnv, log));

  log(`first run: unpacking bundled Python environments into ${envsDir}`);
  const unpackStarted = Date.now();
  perfB("unpack-enter");
  await rm(envsDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  let lastReportedPct = -1;
  await copyTreeConcurrent(paths.envsTemplate, envsDir, {
    onProgress: (done, total) => {
      const pct = Math.floor((done / Math.max(total, 1)) * 100);
      if (pct >= lastReportedPct + 10 || done === total) {
        lastReportedPct = pct;
        log(`first run: unpack ${pct}% (${done}/${total} files)`);
      }
    },
  });
  perfB("unpack-done", `self=${Date.now() - unpackStarted}ms`);
  log(`[perf] copyTreeConcurrent elapsed=${Date.now() - unpackStarted}ms`);
  log("first run: unpack complete");

  const fixStarted = Date.now();
  perfB("venv-fix-enter");
  for (const name of paths.venvNames) {
    await fixVenvHome(join(envsDir, name), paths.python, log);
    await fixEditablePths(join(envsDir, name), paths.backend, log, platform);
  }
  perfB("venv-fix-done", `self=${Date.now() - fixStarted}ms`);
  log(`[perf] fixVenvHome/fixEditablePths elapsed=${Date.now() - fixStarted}ms`);
  // The freshly copied envs may still come from a pre-fix payload —
  // replace their trampolines (+ runtime DLLs) before the unpacked-phase
  // precompile spawns them.
  await fixVenvLaunchers(paths, envsDir, log, platform);

  // Bytecode: the payload ships __pycache__ precompiled at build time
  // (assemble-backend.mjs A6, content-hash mode) and pyFilter no longer strips
  // it, so the copy above normally carries valid caches.
  //
  // #897 section 2 (second half) — verify the COPY kept that coverage instead of
  // trusting "is there any .pyc". treeHasPycache() answered the latter and
  // short-circuited on the first hit, so release6's 1,384-of-~37,000 payload
  // (PYTHONPYCACHEPREFIX had redirected the rest outside the payload — problems
  // W25) still looked complete: the remedial compile was skipped and the gap only
  // surfaced later as an ImportError the first time a tool imported a missing
  // module. judgeBytecodeCoverage() walks the copied tree once and compares it
  // against the build's own manifest count, so an incomplete set NAMES ITSELF
  // here, at first launch, rather than at first tool use.
  //
  // This is on the first-launch path only (a valid unpack stamp short-circuits at
  // needsUnpack above), and the walk covers the copied envs-template region
  // (measured ~750ms on release6), NOT the read-only in-place jw venv (measured
  // ~3.2s): "partial copy / interrupted unpack" — the failures section 2 names —
  // can only happen to the tree copyTreeConcurrent just wrote.
  let precompiled = 0;
  const compileStarted = Date.now();
  perfB("precompile-phase-enter");
  const verdict = await judgeBytecodeCoverage("copied", envsDir, paths.resourcesPath, log);
  if (verdict.ok) {
    // Template-phase fallbacks kicked off before the copy may still be in
    // flight (cache-less stdlib/jw venv) — never leave them unawaited.
    precompiled = (await Promise.all(templateRuns)).filter(Boolean).length;
  } else {
    const unpackedRuns = precompileTargets(paths, envsDir)
      .filter((t) => t.phase === "unpacked")
      .map((t) => runCompileall(t, compileEnv, log));
    const results = await Promise.all([...unpackedRuns, ...templateRuns]);
    precompiled = results.filter(Boolean).length;
  }
  perfB("precompile-phase-done", `self=${Date.now() - compileStarted}ms precompiled=${precompiled}`);
  log(`[perf] precompile/fallback elapsed=${Date.now() - compileStarted}ms`);

  const stamp: UnpackStamp = { installRoot: paths.resourcesPath, at: new Date().toISOString(), payload: payloadId };
  await mkdir(envsDir, { recursive: true });
  await writeFile(stampPath(dataDir), JSON.stringify(stamp, null, 2), "utf8");
  log(`[perf] bootstrapPackaged total=${Date.now() - bootstrapStarted}ms`);
  log("first run: bundled environments ready");
  return { unpacked: true, jwFixed: true, precompiled };
}

/**
 * uv-made venvs ship Scripts\python.exe / pythonw.exe as trampolines with
 * the BUILD machine's interpreter path burned in — on any other machine
 * they die with "uv trampoline failed to spawn Python child process". Swap
 * them for the bundled real launchers. Idempotent; misses are fine (the
 * assemble script already does the same at payload build time).
 *
 * The swapped-in launcher resolves python3x.dll / vcruntime*.dll by name —
 * its own directory first, then PATH/registry. On a machine without a
 * system Python every venv python dies with 0xC0000135 before main() (seen
 * in the field: all six venv pythons dead, precompile 0-1s ×6, jw init
 * 1.6s). The bundled runtime DLLs must sit beside the launcher; the
 * assemble script ships them, this is the idempotent first-run/reinstall
 * backstop.
 *
 * darwin: POSIX venvs made by uv carry no trampolines and no DLLs — the
 * Windows swap is skipped outright. Instead, venv python launchers are
 * RELATIVE symlinks whose hop count is baked for the venv's position in
 * the PAYLOAD (envs-template/<name>: ../../../python — 3 hops; the jw venv:
 * 4). As long as venvs run in-place that target is correct by construction.
 * W17: when the copy fallback moves a venv OUT of the payload (read-only
 * volume — the W16 DMG run — or the historical default copy mode), the
 * hops now resolve against <dataDir> and land on thin air (measured:
 * <dataDir>/envs/sd-services/bin/python -> ../../../python/bin/python3
 * resolved to /Users/<user>/python — start-stack's venvPython() existsSync
 * says false and the stack fail-fasts with "SHARED_ENV is missing"). Re-point
 * every copied venv's python* symlinks at the ACTUAL bundled interpreter,
 * with the hop count computed from where the venv sits NOW; venvs still
 * inside the payload keep their (correct) baked links untouched — the
 * rewrite is idempotent and only fires for links that do not already
 * resolve to the right interpreter.
 */
async function fixVenvLaunchers(
  paths: PackagedPaths,
  envsDir: string,
  log: (line: string) => void,
  platform: ShellPlatform = CURRENT_SHELL_PLATFORM,
): Promise<void> {
  if (platform === "darwin") {
    // Venvs under envsDir are the COPIED ones (in-place mode passes
    // envsTemplate here and the links are already correct — replaceVenvSymlinks
    // is idempotent and verifies by target, so running it anyway is safe; but
    // skip venvs whose links already point where they should, cheaply, by
    // checking that the venv's python resolves to the bundled interpreter).
    const venvs = paths.venvNames
      .map((name) => join(envsDir, name))
      .filter((v) => existsSync(v));
    for (const venvDir of venvs) {
      const minor = venvPythonMinor(venvDir);
      if (!minor) continue; // unreadable/missing pyvenv.cfg — fixVenvHome already warned
      // Compute the relative hop count from the venv's CURRENT location to
      // the bundled interpreter, exactly like assemble §7b does for the
      // payload position: the link lives in <venv>/bin/ (one level below
      // venvDir), so hops = depth(venvDir → common root) + 1. An off-by-one
      // lands the link one directory short (measured in W15) — use the same
      // relative() the build side uses, not hand-counted "../" repeats.
      const venvBinDir = join(venvDir, "bin");
      const relTarget = posixRelative(venvBinDir, join(paths.python, "bin", "python3"));
      const names = pythonNamesFor(minor);
      // Does the venv's python already resolve to the bundled interpreter?
      // (in-place mode: the baked 3-hop link is correct; idempotence gate
      // for the copy mode: a relaunch re-runs this fix on the copied venvs.)
      const venvPythonLink = join(venvBinDir, names[0]);
      let alreadyResolves = false;
      try {
        alreadyResolves = realpathSync(venvPythonLink) === realpathSync(join(paths.python, "bin", "python3"));
      } catch { /* dead link — falls through to the rewrite */ }
      if (alreadyResolves) continue;
      const n = await replaceVenvSymlinks([venvDir], "bin", relTarget, log, names);
      if (n > 0) {
        log(`first run: re-pointed ${n} venv python symlink(s) in ${venvDir} (copied out of the read-only payload — W17)`);
      }
    }
    return;
  }
  const venvs = [...paths.venvNames.map((name) => join(envsDir, name)), join(paths.jwSrc, ".venv")];
  const existing = venvs.filter((v) => existsSync(v));
  if (existing.length) {
    await replaceVenvTrampolines(existing, paths.python, log);
    await copyVenvRuntimeDlls(existing, paths.python, log);
  }
}

async function fixVenvHome(venvDir: string, pythonHome: string, log: (line: string) => void): Promise<void> {
  const cfg = join(venvDir, "pyvenv.cfg");
  if (!existsSync(cfg)) {
    log(`first run: warning — ${cfg} missing; venv left as-is`);
    return;
  }
  const text = await readFile(cfg, "utf8");
  const fixed = rewritePyvenvHome(text, pythonHome);
  if (fixed !== text) await writeFile(cfg, fixed, "utf8");
}

/** Point the venv's editable-install .pth files (placeholder'ed at assemble
 * time) at the real bundled backend tree. No-op for non-placeholder files.
 * The site-packages location is platform-shaped (Lib\site-packages vs
 * lib/python3.<minor>/site-packages — minor from the venv's own pyvenv.cfg).
 * Review F4: platform is the CALLER's decision, threaded from
 * bootstrapPackaged — never the host constant, so a Linux CI host running a
 * win32-dialect fixture resolves the same paths a real Windows boot does. */
async function fixEditablePths(
  venvDir: string,
  backendRoot: string,
  log: (line: string) => void,
  platform: ShellPlatform = CURRENT_SHELL_PLATFORM,
): Promise<void> {
  const layout = venvLayoutFor(platform);
  const minor = venvPythonMinor(venvDir) ?? "12";
  const sitePackages = join(venvDir, ...layout.sitePackages(minor).split("/"));
  let entries;
  try {
    entries = await readdir(sitePackages, { withFileTypes: true });
  } catch {
    return; // not a venv layout we recognize; nothing to fix
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^_editable_impl_.*\.pth$/.test(entry.name)) continue;
    const file = join(sitePackages, entry.name);
    const text = await readFile(file, "utf8");
    if (!text.includes(BACKEND_PLACEHOLDER)) continue;
    await writeFile(file, rewriteEditablePth(text, backendRoot), "utf8");
    log(`first run: pointed ${entry.name} at the bundled backend`);
  }
}
