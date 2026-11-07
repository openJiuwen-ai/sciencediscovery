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
 * Which isolation the sidecar will get, decided here and sent down with the run.
 *
 * The probe lives on this side because this repository has already paid for the
 * knowledge it encodes: inside a container bubblewrap may need
 * `--disable-userns`, and a fresh procfs mount can be refused so launches have
 * to fall back to a bind. The sidecar asking `which bwrap` a second time, in
 * another language, is how two answers start to disagree — so it does not ask;
 * it is told.
 *
 * The refusal matters more than the detection. A candidate is model-written
 * Python that gets executed, so a run whose isolation is unavailable is refused
 * **at creation**, with a message naming the fix — not at the first expansion,
 * after the user has watched a progress bar for a minute.
 *
 * Windows is the one exception, and a narrow one: it has neither backend, and
 * the desktop ships its own node runtime rather than a container, so an
 * installation can opt into `direct` execution (the same semantics the Windows
 * Runner already gives shell commands). That is not a sandbox — the candidate
 * runs with the user's own file, network and environment access — so the
 * backend is handed down *only* when the deployment opted in, and pre-flight
 * still requires the user's per-run confirmation before it accepts a goal.
 */

import { access, constants } from "node:fs/promises";
import { platform } from "node:process";

import { detectSandboxCapability } from "@sciencediscovery/sandbox-capability";

import { apiLog } from "../logging.js";

/** What the sidecar needs to build its command line. Mirrors the Python
 *  `SandboxCapability`; the wire form is snake_case. */
export interface EvolveSandboxCapability {
  /** `direct` means the candidate runs unconfined, with the user's own access.
   *  It only ever comes from an installation that opted in on Windows, and a
   *  run still needs the user's confirmation in its goal. */
  backend: "bwrap" | "seatbelt" | "direct" | null;
  bwrapPath: string;
  disableUserns: boolean;
  procMode: "bind" | "proc";
  /** Why there is no backend, for the message the user sees. */
  reason?: string;
}

export const SANDBOX_MISSING_HINT = [
  "A candidate program is model-written, unreviewed code and will not be executed without isolation.",
  "Linux: install bubblewrap (bwrap).",
  "macOS: sandbox-exec ships with the system; nothing to install.",
  "Windows: the desktop can run candidates without isolation, but only after you confirm it in the run dialog.",
].join(" ");

const WINDOWS_NO_SANDBOX = "Windows has no bubblewrap or Seatbelt, and this installation has not "
  + "enabled direct execution";

/**
 * The platforms whose answer needs no probing.
 *
 * Split out from the probe so the Windows decision — opt in, or refuse — can be
 * exercised on a machine that is not Windows. Linux answers `undefined` and is
 * probed for a bwrap that can actually start a namespace.
 */
export function sandboxForPlatform(
  platformName: NodeJS.Platform,
  options: { bwrapPath?: string; unisolated?: boolean } = {},
): EvolveSandboxCapability | undefined {
  const bwrapPath = options.bwrapPath ?? "bwrap";
  if (platformName === "darwin") {
    return { backend: "seatbelt", bwrapPath, disableUserns: false, procMode: "proc" };
  }
  if (platformName !== "win32") return undefined;
  if (options.unisolated === true) {
    return { backend: "direct", bwrapPath, disableUserns: false, procMode: "proc" };
  }
  return {
    backend: null,
    bwrapPath,
    disableUserns: false,
    procMode: "proc",
    reason: WINDOWS_NO_SANDBOX,
  };
}

/**
 * Probe once and describe what the sidecar should use.
 *
 * On macOS the answer is Seatbelt without probing: `sandbox-exec` ships with
 * the system, and there is nothing container-specific to discover.
 *
 * On Windows there is nothing to probe either way. `unisolated` is the
 * installation's own opt-in (the desktop sets it); without it the backend stays
 * null and every run that executes a candidate is refused at creation.
 */
export async function probeEvolveSandbox(
  configured: string,
  options: { unisolated?: boolean } = {},
): Promise<EvolveSandboxCapability> {
  const fixed = sandboxForPlatform(platform, { bwrapPath: configured, unisolated: options.unisolated });
  if (fixed) return fixed;
  // Absolute, so what is handed down names the binary that was actually
  // probed. A bare name is resolved again on the other side, against a
  // different PATH, and a host with two bubblewraps then probes one and
  // confines candidates with the other.
  const bwrapPath = await resolveExecutable(configured);
  const capability = await detectSandboxCapability(bwrapPath);
  if (!capability.sandboxUsable) {
    apiLog.warn("evolve_sandbox_unusable", { detail: capability.detail ?? "", reason: capability.reason });
    return {
      backend: null,
      bwrapPath,
      disableUserns: false,
      procMode: "proc",
      reason: capability.detail || capability.reason,
    };
  }
  return {
    backend: "bwrap",
    bwrapPath,
    disableUserns: capability.disableUserns,
    // The probe's vocabulary is "new"/"bind"; the sidecar's is "proc"/"bind".
    // Translating here keeps the wire shape describing what the sidecar does
    // rather than what the probe found.
    procMode: capability.procFallback ? "bind" : "proc",
  };
}

/**
 * Find `name` on this process's PATH, as `which` would.
 *
 * Node has no built-in for this, and shelling out to `which` would be one more
 * PATH lookup to get wrong. A name that already contains a separator is a path
 * and is returned as given.
 */
async function resolveExecutable(name: string): Promise<string> {
  if (name.includes("/")) return name;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = `${directory}/${name}`;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Keep looking — this is what PATH means.
    }
  }
  // Nothing found: hand back the name so the probe fails with the real error
  // rather than this function inventing one.
  return name;
}

/** The wire form the sidecar's `RunSpec` expects. */
export function toSidecarCapability(capability: EvolveSandboxCapability): Record<string, unknown> {
  return {
    backend: capability.backend,
    bwrap_path: capability.bwrapPath,
    disable_userns: capability.disableUserns,
    proc_mode: capability.procMode,
  };
}
