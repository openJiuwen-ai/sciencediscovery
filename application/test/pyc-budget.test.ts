// Pins the two guards against problems W25: the payload build must not inherit a
// bytecode redirect from its environment, and the assembled tree must be proven
// to actually carry its bytecode.
//
// The numbers asserted below are the release6 incident, measured twice — once on
// the broken installer and once on the rebuild that replaced it:
//
//   broken : 1,384 .pyc / 37,998 .py  (446.5 MiB exe, first run recompiled all)
//   good   : 37,324 .pyc / 37,998 .py (586.2 MiB exe, first-run compileall no-op)
//
// Both trees had the SAME .py count, which is why the gate is a ratio and why
// these two rows are the load-bearing assertions in this file: any future
// loosening of PYC_MIN_RATIO that lets the broken tree through turns
// "the release6 broken payload is rejected" red by name.
//
// Field lesson: the build that produced the broken installer was GREEN on all
// four of its gates (A1 import self-check, A1b runtime probe, A2 required-files,
// A5 path budget). compileall exited 0 — it wrote the right content to the wrong
// place — so nothing downstream could see the loss. This test is the always-run
// half of the fix; the build-time half is A6 in scripts/assemble-backend.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BYTECODE_ENV_BLOCKLIST,
  BYTECODE_ENV_CONSIDERED_AND_REJECTED,
  PYC_MIN_RATIO,
  UNPACKED_MIN_COUNT_SHARE,
  payloadCompileEnv,
  pycBudgetVerdict,
  regionsBelowRatio,
  unpackedBytecodeVerdict,
} from "../scripts/lib/pyc-budget.mjs";

// --- payloadCompileEnv: the cause -----------------------------------------

test("PYTHONPYCACHEPREFIX is dropped, and the drop is reported", () => {
  const warnings = [];
  const env = payloadCompileEnv(
    { PYTHONPYCACHEPREFIX: "/e/tmp-build/pycache", PATH: "/usr/bin" },
    { warn: (line) => warnings.push(line) },
  );
  // The exact value from logs/pr834-build.sh:20 at the time of the incident.
  assert.equal(env.PYTHONPYCACHEPREFIX, undefined);
  assert.equal("PYTHONPYCACHEPREFIX" in env, false);
  assert.equal(warnings.length, 1, "an inherited redirect must be announced, not silently undone");
  assert.match(warnings[0], /PYTHONPYCACHEPREFIX=\/e\/tmp-build\/pycache/);
  assert.match(warnings[0], /W25/);
});

