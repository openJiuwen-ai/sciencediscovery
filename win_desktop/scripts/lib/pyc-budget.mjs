// pyc-budget: prove the payload's precompiled bytecode is INSIDE the payload.
//
// Field history (problems W25, release6, 2026-11-05): the local build script
// exported PYTHONPYCACHEPREFIX=$TMPB/pycache, and assemble-backend.mjs builds
// its compile environment as {...process.env}, so compileall inherited the
// redirect and wrote all 73,752 .pyc files (1011 MB) into a mirror tree
// OUTSIDE the payload. compileall still exited 0 — it wrote the right content
// to the wrong place — and every existing gate stayed green:
//
//   A1 payload self-check : imports succeed, because the .py sources all shipped
//   A1b runtime probe     : runs code; it never counts bytecode
//   A2 required-files     : the manifest has no bytecode entry
//   A5 path budget        : measures path length, unrelated
//
// The installer came out 446.5 MiB instead of ~577 MiB carrying 1,384 .pyc
// instead of ~37,000, so the first launch recompiled the entire payload — a
// multi-minute startup regression that breaks this project's "first run must
// not get slower" constraint. Nothing in the build noticed.
//
// Two guards live here, because cause and symptom need separate nets:
//
//   payloadCompileEnv() removes the CAUSE — a bytecode redirect inherited from
//     the build environment. assemble-backend.mjs already applies exactly this
//     defence to SD_PROBE_DEV_TREE; lesson L56 generalises it (any PYTHON*/cache
//     variable exported for a human's convenience is inherited by every child
//     this build spawns, and none of them filters it for you).
//
//   pycBudgetVerdict() catches the SYMPTOM — bytecode missing from the tree,
//     however it went missing: this variable, a future one, a compileall that
//     silently skips (problems W4 is the same load-bearing point failing the
//     other way round), or a sweep that eats __pycache__.
//
// Both are pure functions so win_desktop/test/pyc-budget.test.ts can pin them
// without a payload tree. That test pins the ACTUAL incident numbers: the broken
// tree's 1,384/37,998 must be rejected and the rebuilt tree's 37,324/37,998
// must be accepted, so the threshold can never be loosened past the one failure
// this module exists to prevent.

/**
 * Environment variables that must never reach a payload build.
 *
 * Only PYTHONPYCACHEPREFIX is listed, because only it is EVIDENCE-BACKED.
 * compileall honours it by writing every .pyc into a mirrored tree under the
 * prefix instead of next to its source, so the payload kept 1,384 bytecode
 * files out of ~37,000 while the build reported success (problems W25).
 *
 * PYTHONDONTWRITEBYTECODE looks like it belongs here and DOES NOT. Measured
 * (logs/w25-evidence/probe-env-semantics.sh, python 3.13, same compileall
 * invocation assemble uses):
 *
 *   baseline                          rc=0  pyc_in_tree=1
 *   PYTHONDONTWRITEBYTECODE=1         rc=0  pyc_in_tree=1   <- still written
 *   PYTHONPYCACHEPREFIX=<mirror>      rc=0  pyc_in_tree=0, pyc_in_mirror=1
 *
 * compileall is an explicit compile request; that variable only suppresses the
 * IMPLICIT bytecode write that importing performs, so it changes nothing here.
 * The negative result is recorded so nobody re-derives it by reasoning and
 * adds a blocklist entry whose comment claims a protection it does not give —
 * a guard justified by a false argument is worse than no guard, because it gets
 * cited as evidence (lesson L51). pyc-budget.test.ts pins this exclusion, so
 * adding the name back turns a test red and points at the probe.
 *
 * The blocklist is deliberately not the whole defence: it names one known cause,
 * while pycBudgetVerdict() catches the symptom of ANY cause, including a third
 * redirect nobody thought to blocklist.
 */
export const BYTECODE_ENV_BLOCKLIST = ["PYTHONPYCACHEPREFIX"];

/**
 * Variables that were considered for the blocklist and rejected BY MEASUREMENT.
 * Kept as data rather than prose so the test can pin the exclusion.
 */
export const BYTECODE_ENV_CONSIDERED_AND_REJECTED = {
  PYTHONDONTWRITEBYTECODE:
    "measured inert for compileall (explicit compile still writes .pyc); see probe-env-semantics.sh",
};

