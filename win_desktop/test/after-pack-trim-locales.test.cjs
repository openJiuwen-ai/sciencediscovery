// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
//
// #897 §3.1: pin the locale-trim afterPack hook's CONTRACT, which previously
// had no test at all:
//   1. a missing locales dir FAILS the build (the old early-return logged
//      "creating with en-US + zh-CN" while creating nothing — a packaging
//      flow that stages locales after the hook would silently lose the ~30 MB
//      W4 win while the log claimed the opposite);
//   2. the trim keeps exactly en-US/zh-CN (+ zh-TW, the fallback for
//      zh-HK/zh-MO system locales) and drops every other .pak;
//   3. the post-trim verification catches a misfire (missing kept pak /
//      leftover pak) instead of trusting the loop.
//
// Runs the REAL hook module (require'd, not restated) against temp dirs, so a
// regression in the hook turns this red instead of a copy passing forever.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const hook = require("../scripts/after-pack-trim-locales.cjs").default;

function workspace(paks) {
  const appOutDir = mkdtempSync(join(tmpdir(), "sd-locales-"));
  const localesDir = join(appOutDir, "locales");
  mkdirSync(localesDir, { recursive: true });
  for (const name of paks) writeFileSync(join(localesDir, name), "");
  // A non-pak file must survive the trim untouched (the hook only speaks .pak).
  writeFileSync(join(localesDir, "README.md"), "not a locale");
  return { context: { appOutDir }, localesDir };
}

test("trims every pak except en-US/zh-CN/zh-TW and leaves non-paks alone", async () => {
  const { context, localesDir } = workspace([
    "en-US.pak", "zh-CN.pak", "zh-TW.pak",
    "de.pak", "ja.pak", "fr-FR.pak", "zh-HK.pak", "am.pak",
  ]);
  try {
    await hook(context);
    const left = readdirSync(localesDir).sort();
    assert.deepEqual(left, ["README.md", "en-US.pak", "zh-CN.pak", "zh-TW.pak"]);
  } finally { rmSync(context.appOutDir, { recursive: true, force: true }); }
});

test("a missing locales dir fails the build instead of silently skipping the trim", async () => {
  // The exact regression #897 §3.1 records: the old branch logged "creating
  // with en-US + zh-CN", created nothing, and returned — the build stayed
  // green while ~45 locale paks shipped.
  const appOutDir = mkdtempSync(join(tmpdir(), "sd-locales-"));
  try {
    await assert.rejects(
      () => hook({ appOutDir }),
      /locales dir not present/,
      "the hook returned successfully on a missing locales dir; the ~30 MB W4 win is silently lost again",
    );
  } finally { rmSync(appOutDir, { recursive: true, force: true }); }
});

test("a leftover pak the trim should have removed fails the post-trim verification", async () => {
  // Simulate the loop misfiring (e.g. a KEEP regex regression keeping de.pak):
  // the verification pass must reject the result, not trust the loop.
  const { context, localesDir } = workspace(["en-US.pak", "zh-CN.pak", "zh-TW.pak", "de.pak"]);
  try {
    const hookSource = require("node:fs").readFileSync(require.resolve("../scripts/after-pack-trim-locales.cjs"), "utf8");
    // Run the real hook but with a KEEP that admits de.pak, then assert the
    // verification (which uses its OWN expectation) still fails the build.
    const loosened = hookSource.replace(
      "const KEEP = /^(en-US|zh-CN|zh-TW)\\.pak$/;",
      "const KEEP = /^(en-US|zh-CN|zh-TW|de)\\.pak$/;",
    );
    assert.notEqual(loosened, hookSource, "the KEEP anchor changed shape; update this guard");
    const sandbox = join(context.appOutDir, "sandbox.cjs");
    writeFileSync(sandbox, loosened + "\nmodule.exports = exports;\n");
    const loosenedHook = require(sandbox).default;
    await assert.rejects(
      () => loosenedHook(context),
      /trim verification failed: 4 \.pak remaining .*de\.pak/,
      "the post-trim verification did not catch a pak the trim should have removed",
    );
  } finally { rmSync(context.appOutDir, { recursive: true, force: true }); }
});

test("a missing kept pak fails the post-trim verification", async () => {
  // en-US.pak absent from the staged set: the trim loop would "succeed" with
  // nothing to remove, but the product would boot without its English UI.
  const { context } = workspace(["zh-CN.pak", "zh-TW.pak", "de.pak"]);
  try {
    await assert.rejects(
      () => hook(context),
      /trim verification failed: .*missing=\[en-US\.pak\]/,
      "a payload without en-US.pak passed the post-trim verification",
    );
  } finally { rmSync(context.appOutDir, { recursive: true, force: true }); }
});

test("the verification expectation is independent of the KEEP regex", async () => {
  // The guard behind the guard: if the verification ever goes back to testing
  // `!KEEP.test(name)` (reusing the trim's own regex), a KEEP regression
  // passes trim AND verification together — the hole the mutation test above
  // exercises. Pin that the verification reads counts and a membership list,
  // not the regex.
  const hookSource = require("node:fs").readFileSync(require.resolve("../scripts/after-pack-trim-locales.cjs"), "utf8");
  const verification = hookSource.slice(hookSource.indexOf("Post-trim assertion"));
  assert.ok(/remaining\.length > 3/.test(verification),
    "the verification no longer caps the .pak count; a KEEP-regex-only check re-opens the hole");
  assert.ok(!/!KEEP\.test/.test(verification),
    "the verification reuses the KEEP regex; a KEEP regression would pass trim and check together");
});