test("the rest of the build environment survives the filter", () => {
  const env = payloadCompileEnv({
    PATH: "/usr/bin",
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
    PYTHONPYCACHEPREFIX: "/x/pycache",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(env.TEMP, "C:\\Users\\me\\AppData\\Local\\Temp");
  // PYTHONWARNINGS is what assemble sets today and is unrelated to redirection.
  assert.equal(env.PYTHONWARNINGS, "ignore");
});

test("a clean environment is returned unchanged and warns nothing", () => {
  const warnings = [];
  const env = payloadCompileEnv({ PATH: "/usr/bin" }, { warn: (l) => warnings.push(l) });
  assert.deepEqual(env, { PATH: "/usr/bin", PYTHONWARNINGS: "ignore" });
  assert.equal(warnings.length, 0);
});

test("every blocklisted variable is dropped, and the input is not mutated", () => {
  const base = { PYTHONPYCACHEPREFIX: "/x", PATH: "/usr/bin" };
  const env = payloadCompileEnv(base);
  for (const name of BYTECODE_ENV_BLOCKLIST) {
    assert.equal(name in env, false, `${name} survived the filter`);
  }
  // The input object must not be mutated in place: callers pass process.env-
  // derived objects around, and a delete on the original would leak the change
  // into every later child process.
  assert.equal(base.PYTHONPYCACHEPREFIX, "/x");
});

test("PYTHONDONTWRITEBYTECODE is NOT blocklisted, because measurement says it is inert", () => {
  // The obvious reasoning is "that variable suppresses bytecode, so filter it
  // too". It is wrong: compileall is an explicit compile request and still
  // writes its .pyc with the variable set (measured in
  // logs/w25-evidence/probe-env-semantics.sh: pyc_in_tree=1 both with and
  // without it). Blocking it would add a guard whose comment claims a
  // protection it does not provide — the failure mode lesson L51 names.
  //
  // This test pins the EXCLUSION so a well-meaning future edit that adds the
  // name to the blocklist goes red here, with the probe named as the reason to
  // go re-measure rather than re-reason.
  assert.ok(
    !BYTECODE_ENV_BLOCKLIST.includes("PYTHONDONTWRITEBYTECODE"),
    "re-measure with probe-env-semantics.sh before blocklisting this; it was inert in the recorded run",
  );
  assert.ok("PYTHONDONTWRITEBYTECODE" in BYTECODE_ENV_CONSIDERED_AND_REJECTED,
    "the rejected candidate must stay documented, not just absent");
  // It still passes through to children untouched (it is harmless here).
  const env = payloadCompileEnv({ PYTHONDONTWRITEBYTECODE: "1" });
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
});

// --- pycBudgetVerdict: the symptom ----------------------------------------

test("the release6 broken payload is rejected", () => {
  // 1,384 / 37,998 = 3.6%: the bytecode went to /e/tmp-build/pycache instead.
  const got = pycBudgetVerdict(37998, 1384);
  assert.equal(got.ok, false);
  assert.ok(got.ratio < 0.04, `ratio ${got.ratio} should be ~0.036`);
  assert.match(got.reason, /3\.6%/);
  assert.match(got.reason, /1384/);
  assert.match(got.reason, /37998/);
});

test("the release6 rebuild is accepted", () => {
  // 37,324 / 37,998 = 98.2%, the five-item verification of the good build.
  const got = pycBudgetVerdict(37998, 37324);
  assert.equal(got.ok, true);
  assert.equal(got.reason, "");
  assert.ok(got.ratio > 0.98, `ratio ${got.ratio} should be ~0.982`);
});

test("the threshold sits far above the failure it exists to catch", () => {
  const broken = 1384 / 37998;
  const good = 37324 / 37998;
  assert.ok(PYC_MIN_RATIO > broken * 10, `limit ${PYC_MIN_RATIO} is not 10x the broken ratio ${broken}`);
  assert.ok(PYC_MIN_RATIO < good, `limit ${PYC_MIN_RATIO} would reject the known-good tree (${good})`);
  // The good tree keeps headroom for upstream churn (tests added/removed).
  assert.ok(good - PYC_MIN_RATIO > 0.05, "less than 5 points of headroom on the good tree is too tight");
});

test("a payload that lost half its bytecode is still rejected", () => {
  // Not the incident, but the shape a future regression could take: a partial
  // loss hides far better than a total one. Half coverage must not pass.
  assert.equal(pycBudgetVerdict(37998, 18999).ok, false);
  // Just under the limit fails; just over passes — the boundary is real, not a
  // comparison that can never be false (lesson L51).
  const atLimit = Math.ceil(1000 * PYC_MIN_RATIO);
  assert.equal(pycBudgetVerdict(1000, atLimit).ok, true);
  assert.equal(pycBudgetVerdict(1000, atLimit - 1).ok, false);
});

test("zero .py files is a broken measurement, not a pass", () => {
  // 0/0 as a ratio would be NaN, and treating it as "nothing to compile, all
  // good" is the check that cannot fail. This is what a wrong --out looks like.
  const got = pycBudgetVerdict(0, 0);
  assert.equal(got.ok, false);
  assert.match(got.reason, /0 \.py files/);
  assert.equal(Number.isNaN(got.ratio), false);
});

test("a tree with .py but no .pyc at all is rejected with the counts named", () => {
  const got = pycBudgetVerdict(1200, 0);
  assert.equal(got.ok, false);
  assert.equal(got.ratio, 0);
  assert.match(got.reason, /0\.0%/);
});

// --- regionsBelowRatio: the diagnostic ------------------------------------

test("regions below the limit are reported worst-first", () => {
  const got = regionsBelowRatio({
    python: { py: 1000, pyc: 990 }, // 99.0% — fine
    "envs-template": { py: 2000, pyc: 100 }, // 5.0% — worst
    backend: { py: 3000, pyc: 1500 }, // 50.0% — also below
  });
  assert.deepEqual(
    got.map((r) => r.name),
    ["envs-template", "backend"],
  );
  assert.ok(got[0].ratio < got[1].ratio);
  assert.equal(got[0].pyc, 100);
});

test("a fully covered tree reports no regions, and empty regions are ignored", () => {
  assert.deepEqual(regionsBelowRatio({ python: { py: 10, pyc: 10 } }), []);
  // A region with no .py at all cannot be judged; reporting it as 0% coverage
  // would be a false alarm on an empty directory.
  assert.deepEqual(regionsBelowRatio({ empty: { py: 0, pyc: 0 } }), []);
});

test("a small subtree can lose all its bytecode without tripping the total", () => {
  // The advisory exists because the gate is whole-tree, and a whole-tree ratio
  // has a blind spot proportional to the region's size. With one small target
  // losing EVERY .pyc (2,000 of 32,000 files), the total still clears 90%:
  //   (0 + 29,700) / (2,000 + 30,000) = 92.8%  -> gate passes
  // but that subtree ships uncompiled and recompiles on first run. The region
  // line is what makes the loss visible.
  //
  // The blind spot is size-bounded, not open-ended: the same total loss on a
  // LARGER target does trip the gate, which the next assertion pins. Losing all
  // 5,000 of the stdlib's files gives 29,700/35,000 = 84.9% -> gate fails.
  const small = {
    python: { py: 2000, pyc: 0 },
    "envs-template": { py: 30000, pyc: 29700 },
  };
  assert.equal(pycBudgetVerdict(32000, 29700).ok, true, "the whole-tree gate passes here");
  assert.deepEqual(
    regionsBelowRatio(small).map((r) => r.name),
    ["python"],
    "…so the region line must name the subtree that lost its bytecode",
  );

  const large = {
    python: { py: 5000, pyc: 0 },
    "envs-template": { py: 30000, pyc: 29700 },
  };
  assert.equal(pycBudgetVerdict(35000, 29700).ok, false, "a big target losing everything must fail the gate");
  assert.deepEqual(
    regionsBelowRatio(large).map((r) => r.name),
    ["python"],
  );
});

// --- wiring: the gate must actually be reachable ---------------------------
//
// Everything above tests the library. None of it proves assemble-backend.mjs
// CALLS the library — a correct guard that nobody invokes is dead code, and
// "the code exists" is not "the code runs" (lesson L55). These assertions are
// read out of the source rather than restated, so reverting the wiring turns
// them red (same pattern as test/installer-nsh.test.ts, whose header explains
// why a coupling guard must read the literal instead of repeating it).

const winDesktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assemble = readFileSync(join(winDesktopDir, "scripts", "assemble-backend.mjs"), "utf8");

test("assemble builds the compile environment through payloadCompileEnv", () => {
  assert.match(
    assemble,
    /const compileEnv = payloadCompileEnv\(process\.env, \{ warn: say \}\);/,
    "compileEnv must come from payloadCompileEnv so an inherited PYTHONPYCACHEPREFIX is stripped",
  );
  // The regression this replaces, pinned as absent: an unfiltered spread is
  // what let the redirect through in release6.
  assert.ok(
    !/const compileEnv = \{ \.\.\.process\.env/.test(assemble),
    "compileEnv regressed to an unfiltered {...process.env} spread — that is the W25 defect",
  );
});

test("the compile environment reaches compileall", () => {
  // Stripping the variable is pointless if the child process is spawned with a
  // different environment. compileall is the call that writes the bytecode.
  const m = /execFileSync\(pythonExe, \["-m", "compileall"[\s\S]{0,300}?\{ env: compileEnv,/.exec(assemble);
  assert.ok(m, "compileall is no longer spawned with the filtered compileEnv");
});

test("the A6 gate judges the walked counts and fails the build", () => {
  assert.match(assemble, /pycBudgetVerdict\(pyCount, pycCount\)/, "A6 must judge the counts from the payload walk");
  assert.match(assemble, /if \(!verdict\.ok\) \{\s*\n\s*fail\(/, "A6 must fail() the build when the verdict is not ok");
  assert.match(assemble, /A6 bytecode budget:/, "A6 must print on every build (a trend quantity nobody sees eroding fails all at once)");
  // The counts must actually be accumulated by the walk, not left at zero — a
  // gate fed 0/0 would take the "broken measurement" branch forever and could
  // be mistaken for working.
  assert.match(assemble, /if \(e\.name\.endsWith\("\.py"\)\) \{\s*\n\s*pyCount \+= 1;/, "the walk must count .py files");
  assert.match(assemble, /pycCount \+= 1;/, "the walk must count .pyc files");
});

test("the A6 threshold is imported from the library, not restated", () => {
  // Restating 0.9 here would let the build drift from the tested constant — the
  // exact failure installer-nsh.test.ts exists to prevent across two files.
  assert.match(assemble, /import \{[^}]*PYC_MIN_RATIO[^}]*\} from "\.\/lib\/pyc-budget\.mjs";/,
    "A6 must import PYC_MIN_RATIO so the build and this test share one constant");
  assert.match(assemble, /limit \$\{pct\(PYC_MIN_RATIO\)\}/, "the printed limit must be the imported constant");
  assert.ok(!/PYC_MIN_RATIO = 0\.\d/.test(assemble), "A6 must not define its own copy of the limit");
});

// --- unpackedBytecodeVerdict: the first-launch half (#897 §2) ---------------
//
// The build-side half above catches a payload that never shipped its bytecode.
// This half catches the same payload AFTER it reached a machine: release6's
// 1,384-of-37,998 tree had "a .pyc" everywhere bootstrap looked, so
// treeHasPycache() said the copy was fine, the remedial compile was skipped,
// and the loss surfaced as an ImportError the first time a tool imported a
// missing module. The numbers below are the measured release6 pair plus the
// measured envs-template region, so the limit is calibrated against real trees.

test("the release6 broken copy is rejected and the rebuilt copy is accepted", () => {
  // Measured on the two release6 trees (find -type f): the broken installer
  // shipped 1,384 .pyc against 37,998 .py; the rebuild shipped 37,324.
  const broken = unpackedBytecodeVerdict({ py: 37998, pyc: 1384 }, { py: 37998, pyc: 37324 });
  assert.equal(broken.ok, false, "the W25 incident tree must not pass at bootstrap either");
  assert.match(broken.reason, /3\.6%/, "the reason must carry the measured coverage");
  assert.equal(broken.expectedPyc, 37324, "the build's own count is surfaced so the log can name the gap");

  const good = unpackedBytecodeVerdict({ py: 37998, pyc: 37324 }, { py: 37998, pyc: 37324 });
  assert.equal(good.ok, true, "the rebuilt tree must pass");
});

test("a healthy copied env region passes at its measured coverage", () => {
  // Measured on release6 resources/envs-template: 6,119 .pyc for 6,124 .py.
  const v = unpackedBytecodeVerdict({ py: 6124, pyc: 6119 }, { py: 6124, pyc: 6119 });
  assert.equal(v.ok, true);
  assert.ok(v.ratio > 0.99, `expected ~99.9%, got ${(v.ratio * 100).toFixed(1)}%`);
});

test("NSIS dropping a few MAX_PATH .pyc does not false-positive", () => {
  // problems W15 measured extraction silently losing .pyc whose __pycache__ path
  // breaches MAX_PATH (one directory shipped 6 where the payload had 7). A
  // NORMAL install therefore arrives a handful of files short of the build
  // count — if that tripped the warning every install would cry wolf, and the
  // warning would be ignored exactly when it mattered (lesson L51).
  const v = unpackedBytecodeVerdict({ py: 6124, pyc: 6113 }, { py: 6124, pyc: 6119 });
  assert.equal(v.ok, true, `99.8% coverage is a normal install, got ${(v.ratio * 100).toFixed(1)}%`);
  assert.equal(v.expectedPyc, 6119);
});

test("a missing manifest still judges coverage instead of passing blind", () => {
  // version.json predating the `bytecode` field (or absent) yields null. The
  // verdict must NOT degrade to "ok" — that would be a check that cannot fail.
  // It falls back to the absolute limit, which still rejects the incident tree.
  const brokenNoManifest = unpackedBytecodeVerdict({ py: 37998, pyc: 1384 }, null);
  assert.equal(brokenNoManifest.ok, false);
  assert.equal(brokenNoManifest.expectedPyc, null);
  const goodNoManifest = unpackedBytecodeVerdict({ py: 6124, pyc: 6119 }, null);
  assert.equal(goodNoManifest.ok, true);
});

test("a manifest can make the verdict stricter but never rescues a bad ratio", () => {
  // A manifest is build output, not ground truth. The asymmetry is load-bearing:
  // a stale-high manifest must NOT be able to wave a broken copy through, while
  // the recorded count IS allowed to condemn a copy the ratio would have passed
  // (that is the whole point of the count limit — see the next test).
  const bogusHigh = unpackedBytecodeVerdict({ py: 6124, pyc: 200 }, { py: 6124, pyc: 999999 });
  assert.equal(bogusHigh.ok, false, "a manifest promising more cannot rescue a near-empty copy");
  assert.match(bogusHigh.reason, /3\.3%/, "the ratio failure must be reported, not the count one");
  const bogusLow = unpackedBytecodeVerdict({ py: 6124, pyc: 6119 }, { py: 6124, pyc: 0 });
  assert.equal(bogusLow.ok, true, "a manifest promising nothing cannot condemn a complete copy");
});

test("a copy that lost whole directories is caught by the recorded count", () => {
  // The blind spot this exists for (#897 §2 names it "partial copy"): a
  // directory that never landed takes its .py and its .pyc together, so the
  // coverage ratio — the only limit before this one — barely moves. Measured
  // release6 region shape, 1,000 files short:
  //   ratio 5,119/5,124 = 99.9%  -> would PASS the coverage gate
  //   share 5,119/6,119 = 83.7%  -> must be caught here
  const partial = unpackedBytecodeVerdict({ py: 5124, pyc: 5119 }, { py: 6124, pyc: 6119 });
  assert.equal(partial.ok, false, "a thousand missing files must not pass as a healthy copy");
  assert.ok(partial.ratio > PYC_MIN_RATIO, "…even though its coverage ratio clears the limit");
  assert.match(partial.reason, /5119 of the 6119/, "the reason must name both counts");
  assert.match(partial.reason, /whole directories are missing/);

  // The same loss with NO manifest cannot be caught — there is nothing to
  // compare against — so the ratio limit stays the only net. Pinned so the
  // degradation is a known limitation, not a silent one.
  assert.equal(unpackedBytecodeVerdict({ py: 5124, pyc: 5119 }, null).ok, true);
});
test("a copy that lost its sources but kept its caches is caught", () => {
  // The second blind spot of a ratio, and the one that points the WRONG way.
  // Coverage is pyc/py, so deleting .py while leaving __pycache__ behind makes
  // the number look HEALTHIER — an antivirus rule that quarantines scripts and
  // spares the caches produces exactly this. Those .pyc are unusable (PEP 3147
  // resolves them against a source that is gone), so the import still fails,
  // now behind a verdict that reads better than the payload that shipped.
  //
  // Measured at the head before the .py limit existed
  // (logs/w25-evidence/probe-f4-source-share.mjs): every case below returned
  // ok:true, including {py:10,pyc:20} vs {py:20,pyc:20} at ratio 200%.
  const halfSources = unpackedBytecodeVerdict({ py: 3062, pyc: 6119 }, { py: 6124, pyc: 6119 });
  assert.equal(halfSources.ok, false, "half the sources gone cannot pass as a healthy copy");
  assert.ok(halfSources.ratio > 1, `the ratio reads ${halfSources.ratio} — better than the build shipped`);
  assert.match(halfSources.reason, /3062 of the 6124 \.py/, "the reason must name both source counts");
  assert.match(halfSources.reason, /cannot be imported without the \.py/);

  // A quarantine that takes a package's scripts, past the tolerance. Measured
  // boundary on the real region: 6,124 x 0.95 = 5,817.8, so losing 306 sources
  // (5,818 left) is still inside the limit and losing 307 (5,817 left) is not.
  const quarantine = unpackedBytecodeVerdict({ py: 5817, pyc: 6119 }, { py: 6124, pyc: 6119 });
  assert.equal(quarantine.ok, false, "a quarantine past the tolerance must be named, not read as 105% coverage");
  assert.match(quarantine.reason, /5817 of the 6124 \.py/);

  // Inside the tolerance it stays silent, on purpose: this is the same slack
  // that keeps the .pyc side from crying wolf (problems W15). A limit that
  // warned on every install would be ignored exactly when it mattered (L51).
  const withinTolerance = unpackedBytecodeVerdict({ py: 5824, pyc: 6119 }, { py: 6124, pyc: 6119 });
  assert.equal(withinTolerance.ok, true, "300 of 6,124 sources is 95.1%, inside the limit");
  assert.equal(unpackedBytecodeVerdict({ py: 5818, pyc: 6119 }, { py: 6124, pyc: 6119 }).ok, true);

  // Both recorded counts are surfaced, so the log line can name either gap.
  assert.equal(halfSources.expectedPy, 6124);
  assert.equal(halfSources.expectedPyc, 6119);

  // The .pyc reason still wins when BOTH counts fall short — a whole-directory
  // loss is the more specific diagnosis, and its wording is pinned above.
  const both = unpackedBytecodeVerdict({ py: 5124, pyc: 5119 }, { py: 6124, pyc: 6119 });
  assert.match(both.reason, /whole directories are missing/);

  // No manifest: nothing to compare sources against, so the ratio is the only
  // net and it cannot see this shape. Pinned as a known limitation, matching
  // the whole-directory case above.
  assert.equal(unpackedBytecodeVerdict({ py: 3062, pyc: 6119 }, null).ok, true);
});

test("the source limit shares one tolerance with the .pyc limit", () => {
  // One limit, two counts: a benign loss of either kind is treated alike, so
  // the calibration that keeps the .pyc side from crying wolf (problems W15,
  // worst case one file) applies to sources too.
  const oneShort = unpackedBytecodeVerdict({ py: 6123, pyc: 6119 }, { py: 6124, pyc: 6119 });
  assert.equal(oneShort.ok, true, "one missing source must stay silent");

  const limit = Math.ceil(6124 * UNPACKED_MIN_COUNT_SHARE);
  assert.equal(unpackedBytecodeVerdict({ py: limit, pyc: 6119 }, { py: 6124, pyc: 6119 }).ok, true);
  assert.equal(unpackedBytecodeVerdict({ py: limit - 1, pyc: 6119 }, { py: 6124, pyc: 6119 }).ok, false);
  assert.ok(6124 - limit > 200, "the source side needs the same headroom as the .pyc side");

  // A manifest recording no sources cannot condemn a tree that has them.
  assert.equal(unpackedBytecodeVerdict({ py: 6124, pyc: 6119 }, { py: 0, pyc: 6119 }).ok, true);
});

test("the count limit is calibrated against the measured benign loss", () => {
  // problems W15 measured NSIS silently skipping .pyc whose absolute path
  // breaches MAX_PATH — worst case ONE file. A normal install must not warn,
  // or the warning is noise exactly where it needs to be believed (lesson L51).
  const oneShort = unpackedBytecodeVerdict({ py: 6124, pyc: 6118 }, { py: 6124, pyc: 6119 });
  assert.equal(oneShort.ok, true, "the measured W15 loss must stay silent");
  const sixShort = unpackedBytecodeVerdict({ py: 6124, pyc: 6113 }, { py: 6124, pyc: 6119 });
  assert.equal(sixShort.ok, true, "W15's one directory shipping 6 where the payload had 7");

  // The boundary is real, not a comparison that can never be false.
  const limit = Math.ceil(6119 * UNPACKED_MIN_COUNT_SHARE);
  assert.equal(unpackedBytecodeVerdict({ py: 6124, pyc: limit }, { py: 6124, pyc: 6119 }).ok, true);
  assert.equal(unpackedBytecodeVerdict({ py: 6124, pyc: limit - 1 }, { py: 6124, pyc: 6119 }).ok, false);

  // And the headroom over the known-good case is wide, so upstream churn in the
  // region cannot start tripping it.
  const headroom = 6119 - limit;
  assert.ok(headroom > 200, `only ${headroom} files of slack on a normal install is too tight`);
});

test("an empty copied tree is a broken measurement, not a pass", () => {
  // 0 .py means the walk saw nothing — the copy never landed. Reporting that as
  // "0% coverage" is true but useless; treating 0/0 as ok would be the
  // "check that cannot fail" failure (lesson L51).
  const v = unpackedBytecodeVerdict({ py: 0, pyc: 0 }, null);
  assert.equal(v.ok, false);
  assert.match(v.reason, /0 \.py files/);
});

// --- wiring: both halves of #897 §2 must actually be connected --------------
//
// The library above is only half the guarantee. Issue #897 §2 asks for a count
// written AT ASSEMBLE TIME and checked AT BOOTSTRAP; neither is proven by
// testing the pure functions, because a correct function nobody calls is dead
// code (lesson L55 — "the code exists" is not "the code runs"). These read the
// two source files and pin the calls, the same pattern as the assemble-side
// wiring tests above and test/installer-nsh.test.ts.

const bootstrap = readFileSync(join(winDesktopDir, "src", "bootstrap.ts"), "utf8");

test("assemble records the bytecode count in the version.json manifest", () => {
  // §2 first half: the count has to leave the build, or bootstrap has nothing to
  // compare the copy against. It must come from the SAME walk A6 gates on, not a
  // second traversal that could disagree with the gate.
  assert.match(assemble, /bytecode:\s*\{\s*\n\s*py: pyCount,\s*\n\s*pyc: pycCount,/,
    "the manifest must carry the A6 walk's py/pyc counts");
  assert.match(assemble, /byRegion: pycByRegion,/,
    "the manifest must carry the per-region buckets bootstrap reads envs-template from");
});

test("bootstrap imports the first-launch verdict from the library", () => {
  assert.match(bootstrap, /import \{[^}]*unpackedBytecodeVerdict[^}]*\} from "\.\.\/scripts\/lib\/pyc-budget\.mjs";/,
    "bootstrap must share the tested verdict, not reimplement the limit");
  // The threshold must stay the imported one — a restated 0.9 in bootstrap would
  // let the first-launch check drift from the build check (the exact coupling
  // installer-nsh.test.ts exists to prevent across files).
  assert.ok(!/unpackedBytecodeVerdict[\s\S]{0,400}?0\.9/.test(bootstrap),
    "bootstrap must not restate the coverage limit");
});

// Isolate the in-place branch of bootstrapPackaged. Guards that read source text
// can be satisfied by a comment, so every anchor below asserts it actually
// matched: a guard that silently anchors on nothing is worse than no guard
// (lesson L51), and this one would go green on a deleted branch.
const inPlaceBranch = /if \(inPlaceEnvs\) \{[\s\S]*?\n {2}\}/.exec(bootstrap)?.[0];
assert.ok(inPlaceBranch, "the in-place branch anchor no longer matches bootstrap.ts — re-anchor");
// Four landmarks split the branch into arms:
//   [0 .. gate)        the fix passes + the payload-aware gate itself,
//   [gate .. verdict)   the already-judged arm (reuses the prior verdict),
//   [verdict .. else)   the first-launch VERDICT-OK arm,
//   [else .. end)       the first-launch INCOMPLETE arm (compile everything).
const gatePos = inPlaceBranch.indexOf("const needsJudgement = needsBytecodeJudgement(");
const verdictPos = inPlaceBranch.indexOf('await judgeBytecodeCoverage("in-place"');
assert.ok(gatePos > 0, "the payload-aware judgement gate is missing from the in-place branch");
assert.ok(verdictPos > gatePos, "the in-place verdict call is missing or sits before the gate");
const inPlaceFirstArm = inPlaceBranch.slice(verdictPos);
// The incomplete arm begins at the "} else {" that follows the verdict.ok test.
const okPos = inPlaceFirstArm.indexOf("verdict.ok");
assert.ok(okPos > 0, "the verdict.ok branch is missing from the in-place arm");
const incompletePos = inPlaceFirstArm.indexOf("} else {", okPos);
assert.ok(incompletePos > okPos, "the incomplete arm anchor no longer matches");
const inPlaceStampArm = inPlaceBranch.slice(gatePos, verdictPos);
const inPlaceOkArm = inPlaceFirstArm.slice(0, incompletePos);
const inPlaceIncompleteArm = inPlaceFirstArm.slice(incompletePos);

test("both bootstrap branches judge coverage through the shared helper", () => {
  // §2 second half. The check lives in one helper so the copy branch and the
  // in-place branch cannot drift apart — and so it cannot be wired into only one
  // of them, which is what made the first version unreachable on real installs:
  // SCIENCE_AGENT_IN_PLACE_ENVS=1 is the packaged DEFAULT (main.ts sets it
  // before bootstrapPackaged) and that branch returned before the check.
  //
  // Counted as `await helper(` CALLS, not bare occurrences: the prose in two
  // comments names the helper too, and a guard that counts those would stay
  // green with both calls deleted.
  assert.equal(
    bootstrap.match(/await judgeBytecodeCoverage\(/g)?.length ?? 0, 2,
    "expected exactly one verdict call per branch (copy and in-place)",
  );
  assert.match(bootstrap, /await judgeBytecodeCoverage\("in-place", envsDir, paths\.resourcesPath, log\)/,
    "the in-place branch — the packaged default — must judge the payload it runs from");
  assert.match(bootstrap, /await judgeBytecodeCoverage\("copied", envsDir, paths\.resourcesPath, log\)/,
    "the copy branch must judge the tree copyTreeConcurrent just wrote");
  // The helper must actually count and judge, not just log.
  const helper = /async function judgeBytecodeCoverage\([\s\S]*?\n\}/.exec(bootstrap)?.[0] ?? "";
  assert.ok(helper, "the judgeBytecodeCoverage definition anchor no longer matches");
  assert.match(helper, /await countBytecode\(envsDir\)/, "the tree must be counted, not probed for a first hit");
  assert.match(helper, /readPayloadBytecodeManifest\(resourcesPath\)/, "the build's manifest count must be read");
  assert.match(helper, /unpackedBytecodeVerdict\(counts, expectedRegion\)/, "the count must be judged by the shared verdict");
  assert.match(helper, /first run: WARNING .* incomplete bytecode:/,
    "an incomplete tree must be named at first launch");
});

test("the in-place walk is gated on the PAYLOAD, not just the install", () => {
  // The copy branch short-circuits on a valid stamp before reaching its check,
  // but the in-place branch runs on EVERY launch (that short-circuit is
  // copy-mode only), and the walk is ~750ms on the real envs-template region.
  // "First run must not get slower" is a hard constraint on this project, so the
  // gate is part of the wiring, not an optimisation.
  //
  // But the gate must ask "has THIS PAYLOAD been judged here", not "is there a
  // stamp for this install location". needsUnpack answers the latter, and an
  // upgrade keeps the install root (installer.nsh restores $INSTDIR from the
  // registry) and the pinned data dir, so a needsUnpack gate skipped the
  // judgement on the one launch that installs a new payload — F3.
  assert.match(bootstrap, /const needsJudgement = needsBytecodeJudgement\(dataDir, paths\.resourcesPath, payloadId\);/,
    "the in-place check must be gated on the payload-aware predicate");
  // Pinned as ABSENT: gating the in-place judgement on needsUnpack is the bug
  // this fix removes, and re-adding it must go red here, not merely pass a
  // behavioural test that happens to use the same install root twice.
  assert.ok(!inPlaceBranch.includes("needsUnpack(dataDir"),
    "the in-place judgement regressed to a location-only gate — an upgrade would skip it (F3)");
  // The verdict lives in the judgement arm only; the already-judged arm reuses
  // the earlier verdict and must not re-walk.
  assert.ok(!inPlaceStampArm.includes("judgeBytecodeCoverage("),
    "the already-judged arm must not re-walk the payload");
});

test("the judgement gate keys on payload identity and is a separate predicate", () => {
  // The predicate must exist, be exported for test, and actually compare the
  // stamped payload against the running one — a stub that returns false would
  // silently skip every judgement after the first install.
  const def = /export function needsBytecodeJudgement\(([\s\S]*?)\n\}/.exec(bootstrap)?.[0] ?? "";
  assert.ok(def, "needsBytecodeJudgement is not defined/exported in bootstrap.ts");
  assert.match(def, /stamp\.payload !== payloadId/, "the gate must compare payload identity");
  assert.match(def, /stamp\.payload === undefined/, "a stamp predating the payload field must be judged, not trusted");
  // Separate from needsUnpack on purpose: the unpack decision must not change.
  assert.match(bootstrap, /if \(!inPlaceEnvs && !needsUnpack\(dataDir, paths\.resourcesPath\)\) \{/,
    "the copy-mode short-circuit must still gate on needsUnpack (unchanged unpack decision)");
  // The stamp records the payload it was judged against, in both write sites.
  assert.equal(bootstrap.match(/payload: payloadId \}/g)?.length ?? 0, 2,
    "both stamp writes (in-place and copy) must record payloadId");
  // And payloadId comes from version.json's own identity fields.
  const idDef = /export function payloadIdentity\(([\s\S]*?)\n\}/.exec(bootstrap)?.[0] ?? "";
  assert.ok(idDef, "payloadIdentity is not defined/exported in bootstrap.ts");
  assert.match(idDef, /repoCommit/, "payload identity must use the build's repoCommit");
  assert.match(idDef, /builtAt/, "payload identity must use the build's builtAt");
});

test("the remedial compile cannot inherit a bytecode redirect either", () => {
  // P3 of the review: assemble strips PYTHONPYCACHEPREFIX from the BUILD
  // environment, but bootstrap spawns its own compileall to recover a broken
  // payload. If that inherits the variable from the user's environment the
  // recovery writes every .pyc outside the tree, still exits 0, and the stamp
  // freezes the gap in — the W25 defect, moved from build time to install time.
  assert.match(bootstrap, /payloadCompileEnv\(process\.env, \{ warn: log \}\)/,
    "compileEnv must come from the same filter the build uses");
  assert.ok(!/const compileEnv: NodeJS\.ProcessEnv = \{\s*\n\s*\.\.\.process\.env/.test(bootstrap),
    "compileEnv regressed to an unfiltered {...process.env} spread — that is the W25 defect");
});

test("the weak treeHasPycache short-circuit no longer gates either first-launch decision", () => {
  // Pinned as absent: this is the exact defect. treeHasPycache returns true if
  // ANY __pycache__ holds ANY .pyc, so release6's 1,384-of-37,998 tree passed it
  // and the remedial compile was skipped.
  assert.ok(!/if \(await treeHasPycache\(envsDir\)\)/.test(bootstrap),
    "the copied-tree branch regressed to the W25 first-hit short-circuit");
  // Once the verdict has named the tree incomplete, the per-target probe must not
  // get a second vote — it would skip most targets for the same first-hit reason.
  // Asserted on CALL syntax within the INCOMPLETE arm only: a comment there names
  // compileIfCacheless, and both other arms legitimately still call it (the ok arm
  // for the read-only targets outside the judged region, the stamp-valid arm as a
  // cheap safety net).
  assert.ok(!/compileIfCacheless\(/.test(inPlaceIncompleteArm),
    "after an incomplete verdict every target must compile, not be re-probed");
  assert.match(inPlaceIncompleteArm, /runCompileall\(t, compileEnv, log\)/,
    "the incomplete arm must compile unconditionally");
  // The verdict-ok arm keeps the probe for the stdlib/jw targets the region
  // verdict does not cover — a W4-style single-target skip must still self-heal.
  assert.match(inPlaceOkArm, /compileIfCacheless\(t, compileEnv, log\)/,
    "the verdict-ok arm must still probe the read-only targets outside the judged region");
  assert.match(inPlaceStampArm, /compileIfCacheless\(t, compileEnv, log\)/,
    "the stamp-valid arm should still use the cheap per-target probe");
});
