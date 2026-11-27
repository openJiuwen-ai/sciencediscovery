// Static regression guard over mac.signIgnore in electron-builder.yml (W23a).
//
// Why this lives here: signIgnore is a persistent policy that grows per
// incident (W23 added \.pyc$, W23a added 13 data-file patterns) and is
// applied to every future payload — but the safety invariant it rests on
// ("patterns match N data files, 0 true Mach-O harmed") was enforced only
// by a one-off scan of a 92,376-file bundle on the author's Mac. A single
// added pattern such as /lib/ or \.so$ would silently skip real Mach-O and
// only surface as a failed launch or a codesign --verify --deep --strict
// failure after a multi-hour signed build.
//
// The patterns are read out of electron-builder.yml, not restated here —
// an assertion that repeats a pattern cannot catch that pattern changing.
// This is pure path/regex logic (same compile+match semantics as
// app-builder-lib's MacTargetHelper: new RegExp(it) tested against the
// absolute file path), so it runs on Linux and macOS without signing
// material, in build-mac.sh step 1 BEFORE step 5 spends hours in codesign.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url)) + "/..";
const read = (rel: string): string => readFileSync(join(appDir, rel), "utf8");

/** mac.signIgnore entries, parsed with the same semantics the toolchain
 * uses: app-builder-lib@26.15.3 MacTargetHelper compiles each entry with
 * new RegExp(it) and tests it against the absolute file path. Parsing stops
 * at the first non-list line after the signIgnore key, so a later YAML list
 * at the same indentation (dmg contents) can never leak in. Surrounding
 * quotes are stripped so a quoted entry ("\\.fits$") is compiled the way
 * YAML consumers see it, not with literal quote characters. */
