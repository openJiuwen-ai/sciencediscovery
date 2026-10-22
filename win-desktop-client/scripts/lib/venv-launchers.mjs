// [windows-desktop] F10.6m —— uv 创建的 venv 里 Scripts\python.exe / pythonw.exe
// 不是真解释器，而是 uv trampoline：PE 里烧录的是**构建机**的解释器绝对路径，
// 装到任何其他机器上 spawn 直接 "uv trampoline failed to spawn Python child
// process: entity not found"（外机 dist7-12 全部失败的最终根因；本机酸测两次
// 假阳性都是因为构建机路径恰好存在）。它也不读 pyvenv.cfg，所以 bootstrap
// 只修 home 无济于事。
//
// 修法：按特征串识别 trampoline，用捆绑真解释器的 exe 覆盖。真 exe 落进
// venv\Scripts\ 后走 CPython 标准 venv 探测（从自身位置向上找 pyvenv.cfg →
// home → base interpreter），与 fixVenvHome 配合即闭环。
//
// [windows-desktop] F10.6n —— 只换 exe 还不够：真 exe 按名字解析
// python3x.dll/vcruntime*.dll（先 exe 自身目录，再 PATH/注册表兜底）。干净
// 机器上兜底全空 → 进程 main() 之前 0xC0000135 秒退（dist13 外机六个 venv
// python 全灭、precompile 0-1s ×6、jw init 1.6s 的根因）；构建机 PATH 里恰好
// 有别的 Python 把它掩盖了。修法：把捆绑 python 根目录的运行时 DLL 一并拷进
// 每个 venv\Scripts\，让 exe 自身目录一次命中（copyVenvRuntimeDlls）。
//
// 两个调用方共用本模块：assemble-backend（打包时修载荷，新装从源头干净）
// 与 bootstrap（首启兜底——同位置重装时 unpack stamp 有效，dataDir\envs 里
// 还是修复前拷出的旧 trampoline）。

import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TRAMPOLINE_MARKER = "uv trampoline";

/** Runtime DLLs a copied-in CPython launcher needs beside itself to boot on
 * a clean machine (F10.6n, dist13 external root cause): the interpreter
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
