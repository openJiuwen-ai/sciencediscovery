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
 * One shared answer to "what can bubblewrap actually do on this host?", used by
 * both the launcher preflight and the runner so they cannot disagree.
 *
 * `--disable-userns` is implemented by writing `user.max_user_namespaces`
 * inside the sandbox, so a binary that lists the option in `--help` can still
 * fail to use it: LXC and container runtimes that mount `/proc/sys` read-only
 * make that write fail with EROFS, and bubblewrap then aborts the whole launch.
 * Checking `--help` therefore says nothing about whether an execution will
 * start. The only faithful check is to run a minimal sandbox with the flag.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Probe budget. Generous: a cold bubblewrap on a loaded host is still fast. */
export const SANDBOX_PROBE_TIMEOUT_MS = 15_000;

export type SandboxCapabilityReason =
  /** The hardened sandbox, `--disable-userns` included, launched. */
  | "supported"
  /** Pre-0.8 bubblewrap: the binary does not know the option at all. */
  | "option-unknown"
  /** The binary knows the option but this environment refuses the sysctl write. */
  | "option-rejected"
  /** bubblewrap cannot build even the baseline sandbox; the flag is moot. */
  | "sandbox-unusable";

export type SandboxProcMode =
  /** Product default: `--proc /proc` gives the sandbox its own procfs. */
  | "new"
  /**
   * Fallback: `--ro-bind /proc /proc`. Used only where mounting a fresh procfs
   * is refused, because the sandbox then sees the container's process list.
   */
  | "bind";

export interface SandboxCapability {
  /** Add `--disable-userns` to product launches. False means "omit it". */
  disableUserns: boolean;
  /** The baseline namespace sandbox builds here, so executions can run. */
  sandboxUsable: boolean;
  reason: SandboxCapabilityReason;
  /** bubblewrap's own failure line, kept for logs. Absent when nothing failed. */
  detail?: string;
  /** How launches must provide `/proc`. */
  procMode: SandboxProcMode;
  /** True when `--proc` was refused and `procMode` fell back to `bind`. */
  procFallback: boolean;
  /** bubblewrap's refusal of `--proc`, kept for logs. Set only on fallback. */
  procDetail?: string;
}

/** How a launch mounts `/proc` for the chosen mode. */
export function procMountArguments(procMode: SandboxProcMode): string[] {
  return procMode === "bind"
    ? ["--ro-bind", "/proc", "/proc"]
    : ["--proc", "/proc"];
}

/**
 * The smallest launch that still exercises the setup a real execution depends
 * on. `/proc` is part of it: whether a fresh procfs can be mounted is exactly
 * one of the things being detected, and the `--disable-userns` probe has to run
 * on whichever `/proc` shape the product will actually use.
 */
export function sandboxProbeArguments(options: {
  disableUserns: boolean;
  procMode: SandboxProcMode;
}): string[] {
  return [
    "--unshare-all", "--unshare-user", "--die-with-parent",
    ...(options.disableUserns ? ["--disable-userns"] : []),
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    ...procMountArguments(options.procMode),
    "/usr/bin/true",
  ];
}

/** bubblewrap reports every setup failure on stderr; its last line names the cause. */
function probeFailureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string") {
    const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (last) return last;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runProbe(
  bwrapPath: string,
  options: { disableUserns: boolean; procMode: SandboxProcMode },
  timeoutMs: number,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await execFileAsync(bwrapPath, sandboxProbeArguments(options), {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    });
    return { ok: true };
  } catch (error) {
    return { detail: probeFailureDetail(error), ok: false };
  }
}

/**
 * Settle `/proc` before anything else. Docker's default `readonlyPaths` /
 * `maskedPaths` stop bubblewrap from mounting a fresh procfs in its new pid
 * namespace, which fails the launch outright — so the product's own `/proc`
 * shape has to be decided first, and the `--disable-userns` probe then runs on
 * that shape rather than on a launch the product would never use.
 */
async function probeProcMode(
  bwrapPath: string,
  timeoutMs: number,
): Promise<{ procMode: SandboxProcMode; procFallback: boolean; procDetail?: string; usable: boolean }> {
  const fresh = await runProbe(bwrapPath, { disableUserns: false, procMode: "new" }, timeoutMs);
  if (fresh.ok) return { procFallback: false, procMode: "new", usable: true };

  // A fresh procfs was refused. Binding the existing /proc is weaker — the
  // sandbox then sees the container's processes — so it is only ever a
  // fallback, and only when it actually gets a sandbox running.
  const bound = await runProbe(bwrapPath, { disableUserns: false, procMode: "bind" }, timeoutMs);
  if (bound.ok) {
    return { procDetail: fresh.detail, procFallback: true, procMode: "bind", usable: true };
  }
  // Neither shape works: this host builds no sandbox at all. Report the
  // product-default failure, which is the one an operator should act on.
  return { procDetail: fresh.detail, procFallback: false, procMode: "new", usable: false };
}

