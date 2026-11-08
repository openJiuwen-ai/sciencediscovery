// pyc-mode: prove the payload's bytecode is one the INSTALLED machine can reuse.
//
// Field history (problems W28-C, release7, 2026-11-07): the installer shipped
// 37,324 .pyc of which 971 were in timestamp invalidation mode. Every existing
// gate was green, and none of them was wrong:
//
//   A1/A1b import self-check : the modules import fine, the bytecode is valid
//   A5 path budget           : measures path length, unrelated
//   A6 bytecode budget       : counts .pyc against .py — 971 files that ship in
//                              the WRONG MODE still count as shipped
//
// A6 counted them because coverage and mode are different properties. The
// installed tree pays for the difference: NSIS extraction restamps every .py to
// the install instant (measured: all sources at 2026-11-07T07:40:02Z), so a
// timestamp-mode .pyc is stale the moment it lands and CPython recompiles it.
// The first launch rewrote 1,048 .pyc files. checked-hash bytecode is immune —
// its validity keys on the source CONTENT hash, not its mtime — which is exactly
// why step 7c asks compileall for `--invalidation-mode checked-hash`.
//
// Why 7c did not already fix this (measured, four arms,
// logs/w28-evidence/w28c-compileall-mode-experiment.mjs): compileall only
// REWRITES a .pyc it judges invalid. All 971 were judged VALID in the build tree,
// because the copy chain preserved each .py's original mtime (measured:
// pydantic/main.py mtime 2026-10-14T10:02:41Z == its .pyc's hdr_mtime), so
// skipping them was correct behaviour and not a coverage hole. Arm A: valid
// timestamp-mode pyc + checked-hash compileall -> still timestamp-mode.
//
// So the fix has to convert them, and the shape of the conversion was also
// measured rather than assumed. Two candidate shapes:
//
//   delete the timestamp-mode .pyc, then let compileall recreate them
//     Works (logs/w28-evidence/w28c-fix-prototype.mjs: 111 -> 0, control arm
//     111 -> 111 proving compileall alone cannot). But deletion on this machine
//     costs ~500 ms per file — measured in the workspace, in its parent, and on a
//     different volume, with Defender real-time protection OFF and a healthy
//     local NTFS SSD; only %TEMP% was fast (0.92 ms/file). Creation is cheap
//     (0.4 ms/file). For 971 files that is ~8 minutes, and that figure is an
//     artifact of a filesystem stack, not of the payload.
//
//   recompile the offending sources in place, overwriting the stale .pyc   <- shipped
//     Same end state, no unlink, so it does not pay the deletion tax: 8.4 s for
//     all 971 with the bundled interpreter (logs/w28-evidence/w28c-arm-c-overwrite.txt,
//     arm C; arm A of the same run is the control, 971 -> 971).
//
// The third shape considered and rejected by measurement is global `compileall -f`
// (force): it reaches the same end state by recompiling ALL 37,998 sources, so it
// pays for 37,027 that were already fine. logs/w28-evidence/w28c-force-all-cost.txt.
//
// Two guards live here, mirroring pyc-budget.mjs — cause and symptom need
// separate nets:
//
//   RECOMPILE_DRIVER + recompileTimestampBytecode() remove the CAUSE: bytecode
//     that shipped in a mode the installed tree cannot reuse.
//
//   pycModeVerdict() catches the SYMPTOM: any timestamp-mode .pyc still in the
//     payload when the build finishes, however it got there — a driver that
//     silently skipped a target, an interpreter that declined to compile
//     something, or a future copy step that pulls bytecode in from a dev tree
//     after the conversion ran.
//
// Both halves are pure/testable so win_desktop/test/pyc-mode.test.ts can pin them
// without a payload tree, and the driver is a string constant rather than a
// separate file so the test can assert what the build will actually execute
// (a hand-copied replica proves the replica, not the driver — lesson L66).

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

/**
 * Header byte length of a PEP 552 .pyc: 4 magic + 4 flags + 8 mode-specific.
 * Anything shorter cannot be judged, and "cannot judge" must not read as "fine".
 */
export const PYC_HEADER_BYTES = 16;

/**
 * The only flags value the payload may ship, measured on release7:
 * `flags distribution : 0x3=36353, 0x0=971` (logs/w28-evidence/w28c-header-shape.txt).
 *
 * bit0 = 1 : hash-based rather than timestamp-based (PEP 552)
 * bit1 = 1 : CHECKED, i.e. the interpreter verifies the source hash at import
 *            time instead of trusting the file blindly.
 *
 * 0x3 is therefore "checked hash" — what `compileall --invalidation-mode
 * checked-hash` writes. bit1 must stay set: `unchecked-hash` (0x1) skips
 * verification entirely and would serve stale bytecode after an in-place source
 * edit, which is a correctness regression traded for a startup win this project
 * does not need. Measured unchecked-hash count on release7: 0, so gating on the
 * exact value rejects nothing that exists and forbids a shape nobody ships.
 */
