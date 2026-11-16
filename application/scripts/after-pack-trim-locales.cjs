// afterPack hook (electron-builder.yml): trim Electron locales to en-US +
// zh-CN. The stock Electron runtime ships ~45 locale .pak files (~45 MB raw,
// ~30 MB in the installer); the product only ever renders English or
// Simplified Chinese. SIZEOPT W4 (2026-11-03).
//
// [mac-desktop] W28: platform dialects. Electron stages locales in TWO
// different shapes and this hook must trim whichever one it finds:
//   win32: <appOutDir>/locales/<locale>.pak          (flat dir, one pak per locale)
//   darwin: <appOutDir>/<App>.app/Contents/Frameworks/Electron Framework.framework/
//           Versions/A/Resources/<locale>.lproj/locale.pak   (one .lproj dir per
//           locale, EACH holding a locale.pak — the .lproj dirs double as
//           Launch Services locale declarations, so whole-dir removal is the
//           darwin equivalent of the win32 pak removal).
// Upstream's hook (upstream W4, #897 hardening) knew only the win32 shape and
// hard-failed on darwin with "locales dir not present" — that failure mode is
// exactly what the #897 hardening was designed for: a flow change the hook
// must hear about, and the darwin layout is one such flow, not an error.
//
// #897 hardening (kept for BOTH dialects): a missing locales dir is a hard
// failure — the hook's contract is to trim a directory electron-builder staged
// BEFORE it, and anything else is a flow change this hook must hear about,
// not absorb. On darwin the Resources dir itself is the staging root.
const { readdirSync, rmSync, existsSync } = require("node:fs");
const { join } = require("node:path");

// en-US + zh-CN are the product UI languages. zh-TW is kept as the fallback
// for zh-HK/zh-MO system locales (Electron falls back from the missing
// zh-HK.pak/zh-MO.pak to the Traditional Chinese pak), not as a UI language.
// W28: the two dialects NAME locales differently — win32's flat paks use
// BCP-47 dashes (en-US.pak), darwin's .lproj dirs use Electron's internal
// underscore form (en.lproj / zh_CN.lproj / zh_TW.lproj — verified against a
// real electron-builder 37 staging; a dash-form KEEP would match nothing on
// darwin and the verification below would correctly fail the build).
const KEEP = /^(en-US|zh-CN|zh-TW)\.pak$|^(en|zh_CN|zh_TW)\.lproj$/;

/** Resolve the dialect-specific staging root(s) under appOutDir.
 * win32: the flat `locales/` dir. darwin: the framework's Resources dir whose
 * `*.lproj` children each hold a locale.pak. Returns [] when the expected
 * staging shape is absent — the caller turns that into the #897 failure. */
function localeRoots(appOutDir) {
  const candidates = [];
  // win32 shape
  const flat = join(appOutDir, "locales");
  if (existsSync(flat)) candidates.push({ kind: "flat", dir: flat });
  // darwin shape: <appOutDir>/*.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources
  // The .app name is discovered from the staging dir itself (electron-builder
  // names it after the product), so the hook needs nothing from context.
  let resourcesDir = null;
  for (const entry of readdirSync(appOutDir)) {
    if (!entry.endsWith(".app")) continue;
    const candidate = join(appOutDir, entry, "Contents", "Frameworks",
      "Electron Framework.framework", "Versions", "A", "Resources");
    if (existsSync(candidate)) { resourcesDir = candidate; break; }
  }
  if (resourcesDir) {
    // Only claim the Resources dir when it actually carries .lproj locale dirs;
    // a darwin build always does, so absence here means an unexpected layout.
    const hasLproj = readdirSync(resourcesDir).some(n => n.endsWith(".lproj"));
    if (hasLproj) candidates.push({ kind: "lproj", dir: resourcesDir });
  }
  return candidates;
}

exports.default = async function afterPack(context) {
  const roots = localeRoots(context.appOutDir);
  if (roots.length === 0) {
    throw new Error(
      `[afterPack] no locale staging found under ${context.appOutDir} — electron-builder changed its staging order or layout; `
      + `this hook trims a directory it expects to already exist (SIZEOPT W4). Failing the build instead of `
      + `silently shipping ~30 MB of untrimmed locales.`
    );
  }
  let removed = 0;
  const kept = [];
  for (const root of roots) {
    if (root.kind === "flat") {
      for (const name of readdirSync(root.dir)) {
        if (!name.endsWith(".pak")) continue;
        if (KEEP.test(name)) continue;
        rmSync(join(root.dir, name), { force: true });
        removed += 1;
      }
      kept.push(...readdirSync(root.dir).filter(name => name.endsWith(".pak")));
    } else {
      // darwin: each <locale>.lproj is removed whole (the dir holds the pak
      // AND doubles as the Launch Services locale declaration).
      for (const name of readdirSync(root.dir)) {
        if (!name.endsWith(".lproj")) continue;
        if (KEEP.test(name)) continue;
        rmSync(join(root.dir, name), { recursive: true, force: true });
        removed += 1;
      }
      kept.push(...readdirSync(root.dir).filter(name => name.endsWith(".lproj")));
    }
  }
  // Post-trim assertion (#897): the whole point of this hook is the size win,
  // so verify the RESULT against an expectation that does not reuse the KEEP
  // regex — a KEEP regression must fail here, not pass the trim and the check
  // together. The assertion is deliberately regex-independent (the shape the
  // #897 review specified): at most 3 locale containers, and both UI languages
  // present. zh-TW is the optional third (fallback for zh-HK/zh-MO locales).
  // W28: the expected names are dialect-specific (dash-paks on win32,
  // underscore-lproj on darwin), so each staging root is checked against its
  // own pair.
  const flatKept = kept.filter(n => n.endsWith(".pak"));
  const lprojKept = kept.filter(n => n.endsWith(".lproj"));
  const problems = [];
  if (flatKept.length > 0) {
    const missingFlat = ["en-US.pak", "zh-CN.pak"].filter(n => !flatKept.includes(n));
    if (flatKept.length > 3 || missingFlat.length > 0) {
      problems.push(`flat staging kept ${flatKept.join(", ")} (missing=[${missingFlat.join(", ")}])`);
    }
  }
  if (lprojKept.length > 0) {
    const missingLproj = ["en.lproj", "zh_CN.lproj"].filter(n => !lprojKept.includes(n));
    if (lprojKept.length > 3 || missingLproj.length > 0) {
      problems.push(`darwin staging kept ${lprojKept.join(", ")} (missing=[${missingLproj.join(", ")}])`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[afterPack] locale trim verification failed: ${problems.join("; ")} `
      + `— expected exactly en-US + zh-CN (zh-TW at most as the zh-HK/zh-MO fallback). `
      + `Failing the build.`
    );
  }
  console.log(`[afterPack] trimmed ${removed} Electron locale(s), kept ${kept.map(n => n.replace(/\.(pak|lproj)$/, "")).join("/")} (en-US/zh-CN UI; zh-TW fallback for zh-HK/zh-MO system locales)`);
};