async function probeSandboxCapability(bwrapPath: string, timeoutMs: number): Promise<SandboxCapability> {
  const proc = await probeProcMode(bwrapPath, timeoutMs);
  if (!proc.usable) {
    return {
      detail: proc.procDetail,
      disableUserns: false,
      procFallback: false,
      procMode: proc.procMode,
      reason: "sandbox-unusable",
      sandboxUsable: false,
    };
  }

  const shape = { procDetail: proc.procDetail, procFallback: proc.procFallback, procMode: proc.procMode };
  const hardened = await runProbe(bwrapPath, { disableUserns: true, procMode: proc.procMode }, timeoutMs);
  if (hardened.ok) return { ...shape, disableUserns: true, reason: "supported", sandboxUsable: true };

  // The baseline already launched on this same /proc shape, so the only new
  // variable is the flag itself: this failure is attributable to it.
  return {
    ...shape,
    detail: hardened.detail,
    disableUserns: false,
    reason: /unknown option/i.test(hardened.detail ?? "") ? "option-unknown" : "option-rejected",
    sandboxUsable: true,
  };
}

const capabilityCache = new Map<string, Promise<SandboxCapability>>();

/**
 * Detect once per binary per process and share the promise: every execution
 * asks for this, and the answer cannot change while the process runs.
 */
export function detectSandboxCapability(
  bwrapPath: string,
  options: { timeoutMs?: number } = {},
): Promise<SandboxCapability> {
  let pending = capabilityCache.get(bwrapPath);
  if (!pending) {
    pending = probeSandboxCapability(bwrapPath, options.timeoutMs ?? SANDBOX_PROBE_TIMEOUT_MS);
    capabilityCache.set(bwrapPath, pending);
  }
  return pending;
}

/** Tests only: the cache is keyed by path, which stubs reuse across cases. */
export function resetSandboxCapabilityCache(): void {
  capabilityCache.clear();
}

/**
 * What to check when bubblewrap cannot build any sandbox here. Shared so the
 * launcher preflight and the runner describe this host the same way.
 */
export const SANDBOX_UNUSABLE_HINT = [
  "bubblewrap is installed but cannot create a sandbox on this host.",
  "The Web UI and control API still start; run_python and run_shell will fail.",
  "Check that unprivileged user namespaces are permitted:",
  "  sysctl kernel.unprivileged_userns_clone             # 1 where the knob exists",
  "  sysctl kernel.apparmor_restrict_unprivileged_userns # 0 on Ubuntu 24.04+",
].join("\n");

/**
 * The unusable-sandbox hint plus bubblewrap's own refusal. Never say executions
 * still run here: on this host every tool call fails, so reporting one of the
 * degradations instead would understate the problem.
 */
export function sandboxUnusableMessage(bwrapPath: string, capability: SandboxCapability): string {
  const detail = capability.detail ?? capability.procDetail;
  return `bubblewrap at "${bwrapPath}" could not build a sandbox`
    + `${detail ? `: ${detail}` : "."}\n${SANDBOX_UNUSABLE_HINT}`;
}

/**
 * Why `/proc` was downgraded, worded for an operator. Names the weakening
 * explicitly: a bound `/proc` is not the profile the product ships with.
 */
export function procFallbackMessage(bwrapPath: string, capability: SandboxCapability): string {
  return `bubblewrap at "${bwrapPath}" cannot mount a fresh /proc here: `
    + `${capability.procDetail ?? "the sandbox probe failed with --proc /proc"}. `
    + "Falling back to --ro-bind /proc /proc so executions still run. "
    + "In this weaker profile the sandbox sees the container's /proc — that is, the "
    + "surrounding container's process list — instead of only its own processes. "
    + "Docker's default readonlyPaths/maskedPaths cause this; the supported deployment "
    + "adds security_opt: systempaths=unconfined, which keeps the stronger fresh-procfs "
    + "profile. Do not use privileged to work around it.";
}

/**
 * Why the flag was dropped, worded for an operator. Shared so the launcher and
 * the runner explain the same environment the same way.
 */
export function disableUsernsOmittedMessage(bwrapPath: string, capability: SandboxCapability): string {
  const consequence = "Namespace isolation, seccomp and the mount allowlist still apply, "
    + "but nested user namespaces inside executions are not blocked.";
  if (capability.reason === "option-unknown") {
    return `bubblewrap at "${bwrapPath}" does not support --disable-userns `
      + "(requires bwrap >= 0.8; Ubuntu 22.04 ships 0.6). "
      + `${consequence} Upgrade bubblewrap for the stronger profile.`;
  }
  return `bubblewrap at "${bwrapPath}" supports --disable-userns but cannot use it here: `
    + `${capability.detail ?? "the sandbox probe failed with the option enabled"}. `
    + "This is expected under LXC and container runtimes that mount /proc/sys read-only, "
    + "because the option works by writing user.max_user_namespaces. "
    + `The option is omitted so executions still run. ${consequence}`;
}
