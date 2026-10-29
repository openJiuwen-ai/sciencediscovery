// Backend stack lifecycle: spawn start-stack.mjs with Electron's own
// node runtime, poll the control API health endpoint, stop gracefully.
// spawn arguments and health judgement are pure functions (unit-tested);
// the process plumbing stays thin and behind this module.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { stackEntry } from "./config.ts";

/** Arguments for the stack child process. Pure. */
export function stackArgs(repoRoot: string): { entry: string; args: string[] } {
  return { entry: stackEntry(repoRoot), args: ["--mode", "local", "--no-node-build"] };
}

/** Decide the next poll interval (ms). Pure.
 * A flat fast window (default 250ms) for the first minute — cold
 * starts typically become healthy inside it, and the old 1s→5s backoff was
 * observed adding up to 5s of pure wait after the API was already up
 * (shell.log 07:56:45 api 200 → 07:56:50 next poll). Backoff only kicks in
 * for genuinely slow/wedged stacks (wizard's 1200s window). */
export function nextPollDelayMs(elapsedMs: number, maxMs: number, baseMs = 250): number {
  if (elapsedMs >= maxMs) return -1; // give up
  if (elapsedMs < 60_000) return baseMs;
  return Math.min(baseMs * 2 ** Math.floor((elapsedMs - 60_000) / 10_000), 5000);
}

export interface StackHandle {
  /** Stop the stack: SIGINT first (start-stack killTree), escalate to kill. */
  stop: (timeoutMs?: number) => Promise<void>;
  exited: Promise<number | null>;
  /** Child pid (recorded in wizard-state for crash-resume detection). */
  pid: number | null;
  /** True while the spawned stack process is still alive — lets a retry
   * wait on the previous spawn instead of stacking a second one on the ports. */
  running: () => boolean;
}

/**
 * Spawn the stack detached from the shell's stdio but owned by the shell's
 * process group semantics: on Windows a console-less GUI app cannot send
 * Ctrl-C, so we signal via taskkill /T on the child tree after a grace window.
 */
export function spawnStack(
  execPath: string,
  repoRoot: string,
  extraEnv: NodeJS.ProcessEnv,
  log: (line: string) => void,
): StackHandle {
  const { entry, args } = stackArgs(repoRoot);
  log(`spawning stack: ${execPath} ${entry} ${args.join(" ")}`);
  // ELECTRON_RUN_AS_NODE makes Electron's binary act as plain node (the
  // shell carries its own runtime, clean machines need no node).
  const child: ChildProcess = spawn(execPath, [entry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", d => log(`[stack] ${String(d).trimEnd()}`));
  child.stderr?.on("data", d => log(`[stack:err] ${String(d).trimEnd()}`));
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  let stopping = false;
  return {
    exited,
    pid: child.pid ?? null,
    running: () => child.exitCode === null && child.signalCode === null,
    async stop(timeoutMs = 15_000) {
      if (stopping) return;
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // start-stack.mjs installs SIGINT/SIGTERM handlers that killTree the whole
      // stack. A GUI app has no console to signal, so use taskkill /T: it
      // terminates the process tree, and each service's own cleanup runs.
      const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      await new Promise<number | null>(resolve => kill.once("exit", code => resolve(code)));
      const done = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), timeoutMs))]);
      if (!done && child.pid) {
        log("stack did not exit in time; already force-killed by taskkill /T");
      }
    },
  };
}

/**
 * Kill a stack process tree by pid. The wizard records the stack it
 * spawns; when a later run gives up waiting on that recorded spawn it must
 * also reap it, or the zombie keeps its epoch ports and data-dir locks while
 * every retry shifts epochs and stacks another one on top (observed in the
 * field: an epoch-0 zombie, "Cannot bind the ports", memory-graph log
 * rotation PermissionError storm).
 */
