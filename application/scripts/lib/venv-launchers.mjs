// [windows-desktop] In uv-created venvs, Scripts\python.exe / pythonw.exe are
// not real interpreters but uv trampolines: the PE burns in the BUILD
// machine's absolute interpreter path, so on any other machine spawn dies
// with "uv trampoline failed to spawn Python child process: entity not
// found" (the final root cause of every off-machine failure; two local acid
// tests were false positives only because the build-machine path happened
// to exist there). The trampoline does not read pyvenv.cfg either, so
// bootstrap fixing only the home line is useless.
//
// Fix: identify trampolines by their marker string and overwrite them with
// the bundled real interpreter exe. Dropped into venv\Scripts\, the real exe
// follows CPython's standard venv discovery (walk up from its own location
// to pyvenv.cfg → home → base interpreter), closing the loop together with
// fixVenvHome.
//
// [windows-desktop] Swapping the exe alone is not enough: the real exe
// resolves python3x.dll/vcruntime*.dll by name (its own directory first,
// then PATH/registry fallbacks). On a clean machine every fallback is empty
// → the process exits with 0xC0000135 before main() (the root cause of six
// dead venv pythons off-machine, precompile 0-1s ×6, jiuwenswarm init
// 1.6s); an unrelated Python on the build machine's PATH masked it. Fix:
// copy the bundled python root's runtime DLLs into every venv\Scripts\ so
// the exe's own directory hits on the first try (copyVenvRuntimeDlls).
//
// Two callers share this module: assemble-backend (repairs the payload at
// packaging time, so fresh installs are clean at the source) and bootstrap
// (first-run safety net — a same-location reinstall keeps the unpack stamp
// valid while dataDir\envs still holds pre-fix trampolines).

