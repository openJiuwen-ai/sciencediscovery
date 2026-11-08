// Pins the W28-C guards: the payload must not ship bytecode in an invalidation
// mode the installed tree cannot reuse.
//
// Field lesson source (problems W28-C, release7, 2026-11-07): the installer
// shipped 37,324 .pyc of which 971 were timestamp-mode. Every gate was green and
// none was wrong — A6 counted them because coverage and mode are different
// properties. NSIS extraction restamps every .py to the install instant, so a
// timestamp-mode .pyc is stale on arrival and CPython recompiles it: measured
// 1,048 .pyc rewritten on first launch.
//
// The numbers asserted below are that measured tree (logs/w28-evidence/):
//   release7 : 37,324 .pyc, 971 timestamp-mode, 0 unparseable, magic uniformly
//              the bundled interpreter's (w28c-header-shape.txt)
//
// Two kinds of test live here, because the two guards need different proof:
//   * pure functions (readPycHeader, sourceOfPyc, pycModeVerdict) are pinned
//     against hand-built headers and the measured counts — no interpreter needed,
//     so they run everywhere.
//   * recompileTimestampBytecode is the CAUSE-side driver: a string of python the
//     build pipes to an interpreter. Testing the string's TEXT proves nothing
//     about whether it runs (lesson L66 — a hand-copied replica is not the
//     driver), so the behavioural tests below execute it against a real python
//     and assert the .pyc it produces. They skip (loudly, with a reason) only
//     where no interpreter exists; on the dev machine that builds the payload
//     they always run.
//
// The wiring block at the end reads assemble-backend.mjs and pins the ORDER: A1c
// must run after the A1/A1b import self-checks, because those execute a payload
// python and an implicit import that compiles a source writes TIMESTAMP-mode
// bytecode by default — converting first would let a self-check silently undo the
// conversion (lesson L67). A correct conversion in the wrong place is dead work.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PYC_HEADER_BYTES,
  SHIPPED_PYC_FLAGS,
  RECOMPILE_DRIVER,
  readPycHeader,
  sourceOfPyc,
  pycModeVerdict,
  recompileTimestampBytecode,
} from "../scripts/lib/pyc-mode.mjs";

// --- helpers ---------------------------------------------------------------

