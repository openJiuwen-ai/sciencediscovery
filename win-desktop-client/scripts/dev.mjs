// Dev runner: build once, then launch the shell with Electron's own runtime.
// 本机没有系统 node（F1 结论）——壳用 Electron 自带运行时跑主进程，dev 链路同样自洽。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronExe = join(root, "node_modules", "electron", "dist", "electron.exe");
const child = spawn(electronExe, ["--inspect=0", "."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, SD_SHELL_DEV: "1" },
});
child.on("exit", code => process.exit(code ?? 0));
