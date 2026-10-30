// Dev runner: build once, then launch the shell with Electron's own runtime.
// No system node on the machine — the shell runs its main process on
// Electron's own bundled runtime, keeping the dev chain self-contained too.
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
