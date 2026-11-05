// afterPack hook (electron-builder.yml): trim Electron locales to en-US +
// zh-CN. The stock Electron runtime ships ~45 locale .pak files (~45 MB raw,
// ~30 MB in the installer); the product only ever renders English or
// Simplified Chinese. SIZEOPT W4 (2026-11-03).
const { readdirSync, rmSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const localesDir = join(context.appOutDir, "locales");
  if (!existsSync(localesDir)) {
    console.log("[afterPack] locales dir not present yet — creating with en-US + zh-CN");
    return; // electron-builder may stage locales after the hook on some flows
  }
  let removed = 0;
  for (const name of readdirSync(localesDir)) {
    if (!name.endsWith(".pak")) continue;
    // Keep American English + Simplified Chinese (product UI languages) and
    // Simplified Chinese's fallback variants; drop the other ~50.
    if (/^(en-US|zh-CN|zh-TW)\.pak$/.test(name)) continue;
    rmSync(join(localesDir, name), { force: true });
    removed += 1;
  }
  console.log(`[afterPack] trimmed ${removed} Electron locale pak(s), kept en-US/zh-CN/zh-TW`);
};