/**
 * Build the environment for every python the payload build spawns.
 *
 * Starts from the caller's environment (the build needs PATH, SYSTEMROOT,
 * TEMP, ...) and drops the bytecode redirects above. Returns a NEW object:
 * callers pass the result straight to execFileSync({env}), which replaces the
 * child environment wholesale rather than merging into it.
 *
 * @param {Record<string, string | undefined>} baseEnv usually process.env
 * @param {{warn?: (line: string) => void}} [options] `warn` receives one line
 *   per dropped variable so an inherited redirect is visible in the build log
 *   instead of being silently undone (a silent fix hides that somebody's
 *   environment is wrong, and the same variable will keep coming back).
 * @returns {Record<string, string | undefined>}
 */
export function payloadCompileEnv(baseEnv, { warn = () => {} } = {}) {
  const env = { ...baseEnv, PYTHONWARNINGS: "ignore" };
  for (const name of BYTECODE_ENV_BLOCKLIST) {
    if (name in env) {
      warn(
        `${name}=${env[name]} was set in the build environment; ignoring it for the payload build — ` +
          `it redirects or suppresses the .pyc files the installer must ship (problems W25)`,
      );
      delete env[name];
    }
  }
  return env;
}

/**
 * Minimum share of the payload's .py files that must have a compiled .pyc
 * beside them.
 *
 * Measured, not guessed — a gate's arithmetic has to be calibrated against a
 * known answer before it is trusted (problems W9 shipped a path gate that
 * under-counted by 6 chars because its threshold was derived from a truncated
 * sample, and problems W15 derived a threshold from a number MAX_PATH had
 * already cut down). Both samples below are the same release6 tree, before and
 * after the W25 rebuild, counted with `find -type f`:
 *
 *   BROKEN (the incident) :  1,384 .pyc / 37,998 .py =  3.6%   -> must fail
 *   GOOD   (rebuilt)      : 37,324 .pyc / 37,998 .py = 98.2%   -> must pass
 *
 * The good ratio is not 100% and must not be demanded to be. Measured on that
 * same rebuilt tree, split by whether the path contains a tests/ directory
 * (`find -type f`, same counts as above):
 *
 *   under tests/     :  4,023 .pyc /  4,580 .py = 87.8%   (557 short)
 *   elsewhere        : 33,301 .pyc / 33,418 .py = 99.7%   (117 short)
 *
 * tests/ is short because compileall runs with `-x "[/\\]tests[/\\]"` for the
 * jiuwenswarm src target, so the sweep's removal of first-party test bytecode
 * is not immediately undone; third-party site-packages tests are compiled by
 * the other targets, which is why that subtree is not empty. The remaining 117
 * are modules compileall legitimately skips (e.g. syntax it declines to
 * compile). 0.90 therefore leaves the good tree ~8 points of headroom for
 * upstream churn while sitting 24x above the broken tree, so it cannot be
 * satisfied by the failure it exists to catch.
 */
export const PYC_MIN_RATIO = 0.9;

/**
 * Judge the payload's bytecode coverage. Pure: the caller walks the tree.
 *
 * A ratio is used instead of an absolute .pyc count on purpose — an absolute
 * floor has to be hand-updated every time upstream adds or drops a dependency,
 * and a stale floor fails in the unsafe direction (too low = the gate passes a
 * payload that lost half its bytecode). The ratio is self-normalising: however
 * many .py files the payload carries, a healthy compileall leaves ~98% of them
 * with a sibling .pyc.
 *
 * @param {number} pyCount  .py files under the payload root
 * @param {number} pycCount .pyc files under the same root
 * @param {{minRatio?: number}} [options]
 * @returns {{ok: boolean, ratio: number, reason: string}} `reason` is empty
 *   when ok, and is the text the build prints when not.
 */
export function pycBudgetVerdict(pyCount, pycCount, { minRatio = PYC_MIN_RATIO } = {}) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  // 0 .py files means the walk measured nothing — wrong --out, or a tree that
  // was never staged. Reporting that as "0% coverage" would be true but
  // useless, and treating 0/0 as a pass would be the "check that cannot fail"
  // failure of lesson L51, so it is called out as a broken measurement.
  if (pyCount === 0) {
    return {
      ok: false,
      ratio: 0,
      reason:
        "the tree walk counted 0 .py files, so this measurement measured nothing " +
        "(wrong --out, or the payload was never staged) — refusing to pass a budget nobody took",
    };
  }
  const ratio = pycCount / pyCount;
  if (ratio < minRatio) {
    return {
      ok: false,
      ratio,
      reason:
        `only ${pct(ratio)} of the payload's ${pyCount} .py files have a compiled .pyc beside them ` +
        `(${pycCount} .pyc found, limit ${pct(minRatio)})`,
    };
  }
  return { ok: true, ratio, reason: "" };
}