function signIgnorePatterns(): string[] {
  const yml = read("electron-builder.yml");
  const m = /^  signIgnore:\n((?:    - .*\n)+)/m.exec(yml);
  assert.ok(m, "mac.signIgnore block not found in electron-builder.yml");
  return m[1]
    .split("\n")
    .filter((l) => l.startsWith("    - "))
    .map((l) => l.slice(6))
    .map((p) => p.replace(/^("|')(.*)\1$/, "$2"));
}

/** The one Mach-O skip that predates W23a and is safe by design: .pyc is
 * bytecode, never executable, and stays sealed under CodeResources. */
const PYC = "\\.pyc$";

const patterns = signIgnorePatterns();
const compiled = patterns.map((p) => new RegExp(p));

/** Mirrors @electron/osx-sign shouldIgnoreFilePath: the compiled pattern is
 * tested against the file's absolute path inside the bundle. */
const ignores = (absPath: string): boolean =>
  compiled.some((re) => re.test(absPath));

const APP_ROOT = "/release/mac-arm64/ScienceDiscovery.app";

/** Representative payload Mach-O paths — every executable shape the bundle
 * ships (bot F1 table): the app binary, the Electron framework, a helper
 * bundle binary, the bundled CPython interpreter, a framework dylib, and a
 * native extension module. If any signIgnore pattern matches one of these,
 * a future signed build skips a real Mach-O. */
const MACH_O_PATHS: [string, string][] = [
  ["app binary", `${APP_ROOT}/Contents/MacOS/ScienceDiscovery`],
  [
    "Electron framework",
    `${APP_ROOT}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
  ],
  [
    "helper bundle binary",
    `${APP_ROOT}/Contents/Frameworks/ScienceDiscovery Helper.app/Contents/MacOS/ScienceDiscovery Helper`,
  ],
  [
    "bundled CPython interpreter",
    `${APP_ROOT}/Contents/Resources/python/bin/python3.12`,
  ],
  [
    "framework dylib",
    `${APP_ROOT}/Contents/Resources/python/lib/libpython3.12.dylib`,
  ],
  [
    "native extension module (.so)",
    `${APP_ROOT}/Contents/Resources/backend/jw/.venv/lib/python3.12/site-packages/orjson/orjson.cpython-312-darwin.so`,
  ],
];

test("signIgnore: patterns parse out of electron-builder.yml", () => {
  // W23's original entry plus the 14 W23a cohort patterns = 15 today. The
  // exact count asserts neither a pattern was lost in a merge nor a stray
  // one added without widening this test's tables.
  assert.equal(patterns.length, 15);
  assert.ok(patterns.includes(PYC), "the W23 \\.pyc$ entry must stay");
});

test("signIgnore: no pattern matches a representative Mach-O path", () => {
  for (const [what, path] of MACH_O_PATHS) {
    const offender = patterns.find((p) => new RegExp(p).test(path));
    assert.ok(
      !offender,
      `pattern ${offender} would skip a real Mach-O (${what}): ${path}`,
    );
  }
});

test("signIgnore: every pattern is individually load-bearing", () => {
  // F2: a probe path matched by TWO patterns guards neither — narrowing one
  // while the other still matches leaves the suite green (bot proved this by
  // mutating each pattern in turn). The probe table below stores only PATHS
  // (plus a label); the patterns themselves come from the yml via
  // signIgnorePatterns(), never restated here — a narrowed/dropped pattern
  // loses its only probe and fails loudly.
  //
  // Probe construction rule: suffix patterns get a file in a neutral
  // directory (site-packages/_cohort/) where no directory pattern applies;
  // directory patterns get a file whose extension no suffix pattern covers.
  // Each probe is matched by EXACTLY ONE pattern from the parsed list, and
  // each pattern matches EXACTLY ONE probe — a bijection, so breaking any
  // single pattern fails exactly one assertion, naming it.
  const NEUTRAL = `${APP_ROOT}/Contents/Resources/backend/jw/.venv/lib/python3.12/site-packages/_cohort`;
  const SP = `${APP_ROOT}/Contents/Resources/backend/jw/.venv/lib/python3.12/site-packages`;
  const probes: [string, string][] = [
    ["bytecode", `${APP_ROOT}/Contents/Resources/backend/jw/src/core/mod.cpython-312.pyc`],
    ["numpy archive", `${NEUTRAL}/asset.npz`],
    ["matlab data", `${NEUTRAL}/pair.mat`],
    ["spss data", `${NEUTRAL}/asset.sav`],
    ["audio", `${NEUTRAL}/asset.wav`],
    ["fits image", `${NEUTRAL}/asset.fits`],
    ["static lib", `${NEUTRAL}/libcore.a`],
    ["type1 font", `${NEUTRAL}/font.pfb`],
    ["tzdata blob", `${SP}/tzdata/zoneinfo/America/New_York`],
    ["pdfminer CMap", `${SP}/pdfminer/cmap/Adobe-Japan1.ucd.gz`],
    ["test data dir", `${SP}/numpy/_core/tests/data/astype.npy`],
    ["sklearn dataset image", `${SP}/sklearn/datasets/images/china.jpg`],
    ["reportlab non-pfb font", `${SP}/reportlab/fonts/DarkGardenMK.afm`],
    ["babel locale data", `${SP}/babel/locale-data/en_US.dat`],
    ["matplotlib data", `${SP}/matplotlib/mpl-data/matplotlibrc`],
  ];
  assert.equal(probes.length, patterns.length, "probe table and pattern list must stay in lockstep (15 patterns, 15 probes)");
  // Direction 1 — every probe is matched by exactly one parsed pattern.
  for (const [what, probe] of probes) {
    const matchers = patterns.filter((p) => new RegExp(p).test(probe));
    assert.equal(
      matchers.length,
      1,
      `probe "${what}" is matched by ${JSON.stringify(matchers)} — need exactly 1 (shadowed = guards nothing, zero = its pattern was narrowed/dropped and the cohort re-enters the timestamp marathon): ${probe}`,
    );
  }
  // Direction 2 — every parsed pattern matches at least one probe, so none
  // of the 15 can be dropped from the yml and stay green.
  for (const p of patterns) {
    const re = new RegExp(p);
    const hits = probes.filter(([, probe]) => re.test(probe));
    assert.ok(hits.length >= 1, `pattern ${p} matches no probe — it is either new (add one, in a neutral path) or narrowed past its cohort`);
  }
});

test("signIgnore: .pyc bytecode still matches (W23 regression guard)", () => {
  const pyc = `${APP_ROOT}/Contents/Resources/backend/jw/src/core/foundation/store/module.cpython-312.pyc`;
  assert.ok(ignores(pyc), "the W23 \\.pyc$ skip must keep matching bytecode");
});
