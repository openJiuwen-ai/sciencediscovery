// Backend stack lifecycle: spawn start-stack.mjs with Electron's own
// node runtime, poll the control API health endpoint, stop gracefully.
// spawn arguments and health judgement are pure functions (unit-tested);
// the process plumbing stays thin and behind this module.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { stackEntry } from "./config.ts";
import { IS_DARWIN } from "./shell-platform.ts";

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
 * Ctrl-C, so we signal via taskkill /T on the child tree after a grace
 * window. On darwin the child gets its own process group (detached) so a
 * wedged group can later be killed with kill(-pid) wholesale.
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
    // darwin: own process group — stop() can then SIGTERM the leader (its
    // handler killTrees the whole stack) and, if the grace window runs
    // out, SIGKILL the group without orphaning grandchildren.
    detached: IS_DARWIN,
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
      // stack. A GUI app has no console to signal, so win32 uses taskkill /T: it
      // terminates the process tree (/F is TerminateProcess — no handler runs,
      // which is why start-stack.mjs also restores a leftover uv.lock.stack-backup
      // on its next entry). darwin SIGTERMs the group leader instead: its handler
      // cleans up the whole stack (start-stack.mjs L350-351), and the grace
      // window below SIGKILLs the process group if it runs out.
      if (!IS_DARWIN) {
        const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        await new Promise<number | null>(resolve => kill.once("exit", code => resolve(code)));
      } else if (child.pid) {
        try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      const done = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), timeoutMs))]);
      if (!done && child.pid) {
        if (IS_DARWIN) {
          log("stack did not exit after SIGTERM within the grace window; SIGKILLing the process group");
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
        } else {
          log("stack did not exit in time; already force-killed by taskkill /T");
        }
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
  if (IS_DARWIN) {
    // Group kill (negative pid): the recorded spawn was made detached, so it
    // leads its own process group. ESRCH = group already gone — the zombie
    // we were asked to reap died on its own; not an error.
    log(`killing stack tree pid ${pid} (SIGKILL process group)`);
    try { process.kill(-pid, "SIGKILL"); } catch { /* group already gone */ }
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* leader already gone */ }
    return;
  }
  log(`killing stack tree pid ${pid} (taskkill /T /F)`);
  const kill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  await new Promise<number | null>(resolve => kill.once("exit", code => resolve(code)));
}

/**
 * Parse `netstat -ano -p tcp` output for the LISTENING pid on an EXACT
 * port. Pure (F17): a substring `:4410` would also match `:44100` /
 * `:14410` lines, and a false hit feeds taskkill /T /F an unrelated
 * process tree — so the Local Address column is split and the port
 * compared numerically. Columns: Proto | Local | Foreign | State | PID.
 */
export function parseNetstatPid(netstatOutput: string, healthPort: number): number | null {
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/LISTENING/i.test(cols[3] ?? "")) continue;
    const local = cols[1] ?? "";
    const port = local.slice(local.lastIndexOf(":") + 1);
    if (Number(port) === healthPort) {
      const found = parseInt(cols[4] ?? "", 10);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Stop a backend stack this shell did NOT spawn (F9: reused via
 * ensureBackend when the previous session's stack survived). The shell
 * holds no handle, so the pid is discovered from the stack's own health
 * port (lsof on darwin, netstat on win32) and the same tree-kill is
 * applied. Best-effort: if the pid cannot be discovered the caller still
 * proceeds — the swap then races a backend that answered health a moment
 * ago, which is the pre-F9 status quo, not a new failure mode.
 */
export async function stopExternalStack(
  healthPort: number,
  log: (line: string) => void,
): Promise<void> {
  let pid: number | null = null;
  if (IS_DARWIN) {
    const out = spawnSync("lsof", ["-ti", `tcp:${healthPort}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    pid = parseInt((out.stdout ?? "").trim().split(/\s+/)[0] ?? "", 10) || null;
  } else {
    const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    pid = parseNetstatPid(out.stdout ?? "", healthPort);
  }
  if (!pid) {
    log(`external stack: no pid found listening on ${healthPort}; nothing to stop`);
    return;
  }
  await killStackTree(pid, log);
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
  while (true) {
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