import { copyFile, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { join, posix } from "node:path";
const TRAMPOLINE_MARKER = "uv trampoline";

/** Runtime DLLs a copied-in CPython launcher needs beside itself to boot on
 * a clean machine: the interpreter
 * runtime (python3x.dll + the python3.dll ABI shim) and the MSVC runtimes
 * it links against. The launcher resolves these by name — its own directory
 * first, then the system PATH/registry. On machines without a system Python
 * neither fallback exists and the process dies with 0xC0000135
 * (STATUS_DLL_NOT_FOUND) before main() — on the build machine an
 * unrelated PATH Python silently masked it (third false-positive class). */
const RUNTIME_DLL_RE = /^(python3.*\.dll|vcruntime.*\.dll)$/i;

/** The runtime DLL file names shipped in the bundled python root. Pure. */
export async function bundledRuntimeDlls(pythonHome) {
  let entries;
  try {
    entries = await readdir(pythonHome, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && RUNTIME_DLL_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Copy the bundled runtime DLLs into each venv's Scripts\, beside the
 * launcher replaced by replaceVenvTrampolines. Idempotent: skips files that
 * are already present with the same size. Returns how many files were
 * copied. Venvs without Scripts\python.exe are skipped (nothing launches
 * from them). */
export async function copyVenvRuntimeDlls(venvDirs, pythonHome, log = () => {}) {
  const dlls = await bundledRuntimeDlls(pythonHome);
  if (!dlls.length) return 0;
  let copied = 0;
  for (const venvDir of venvDirs) {
    if (!existsSync(join(venvDir, "Scripts", "python.exe"))) continue;
    let venvCopied = 0;
    for (const name of dlls) {
      const dst = join(venvDir, "Scripts", name);
      let stale = true; // missing → copy
      try {
        stale = (await stat(dst)).size !== (await stat(join(pythonHome, name))).size;
      } catch {
        /* missing → copy */
      }
      if (!stale) continue;
      await copyFile(join(pythonHome, name), dst);
      copied++;
      venvCopied++;
    }
    if (venvCopied) log(`installed ${venvCopied} runtime DLL(s) beside the launcher in ${venvDir}`);
  }
  return copied;
}

/** True when the exe at exePath is a uv trampoline (the build machine's
 * interpreter path burned into the PE). uv trampolines are ~45 KiB and always
 * carry the marker string; real CPython launchers never do. */
export async function isUvTrampoline(exePath) {
  let buf;
  try {
    buf = await readFile(exePath);
  } catch {
    return false;
  }
  return buf.subarray(0, 512 * 1024).includes(Buffer.from(TRAMPOLINE_MARKER, "latin1"));
}

/** Replace trampoline python.exe/pythonw.exe in each venv with the bundled
 * real launchers from pythonHome (a directory). Idempotent — real launchers
 * are left untouched. Returns how many files were replaced. */
export async function replaceVenvTrampolines(venvDirs, pythonHome, log = () => {}) {
  let replaced = 0;
  for (const venvDir of venvDirs) {
    for (const name of ["python.exe", "pythonw.exe"]) {
      const dst = join(venvDir, "Scripts", name);
      if (!existsSync(dst)) continue;
      if (!await isUvTrampoline(dst)) continue;
      const src = join(pythonHome, name);
      if (!existsSync(src)) continue; // payload without pythonw — leave as-is
      await copyFile(src, dst);
      replaced++;
      log(`replaced uv trampoline ${name} in ${venvDir}`);
    }
  }
  return replaced;
}

// [macOS adaptation] POSIX venvs carry the SAME off-machine disease in a
// different shape: uv/CPython venvs put bin/python (and bin/python3) down as
// SYMLINKS whose target is an ABSOLUTE path on the build machine (measured:
// `python3 -> /Users/<builder>/.workbuddy/binaries/.../bin/python3`).
// Everything else about the venv is position-independent (pyvenv.cfg home is
// rewritten at assemble/bootstrap), but a symlink with a burned-in absolute
// target is a dead link on any other machine — the darwin twin of the
// trampoline lesson ("two local acid tests were false positives only because
// the build-machine path happened to exist there").
//
// Fix: point every venv bin/python* symlink at the bundled base interpreter
// with a RELATIVE target (../../python/bin/python3 from <venv>/bin), so the
// link stays valid wherever the payload is installed. Console entry points
// (jiuwenswarm-start etc.) keep their own symlinks — pip-installed entry
// point scripts resolve the interpreter at runtime via their shebang, and
// the shebang is rewritten separately by bootstrap.
//
// pythonNamesFor(minor): the venv layout carries THREE interpreter links —
// python, python3, and the versioned python3.<minor> (e.g. python3.12). The
// versioned link is what pyvenv.cfg-agnostic tooling (and codesign
// --deep --strict: "invalid destination for symbolic link in bundle") walks,
// so ALL three must be rewritten, not just the two unversioned ones
// (measured: python3.12 left absolute → codesign verify rejected the bundle,
// and the link is dead on any user machine).
export function pythonNamesFor(minor) {
  return ["python", "python3", `python3.${minor}`];
}

export async function replaceVenvSymlinks(venvDirs, venvBinDir, bundledPythonRelTarget, log = () => {}, names = ["python", "python3"]) {
  let replaced = 0;
  for (const venvDir of venvDirs) {
    for (const name of names) {
      const linkPath = join(venvDir, venvBinDir, name);
      // Only a symlink is rewriteable: a regular file (real interpreter, or a
      // Windows trampoline) is not ours to touch, and a missing entry means
      // the venv was provisioned differently than expected — skip silently,
      // the caller's gate counts what actually happened.
      let isLink = false;
      try {
        isLink = lstatSync(linkPath).isSymbolicLink();
      } catch {
        continue; // missing — nothing to rewrite
      }
      if (!isLink) continue;
      const target = await readlink(linkPath);
      if (target === bundledPythonRelTarget) continue; // already fixed (idempotent)
      await rm(linkPath, { force: true });
      await symlink(bundledPythonRelTarget, linkPath);
      replaced++;
      log(`rewrote venv symlink ${name} -> ${bundledPythonRelTarget} in ${venvDir}`);
    }
  }
  return replaced;
}

// [macOS adaptation] The bundled python INSTALL ROOT itself (uv-managed
// CPython trees) ships absolute symlinks baked at install time — measured on
// a payload: bin/python3 -> <builder>/.local/share/uv/python/.../bin/python3.12,
// lib/pkgconfig/python3.pc -> <builder>/.../python-3.12.pc, share/man/man1/
// python3.1 -> <builder>/.../python3.12.1. On any other machine these are
// dead links, and `codesign --verify --deep --strict` refuses the whole
// bundle ("invalid destination for symbolic link in bundle") before the
// runtime even gets a chance to trip on them.
//
// Fix: walk <out>/python once; for every ABSOLUTE symlink, map its leaf
// name into the payload tree (the bundled tree mirrors the install root,
// so destinations keep their leaf names) and rewrite it as a relative hop.
// Links whose leaf has no counterpart in the tree (pkgconfig/man dev
// artifacts) are removed outright — codesign requires a valid destination
// for EVERY symlink in the bundle, and they carry no runtime meaning for a
// bundled interpreter. Idempotent: already-relative links are untouched.
export async function relocatablePythonTree(pythonRoot, log = () => {}) {
  let rewritten = 0;
  let removed = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(p);
        if (!target.startsWith("/")) continue; // relative already
        const leaf = target.split("/").filter(Boolean).pop() || "";
        if (!leaf) continue;
        const candidates = await findByName(pythonRoot, leaf);
        if (candidates.length === 0) {
          await rm(p, { force: true });
          removed++;
          log(`removed off-tree symlink ${p} -> ${target}`);
          continue;
        }
        // Prefer the candidate sharing the link's own parent dir name
        // (lib/pkgconfig links prefer lib/pkgconfig targets).
        const parentName = dir.split("/").filter(Boolean).pop();
        const dest =
          candidates.find((c) => {
            const segs = c.split("/").filter(Boolean);
            return segs[segs.length - 2] === parentName;
          }) || candidates[0];
        const rel = posixRelative(dir, dest);
        await rm(p, { force: true });
        await symlink(rel, p);
        rewritten++;
        log(`relativized ${p}: ${target} -> ${rel}`);
      }
    }
  };
  await walk(pythonRoot);
  return { rewritten, removed };
}

// Find regular files by exact name under root (bounded walk, no fd hoard).
async function findByName(root, name) {
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === name) hits.push(p);
    }
  }
  return hits;
}

function posixRelative(fromDir, toPath) {
  return posix.relative(fromDir, toPath);
}
