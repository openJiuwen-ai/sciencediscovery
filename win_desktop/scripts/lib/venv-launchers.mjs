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

import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
