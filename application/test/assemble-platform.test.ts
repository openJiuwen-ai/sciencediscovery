// assemble-platform dialect (macOS adaptation, D3 §2) — the decision table
// assemble-backend.mjs consumes for every platform-sensitive step. Pinned
// here in lockstep with src/shell-platform.ts venvLayoutFor() (the runtime
// consumer): if one table moves without the other, a test below fails naming
// the drifted field.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSEMBLE_PLATFORMS, parseAssemblePlatform, assemblePlatformFamily,
  assembleDialect, finderAnchorLevel, sitePackagesDepth,
} from "../scripts/lib/assemble-platform.mjs";

// --- argument parsing -----------------------------------------------------------

test("parseAssemblePlatform defaults to win32-x64 (current behaviour, byte-for-byte)", () => {
  const r = parseAssemblePlatform(["node", "assemble-backend.mjs", "--out", "x"]);
  assert.equal(r.platform, "win32-x64");
  assert.equal(r.error, null);
});

test("parseAssemblePlatform accepts every shipped platform", () => {
  for (const p of ["win32-x64", "darwin-arm64", "darwin-x64"]) {
    const r = parseAssemblePlatform(["--platform", p]);
    assert.equal(r.platform, p);
    assert.equal(r.error, null);
  }
});

test("parseAssemblePlatform rejects missing value and unknown platforms", () => {
  const missing = parseAssemblePlatform(["--platform"]);
  assert.equal(missing.platform, null);
  assert.match(missing.error, /requires a value/);
  const unknown = parseAssemblePlatform(["--platform", "linux-arm64"]);
  assert.equal(unknown.platform, null);
  assert.match(unknown.error, /unknown platform "linux-arm64"/);
  assert.match(unknown.error, /darwin-arm64/); // error names the valid set
});

// --- dialect table (lockstep with shell-platform.ts venvLayoutFor) ---------------

test("win32 dialect matches the shipped Windows payload shape", () => {
  const d = assembleDialect("win32-x64");
  assert.equal(d.family, "win32");
  assert.equal(d.basePythonName, "python.exe");
  // The bundled interpreter path under <out>/python: win32 roots carry
  // python.exe at the root itself (lockstep with venvLayoutWin32.basePython).
  assert.equal(d.bundledBasePythonPath, "python.exe");
  assert.equal(d.venvBin, "Scripts");
  assert.equal(d.venvPythonName, "python.exe");
  assert.equal(d.venvLib("12"), "Lib");
  assert.equal(d.sitePackages("12"), "Lib\\site-packages");
  assert.equal(d.stdlibLib("12"), "Lib");
  assert.equal(d.micromambaName, "micromamba.exe");
  assert.equal(d.pthSeparator, "\\");
  assert.equal(d.finderSeparator, "\\");
  assert.equal(d.hasTrampolines, true);
  assert.deepEqual(d.stdlibCompileTarget("12"), ["Lib"]);
});

test("darwin dialect matches the POSIX payload shape (python-build-standalone)", () => {
  const d = assembleDialect("darwin-arm64");
  assert.equal(d.family, "darwin");
  assert.equal(d.basePythonName, "python3");
  // The darwin payload bundles the uv python INSTALL ROOT, so the bundled
  // interpreter keeps its bin/ layout — one level deeper than win32
  // (lockstep with venvLayoutDarwin.basePython "bin/python3" and with
  // replaceVenvSymlinks' hop target python/bin/python3).
  assert.equal(d.bundledBasePythonPath, "bin/python3");
  assert.equal(d.venvBin, "bin");
  assert.equal(d.venvPythonName, "python");
  assert.equal(d.venvLib("12"), "lib/python3.12");
  assert.equal(d.sitePackages("12"), "lib/python3.12/site-packages");
  assert.equal(d.stdlibLib("12"), "lib/python3.12");
  assert.equal(d.micromambaName, "micromamba");
  assert.equal(d.pthSeparator, "/");
  assert.equal(d.finderSeparator, "/");
  assert.equal(d.hasTrampolines, false);
  assert.deepEqual(d.stdlibCompileTarget("12"), ["lib", "python3.12"]);
});

test("darwin-x64 shares the arm64 dialect (layout is arch-independent)", () => {
  const arm = assembleDialect("darwin-arm64");
  const x64 = assembleDialect("darwin-x64");
  // Field-by-field (the objects carry functions, so reference equality — and
  // therefore deepEqual on function properties — does not apply).
  assert.equal(x64.family, arm.family);
  assert.equal(x64.basePythonName, arm.basePythonName);
  assert.equal(x64.venvBin, arm.venvBin);
  assert.equal(x64.venvPythonName, arm.venvPythonName);
  assert.equal(x64.venvLib("12"), arm.venvLib("12"));
  assert.equal(x64.sitePackages("12"), arm.sitePackages("12"));
  assert.equal(x64.stdlibLib("12"), arm.stdlibLib("12"));
  assert.equal(x64.micromambaName, arm.micromambaName);
  assert.equal(x64.pthSeparator, arm.pthSeparator);
  assert.equal(x64.hasTrampolines, arm.hasTrampolines);
  assert.deepEqual(x64.stdlibCompileTarget("12"), arm.stdlibCompileTarget("12"));
});

test("assemblePlatformFamily routes every shipped platform", () => {
  assert.equal(assemblePlatformFamily("win32-x64"), "win32");
  assert.equal(assemblePlatformFamily("darwin-arm64"), "darwin");
  assert.equal(assemblePlatformFamily("darwin-x64"), "darwin");
});

// --- editable finder anchor (D3 §2 §5: the parents[N] rewrite) -------------------

test("finder anchor level is depth-relative: win32 parents[3], darwin parents[4]", () => {
  const win = assembleDialect("win32-x64");
  const mac = assembleDialect("darwin-arm64");
  // Windows: .venv\Lib\site-packages\f.py → parents[3] lands on <src>
  // (the shipped rewrite's literal value — pinned).
  assert.equal(finderAnchorLevel(sitePackagesDepth(win, "12")), 3);
  // POSIX: .venv/lib/python3.12/site-packages/f.py → parents[4] lands on <src>.
  assert.equal(finderAnchorLevel(sitePackagesDepth(mac, "12")), 4);
});

test("sitePackagesDepth counts segments from venv root to site-packages", () => {
  assert.equal(sitePackagesDepth(assembleDialect("win32-x64"), "12"), 2);
  assert.equal(sitePackagesDepth(assembleDialect("darwin-x64"), "12"), 3);
});

test("ASSEMBLE_PLATFORMS is exactly the shipped set (no legacy aliases)", () => {
  assert.deepEqual(ASSEMBLE_PLATFORMS, ["win32-x64", "darwin-arm64", "darwin-x64"]);
});