/**
 * Per-region coverage, for the advisory line only (never a hard failure).
 *
 * The whole-tree ratio is what gates the build; this is the diagnostic that
 * says WHERE coverage was lost, because a single compile target failing can
 * hide inside a healthy total (the stdlib target losing every .pyc still leaves
 * the site-packages trees intact). Regions are the payload's top-level
 * directories, the same granularity A5's path budget reports at.
 *
 * @param {Record<string, {py: number, pyc: number}>} buckets
 * @param {number} [minRatio]
 * @returns {{name: string, py: number, pyc: number, ratio: number}[]} worst first
 */
export function regionsBelowRatio(buckets, minRatio = PYC_MIN_RATIO) {
  return Object.entries(buckets)
    .filter(([, b]) => b.py > 0 && b.pyc / b.py < minRatio)
    .map(([name, b]) => ({ name, py: b.py, pyc: b.pyc, ratio: b.pyc / b.py }))
    .sort((a, b) => a.ratio - b.ratio);
}

/**
 * Minimum share of the BUILD's recorded counts that a copy must still carry.
 * Applied to the .pyc count AND to the .py count, because the coverage ratio
 * is blind in opposite directions to each: it barely moves when whole
 * directories go missing (.py and .pyc together), and it gets BETTER when only
 * the sources go missing. Only consulted when version.json recorded a count
 * for the region.
 *
 * The .pyc side closes a blind spot the coverage ratio cannot see, because a
 * copy that loses a whole package directory loses its .py and its .pyc
 * together — the ratio of what survived barely moves. Computed on the measured
 * release6
 * envs-template region (6,124 .py / 6,119 .pyc):
 *
 *   files lost   coverage ratio      share of the build count
 *            0   99.92%  -> passes   100.0%
 *          100   99.92%  -> passes    98.4%
 *          306   99.91%  -> passes    95.0%  <- the limit
 *          500   99.91%  -> passes    91.8%
 *         1000   99.90%  -> passes    83.7%
 *
 * The ratio column is flat to three decimals across a thousand missing files:
 * issue #897 §2 names "partial copy" as a failure the bootstrap check must
 * catch, and a ratio-only gate is blind to exactly that shape. The share
 * column is what catches it.
 *
 * 0.95 is calibrated against the ONE measured benign loss (problems W15):
 * NSIS silently skips .pyc whose absolute path breaches MAX_PATH, and the
 * measured worst case was a single file (263 chars where the limit is 259).
 * At 0.95 a normal install may lose 305 of 6,119 files before this warns, so
 * the known-good case keeps ~300x headroom and the warning cannot cry wolf —
 * a warning every install emits is a warning nobody reads when it matters
 * (lesson L51). Raising the limit buys nothing: the losses above start at
 * hundreds of files, and lowering it re-opens the blind spot.
 */
export const UNPACKED_MIN_COUNT_SHARE = 0.95;

/**
 * Judge the env tree bootstrap runs its bytecode from — the first-launch half
 * of the bytecode guard (issue #897 section 2: "check it at bootstrap, so an
 * incomplete set ... names itself at first launch instead of surfacing as an
 * ImportError at first tool use").
 *
 * Why this exists separately from treeHasPycache(): that helper answers "is
 * there ANY .pyc under here" and short-circuits on the first hit, so the
 * release6 payload — 1,384 .pyc where the build had compiled ~37,000, because
 * PYTHONPYCACHEPREFIX redirected the rest outside the payload (problems W25) —
 * still looked complete. bootstrap then SKIPPED the remedial compile, and the
 * missing modules only failed later, as an ImportError the first time a tool
 * imported one. This answers "did the copy keep the coverage the build shipped"
 * instead, so the same payload is named at first launch.
 *
 * Two limits are applied, because each catches a shape the other is blind to:
 *
 *   PYC_MIN_RATIO reuses the build gate rather than inventing a second
 *     threshold. The copied tree is a 1:1 unpack of the payload's
 *     envs-template region (measured on release6: 6,119 .pyc for 6,124 .py =
 *     99.9%), so the limit that gates the build applies to the copy unchanged.
 *     It catches a tree that ARRIVED WITHOUT ITS BYTECODE — the W25 incident,
 *     where the .py all shipped and the .pyc went elsewhere.
 *
 *   UNPACKED_MIN_COUNT_SHARE compares the walk against the build's own
 *     recorded counts, and is applied to BOTH sides of the ratio because each
 *     side hides a different loss:
 *       .pyc — catches a tree that arrived PARTIALLY (§2's "partial copy /
 *         interrupted unpack"), where whole directories never landed, so their
 *         .py and .pyc are missing together and the ratio barely moves (see the
 *         table on that constant).
 *       .py — catches a tree that lost its SOURCES and kept its caches, the
 *         shape an antivirus quarantine rule produces. The ratio is pyc/py, so
 *         deleting .py makes coverage look HEALTHIER: half the sources gone
 *         reads as ~200% coverage and passes a ratio-only gate, while a PEP
 *         3147 .pyc is unusable without the .py beside it. The user then hits
 *         the ImportError §2 exists to pre-empt, from a tree that reported
 *         itself as better than the one that shipped.
 *
 * The count limit only applies when the manifest recorded one. An absent
 * version.json (or one predating the `bytecode` field) degrades to the ratio
 * alone instead of passing blind, and a manifest can never RESCUE a bad ratio:
 * it is build output, not ground truth, so it may only make the verdict
 * stricter. That asymmetry is deliberate — a stale-high manifest would
 * otherwise wave a broken copy through, and the direction a build artifact can
 * be wrong in is the unsafe one.
 *
 * @param {{py: number, pyc: number}} actual counted by walking the tree
 * @param {{py: number, pyc: number}|null} expected the manifest count for the
 *   region this tree came from (version.json bytecode.byRegion), or null when
 *   the manifest is absent or predates that field.
 * @param {{minRatio?: number, minCountShare?: number}} [options]
 * @returns {{ok: boolean, ratio: number, reason: string,
 *   expectedPyc: number|null, expectedPy: number|null,
 *   kind: "ratio"|"pyc-count"|"py-count"|null}} `reason` is empty when ok;
 *   the two `expected` fields are the manifest counts (or null) so the caller's
 *   log line can name the gap. `kind` says which limit fired, and it is not
 *   cosmetic: a missing .pyc can be recompiled on the spot, a missing .py
 *   cannot — compileall has nothing to compile from — so the caller owes the
 *   user a different promise for each.
 */
