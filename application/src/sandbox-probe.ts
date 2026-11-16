// Seatbelt self-probe (B2-1, D2 §8): decides whether this macOS can run the
// sandboxed execution path at all, BEFORE the wizard lets the user into the
// main UI. Upstream red line: a failed probe must not pass go (fail-closed).
//
// Layering follows the shell's established split (F12 philosophy, proven
// across B1): the DECISION is pure (exit code + signal → verdict, with the
// reason string the error page will show), and the IO is one thin spawn
// that any test can fake. Nothing imports Electron here.
//
// The probe runs sandbox-exec with a minimal allow-default profile against
// /usr/bin/true: success proves both that the binary exists and that the
// kernel accepted a profile compile — the same machinery the payload's
// runner (services/runner seatbelt.ts) uses per task. MDM-controlled Macs
// and nested virtualization can break one or both; those users get the
// error page instead of a mid-run surprise.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Minimal profile: version header + allow default (no deny rules). */
export const SEATBELT_PROBE_PROFILE = "(version 1)(allow default)";

/** The target /usr/bin/true — exists on every macOS since time began. */
export const SEATBELT_PROBE_TARGET = "/usr/bin/true";

/** Spawn-contract type: everything the decision needs, faked in tests. */
export interface SeatbeltProbeOutcome {
  /** Exit code (null when killed by a signal). */
  code: number | null;
  /** Signal that killed the process, if any (e.g. "SIGKILL"). */
  signal: NodeJS.Signals | null;
  /** True when spawn itself failed (ENOENT: no sandbox-exec on PATH). */
  spawnError?: string;
}

/** Machine-readable failure shape (review follow-up): the shell passes this
 *  to the error page, which renders its copy per locale from `failCode` +
 *  `signal`/`exitCode`/`spawnError`. The zh `reason` stays on the verdict as
 *  the log line and the no-JS/static fallback — the page's EN dictionary is
 *  keyed by `failCode`, never by translating that string. */
export type SeatbeltFailCode = "spawn-error" | "signal" | "exit-code";

export interface SeatbeltFailureDetail {
  failCode: SeatbeltFailCode;
  /** Set when failCode === "signal" (the signal that killed the probe). */
  signal?: NodeJS.Signals;
  /** Set when failCode === "exit-code" (sandbox-exec's non-zero exit). */
  exitCode?: number;
  /** The spawn error message when failCode === "spawn-error". */
  spawnError?: string;
}

export type SeatbeltVerdict =
  | { kind: "ok"; platform: "darwin" }
  | { kind: "failed"; platform: "darwin"; reason: string; diagnostics: string[]; detail: SeatbeltFailureDetail }
  | { kind: "not-applicable"; platform: "win32" | "linux" };

/**
 * Pure decision over a probe outcome (and the platform, so win32/linux
 * short-circuit without ever spawning). The reason strings are the
 * user-facing copy for the B2-2 error page; diagnostics are the commands
 * the page suggests the user runs.
 */
export function interpretSeatbeltProbe(
  outcome: SeatbeltProbeOutcome,
  platform: NodeJS.Platform,
): SeatbeltVerdict {
  if (platform !== "darwin") {
    // Windows has no Seatbelt and no fail-closed contract (Provider A runs
    // unsandboxed by design — SCIENCE_AGENT_EVOLVE_UNISOLATED, B1-4); Linux
    // is a dev-only host. Neither wizard ever shows this check.
    return { kind: "not-applicable", platform: platform as "win32" | "linux" };
  }
  if (outcome.spawnError) {
    return {
      kind: "failed",
      platform: "darwin",
      reason:
        "未检测到 macOS 沙箱（Seatbelt）：找不到 sandbox-exec 命令。SD 桌面版必须在沙箱内运行代码，无法继续。",
      diagnostics: [
        "ls -l /usr/bin/sandbox-exec   # 检查命令是否存在",
        "sudo profiles status -all     # 查看是否有 MDM 下发的受限配置（建议联系管理员）",
      ],
      detail: { failCode: "spawn-error", spawnError: outcome.spawnError },
    };
  }
  if (outcome.code === 0) return { kind: "ok", platform: "darwin" };
  if (outcome.code === null && outcome.signal) {
    return {
      kind: "failed",
      platform: "darwin",
      reason: `沙箱探测进程被 ${outcome.signal} 信号终止，无法确认 Seatbelt 可用。SD 桌面版必须在沙箱内运行代码，无法继续。`,
      diagnostics: [
        "ls -l /usr/bin/sandbox-exec   # 检查命令是否存在",
        "sudo profiles status -all     # 查看是否有 MDM 下发的受限配置（建议联系管理员）",
      ],
      detail: { failCode: "signal", signal: outcome.signal },
    };
  }
  return {
    kind: "failed",
    platform: "darwin",
    reason: `沙箱探测失败（sandbox-exec 退出码 ${outcome.code}）。在 MDM 受控或嵌套虚拟化环境中 Seatbelt 可能被禁用。SD 桌面版必须在沙箱内运行代码，无法继续。`,
    diagnostics: [
      "sandbox-exec -p '(version 1)(allow default)' /usr/bin/true   # 手动复现探测",
      "sudo profiles status -all     # 查看是否有 MDM 下发的受限配置（建议联系管理员）",
    ],
    detail: { failCode: "exit-code", exitCode: outcome.code ?? undefined },
  };
}

