// F10 packaged bootstrap: first-run provisioning of the bundled payload.
// The installer ships venvs as a read-only template under <resources>; the
// stack expects them under <dataDir>\envs (writable, uv-extensible later).
// This module unpacks that template once per data dir and rewrites each
// venv's pyvenv.cfg `home` to the bundled base interpreter, so the venvs run
// from any installation directory the user picked.
// Pure decisions are exported for unit tests; the IO is thin and fire-and-forget-safe.
//
// F10.6d2 (owner feedback "first two steps too slow"): (a) the envs-template
// copy now runs through a bounded-concurrency pool — fs.cp is serial per file
// and tens of thousands of small venv files made unpack I/O-latency bound;
// (b) precompile targets are split into a "template" phase (stdlib + jw venv,
// both live in the read-only resources) that STARTS before the copy and
// overlaps it, and an "unpacked" phase (the five copied venvs) that all run
// in parallel instead of the former serial for-loop.

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
// @ts-expect-error — plain .mjs helper shared with scripts/assemble-backend.mjs (no .d.mts in scope)
import { copyVenvRuntimeDlls, replaceVenvTrampolines } from "../scripts/lib/venv-launchers.mjs";

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

export function packagedPaths(resourcesPath: string): PackagedPaths {
  return {
    resourcesPath,
    backend: join(resourcesPath, "backend"),
    python: join(resourcesPath, "python"),
    micromamba: join(resourcesPath, "micromamba", "micromamba.exe"),
    envsTemplate: join(resourcesPath, "envs-template"),
    venvNames: ["gateway", "memory-graph", "evolve", "adapter", "paper"],
    jwSrc: join(resourcesPath, "backend", ".sciencediscovery-data", "jiuwenswarm", "src"),
  };
}

/** Stamp written into the unpacked envs; a mismatch (different install dir,
 *  e.g. reinstall to another location) forces a fresh unpack. */
export interface UnpackStamp {
  installRoot: string;
  at: string;
}

export function stampPath(dataDir: string): string {
  return join(dataDir, "envs", ".shell-unpacked");
}

