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
 * Session env profiles: environment continuity between the persistent shell
 * session and later python/r/shell executions in the same Session. The profile
 * is captured from the shell worker's own `env` dump
 * after each evaluation — it never contains host environ entries because the
 * shell itself starts from `--clearenv` — and is re-injected after
 * `--clearenv` into subsequent sandbox launches under a controlled policy.
 */

export interface SessionEnvProfile {
  /** Sandbox-internal cwd captured from the shell (e.g. `/workspace/subdir`). */
  cwd: string;
  updatedAt: string;
  variables: Record<string, string>;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Runner-owned baseline keys: the sandbox launch always sets these itself. */
export const PROFILE_RESERVED_KEYS = new Set([
  "HOME",
  "OLDPWD",
  "PATH",
  "PWD",
  "PYTHONNOUSERSITE",
  "PYTHONPATH",
  "R_ENVIRON_USER",
  "SHLVL",
  "_",
]);

/** Keys that change loader/interpreter startup behavior: never sedimented. */
const PROFILE_BLOCKED_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "IFS",
  "PROMPT_COMMAND",
  "PS4",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "SHELLOPTS",
]);

const PROFILE_BLOCKED_PREFIXES = ["BASH_FUNC_", "LD_"];

/** Keep bwrap argv bounded: oversized values are dropped at capture time. */
const PROFILE_MAX_VALUE_BYTES = 32 * 1024;
const PROFILE_MAX_TOTAL_BYTES = 256 * 1024;

export function profileKeyAllowed(name: string): boolean {
  return ENV_NAME_PATTERN.test(name)
    && !PROFILE_RESERVED_KEYS.has(name)
    && !PROFILE_BLOCKED_KEYS.has(name)
    && !PROFILE_BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Filter a raw shell env dump down to the injectable profile variables. */
export function sedimentableVariables(dump: Record<string, string>): Record<string, string> {
  const variables: Record<string, string> = {};
  let totalBytes = 0;
  for (const name of Object.keys(dump).toSorted()) {
    const value = dump[name]!;
    if (!profileKeyAllowed(name)) continue;
    const entryBytes = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (Buffer.byteLength(value) > PROFILE_MAX_VALUE_BYTES) continue;
    if (totalBytes + entryBytes > PROFILE_MAX_TOTAL_BYTES) continue;
    totalBytes += entryBytes;
    variables[name] = value;
  }
  return variables;
}

/** Only sandbox workspace paths may carry over as a launch cwd. */
export function sedimentableCwd(cwd: string): string | undefined {
  return cwd === "/workspace" || cwd.startsWith("/workspace/") ? cwd : undefined;
}

/**
 * Profiles are keyed by Session and Permission Epoch, mirroring the kernel
 * reuse key: an epoch change never leaks environment across permission
 * boundaries. Lifetime is tied to the owning shell session — stopping the
 * shell (idle timeout, teardown, exit) clears the profile.
 */
export class SessionEnvProfileStore {
  private readonly profiles = new Map<string, SessionEnvProfile>();

  private key(sessionId: string, permissionEpochId: string): string {
    return `${sessionId}:${permissionEpochId}`;
  }

  get(sessionId: string, permissionEpochId: string): SessionEnvProfile | undefined {
    const profile = this.profiles.get(this.key(sessionId, permissionEpochId));
    return profile ? { ...profile, variables: { ...profile.variables } } : undefined;
  }

  /** Capture from a raw shell env dump; stores only the injectable subset. */
  update(sessionId: string, permissionEpochId: string, cwd: string, dump: Record<string, string>): void {
    this.profiles.set(this.key(sessionId, permissionEpochId), {
      cwd: sedimentableCwd(cwd) ?? "/workspace",
      updatedAt: new Date().toISOString(),
      variables: sedimentableVariables(dump),
    });
  }

  clear(sessionId: string, permissionEpochId: string): void {
    this.profiles.delete(this.key(sessionId, permissionEpochId));
  }

  clearSession(sessionId: string): void {
    for (const key of this.profiles.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.profiles.delete(key);
    }
  }
}
