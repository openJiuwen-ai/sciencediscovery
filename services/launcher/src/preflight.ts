// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Host checks run before `serve` starts any process.
 *
 * The single-file binary carries its own Node, CPython and micromamba, so the
 * only mandatory host dependency is bubblewrap: sandboxed `run_python` and
 * `run_shell` execute under it and it cannot be vendored, because it needs
 * setuid or unprivileged user namespaces from the host kernel.
 */
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import {
  detectSandboxCapability,
  disableUsernsOmittedMessage,
  procFallbackMessage,
  SANDBOX_UNUSABLE_HINT,
  type SandboxProcMode,
} from "@sciencediscovery/sandbox-capability";

export const BWRAP_INSTALL_HINT = [
  "Install bubblewrap with your system package manager, then run serve again:",
  "  Debian / Ubuntu   sudo apt-get install -y bubblewrap",
  "  Fedora / RHEL     sudo dnf install -y bubblewrap",
  "  openEuler         sudo dnf install -y bubblewrap",
  "  Arch              sudo pacman -S bubblewrap",
  "  Alpine            sudo apk add bubblewrap",
].join("\n");

export function missingBwrapMessage(bwrapPath: string): string {
  return [
    `bubblewrap (${bwrapPath}) was not found on this host.`,
    "",
    "ScienceDiscovery runs every sandboxed Python and shell tool inside bubblewrap,",
    "so it is a required host dependency and is deliberately not bundled: the",
    "sandbox depends on kernel user namespaces that only the host can grant.",
    "",
    BWRAP_INSTALL_HINT,
    "",
    "To start the Web UI and control API anyway, with sandboxed execution",
    "unavailable, re-run with --skip-sandbox-check.",
  ].join("\n");
}

/** Resolve an executable the way execvp would, so errors can name a real path. */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [command]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

/**
 * Probe whether bubblewrap can actually build a sandbox here. Presence on PATH
 * is not enough: hardened hosts disable unprivileged user namespaces, and the
 * failure would otherwise only surface on the first tool call.
 *
 * This delegates to the detection the runner uses, so preflight cannot report a
 * sandbox the runner then fails to build. In particular it probes with
 * `--disable-userns` first: reporting success from a launch that omits an
 * option the runner would add is exactly the mismatch that let the service look
 * healthy while every tool call failed.
 */
export async function probeSandbox(bwrapPath: string): Promise<{ ok: boolean; detail?: string }> {
  const capability = await detectSandboxCapability(bwrapPath);
  return capability.sandboxUsable
    ? { ok: true }
    : { detail: capability.detail, ok: false };
}

/** The runner prints the same guidance for this host, so the text lives once. */
export const RESTRICTED_USERNS_HINT = SANDBOX_UNUSABLE_HINT;

export interface PreflightOptions {
  bwrapPath: string;
  dataDir: string;
  skipSandboxCheck: boolean;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

export interface PreflightResult {
  /** Absolute bubblewrap path, or undefined when the check was skipped. */
  bwrapPath?: string;
  sandboxUsable: boolean;
  /**
   * Whether sandboxed executions will carry `--disable-userns`. False is a
   * degraded but working sandbox, not a failure, so it never blocks serve.
   */
  disableUserns: boolean;
  /** How sandboxed executions will provide `/proc`. */
  procMode: SandboxProcMode;
  /** True when `--proc` was refused and launches fell back to binding `/proc`. */
  procFallback: boolean;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  await mkdir(options.dataDir, { recursive: true });
  try {
    await access(options.dataDir, constants.W_OK);
  } catch {
    throw new Error(`The data directory ${options.dataDir} is not writable by this user.`);
  }

  const resolved = await findExecutable(options.bwrapPath, options.env);
  if (!resolved) {
    if (!options.skipSandboxCheck) throw new Error(missingBwrapMessage(options.bwrapPath));
    warn(`WARNING: bubblewrap (${options.bwrapPath}) is missing; sandboxed execution will fail.`);
    return { disableUserns: false, procFallback: false, procMode: "new", sandboxUsable: false };
  }

  const capability = await detectSandboxCapability(resolved);
  if (!capability.sandboxUsable) {
    warn(`WARNING: ${RESTRICTED_USERNS_HINT}`);
  } else {
    // The sandbox works but may be degraded on either axis, and both can be
    // degraded at once, so report them independently rather than as a chain.
    if (capability.procFallback) warn(`WARNING: ${procFallbackMessage(resolved, capability)}`);
    if (!capability.disableUserns) warn(`WARNING: ${disableUsernsOmittedMessage(resolved, capability)}`);
  }
  return {
    bwrapPath: resolved,
    disableUserns: capability.disableUserns,
    procFallback: capability.procFallback,
    procMode: capability.procMode,
    sandboxUsable: capability.sandboxUsable,
  };
}
