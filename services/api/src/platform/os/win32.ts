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
import { rename } from "node:fs/promises";

import type { OsAdaptation, RestrictToOwnerOptions } from "./types.js";

/**
 * Windows has no POSIX permission bits: Node's chmod only toggles the
 * read-only attribute, leaving token files world-readable within the profile.
 * The NTFS equivalent of 0600 is an ACL limited to the current user:
 * strip inheritance, then grant that principal full control. icacls ships
 * with Windows, so no dependency is introduced.
 */

let cachedPrincipal: string | undefined;

/** "domain\user" for the current process, via whoami (handles domain accounts). */
export function currentUserPrincipal(): string {
  if (cachedPrincipal) return cachedPrincipal;
  const result = spawnSync("whoami", [], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`whoami failed (${result.status}): ${result.stderr.trim()}`);
  }
  cachedPrincipal = result.stdout.trim();
  return cachedPrincipal;
}

function icaclsArgs(path: string, options?: RestrictToOwnerOptions): string[] {
  // (OI)(CI) lets a directory pass the restriction on to future children;
  // a plain file takes a direct full-control grant.
  const grant = options?.directory ? `${currentUserPrincipal()}:(OI)(CI)F` : `${currentUserPrincipal()}:F`;
  return [path, "/inheritance:r", "/grant:r", grant];
}

function assertIcaclsOk(status: number | null, output: string): void {
  if (status !== 0) throw new Error(`icacls failed (${status ?? "signal"}): ${output.trim()}`);
}

export const win32Adaptation: OsAdaptation = {
  async restrictToOwner(path, options) {
    const args = icaclsArgs(path, options);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("icacls", args, { windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", rejectPromise);
      child.once("close", (status) => {
        try {
          assertIcaclsOk(status, output);
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
  },
  restrictToOwnerSync(path, options) {
    const result = spawnSync("icacls", icaclsArgs(path, options), { encoding: "utf8" });
    if (result.error) throw result.error;
    assertIcaclsOk(result.status, `${result.stdout}${result.stderr}`);
  },
  async renameReplace(source, destination) {
    // AV scanners and search indexers briefly hold freshly written files;
    // MoveFileEx-with-replace then reports EPERM/EACCES/EBUSY. Back off and
    // retry: the window is tens of milliseconds, so ~1.5s of patience is ample.
    const retryable = new Set(["EPERM", "EACCES", "EBUSY"]);
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await rename(source, destination);
      } catch (error) {
        lastError = error;
        if (!retryable.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50 + attempt * 25));
      }
    }
    throw lastError;
  },
};