/** Env vars the packaged shell injects into every stack spawn. */
export function packagedEnv(paths: PackagedPaths, dataDir: string): NodeJS.ProcessEnv {
  return {
    SCIENCE_AGENT_PACKAGED: "1",
    SCIENCE_AGENT_PYTHON_PATH: join(paths.python, "python.exe"),
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
    JIUWENSWARM_SRC: paths.jwSrc,
    // The api defaults paper's interpreter to a POSIX-style venv path that
    // never exists on Windows; point it at the unpacked bundled paper venv.
    SCIENCE_AGENT_PAPER_PYTHON_PATH: join(dataDir, "envs", "paper", "Scripts", "python.exe"),
    // F10.10: ship the new desktop UI as the renderer payload.
    SCIENCE_AGENT_WEB_DIR: "apps/desktop/dist",
  };
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
 * F10.6d: compileall argv for one precompile target. Pure.
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
 * F10.6d2: the compileall target list for this install, derived from what
 * actually exists on disk right now. Call once before the unpack (yields the
 * template-phase targets) and once after it (also yields the unpacked venvs).
 * Pure w.r.t. the filesystem state it observes.
 */
export function precompileTargets(paths: PackagedPaths, envsDir: string): PrecompileTarget[] {
  const out: PrecompileTarget[] = [];
  const basePython = join(paths.python, "python.exe");
  if (existsSync(basePython)) {
    out.push({ label: "python stdlib", python: basePython, target: join(paths.python, "Lib"), phase: "template" });
  }
  for (const name of paths.venvNames) {
    const venvDir = join(envsDir, name);
    const venvPython = join(venvDir, "Scripts", "python.exe");
    if (existsSync(venvPython)) {
      out.push({ label: `${name} venv`, python: venvPython, target: join(venvDir, "Lib", "site-packages"), phase: "unpacked" });
    }
  }
  const jwVenv = join(paths.jwSrc, ".venv");
  const jwPython = join(jwVenv, "Scripts", "python.exe");
  if (existsSync(jwPython)) {
    out.push({ label: "jiuwenswarm venv", python: jwPython, target: join(jwVenv, "Lib", "site-packages"), phase: "template" });
  }
  return out;
}

export interface BootstrapResult {
  unpacked: boolean;
  jwFixed: boolean;
  /** How many bytecode precompile runs succeeded (F10.6d; 0 when skipped). */
  precompiled: number;
}

/** True when the envs under this data dir must be (re)unpacked. Pure decision. */
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

/**
 * F10.6d2: recursive tree copy with bounded concurrency. fs.cp copies files
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
      // cold starts then pay the compile tax every launch (F10.6d bugfix).
      env,
      windowsHide: true,
      timeout: 600_000,
      // maxBuffer: compileall prints one line per un-compileable file; the jw
      // venv emits >1MB (default cap) and the whole precompile used to fail
      // with "stdout maxBuffer length exceeded" — silently losing the cache
      // and re-taxing every cold start (F10.6d2 bugfix, found in shell.log).
      maxBuffer: 64 * 1024 * 1024,
    });
    log(`first run: precompiled bytecode for ${target.label} (${Math.round((Date.now() - started) / 1000)}s)`);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean };
    // compileall exits 1 when SOME files fail — on Windows typically the
    // 260-char path limit skipping a slice of long-path files while the rest
    // of the venv does get cached. That is a partial success, not a failure;
    // the old "failed" wording made a normal install look broken (F10.6
    // feedback round ②). Real failures (python missing / timeout) keep the
    // hard warning.
    if (typeof err.code === "number" && !err.killed) {
      log(`first run: precompile partially done for ${target.label} (${Math.round((Date.now() - started) / 1000)}s; skipped files compile lazily on first launch — normal on Windows)`);
    } else {
      log(`first run: warning — bytecode precompile failed for ${target.label}: ${String(err.message ?? error)}`);
    }
    return false;
  }
}

/**
 * First-run provisioning for a packaged install:
 *  1. start precompiling the template-phase targets (stdlib + jw venv) —
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
): Promise<BootstrapResult> {
  const envsDir = join(dataDir, "envs");
  if (!needsUnpack(dataDir, paths.resourcesPath)) {
    // F10.6m: a same-location reinstall keeps a valid unpack stamp, so
    // dataDir\envs may still hold pre-fix trampoline launchers copied from
    // an older payload. The fix is idempotent and cheap — always run it.
    await fixVenvLaunchers(paths, envsDir, log);
    // F10.6n: the reinstall also refreshed the payload's in-place jw venv,
    // re-shipping the build machine's pyvenv.cfg home — fix that too, or the
    // next jw spawn (init/precompile) runs against a nonexistent interpreter.
    const jwVenv = join(paths.jwSrc, ".venv");
    if (existsSync(join(jwVenv, "pyvenv.cfg"))) {
      await fixVenvHome(jwVenv, paths.python, log);
    }
    return { unpacked: false, jwFixed: false, precompiled: 0 };
  }
  const compileEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONWARNINGS: "ignore",
  };

  // F10.6m/F10.6n: fix the in-place jw venv launchers + runtime DLLs and its
  // pyvenv.cfg home BEFORE anything spawns it (on a fresh data dir envsDir
  // doesn't exist yet, so only jw matches — the idempotent full pass after
  // the copy picks up the five copied venvs). dist13 ordering bug: the jw home
  // fix used to run only AFTER the ~7s unpack, so the overlapping jw
  // precompile spawned against the build machine's burned-in home.
  await fixVenvLaunchers(paths, envsDir, log);
  const jwVenv = join(paths.jwSrc, ".venv");
  if (existsSync(join(jwVenv, "pyvenv.cfg"))) {
    await fixVenvHome(jwVenv, paths.python, log);
    log("first run: pointed the bundled JiuwenSwarm venv at the bundled interpreter");
  }

  log(`first run: unpacking bundled Python environments into ${envsDir}`);
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
  log("first run: unpack complete");

  for (const name of paths.venvNames) {
    await fixVenvHome(join(envsDir, name), paths.python, log);
    await fixEditablePths(join(envsDir, name), paths.backend, log);
  }
  // F10.6m: the freshly copied envs may still come from a pre-fix payload —
  // replace their trampolines (F10.6n: + runtime DLLs) before the
  // unpacked-phase precompile spawns them.
  await fixVenvLaunchers(paths, envsDir, log);

  // Bytecode: the payload ships __pycache__ precompiled at build time
  // (assemble-backend.mjs, content-hash mode) and pyFilter no longer strips
  // it, so the copy above already carries valid caches. Compile here ONLY
  // when the copy arrived cache-less (old payload / dev tree) as a fallback.
  let precompiled = 0;
  if (await treeHasPycache(envsDir)) {
    log("first run: bytecode precompiled at build time; skipping the compile step");
  } else {
    log("first run: no bytecode caches found; compiling (this may take a minute)...");
    const unpackedRuns = precompileTargets(paths, envsDir)
      .filter((t) => t.phase === "unpacked")
      .map((t) => runCompileall(t, compileEnv, log));
    const results = await Promise.all(unpackedRuns);
    precompiled = results.filter(Boolean).length;
  }

  const stamp: UnpackStamp = { installRoot: paths.resourcesPath, at: new Date().toISOString() };
  await mkdir(envsDir, { recursive: true });
  await writeFile(stampPath(dataDir), JSON.stringify(stamp, null, 2), "utf8");
  log("first run: bundled environments ready");
  return { unpacked: true, jwFixed: true, precompiled };
}

/**
 * F10.6m: uv-made venvs ship Scripts\python.exe / pythonw.exe as trampolines
 * with the BUILD machine's interpreter path burned in — on any other machine
 * they die with "uv trampoline failed to spawn Python child process". Swap
 * them for the bundled real launchers. Idempotent; misses are fine (the
 * assemble script already does the same at payload build time).
 *
 * F10.6n: the swapped-in launcher resolves python3x.dll / vcruntime*.dll by
 * name — its own directory first, then PATH/registry. On a machine without a
 * system Python every venv python dies with 0xC0000135 before main() (dist13
 * external: all six venv pythons dead, precompile 0-1s ×6, jw init 1.6s). The
 * bundled runtime DLLs must sit beside the launcher; the assemble script
 * ships them, this is the idempotent first-run/reinstall backstop.
 */
async function fixVenvLaunchers(
  paths: PackagedPaths,
  envsDir: string,
  log: (line: string) => void,
): Promise<void> {
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
 * time) at the real bundled backend tree. No-op for non-placeholder files. */
async function fixEditablePths(venvDir: string, backendRoot: string, log: (line: string) => void): Promise<void> {
  const sitePackages = join(venvDir, "Lib", "site-packages");
  let entries;
  try {
    entries = await readdir(sitePackages, { withFileTypes: true });
  } catch {
    return; // not a Windows-venv layout; nothing to fix
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