/** Minimal spawn shape the thin IO needs (tests fake this). */
export type ProbeSpawn = (command: string, args: string[])
  => Pick<ChildProcessWithoutNullStreams, "on">;

/**
 * F12: the probe must never hang the startup gate. A wedged sandbox-exec
 * (MDM-controlled kernel, nested virtualization weirdness) can fire
 * neither close nor error — without this ceiling the fail-closed gate
 * would wait forever with no UI. On timeout the verdict is the same as a
 * killed probe: signal SIGKILL, fail-closed.
 */
export const SEATBELT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Thin IO: run the actual sandbox-exec probe. The spawn function is
 * injectable so tests never touch a real sandbox-exec (the agent sandbox
 * itself denies sandbox-exec — exit 71 — which would fake a "failed"
 * verdict on every dev machine; B1-3 documented the same trap for
 * process-group signals).
 */
export async function runSeatbeltProbe(
  platform: NodeJS.Platform,
  spawnImpl: ProbeSpawn,
  timeoutMs: number = SEATBELT_PROBE_TIMEOUT_MS,
  timerSetTimeout: typeof setTimeout = setTimeout,
  timerClearTimeout: typeof clearTimeout = clearTimeout,
): Promise<SeatbeltVerdict> {
  // Non-darwin short-circuits BEFORE spawning (and before any outcome
  // matters): the verdict is platform-only there.
  if (platform !== "darwin") return interpretSeatbeltProbe({ code: 0, signal: null }, platform);
  return new Promise<SeatbeltVerdict>((resolve) => {
    let settled = false;
    let child: ReturnType<ProbeSpawn> | null = null;
    const finish = (outcome: SeatbeltProbeOutcome) => {
      if (!settled) {
        settled = true;
        if (timer) timerClearTimeout(timer);
        resolve(interpretSeatbeltProbe(outcome, platform));
      }
    };
    const timer = timeoutMs > 0
      ? timerSetTimeout(() => {
          // F12: wedged probe — the same verdict shape as a killed one;
          // also kill the child so it cannot linger holding resources.
          const c = child;
          if (c && typeof (c as { kill?: unknown }).kill === "function") {
            try { (c as unknown as { kill: (sig?: NodeJS.Signals) => void }).kill("SIGKILL"); } catch { /* already gone */ }
          }
          finish({ code: null, signal: "SIGKILL" });
        }, timeoutMs)
      : null;
    try {
      child = spawnImpl("sandbox-exec", [
        "-p", SEATBELT_PROBE_PROFILE, SEATBELT_PROBE_TARGET,
      ]);
      child.on("error", (err: NodeJS.ErrnoException) =>
        finish({ code: null, signal: null, spawnError: err.message }));
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
        finish({ code, signal }));
    } catch (err) {
      // Synchronous spawn throw (bad args / no child_process module) —
      // treated as a spawn failure, never as "available".
      finish({ code: null, signal: null, spawnError: String(err) });
    }
  });
}

/**
 * The startup gate's own decision (review F1 fix): what the main process
 * does with a verdict BEFORE any UI loads. Pure — the caller (main.ts
 * startupFlow) only performs the returned instruction. "failed" means the
 * fail-closed error page REPLACES the session (the SPA is never loaded);
 * every other verdict (ok / not-applicable) lets the startup continue.
 */
export type SeatbeltGateDecision =
  | { action: "block"; page: "seatbelt-error.html"; reason: string; diagnostics: string[]; detail: SeatbeltFailureDetail }
  | { action: "continue" };

export function seatbeltGateDecision(verdict: SeatbeltVerdict): SeatbeltGateDecision {
  if (verdict.kind === "failed") {
    return {
      action: "block",
      page: "seatbelt-error.html",
      reason: verdict.reason,
      diagnostics: verdict.diagnostics,
      detail: verdict.detail,
    };
  }
  return { action: "continue" };
}

/**
 * The query string the fail-closed error page reads (URLSearchParams
 * round-trip; the page JSON.parses `diagnostics`). Pure so tests can pin
 * the contract without loading Electron. `failCode`/`signal`/`exitCode`
 * are the page's i18n keys (review follow-up): the page's EN dictionary is
 * keyed by `failCode` rather than translating the zh `reason` string.
 *
 * `locale` (F13): the page is a file:// origin and cannot read the SPA's
 * http://127.0.0.1 localStorage — the shell passes the SPA's persisted
 * choice explicitly. `?lang=` from a QA harness still wins on the page.
 */
export function seatbeltErrorPageQuery(
  decision: Extract<SeatbeltGateDecision, { action: "block" }>,
  locale?: "zh-CN" | "en" | null,
): string {
  return new URLSearchParams({
    reason: decision.reason,
    diagnostics: JSON.stringify(decision.diagnostics),
    failCode: decision.detail.failCode,
    ...(decision.detail.signal !== undefined ? { signal: decision.detail.signal } : {}),
    ...(decision.detail.exitCode !== undefined ? { exitCode: String(decision.detail.exitCode) } : {}),
    ...(locale ? { lang: locale === "en" ? "en" : "zh" } : {}),
  }).toString();
}