/** Build a .pyc header with the given flags; magic defaults to the bundled 3.12 value. */
function headerBytes(flags: number, magicHex = "cb0d0d0a"): Buffer {
  const h = Buffer.alloc(PYC_HEADER_BYTES);
  Buffer.from(magicHex, "hex").copy(h, 0);
  h.writeUInt32LE(flags, 4);
  return h;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Locate a python on PATH; null when none exists (behavioural tests then skip). */
function findPython(): string | null {
  for (const exe of ["python", "python3", "py"]) {
    const r = spawnSync(exe, ["-c", "import sys;print(sys.version.split()[0])"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return exe;
  }
  return null;
}
const PYTHON = findPython();
const PY_SKIP = PYTHON ? false : "no python interpreter on PATH — behavioural driver test cannot run";

/** Generate a real .pyc for `src` in the given mode using the interpreter itself. */
function genPyc(src: string, mode: "TIMESTAMP" | "CHECKED_HASH"): void {
  const script =
    "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True," +
    "invalidation_mode=py_compile.PycInvalidationMode." + mode + ")";
  execFileSync(PYTHON!, ["-c", script, src], { encoding: "utf8", stdio: "pipe", windowsHide: true });
}

function findPyc(srcDir: string): string {
  const cache = join(srcDir, "__pycache__");
  const f = readdirSync(cache).find((n) => n.endsWith(".pyc"));
  assert.ok(f, `no .pyc generated under ${cache}`);
  return join(cache, f!);
}

// --- constants -------------------------------------------------------------

test("SHIPPED_PYC_FLAGS is checked-hash and the header is 16 bytes", () => {
  // bit0 hash-based, bit1 check-source. Measured on release7: flags 0x3 for all
  // 36,353 hash-mode files, 0x1 (unchecked) for none.
  assert.equal(SHIPPED_PYC_FLAGS, 0x3);
  assert.equal(SHIPPED_PYC_FLAGS & 1, 1, "must be hash-based");
  assert.equal(SHIPPED_PYC_FLAGS & 2, 2, "must be CHECKED, not unchecked-hash");
  assert.equal(PYC_HEADER_BYTES, 16, "4 magic + 4 flags + 8 mode-specific");
});

// --- readPycHeader: pure, hand-built headers -------------------------------

test("readPycHeader classifies all three invalidation modes", () => {
  const dir = tmp("pyc-mode-hdr-");
  try {
    const cases = [
      { flags: 0x0, isHash: false, isChecked: false, name: "timestamp" },
      { flags: 0x3, isHash: true, isChecked: true, name: "checked-hash" },
      { flags: 0x1, isHash: true, isChecked: false, name: "unchecked-hash" },
    ];
    for (const c of cases) {
      const p = join(dir, `${c.name}.cpython-312.pyc`);
      writeFileSync(p, Buffer.concat([headerBytes(c.flags), Buffer.alloc(24, 0)]));
      const h = readPycHeader(p);
      assert.ok(h, `${c.name}: header must parse`);
      assert.equal(h!.flags, c.flags, `${c.name}: flags`);
      assert.equal(h!.isHash, c.isHash, `${c.name}: isHash (bit0)`);
      assert.equal(h!.isChecked, c.isChecked, `${c.name}: isChecked (bit1)`);
      assert.equal(h!.magic, "cb0d0d0a", `${c.name}: magic read in BYTE order`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPycHeader returns null for a short or unreadable header", () => {
  const dir = tmp("pyc-mode-short-");
  try {
    const short = join(dir, "short.cpython-312.pyc");
    writeFileSync(short, Buffer.alloc(PYC_HEADER_BYTES - 1, 0));
    assert.equal(readPycHeader(short), null, "a 15-byte header cannot be judged");
    const missing = join(dir, "does-not-exist.pyc");
    assert.equal(readPycHeader(missing), null, "an absent file is unreadable, not fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPycHeader reads magic in byte order, matching importlib", () => {
  // importlib's MAGIC_NUMBER.hex() is byte order; readUInt32LE yields value order.
  // The header must expose the byte-order string so a caller comparing against
  // importlib does not get a false mismatch (the bug that aborted the four-arm
  // experiment's first run).
  const dir = tmp("pyc-mode-magic-");
  try {
    const p = join(dir, "m.cpython-312.pyc");
    writeFileSync(p, Buffer.concat([headerBytes(0x3, "aabbccdd"), Buffer.alloc(24, 0)]));
    assert.equal(readPycHeader(p)!.magic, "aabbccdd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- sourceOfPyc: pure -----------------------------------------------------

test("sourceOfPyc maps a PEP 3147 path back to its source", () => {
  assert.equal(
    sourceOfPyc("/p/pkg/__pycache__/mod.cpython-312.pyc"),
    "/p/pkg/mod.py",
  );
  assert.equal(
    sourceOfPyc("C:\\tree\\site-packages\\foo\\__pycache__\\bar.cpython-312.pyc"),
    "C:\\tree\\site-packages\\foo\\bar.py",
    "windows separators preserved",
  );
});

test("sourceOfPyc returns null outside a __pycache__ directory", () => {
  // The legacy pre-3.x layout puts mod.pyc beside mod.py; guessing a source there
  // would be wrong, so the caller must skip it.
  assert.equal(sourceOfPyc("/p/pkg/mod.cpython-312.pyc"), null);
});

// --- pycModeVerdict: pure, pinned to the measured release7 tree ------------

test("an all-checked-hash payload passes", () => {
  const v = pycModeVerdict({ pyc: 37324, timestamp: 0, unparseable: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, "");
});

test("the release7 tree (971 timestamp-mode) is rejected and named", () => {
  // This is the load-bearing assertion, the W28-C analogue of pyc-budget.test.ts's
  // release6 row: any future loosening that lets timestamp-mode bytecode through
  // turns this red by name.
  const v = pycModeVerdict({ pyc: 37324, timestamp: 971, unparseable: 0 });
  assert.equal(v.ok, false, "971 timestamp-mode .pyc must not pass");
  assert.match(v.reason, /971/, "the reason must carry the measured count");
  assert.match(v.reason, /TIMESTAMP/i, "the reason must name the mode");
  assert.match(v.reason, /37324/, "the reason must carry the total");
});

test("one timestamp-mode file is still a failure — the limit is exact zero", () => {
  // Coverage is a ratio because upstream churn moves it; mode is binary per file
  // and the conversion is deterministic, so a tolerance here would be a budget for
  // the exact regression this exists to stop.
  assert.equal(pycModeVerdict({ pyc: 37324, timestamp: 1, unparseable: 0 }).ok, false);
});

test("an unparseable header fails rather than passing blind", () => {
  // A mode nobody could read is not a mode that is fine (lesson L51).
  const v = pycModeVerdict({ pyc: 100, timestamp: 0, unparseable: 3 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /3 of 100/);
  assert.match(v.reason, /header/i);
});

test("zero .pyc is a broken measurement, not a pass", () => {
  // Same reasoning as pycBudgetVerdict's pyCount===0 branch: the walk saw nothing.
  const v = pycModeVerdict({ pyc: 0, timestamp: 0, unparseable: 0 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /0 \.pyc/);
});

// --- RECOMPILE_DRIVER: the text must have teeth ----------------------------

test("the driver compiles in CHECKED_HASH mode and fails loudly on error", () => {
  // Asserted on the exported constant the build actually pipes to python, not a
  // restatement. A driver that printed a count and exited 0 would let a partial
  // conversion pass as success.
  assert.match(RECOMPILE_DRIVER, /py_compile\.PycInvalidationMode\.CHECKED_HASH/);
  assert.match(RECOMPILE_DRIVER, /py_compile\.compile\(/);
  assert.match(RECOMPILE_DRIVER, /doraise=True/, "a compile error must raise, not be swallowed");
  assert.match(RECOMPILE_DRIVER, /sys\.exit\(1 if bad else 0\)/, "non-zero exit when any file failed");
  assert.match(RECOMPILE_DRIVER, /invalidation_mode=mode/, "the mode must reach compile()");
  // It must NOT force unchecked-hash: that would skip source verification and
  // serve stale bytecode after an in-place edit.
  assert.ok(!/UNCHECKED_HASH/.test(RECOMPILE_DRIVER), "must not write unchecked-hash");
});

// --- recompileTimestampBytecode: BEHAVIOURAL (real interpreter) ------------

test("the driver converts a timestamp-mode .pyc to checked-hash in place", { skip: PY_SKIP }, () => {
  // This is the proof the string runs (lesson L66): execute it, then read the
  // header of the file it produced. arm C of w28c-arm-c-overwrite.txt measured the
  // same over all 971; this pins the mechanism on one file, always.
  const dir = tmp("pyc-mode-conv-");
  try {
    const src = join(dir, "mod.py");
    writeFileSync(src, "VALUE = 42\n", "utf8");
    genPyc(src, "TIMESTAMP");
    const pyc = findPyc(dir);
    const before = readPycHeader(pyc);
    assert.ok(before && !before.isHash, "fixture must start timestamp-mode");

    const r = recompileTimestampBytecode(PYTHON!, [src], {});
    assert.equal(r.failed, 0, `driver reported failures: ${r.output}`);
    assert.equal(r.recompiled, 1);

    const after = readPycHeader(pyc);
    assert.ok(after, "the .pyc must still exist (overwritten in place, not deleted)");
    assert.equal(after!.isHash, true, "must now be hash-based");
    assert.equal(after!.flags, SHIPPED_PYC_FLAGS, "must be CHECKED-hash (0x3)");
    assert.equal(existsSync(src), true, "the source is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the driver leaves an already-checked-hash file valid", { skip: PY_SKIP }, () => {
  // Idempotence: A1c only feeds it timestamp-mode sources, but a re-run or a
  // mis-classification must not corrupt good bytecode.
  const dir = tmp("pyc-mode-idem-");
  try {
    const src = join(dir, "mod.py");
    writeFileSync(src, "VALUE = 1\n", "utf8");
    genPyc(src, "CHECKED_HASH");
    const pyc = findPyc(dir);
    assert.equal(readPycHeader(pyc)!.flags, SHIPPED_PYC_FLAGS);
    const r = recompileTimestampBytecode(PYTHON!, [src], {});
    assert.equal(r.failed, 0);
    assert.equal(readPycHeader(pyc)!.flags, SHIPPED_PYC_FLAGS, "still checked-hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the driver fails loudly on a source it cannot compile", { skip: PY_SKIP }, () => {
  // Negative arm (lesson L66): a driver that cannot fail proves nothing. A syntax
  // error must make recompileTimestampBytecode throw, so assemble's A1c fail()s
  // the build instead of shipping a half-converted payload.
  const dir = tmp("pyc-mode-bad-");
  try {
    const bad = join(dir, "bad.py");
    writeFileSync(bad, "def f(:\n    pass\n", "utf8");
    assert.throws(
      () => recompileTimestampBytecode(PYTHON!, [bad], {}),
      /conversion failed/i,
      "a source that cannot compile must throw, not report success",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty source list does not spawn an interpreter", () => {
  // A1c calls this unconditionally; when the payload is already clean it must be a
  // cheap no-op, not a python launch. Runs everywhere (no interpreter needed).
  let spawned = false;
  const r = recompileTimestampBytecode("definitely-not-a-real-python", [], {
    log: () => { spawned = true; },
  });
  assert.equal(r.recompiled, 0);
  assert.equal(r.failed, 0);
  assert.equal(spawned, false, "nothing to convert means nothing to run");
});

test("the driver routes its report through the log callback", { skip: PY_SKIP }, () => {
  // assemble passes `say` as the log; the recompiled=/failed= line must reach the
  // build output, or a conversion is invisible in the log (the W4 failure shape).
  const dir = tmp("pyc-mode-log-");
  try {
    const src = join(dir, "mod.py");
    writeFileSync(src, "X = 1\n", "utf8");
    genPyc(src, "TIMESTAMP");
    const lines: string[] = [];
    recompileTimestampBytecode(PYTHON!, [src], { log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /recompiled=1 failed=0/.test(l)), `log lines: ${JSON.stringify(lines)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sourceOfPyc agrees with the interpreter's own source_from_cache", { skip: PY_SKIP }, () => {
  // The split rule must match CPython, because source_from_cache is what the
  // interpreter uses at import time to find a .pyc's source. Asserted against the
  // running interpreter, not against my reading of the spec (lesson L66).
  const dir = tmp("pyc-mode-sfc-");
  try {
    const src = join(dir, "mod.py");
    writeFileSync(src, "Y = 2\n", "utf8");
    genPyc(src, "TIMESTAMP");
    const pyc = findPyc(dir);
    const py = execFileSync(
      PYTHON!,
      ["-c", "import importlib.util as u,sys;print(u.source_from_cache(sys.argv[1]))", pyc],
      { encoding: "utf8", stdio: "pipe", windowsHide: true },
    ).trim();
    const norm = (p: string) => p.replace(/\\/g, "/");
    assert.equal(norm(sourceOfPyc(pyc)), norm(py), "must map to the same source CPython uses");
    assert.equal(norm(sourceOfPyc(pyc)), norm(src));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- wiring: the guards must be reachable, and in the right ORDER ----------
//
// Everything above tests the library. None of it proves assemble-backend.mjs
// CALLS it, or calls it in an order that survives the import self-checks — a
// correct conversion nobody invokes is dead code (lesson L55), and one invoked
// before a step that re-introduces timestamp bytecode is dead work (lesson L67).
// These read the source rather than restating it, so reverting the wiring or
// reordering it turns them red (same pattern as pyc-budget.test.ts's wiring block).

const winDesktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assemble = readFileSync(join(winDesktopDir, "scripts", "assemble-backend.mjs"), "utf8");

test("assemble imports the mode guards from the library", () => {
  assert.match(
    assemble,
    /import \{[^}]*readPycHeader[^}]*recompileTimestampBytecode[^}]*pycModeVerdict[^}]*\} from "\.\/lib\/pyc-mode\.mjs";/,
    "A1c and A6-mode must share the tested library, not reimplement it",
  );
});

test("A1c runs AFTER the A1b runtime probe, not before it", () => {
  // The order is load-bearing (L67): A1 and A1b execute a payload python, and an
  // implicit import that has to compile a source writes TIMESTAMP-mode bytecode by
  // default. Converting before them would let a self-check silently undo the
  // conversion, and A6-mode would then fail on a payload A1c had already fixed.
  const probePos = assemble.indexOf("payload runtime probe OK:");
  const convPos = assemble.indexOf('say("converting timestamp-mode bytecode to checked-hash (A1c)")');
  assert.ok(probePos > 0, "the A1b probe anchor no longer matches assemble-backend.mjs — re-anchor");
  assert.ok(convPos > 0, "the A1c conversion anchor no longer matches — re-anchor");
  assert.ok(convPos > probePos, "A1c must run after A1b; converting before the self-checks is dead work");
});

test("A1c drives the conversion through the library, not an inlined driver", () => {
  // An inlined copy of the python driver in assemble would drift from the tested
  // RECOMPILE_DRIVER constant (the replica-is-not-the-driver failure, L66).
  assert.match(assemble, /recompileTimestampBytecode\(basePythonExe, staleSources,/,
    "A1c must call the library driver with the payload's own base interpreter");
  assert.ok(!/py_compile\.compile\(/.test(assemble),
    "assemble must not inline the driver — it belongs in the tested library constant");
  // It must use the PAYLOAD interpreter, so the bytecode is one the payload can
  // load; a dev-machine python would write a foreign magic.
  assert.match(assemble, /recompileTimestampBytecode\(basePythonExe,/,
    "conversion must use basePythonExe (the payload interpreter), not a dev python");
});

test("A1c fails the build on a partial conversion", () => {
  // A driver that converted 970 of 971 and exited 0 would ship one stale file.
  // The caller must treat any failure as fatal. CRLF-tolerant (\r?\n): the file
  // is CRLF and a bare \n anchor silently fails to match (lesson in MEMORY).
  const a1c = /say\("converting timestamp-mode bytecode[\s\S]*?\r?\n\}\r?\n/.exec(assemble)?.[0] ?? "";
  assert.ok(a1c, "the A1c block anchor no longer matches — re-anchor");
  assert.match(a1c, /if \(r\.failed > 0\) \{\s*\n\s*fail\(/, "a partial conversion must fail() the build");
  assert.match(a1c, /catch \(error\) \{\s*\n\s*fail\(/, "a driver that throws must fail() the build");
});

test("the A5/A6 walk reads each header and accumulates the mode counts", () => {
  // A6-mode is fed by the same walk that counts coverage — no second traversal.
  // If the walk stops reading headers, the gate would see 0 timestamp-mode forever
  // and pass blind (a check that cannot fail, L51).
  assert.match(assemble, /const hdr = readPycHeader\(p\);/, "the walk must read each .pyc header");
  assert.match(assemble, /if \(hdr === null\) pycUnparseableCount \+= 1;/, "unparseable headers must be counted");
  assert.match(assemble, /else if \(!hdr\.isHash\) pycTimestampCount \+= 1;/, "timestamp-mode files must be counted");
});

test("the A6-mode gate judges the walked counts and fails the build", () => {
  assert.match(assemble, /pycModeVerdict\(\{ pyc: pycCount, timestamp: pycTimestampCount, unparseable: pycUnparseableCount \}\)/,
    "A6-mode must judge the counts from the walk");
  assert.match(assemble, /if \(!modeVerdict\.ok\) \{\s*\n\s*fail\(/, "A6-mode must fail() the build when not ok");
  assert.match(assemble, /A6 bytecode mode:/, "A6-mode must print on every build (a trend quantity nobody sees eroding fails all at once)");
});

test("A6-mode runs after the walk that feeds it", () => {
  const walkPos = assemble.indexOf("else if (!hdr.isHash) pycTimestampCount += 1;");
  const gatePos = assemble.indexOf("const modeVerdict = pycModeVerdict(");
  assert.ok(walkPos > 0 && gatePos > 0, "a mode-gate anchor no longer matches — re-anchor");
  assert.ok(gatePos > walkPos, "the gate must judge counts the walk has finished accumulating");
});