export function unpackedBytecodeVerdict(actual, expected, options = {}) {
  const {
    minRatio = PYC_MIN_RATIO,
    minCountShare = UNPACKED_MIN_COUNT_SHARE,
  } = options;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const verdict = pycBudgetVerdict(actual.py, actual.pyc, { minRatio });
  const expectedPyc =
    expected && Number.isFinite(expected.pyc) ? expected.pyc : null;
  const expectedPy =
    expected && Number.isFinite(expected.py) ? expected.py : null;
  if (!verdict.ok) {
    return { ok: false, ratio: verdict.ratio, reason: verdict.reason, expectedPyc, expectedPy, kind: "ratio" };
  }
  // Ratio cleared. Now the two shapes it cannot see, each only judgeable
  // against a count the build recorded, so both stay silent when it left none.
  //
  // The .pyc side first: a copy that lost whole directories kept its ratio and
  // lost files, and that reason is the more specific of the two (it names both
  // counts going down together).
  if (expectedPyc != null && expectedPyc > 0) {
    const share = actual.pyc / expectedPyc;
    if (share < minCountShare) {
      return {
        ok: false,
        ratio: verdict.ratio,
        reason:
          `the tree carries ${actual.pyc} of the ${expectedPyc} .pyc the build recorded for this region ` +
          `(${pct(share)}, limit ${pct(minCountShare)}) while its coverage ratio still looks healthy at ` +
          `${pct(verdict.ratio)} — whole directories are missing, .py and .pyc together`,
        expectedPyc,
        expectedPy,
        kind: "pyc-count",
      };
    }
  }
  // Then the .py side, which the ratio actively hides: deleting sources RAISES
  // pyc/py, so a tree that lost half its .py and kept every __pycache__ reports
  // ~200% coverage and clears the limit above. Those .pyc are unusable — PEP
  // 3147 resolves them against a source that is no longer there — so the
  // modules still fail to import, now behind a verdict that looks healthier
  // than the payload that shipped. Same tolerance as the .pyc side: one limit,
  // two counts, so a benign loss of either kind is treated alike.
  if (expectedPy != null && expectedPy > 0) {
    const share = actual.py / expectedPy;
    if (share < minCountShare) {
      return {
        ok: false,
        ratio: verdict.ratio,
        reason:
          `the tree carries ${actual.py} of the ${expectedPy} .py sources the build recorded for this region ` +
          `(${pct(share)}, limit ${pct(minCountShare)}) while its coverage ratio reads ${pct(verdict.ratio)} — ` +
          "sources are missing, and a cached .pyc cannot be imported without the .py beside it",
        expectedPyc,
        expectedPy,
        kind: "py-count",
      };
    }
  }
  return { ok: true, ratio: verdict.ratio, reason: "", expectedPyc, expectedPy, kind: null };
}
