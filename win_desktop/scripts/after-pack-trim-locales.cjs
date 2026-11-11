// afterPack hook (electron-builder.yml): trim Electron locales to en-US +
// zh-CN. The stock Electron runtime ships ~45 locale .pak files (~45 MB raw,
// ~30 MB in the installer); the product only ever renders English or
// Simplified Chinese. SIZEOPT W4 (2026-11-03).
//
// #897 hardening: the early-return branch used to log "creating with en-US +
// zh-CN" while creating nothing — if a packaging flow ever staged locales
// after this hook, the ~30 MB W4 win would be silently lost while the log
// claimed the opposite. A missing locales dir is now a hard failure: the
// hook's contract is to trim a directory electron-builder staged BEFORE it,
// and anything else is a flow change this hook must hear about, not absorb.
const { readdirSync, rmSync, existsSync } = require("node:fs");
const { join } = require("node:path");

// en-US + zh-CN are the product UI languages. zh-TW is kept as the fallback
// for zh-HK/zh-MO system locales (Electron falls back from the missing
// zh-HK.pak/zh-MO.pak to the Traditional Chinese pak), not as a UI language.
const KEEP = /^(en-US|zh-CN|zh-TW)\.pak$/;

exports.default = async function afterPack(context) {
  const localesDir = join(context.appOutDir, "locales");
  if (!existsSync(localesDir)) {
    throw new Error(
      `[afterPack] locales dir not present at ${localesDir} — electron-builder changed its staging order; `
      + `this hook trims a directory it expects to already exist (SIZEOPT W4). Failing the build instead of `
      + `silently shipping ~30 MB of untrimmed locales.`
    );
  }
  let removed = 0;
  for (const name of readdirSync(localesDir)) {
    if (!name.endsWith(".pak")) continue;
    if (KEEP.test(name)) continue;
    rmSync(join(localesDir, name), { force: true });
    removed += 1;
  }
  // Post-trim assertion (#897): the whole point of this hook is the size win,
  // so verify the RESULT against an expectation that does not reuse the KEEP
  // regex — a KEEP regression must fail here, not pass the trim and the check
  // together. The assertion is deliberately regex-independent (the shape the
  // #897 review specified): at most 3 paks, and both UI languages present.
  // zh-TW is the optional third (fallback for zh-HK/zh-MO system locales).
  const remaining = readdirSync(localesDir).filter(name => name.endsWith(".pak"));
  const missing = ["en-US.pak", "zh-CN.pak"].filter(name => !remaining.includes(name));
  if (remaining.length > 3 || missing.length > 0) {
    throw new Error(
      `[afterPack] locale trim verification failed: ${remaining.length} .pak remaining (${remaining.join(", ")}), `
      + `missing=[${missing.join(", ")}] — expected exactly en-US.pak + zh-CN.pak (zh-TW.pak at most as the zh-HK/zh-MO fallback). `
      + `Failing the build.`
    );
  }
  console.log(`[afterPack] trimmed ${removed} Electron locale pak(s), kept ${remaining.map(n => n.replace(/\.pak$/, "")).join("/")} (en-US/zh-CN UI; zh-TW fallback for zh-HK/zh-MO system locales)`);
};