export const SHIPPED_PYC_FLAGS = 0x3;

/**
 * Read a .pyc header. Returns null when the file is too short or unreadable —
 * the caller decides whether that is fatal (it is: an unparseable header is a
 * file CPython will also refuse, and silently passing it would be a check that
 * cannot fail, lesson L51).
 *
 * The mode lives in `flags`, and the two modes are judged by DIFFERENT rules —
 * timestamp compares (hdr_mtime, hdr_size) against the source's stat, hash
 * compares source_hash(src) against hdr_hash. Applying one rule to both is the
 * mistake that produced a false "stale" verdict here before (lesson L67).
 * Nothing in this module judges VALIDITY, only MODE: validity needs the
 * interpreter's own source_hash, which is not sha256[:8] and cannot be
 * reimplemented faithfully in JS. Only the bundled python may adjudicate it.
 *
 * @param {string} pycPath
 * @returns {{magic: string, flags: number, isHash: boolean, isChecked: boolean}|null}
 */
export function readPycHeader(pycPath) {
  let fd;
  try {
    fd = openSync(pycPath, "r");
    const buf = Buffer.alloc(PYC_HEADER_BYTES);
    const n = readSync(fd, buf, 0, PYC_HEADER_BYTES, 0);
    if (n < PYC_HEADER_BYTES) return null;
    const flags = buf.readUInt32LE(4);
    return {
      // Byte order on purpose. importlib's MAGIC_NUMBER.hex() is also byte order
      // ("cb0d0d0a"); readUInt32LE of the same bytes yields the VALUE order
      // (0x0a0d0dcb). Comparing one against the other is a false mismatch — it
      // is what aborted the first run of the four-arm experiment.
      magic: buf.subarray(0, 4).toString("hex"),
      flags,
      isHash: (flags & 1) === 1,
      isChecked: (flags & 2) === 2,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Judge the payload's bytecode MODE. Pure: the caller walks the tree, same
 * division of labour as pycBudgetVerdict().
 *
 * The limit is an exact zero, not a ratio. Coverage is a ratio because upstream
 * churn moves it constantly and a hard floor goes stale in the unsafe direction;
 * mode is binary per file and the conversion is deterministic, so any non-zero
 * count means the conversion did not run over something it should have. A
 * tolerance here would be a budget for the exact regression this exists to stop.
 *
 * @param {{pyc: number, timestamp: number, unparseable: number}} counts
 * @param {{expectedFlags?: number}} [options]
 * @returns {{ok: boolean, reason: string}} `reason` is empty when ok, and is the
 *   text the build prints when not.
 */
export function pycModeVerdict(counts, { expectedFlags = SHIPPED_PYC_FLAGS } = {}) {
  const { pyc = 0, timestamp = 0, unparseable = 0 } = counts ?? {};
  // 0 .pyc means the walk measured nothing — same reasoning as pycBudgetVerdict's
  // pyCount === 0 branch: true but useless, and passing it would be a gate that
  // cannot fail.
  if (pyc === 0) {
    return {
      ok: false,
      reason:
        "the tree walk counted 0 .pyc files, so the bytecode mode was never measured " +
        "(wrong --out, or the payload was never staged) — refusing to pass a mode nobody checked",
    };
  }
  if (unparseable > 0) {
    return {
      ok: false,
      reason:
        `${unparseable} of ${pyc} .pyc files have a header shorter than ${PYC_HEADER_BYTES} bytes or could not be read — ` +
        "their invalidation mode is unknown, and CPython will refuse them too",
    };
  }
  if (timestamp > 0) {
    return {
      ok: false,
      reason:
        `${timestamp} of ${pyc} .pyc files ship in TIMESTAMP invalidation mode instead of checked-hash ` +
        `(flags 0x${expectedFlags.toString(16)}). The installer restamps every .py to the install instant, ` +
        "so timestamp-mode bytecode is stale on arrival and CPython recompiles it on first launch " +
        "(measured: 1,048 .pyc rewritten, problems W28-C)",
    };
  }
  return { ok: true, reason: "" };
}

/**
 * The python program the build runs to convert timestamp-mode bytecode.
 *
 * Exported as a string rather than kept inline in assemble-backend.mjs, and
 * rather than written as a .py file in the repo, for one reason: the test must be
 * able to assert on the text the build will ACTUALLY execute. A replica retyped
 * into a test proves the replica (lesson L66 — a hand-copied gate is not the
 * gate), and a separate .py file can drift from the caller that invokes it.
 *
 * Reads the source paths from stdin, one per line, so 971 paths cannot hit a
 * command-line length limit and no temporary file has to be created inside the
 * payload tree (anything under --out gets packed into the installer).
 *
 * stdin is decoded as UTF-8 explicitly: Node writes the `input` string as UTF-8,
 * while python's sys.stdin follows the console code page, which on a Chinese
 * Windows is not UTF-8 — a payload path with a non-ASCII segment would otherwise
 * arrive mangled and fail to compile.
 *
 * py_compile.compile() is called WITHOUT cfile, so it derives the PEP 3147 path
 * (__pycache__/<stem>.<tag>.pyc) and OVERWRITES the existing timestamp-mode file.
 * That is the whole point of this shape: overwriting costs 0.4 ms/file where
 * deleting costs ~500 ms/file on a taxed volume (see the file header).
 *
 * Exit code is non-zero when ANY file failed, and the failures are named. A
 * driver that printed a count and exited 0 would let the caller treat a partial
 * conversion as success — and the caller's gate would then be the only thing
 * standing between it and a shipped installer, which is a worse place to find out
 * than the step that did the work.
 */
export const RECOMPILE_DRIVER = `
import io, py_compile, sys

stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
mode = py_compile.PycInvalidationMode.CHECKED_HASH
ok = 0
bad = 0
errs = []
for line in stdin:
    src = line.strip()
    if not src:
        continue
    try:
        py_compile.compile(src, doraise=True, invalidation_mode=mode)
        ok += 1
    except Exception as exc:
        bad += 1
        if len(errs) < 5:
            errs.append("%s: %s" % (src, exc))
print("recompiled=%d failed=%d" % (ok, bad))
for err in errs:
    print("  FAIL " + err)
sys.exit(1 if bad else 0)
`;

/**
 * Map a PEP 3147 .pyc back to the source that produced it.
 *
 * __pycache__/<stem>.<tag>.pyc -> <parent of __pycache__>/<stem>.py
 *
 * The stem/tag split is at the FIRST dot, which matches CPython's own
 * `importlib.util.source_from_cache` exactly — that is the requirement, because
 * it is the same function the interpreter uses at import time to find the source
 * a .pyc belongs to. A source literally named `foo.bar.py` is not correctly
 * reversible by either (both yield `foo.py`); that is a known CPython limitation,
 * not something to "fix" here — diverging from the interpreter would map a .pyc
 * to a source path CPython does not use. test/pyc-mode.test.ts cross-checks this
 * against the running interpreter rather than against my reading of the spec.
 *
 * Returns null for a .pyc that is not in a __pycache__ directory (the legacy,
 * pre-3.x layout) — the caller skips those rather than guessing.
 *
 * @param {string} pycPath
 * @returns {string|null}
 */
export function sourceOfPyc(pycPath) {
  const sep = pycPath.includes("\\") ? "\\" : "/";
  const parts = pycPath.split(/[\\/]/);
  const file = parts.pop();
  const cacheDir = parts.pop();
  if (cacheDir !== "__pycache__") return null;
  const base = file.endsWith(".pyc") ? file.slice(0, -".pyc".length) : file;
  const dot = base.indexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  return [...parts, `${stem}.py`].join(sep);
}

/**
 * Convert timestamp-mode bytecode to checked-hash, in place.
 *
 * Deliberately NOT `compileall -f` over the whole tree: that recompiles all
 * 37,998 sources to fix 971 (measured cost in the file header). And deliberately
 * NOT "delete then compileall": deletion is the expensive operation here.
 *
 * Throws when the interpreter exits non-zero, so the caller decides between
 * failing the build and warning — the same split step 7c already makes between
 * the jiuwenswarm targets (fatal) and the service venvs (soft), because a silent
 * skip is how release6 shipped (problems W4).
 *
 * @param {string} pythonExe an interpreter from the payload itself, so the
 *   bytecode it writes is one the payload can load. Never a dev-machine python.
 * @param {string[]} sources absolute paths of the .py files to recompile
 * @param {{env?: Record<string, string|undefined>, log?: (line: string) => void}} [options]
 *   `env` should come from payloadCompileEnv() — an inherited PYTHONPYCACHEPREFIX
 *   would redirect every file this writes outside the payload and still exit 0,
 *   which is precisely the W25 failure.
 * @returns {{recompiled: number, failed: number, output: string}}
 */
export function recompileTimestampBytecode(pythonExe, sources, { env, log = () => {} } = {}) {
  if (!sources.length) return { recompiled: 0, failed: 0, output: "" };
  let output = "";
  try {
    output = execFileSync(pythonExe, ["-c", RECOMPILE_DRIVER], {
      input: `${sources.join("\n")}\n`,
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Surface what the driver printed: it names the first failures, which is the
    // only clue about WHY an interpreter declined a file.
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    const err = new Error(`bytecode mode conversion failed (rc=${error.status ?? "?"}): ${detail || error.message}`);
    err.output = detail;
    throw err;
  }
  for (const line of output.split("\n")) if (line.trim()) log(line.trim());
  const m = /recompiled=(\d+) failed=(\d+)/.exec(output);
  return {
    recompiled: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    output: output.trim(),
  };
}
