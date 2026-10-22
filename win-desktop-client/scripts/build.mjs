// Build sd-shell: bundle main + preload with esbuild. Two node-platform entries,
// no renderer bundle (the UI is the remote SD web app on 127.0.0.1:4310).
// 选型理由（F7.1）：壳只有主进程/preload 两个 Node 入口，electron-vite 的渲染器
// 构建与 HMR 能力用不上；esbuild 单依赖、秒级构建、配置即一个文件。
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
  format: "cjs",           // Electron 主进程/preload 目前最稳的加载格式
  // .cjs 扩展名：package.json 是 "type":"module"，Electron 会把 .js 主入口
  // 当 ESM 加载而 require 崩溃；CJS bundle + .cjs 是最稳的组合（preload 同理）。
  outfile: join(root, "dist", entry === "src/main.ts" ? "main.cjs" : "preload.cjs"),
  platform: "node",
  sourcemap: true,
  target: "node20",
});

mkdirSync(join(root, "dist"), { recursive: true });

if (watch) {
  // watch 模式走 context API（esbuild 0.25 中 build() 不再接受 watch 选项）
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
  // Tray icon (F10.6f): the window/taskbar icon comes from the exe resource,
  // but the tray needs an explicit image — ship the 256px PNG next to the
  // bundled pages and let main.ts scale it down.
  cpSync(join(root, "build", "icon-256.png"), join(root, "dist", "icon.png"));
  console.log("shell build ok -> dist/");
}