export async function killStackTree(pid: number, log: (line: string) => void): Promise<void> {
  log(`killing stack tree pid ${pid} (taskkill /T /F)`);
  const kill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  await new Promise<number | null>(resolve => kill.once("exit", code => resolve(code)));
}

/**
 * Staged backend-ready budgets for the daily (non-wizard) startup path.
 * Field data (a fresh-install cold start): cold start measured 2:23 with
 * JiuwenSwarm alone at 101s, while the old flat 120s budget timed out and
 * misrouted the window to the auth fallback page. First run keeps the
 * wizard's provisioning budget (1200s); a plain cold start gets 600s. SD_SHELL_STARTUP_TIMEOUT_MS (ms, > 0) overrides both — test hook so
 * a packaged build can exercise the timeout path without waiting minutes.
 * Pure.
 */
export const PROVISIONING_BACKEND_TIMEOUT_MS = 1_200_000;
export const COLD_BACKEND_TIMEOUT_MS = 600_000;

export function startupBudgetMs(provisioning: boolean, env: { SD_SHELL_STARTUP_TIMEOUT_MS?: string | undefined } = process.env): number {
  const override = Number(env.SD_SHELL_STARTUP_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return provisioning ? PROVISIONING_BACKEND_TIMEOUT_MS : COLD_BACKEND_TIMEOUT_MS;
}

/** Poll healthUrl until 200 or timeout. Pure decision, thin IO. */
export async function waitHealthy(
  url: string,
  maxMs: number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      // The API's /api/health bounds its own work (component checks
      // race short deadlines), but a loaded machine can still take seconds to
      // answer. The old 3s per-poll timeout aborted before a 5s runner-timeout
      // answer arrived, so a wedged dependency looked like a dead backend and
      // the wizard timed out forever. Keep the client budget comfortably above
      // the server's worst-case answer time.
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    const delay = nextPollDelayMs(Date.now() - start, maxMs);
    if (delay < 0) return false;
    await new Promise(r => setTimeout(r, delay));
  }
}

/**
 * Outcome of waiting for a spawned stack. `exited` means the
 * start-stack process died before the API ever turned healthy — fail-fast
 * material, not a timeout.
 */
export type HealthyOrExited =
  | { kind: "healthy" }
  | { kind: "timeout" }
  | { kind: "exited"; code: number | null };

/**
 * Race the health poll against the stack process exiting. A dead
 * start-stack (fail-fast on any service error) never binds the health port,
 * so a pure health poll burns the whole budget (wizard: 1200s of frozen
 * "step 8" with zero feedback). On exit, one final cheap probe closes the
 * simultaneous-ready race before reporting failure.
 */
export async function waitHealthyOrExited(
  handle: Pick<StackHandle, "exited">,
  url: string,
  maxMs: number,
  fetchImpl: typeof fetch,
): Promise<HealthyOrExited> {
  const result = await Promise.race<HealthyOrExited>([
    waitHealthy(url, maxMs, fetchImpl).then(ok => (ok ? { kind: "healthy" } : { kind: "timeout" })),
    handle.exited.then(code => ({ kind: "exited", code })),
  ]);
  if (result.kind === "exited" && await waitHealthy(url, 1_500, fetchImpl)) {
    return { kind: "healthy" };
  }
  return result;
}

/**
 * Human message for a stack that died before becoming healthy.
 * start-stack's fail() prints its reason to stderr, so the last few lines
 * are the most specific thing we can surface. Pure.
 *
 * The tail grew to 8 — the port-conflict report is one line per conflicted
 * port (up to 5) plus a bilingual guidance line, and the wizard must show
 * every named occupant, not just the last one.
 */
export function summarizeStackFailure(exitCode: number | null, errLines: string[]): string {
  const tail = errLines.map(l => l.trim()).filter(Boolean).slice(-8);
  const reason = tail.length ? `：${tail.join(" ｜ ")}` : "（start-stack 无错误输出，请打开日志查看）";
  return `后端启动进程提前退出（退出码 ${exitCode ?? "未知"}）${reason}`;
}
