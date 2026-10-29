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
import { resolve } from "node:path";

import { STARTER_PACKAGE_SPECS, type OsAdaptation } from "./types.js";

/**
 * Windows equivalents (#477 and #482): there is no SIGTERM/SIGKILL and no POSIX
 * permission bit. taskkill /T /F is the tree kill; icacls with inheritance
 * removed plus an owner-only grant is the 0600 equivalent.
 */

let cachedSid: string | undefined;

/** The current user's SID ("S-1-..."), via `whoami /user`.
 *
 * Granting by account NAME breaks on non-ASCII (e.g. Chinese)
 * usernames — whoami writes console output in the OEM codepage (GBK on
 * zh-CN), Node decodes it as UTF-8, and the mangled "computer\????" grant
 * then fails account-name→SID mapping with icacls error 1332. The SID is
 * pure ASCII in every locale and icacls accepts it with a leading "*",
 * so grants are SID-based now (mirrors services/api platform/os/win32.ts). */
export function currentUserSid(): string {
  if (cachedSid) return cachedSid;
  const result = spawnSync("whoami", ["/user", "/fo", "list"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`whoami /user failed (${result.status}): ${result.stderr.trim()}`);
  }
  const sid = /S-1-\d+(?:-\d+)+/.exec(result.stdout)?.[0];
  if (!sid) throw new Error(`whoami /user returned no SID:\n${result.stdout.trim()}`);
  cachedSid = sid;
  return sid;
}

export const win32Adaptation: OsAdaptation = {
  async restrictToOwner(path, options) {
    const grantee = `*${currentUserSid()}`;
    const grant = options?.directory ? `${grantee}:(OI)(CI)F` : `${grantee}:F`;
    // AV scanners can briefly hold a freshly-created run workspace
    // (same field pattern renameReplace already retries for); retry rather
    // than fail a run on a transient lock.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
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
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  },
  terminateTree(child) {
    if (!child.pid) return false;
    // taskkill without /F only posts WM_CLOSE, which console processes ignore;
    // SIGTERM's "please exit" has no console equivalent, so force is honest.
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return result.status === 0;
  },
  micromambaBinaryName: "micromamba.exe",
  environmentInterpreterPath(prefixPath, language) {
    // win-64 conda layout: python.exe at the prefix root, R.exe under Scripts/.
    return language === "python"
      ? resolve(prefixPath, "python.exe")
      : resolve(prefixPath, "Scripts", "R.exe");
  },
  condaActivationPaths(prefixPath) {
    // win-64 python.exe delay-loads numpy/scipy DLLs from
    // Library\bin; without these on PATH the import dies with 0xC06D007F.
    return [prefixPath, resolve(prefixPath, "Library", "bin"), resolve(prefixPath, "Scripts")];
  },
  async renameReplace(source, destination) {
    // AV scanners and search indexers briefly hold freshly written
    // files; rename-over-existing then reports EPERM/EACCES/EBUSY. Back off
    // and retry — the window is tens of milliseconds.
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
  starterPackages(language) {
    // matplotlib pulls qt6, whose qml test resources exceed MAX_PATH
    // on any realistic prefix; matplotlib-base (Agg/file rendering, what agents
    // actually use) drops the whole qt6 tree.
    if (language === "python") {
      return [
        ...STARTER_PACKAGE_SPECS.python
          .map((spec) => (spec === "matplotlib=3.9" ? "matplotlib-base=3.9" : spec)),
        // run_shell needs a shell binary and Windows hosts have no bash; the starter
        // env preinstalls MSYS2 m2-bash (~3MB, lands at Library\usr\bin\bash.exe).
        "m2-bash",
      ];
    }
    return [...STARTER_PACKAGE_SPECS[language]];
  },
  packageInstallGuidance(rawErrorMessage) {
    // conda-forge win-64 has real gaps (pysam, jaxlib, modern
    // tensorflow — see the win-64 compatibility notes). Detect the
    // solver's "not found" shapes and point at the workable alternatives
    // instead of leaving a raw libmamba dump.
    const missing = /nothing provides|PackagesNotFound|could not be located|Could not solve for environment specs|The following packages are incompatible/i
      .test(rawErrorMessage);
    if (!missing) return null;
    return "This package may have no conda-forge win-64 build (Windows native). "
      + "Alternatives: retry with manager=\"pip\" if a PyPI wheel exists; "
      + "install the local sandbox engine (WSL) plugin for the full Linux package set; "
      + "or use a remote execution provider.";
  },
  environmentShellPath(prefixPath) {
    // m2-bash lands at Library\usr\bin\bash.exe inside a win-64 conda prefix
    // (MSYS2 port, msys2 runtime DLLs included).
    return resolve(prefixPath, "Library", "usr", "bin", "bash.exe");
  },
};
