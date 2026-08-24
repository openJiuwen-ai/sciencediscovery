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

import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Escape a value embedded in a Seatbelt Scheme string literal. */
export function seatbeltString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // A result file may not exist yet. Resolve the nearest existing parent and
    // append the missing suffix so Seatbelt still sees the kernel's real path.
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return resolve(await canonicalPath(parent), path.slice(parent.length + 1));
  }
}

export interface SeatbeltProfileOptions {
  /** Host paths visible for reading (workspace, runtimes and packaged assets). */
  readPaths: string[];
  /** Host paths writable by the workload (normally workspace and its temp dir). */
  writePaths: string[];
  /** The sole permitted outbound endpoint. Omit for an offline sandbox. */
  proxyPort?: number;
}

/**
 * Build a deny-by-default macOS Seatbelt profile.
 *
 * The process receives only the filesystem roots needed to execute system
 * tools plus the explicitly supplied workload paths. Network access is either
 * absent or limited to one runner-owned loopback proxy port.
 */
export async function buildSeatbeltProfile(options: SeatbeltProfileOptions): Promise<string> {
  const readPaths = [...new Set(await Promise.all(options.readPaths.map(canonicalPath)))];
  const writePaths = [...new Set(await Promise.all(options.writePaths.map(canonicalPath)))];
  const pathRules = (operation: "file-read*" | "file-write*", paths: string[]) => paths
    .map((path) => `  (allow ${operation} (subpath ${seatbeltString(path)}))`)
    .join("\n");
  const networkRules = options.proxyPort === undefined ? "" : `
  (allow network-outbound (remote ip "localhost:${options.proxyPort}"))`;

  return `(version 1)
(deny default)

; Runtime primitives needed by Python, R and non-interactive shell tools.
(allow process-exec process-fork process-info*)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm ipc-posix-sem)

; Stable operating-system and toolchain files. Workload-specific paths follow.
(allow file-read*
  (literal "/")
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library")
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
  (subpath "/private/etc")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom"))
${pathRules("file-read*", [...readPaths, ...writePaths])}
(allow file-write* (literal "/dev/null"))
${pathRules("file-write*", writePaths)}
${networkRules}
`;
}

export interface WorkspacePathMapping {
  hostCwd: string;
  logicalCwd: string;
  toHostPath(logicalPath: string): string;
  toLogicalPath(hostPath: string): string;
}

function descendant(root: string, path: string): string | undefined {
  const result = relative(root, path);
  if (result === "") return "";
  if (result === ".." || result.startsWith(`..${sep}`)) return undefined;
  return result;
}

/** Translate the stable `/workspace` API path to the real macOS host path. */
export function seatbeltWorkspaceMapping(
  workspaceRoot: string,
  readOnlyWorkspaceRoot: string | undefined,
  logicalCwd: string,
): WorkspacePathMapping {
  const logicalRoot = readOnlyWorkspaceRoot && descendant(readOnlyWorkspaceRoot, workspaceRoot) !== undefined
    ? readOnlyWorkspaceRoot
    : workspaceRoot;
  const relativeCwd = logicalCwd === "/workspace" ? "" : logicalCwd.slice("/workspace/".length);
  const hostCwd = resolve(logicalRoot, relativeCwd);
  return {
    hostCwd,
    logicalCwd,
    toHostPath(logicalPath: string): string {
      if (logicalPath === "/workspace") return logicalRoot;
      if (logicalPath.startsWith("/workspace/")) return resolve(logicalRoot, logicalPath.slice(11));
      return logicalPath;
    },
    toLogicalPath(hostPath: string): string {
      const relativePath = descendant(logicalRoot, resolve(hostPath));
      if (relativePath === undefined) return logicalCwd;
      return relativePath ? `/workspace/${relativePath.split(sep).join("/")}` : "/workspace";
    },
  };
}
