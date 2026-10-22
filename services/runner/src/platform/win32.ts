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

import { spawn, spawnSync } from "node:child_process";

import type { OsAdaptation } from "./types.js";

/**
 * Windows equivalents (F3.2/F3.3): there is no SIGTERM/SIGKILL and no POSIX
 * permission bit. taskkill /T /F is the tree kill; icacls with inheritance
 * removed plus an owner-only grant is the 0600 equivalent.
 */

let cachedPrincipal: string | undefined;

/** "domain\user" for the current process, via whoami (handles domain accounts). */
export function currentUserPrincipal(): string {
  if (cachedPrincipal) return cachedPrincipal;
  const result = spawnSync("whoami", [], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`whoami failed (${result.status}): ${result.stderr.trim()}`);
  cachedPrincipal = result.stdout.trim();
  return cachedPrincipal;
}

export const win32Adaptation: OsAdaptation = {
  async restrictToOwner(path, options) {
    const grant = options?.directory ? `${currentUserPrincipal()}:(OI)(CI)F` : `${currentUserPrincipal()}:F`;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("icacls", [path, "/inheritance:r", "/grant:r", grant], { windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", rejectPromise);
      child.once("close", (status) => {
        if (status === 0) resolvePromise();
        else rejectPromise(new Error(`icacls failed (${status ?? "signal"}): ${output.trim()}`));
      });
    });
  },
  terminateTree(child) {
    if (!child.pid) return false;
    // taskkill without /F only posts WM_CLOSE, which console processes ignore;
    // SIGTERM's "please exit" has no console equivalent, so force is honest.
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return result.status === 0;
  },
};
