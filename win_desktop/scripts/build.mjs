// Build sd-shell: bundle main + preload with esbuild. Two node-platform entries,
// no renderer bundle (the UI is the remote SD web app on 127.0.0.1:4310).
// Rationale: the shell has only two Node entries (main/preload) —
// electron-vite's renderer build and HMR would go unused; esbuild is a
// single dependency, builds in seconds, and its config is one file.
import { buildSync, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const options = (entry) => ({
  bundle: true,
  entryPoints: [join(root, entry)],
  external: ["electron"],
  format: "cjs",           // the most reliable load format for Electron main/preload today
  // .cjs extension: package.json is "type":"module", so Electron would load
  // a .js main entry as ESM and require would crash; a CJS bundle + .cjs is
  // the most robust combination (same for preload).
  outfile: join(root, "dist", entry === "src/main.ts" ? "main.cjs" : "preload.cjs"),
  platform: "node",
  sourcemap: true,
  target: "node20",
});

mkdirSync(join(root, "dist"), { recursive: true });

if (watch) {
  // watch mode uses the context API (esbuild 0.25 dropped the watch option from build())
  const ctxs = await Promise.all(
    ["src/main.ts", "src/preload.ts"].map((entry) => context(options(entry)))
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("shell build watching -> dist/");
} else {
  for (const entry of ["src/main.ts", "src/preload.ts"]) {
    const result = buildSync(options(entry));
    if (result.errors.length) {
      console.error(result.errors);
      process.exit(1);
    }
  }
  for (const page of ["fallback.html", "wizard.html", "loading.html"]) {
    cpSync(join(root, "src", page), join(root, "dist", page));
  }
  // The redesigned wizard/loading pages share the SPA wizard's art
  // panel (panel-model.webp) so the first run looks like one flow.
  cpSync(join(root, "src", "panel-model.webp"), join(root, "dist", "panel-model.webp"));
  // Tray icon: the window/taskbar icon comes from the exe resource,
  // but the tray needs an explicit image — ship the 256px PNG next to the
  // bundled pages and let main.ts scale it down.
  cpSync(join(root, "build", "icon-256.png"), join(root, "dist", "icon.png"));
  console.log("shell build ok -> dist/");
}
