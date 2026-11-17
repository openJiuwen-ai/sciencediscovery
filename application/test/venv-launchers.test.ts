// uv-venv launcher trampolines — the root cause of every off-machine
// failure: Scripts\python.exe burns in the BUILD machine's
// interpreter path and dies with "entity not found" everywhere else.
// The swapped-in launcher loads python3x.dll/vcruntime*.dll by name
// (exe dir → PATH → registry); without the DLLs beside it every venv python
// dies with 0xC0000135 on machines without a system Python.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  bundledRuntimeDlls, copyVenvRuntimeDlls, greenletRuntimeProblem, greenletVersionAtLeast,
  isUvTrampoline, MIN_SELF_CONTAINED_GREENLET_VERSION, replaceVenvTrampolines, replaceVenvSymlinks,
} from "../scripts/lib/venv-launchers.mjs";

// The marker text every uv trampoline binary carries (see the real one:
// "uv trampoline failed to spawn Python child process" — byte-identical to
// the field error).
const TRAMP = Buffer.concat([
  Buffer.from("MZ\x90\x00fake-pe-header"),
  Buffer.from("uv trampoline failed to spawn Python child process", "latin1"),
]);

function makeVenv(root: string, name: string, trampoline: boolean, withPythonw = false): string {
  const scripts = join(root, name, "Scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "python.exe"), trampoline ? TRAMP : Buffer.from("MZreal-cpython"));
  if (withPythonw) writeFileSync(join(scripts, "pythonw.exe"), TRAMP);
  return join(root, name);
}

test("isUvTrampoline detects the burned-in marker and nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-launch-"));
  try {
    writeFileSync(join(dir, "t.exe"), TRAMP);
    writeFileSync(join(dir, "r.exe"), Buffer.from("MZreal-cpython-launcher"));
    assert.equal(await isUvTrampoline(join(dir, "t.exe")), true);
    assert.equal(await isUvTrampoline(join(dir, "r.exe")), false);
    assert.equal(await isUvTrampoline(join(dir, "missing.exe")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceVenvTrampolines swaps trampolines for the bundled launchers, idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-launch-"));
  try {
    const home = join(dir, "python");
    mkdirSync(home);
    writeFileSync(join(home, "python.exe"), Buffer.from("MZ-REAL-PYTHON"));
    writeFileSync(join(home, "pythonw.exe"), Buffer.from("MZ-REAL-PYTHONW"));
    const bad = makeVenv(dir, "bad", true, true);
    const good = makeVenv(dir, "good", false);
    const logs: string[] = [];

    const n1 = await replaceVenvTrampolines([bad, good], home, (l) => logs.push(l));
    assert.equal(n1, 2, "python.exe + pythonw.exe in the trampoline venv");
    assert.equal(await readFile(join(bad, "Scripts", "python.exe"), "utf8"), "MZ-REAL-PYTHON");
    assert.equal(await readFile(join(bad, "Scripts", "pythonw.exe"), "utf8"), "MZ-REAL-PYTHONW");
    assert.equal(await readFile(join(good, "Scripts", "python.exe"), "utf8"), "MZreal-cpython", "real launcher untouched");
    assert.equal(logs.length, 2);

    const n2 = await replaceVenvTrampolines([bad, good], home, () => {});
    assert.equal(n2, 0, "second pass is a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceVenvTrampolines leaves pythonw alone when the bundle has no pythonw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-launch-"));
  try {
    const home = join(dir, "python");
    mkdirSync(home);
    writeFileSync(join(home, "python.exe"), Buffer.from("MZ-REAL-PYTHON")); // no pythonw.exe here
    const venv = makeVenv(dir, "v", true, true);

    const n = await replaceVenvTrampolines([venv], home, () => {});
    assert.equal(n, 1, "only python.exe replaced");
    assert.equal(await isUvTrampoline(join(venv, "Scripts", "pythonw.exe")), true, "pythonw left as-is");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- POSIX venv python symlinks (macOS adaptation, D3 §2 §7b) ----------

// The darwin twin of the trampoline disease: uv/CPython venvs put bin/python
// and bin/python3 down as SYMLINKS whose target is an absolute path on the
// build machine. On any other machine the link is dead — same failure class
// ("two local acid tests passed only because the build-machine path existed").
function makePosixVenv(root: string, name: string, absTarget: string): string {
  const bin = join(root, name, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(absTarget, join(bin, "python"));       // e.g. /Users/builder/.workbuddy/.../bin/python3
  symlinkSync(absTarget, join(bin, "python3"));      // same disease, second spelling
  writeFileSync(join(bin, "jiuwenswarm-start"), "#!/bin/sh\nexec python3 \"$@\"\n"); // console script, NOT ours
  return join(root, name);
}

test("replaceVenvSymlinks rewrites burned-in absolute targets to the relative bundled target", async (t) => {
  // The capability this case needs is a POSIX filesystem that stores symlink
  // targets as POSIX paths, and that is exactly what `win32` does not offer:
  // `replaceVenvSymlinks` is reached only from the darwin assembly and
  // bootstrap paths, a Windows host without Developer Mode raises EPERM on the
  // fixture, and the elevated runner creates the link but answers `readlink`
  // in the Windows dialect. So the platform gate is the capability gate here,
  // not a guess: this fixture cannot describe a Windows venv at all. Gate this
  // test, not the file — the trampoline and regular-file cases keep running.
  if (process.platform === "win32") {
    t.skip("models a darwin venv; POSIX symlink targets only exist on POSIX hosts");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "sd-sym-"));
  try {
    const venv = makePosixVenv(dir, "v", "/Users/builder/.workbuddy/binaries/.../bin/python3");
    const logs: string[] = [];
    const n = await replaceVenvSymlinks([venv], "bin", "../../../python/bin/python3", (l) => logs.push(l));
    assert.equal(n, 2, "python + python3 rewritten");
    assert.equal(readlinkSync(join(venv, "bin", "python")), "../../../python/bin/python3");
    assert.equal(readlinkSync(join(venv, "bin", "python3")), "../../../python/bin/python3");
    // The console script is not a python symlink — untouched.
    assert.equal(existsSync(join(venv, "bin", "jiuwenswarm-start")), true);
    assert.equal(lstatSync(join(venv, "bin", "jiuwenswarm-start")).isSymbolicLink(), false);
    assert.equal(logs.length, 2);
    // Idempotent: second pass sees the exact target and rewrites nothing.
    const n2 = await replaceVenvSymlinks([venv], "bin", "../../../python/bin/python3", () => {});
    assert.equal(n2, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceVenvSymlinks leaves regular files and missing entries alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-sym-"));
  try {
    const bin = join(dir, "venv", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "python"), "real-interpreter-binary"); // regular file, not a symlink
    // no bin/python3 at all
    const n = await replaceVenvSymlinks([join(dir, "venv")], "bin", "../python/bin/python3", () => {});
    assert.equal(n, 0, "regular file untouched, missing entry skipped");
    assert.equal((await readFile(join(bin, "python"), "utf8")), "real-interpreter-binary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Runtime DLLs beside the venv launcher ------------------------------

function makeHome(root: string): string {
  const home = join(root, "python");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "python.exe"), Buffer.from("MZ-REAL-PYTHON"));
  writeFileSync(join(home, "python3.dll"), Buffer.alloc(100, 1));
  writeFileSync(join(home, "python312.dll"), Buffer.alloc(200, 2));
  writeFileSync(join(home, "vcruntime140.dll"), Buffer.alloc(300, 3));
  writeFileSync(join(home, "vcruntime140_1.dll"), Buffer.alloc(400, 4));
  // Noise the DLL pick must ignore.
  writeFileSync(join(home, "libcrypto-3-x64.dll"), Buffer.alloc(50, 5));
  writeFileSync(join(home, "BUILD"), "x");
  return home;
}

test("bundledRuntimeDlls picks the interpreter + MSVC runtimes only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-dlls-"));
  try {
    const home = makeHome(dir);
    assert.deepEqual(await bundledRuntimeDlls(home),
      ["python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);
    assert.deepEqual(await bundledRuntimeDlls(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copyVenvRuntimeDlls installs DLLs beside the launcher, idempotently, and repairs stale sizes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-dlls-"));
  try {
    const home = makeHome(dir);
    const venv = makeVenv(dir, "venv", false); // real launcher, no DLLs yet
    const noLauncher = join(dir, "nolauncher");
    mkdirSync(join(noLauncher, "Scripts"), { recursive: true }); // no python.exe → skipped
    const logs: string[] = [];

    const n1 = await copyVenvRuntimeDlls([venv, noLauncher], home, (l) => logs.push(l));
    assert.equal(n1, 4, "all four runtime DLLs copied");
    for (const dll of ["python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
      assert.equal(
        statSync(join(venv, "Scripts", dll)).size,
        statSync(join(home, dll)).size,
        `${dll} copied byte-sized like the bundled one`);
    }
    assert.equal(logs.length, 1, "one log line for the venv that got DLLs");
    assert.ok(!existsSync(join(noLauncher, "Scripts", "python312.dll")), "no python.exe → no DLLs");

    // Second pass: everything in place → no-op.
    const n2 = await copyVenvRuntimeDlls([venv], home, () => {});
    assert.equal(n2, 0, "idempotent when sizes match");

    // A stale/wrong-sized DLL is repaired.
    writeFileSync(join(venv, "Scripts", "python312.dll"), Buffer.alloc(7, 9));
    const n3 = await copyVenvRuntimeDlls([venv], home, () => {});
    assert.equal(n3, 1, "stale DLL re-copied");
    assert.equal(statSync(join(venv, "Scripts", "python312.dll")).size, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("greenletVersionAtLeast accepts the static-runtime release and rejects the dynamic ones", () => {
  assert.equal(MIN_SELF_CONTAINED_GREENLET_VERSION, "3.5.5");
  assert.equal(greenletVersionAtLeast("3.5.5"), true);
  assert.equal(greenletVersionAtLeast("3.5.5.post1"), true);
  assert.equal(greenletVersionAtLeast("3.6.0"), true);
  assert.equal(greenletVersionAtLeast("4.0"), false, "must be a full x.y.z release");
  assert.equal(greenletVersionAtLeast("3.5.4"), false);
  assert.equal(greenletVersionAtLeast("3.3.1"), false);
  assert.equal(greenletVersionAtLeast("3.5.5rc1"), false, "a pre-release is not the fixed release");
  assert.equal(greenletVersionAtLeast("not-a-version"), false);
});

test("greenletRuntimeProblem inspects the shipped _greenlet extension, not the build machine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-greenlet-"));
  try {
    const sitePackages = join(dir, "Lib", "site-packages");
    const packageDir = join(sitePackages, "greenlet");
    mkdirSync(packageDir, { recursive: true });
    const extension = join(packageDir, "_greenlet.cp312-win_amd64.pyd");

    writeFileSync(extension, Buffer.concat([
      Buffer.from("MZ\x90\x00"),
      Buffer.from("MSVCP140.dll\x00", "latin1"),
    ]));
    assert.match(await greenletRuntimeProblem(sitePackages), /MSVCP140\.dll/);
    assert.match(await greenletRuntimeProblem(sitePackages), /greenlet>=3\.5\.5/);

    writeFileSync(extension, Buffer.from("MZ msvcp140.DLL\x00", "latin1"));
    assert.match(await greenletRuntimeProblem(sitePackages), /MSVCP140\.dll/,
      "Windows DLL names are case insensitive");

    writeFileSync(extension, Buffer.from("MZ static C++ runtime"));
    assert.equal(await greenletRuntimeProblem(sitePackages), null);

    rmSync(extension);
    assert.match(await greenletRuntimeProblem(sitePackages), /native extension .* is missing/);

    rmSync(packageDir, { recursive: true, force: true });
    assert.match(await greenletRuntimeProblem(sitePackages), /not installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the jw patch set and assemble gate keep greenlet self-contained", async () => {
  const patch = await readFile(new URL(
    "../../jiuwen_swarm/patches/workswarm0.2.6/0021-greenlet-static-runtime.patch", import.meta.url), "utf8");
  assert.match(patch, /^\+    "greenlet>=3\.5\.5,<4",$/m);
  assert.match(patch, /^\+    "greenlet>=3\.5\.5",$/m);
  assert.match(patch, /^\+version = "3\.5\.5"$/m, "the lock entry must match the raised floor");
  assert.match(patch, /^\+    \{ name = "greenlet", specifier = ">=3\.5\.5,<4" \},$/m,
    "the lock's recorded project specifier must match pyproject, or uv sync rewrites it");

  const assemble = await readFile(new URL("../scripts/assemble-backend.mjs", import.meta.url), "utf8");
  assert.match(assemble, /from greenlet import greenlet as _greenlet; _greenlet\(lambda: None\)\.switch\(\)/,
    "the payload smoke must load the native _greenlet extension");
  assert.match(assemble, /greenletVersionAtLeast/, "the 3.5.5 floor must gate the payload");
  assert.match(assemble, /greenletRuntimeProblem/, "the shipped .pyd DLL reference must gate the payload");
  assert.match(assemble, /MSVCP140\.dll/, "the failure must name the redistributable dependency");
});

test("copyVenvRuntimeDlls returns 0 when the bundle ships no runtime DLLs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-dlls-"));
  try {
    const emptyHome = join(dir, "python");
    mkdirSync(emptyHome);
    writeFileSync(join(emptyHome, "python.exe"), Buffer.from("MZ"));
    const venv = makeVenv(dir, "venv", false);
    assert.equal(await copyVenvRuntimeDlls([venv], emptyHome, () => {}), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
