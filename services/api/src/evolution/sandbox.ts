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
 */

import { access, constants } from "node:fs/promises";
import { platform } from "node:process";

import { detectSandboxCapability } from "@sciencediscovery/sandbox-capability";

import { apiLog } from "../logging.js";

/** What the sidecar needs to build its command line. Mirrors the Python
 *  `SandboxCapability`; the wire form is snake_case. */
export interface EvolveSandboxCapability {
  backend: "bwrap" | "seatbelt" | null;
  bwrapPath: string;
  disableUserns: boolean;
  procMode: "bind" | "proc";
  /** Why there is no backend, for the message the user sees. */
  reason?: string;
}

export const SANDBOX_MISSING_HINT = [
  "候选程序是模型写的、未经审查的代码，没有隔离就不会执行。",
  "Linux：安装 bubblewrap（bwrap）。",
  "macOS：sandbox-exec 随系统提供，无需安装。",
].join(" ");

/**
 * Probe once and describe what the sidecar should use.
 *
 * On macOS the answer is Seatbelt without probing: `sandbox-exec` ships with
 * the system, and there is nothing container-specific to discover.
 */
export async function probeEvolveSandbox(configured: string): Promise<EvolveSandboxCapability> {
  if (platform === "darwin") {
    return { backend: "seatbelt", bwrapPath: configured, disableUserns: false, procMode: "proc" };
  }
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
