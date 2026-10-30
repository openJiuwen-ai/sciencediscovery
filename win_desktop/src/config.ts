// sd-shell configuration resolution. Pure functions only — everything here is
// unit-tested without Electron.
import { join } from "node:path";

/** Where the shell looks for the SD backend checkout.
 *  Packaged layout: <resources>/backend (app.isPackaged); dev: sibling
 *  checkout of the shell project, overridable via SD_SHELL_REPO. */
export function resolveRepoRoot(
  env: NodeJS.ProcessEnv,
  shellDir: string,
  packagedRoot?: string | null,
): string {
  if (env.SD_SHELL_REPO) return env.SD_SHELL_REPO;
  if (packagedRoot) return join(packagedRoot, "backend");
  return join(shellDir, "..", "sciencediscovery");
}

/** Data dir: explicit env wins; otherwise the SD default (user profile). */
export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  return env.SCIENCE_DISCOVERY_DATA_DIR ?? join(env.USERPROFILE ?? ".", ".sciencediscovery");
}

/** Token file inside the data dir (same layout the stack writes at bootstrap). */
export function tokenFilePath(dataDir: string): string {
  return join(dataDir, "secrets", "auth-token");
}

/**
 * UI base URL the shell loads. Fixed by the stack's adapter: web UI on 4310.
 * Overridable for dev against a remote box.
 */
export function uiUrl(env: NodeJS.ProcessEnv): string {
  return (env.SD_SHELL_UI_URL ?? "http://127.0.0.1:4310").replace(/\/+$/, "");
}

/** Control API health endpoint (start-stack.mjs public port). */
export function healthUrl(env: NodeJS.ProcessEnv): string {
  return (env.SD_SHELL_HEALTH_URL ?? "http://127.0.0.1:4410/api/health").replace(/\/+$/, "");
}

/**
 * Backend stack entry: start-stack.mjs contract. Runs foreground; SIGINT
 * triggers its internal killTree of the whole stack.
 */
export function stackEntry(repoRoot: string): string {
  return join(repoRoot, "scripts", "start-stack.mjs");
}
