// F10.6m: uv-venv launcher trampolines — the root cause of every off-machine
// failure (dist7-12): Scripts\python.exe burns in the BUILD machine's
// interpreter path and dies with "entity not found" everywhere else.
// F10.6n: the swapped-in launcher loads python3x.dll/vcruntime*.dll by name
// (exe dir → PATH → registry); without the DLLs beside it every venv python
// dies with 0xC0000135 on machines without a system Python (dist13 external).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  bundledRuntimeDlls, copyVenvRuntimeDlls, isUvTrampoline, replaceVenvTrampolines,
} from "../scripts/lib/venv-launchers.mjs";

// The marker text every uv trampoline binary carries (see the real one:
// "uv trampoline failed to spawn Python child process" — byte-identical to
// the field error from 2026-10-18).
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

// --- F10.6n: runtime DLLs beside the venv launcher ------------------------------

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
