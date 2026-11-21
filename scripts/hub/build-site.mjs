// Build the hub with the base path the deployment serves it under.
//
// The package script used to spell this as `HUB_BASE_PATH=/site/ pnpm ...`,
// which is a POSIX shell prefix and does not run from cmd or PowerShell. This
// wrapper sets the variable in the child's environment instead.
import { spawnSync } from "node:child_process";

// `--root` is the service-hosted deployment: nginx serves the site at `/` and
// proxies `/api`, so the bundle must not assume a `/site/` prefix.
const apiBuild = process.argv.includes("--root");
const base = apiBuild ? "/" : process.env.HUB_BASE_PATH ?? "/site/";
const extraEnv = apiBuild ? { HUB_PUBLIC_DIR: "none" } : {};
const result = spawnSync("pnpm", ["--filter", "@sciencediscovery/hub", "build"], {
  env: { ...process.env, ...extraEnv, HUB_BASE_PATH: base },
  shell: process.platform === "win32",
  stdio: "inherit",
});
process.exit(result.status ?? 1);
