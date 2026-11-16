// Auto-update (B4-3, D4 §5 — inherits the Windows-side F11 conservative
// policy, mac carrier differences live inside electron-updater itself):
// check at startup (delayed past the cold start) + every 6h; PROMPT ONLY —
// the user confirms the download (cancellable); install goes through the
// drain gate (running tasks finished, stack stopped); NEVER a silent
// background upgrade. The update-source URL is frozen by the publish
// section of electron-builder.yml (B4-2) — electron-updater reads it from
// the app's own embedded publish config; nothing here names a URL.
//
// Decision logic is pure and unit-tested (updatePolicy / nextCheckDelayMs /
// shouldPromptForUpdate / drainGateVerdict); the electron-updater plumbing
// stays a thin IO layer behind setupAutoUpdate().

import type { App } from "electron";

/** Policy constants (F11: conservative). Pure. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
export const UPDATE_FIRST_CHECK_DELAY_MS = 30_000; // past the cold start
/** How long the "update available" prompt stays valid before it auto-expires
 * (the user ignored it — the next periodic check re-prompts anyway). */
export const UPDATE_PROMPT_TTL_MS = 60 * 60 * 1000; // 1h

export interface UpdatePolicy {
  intervalMs: number;
  firstDelayMs: number;
  promptTtlMs: number;
}

/** The effective policy. Pure. */
export function updatePolicy(): UpdatePolicy {
  return {
    intervalMs: UPDATE_CHECK_INTERVAL_MS,
    firstDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
    promptTtlMs: UPDATE_PROMPT_TTL_MS,
  };
}

/** Decide whether a found update should prompt. Pure.
 * F11: only prompt, never auto-download. A skipped version re-prompts on
 * the next periodic check (no nag loop inside one interval). */
export function shouldPromptForUpdate(
  currentVersion: string,
  updateVersion: string | null | undefined,
): boolean {
  if (!updateVersion) return false;
  // electron-updater already applies semver ordering before emitting
  // update-available; a defensive equality guard keeps a same-version
  // feed glitch from prompting (D4 §5: no phantom prompts).
  return updateVersion !== currentVersion;
}

/** Verdict of the pre-install drain gate (F19排水 inherited by F11).
 * Pure. */
export type DrainVerdict =
  | { ok: true }
  | { ok: false; reason: "stack-running" | "stack-stopping" };

/**
 * Evaluate the drain gate before installing an update.
 * Pure.
 *
 * @param stackState null = no stack ever spawned this session;
 *                   "running" = stack handle alive;
 *                   "stopping" = stop() in flight.
 */
export function drainGateVerdict(stackState: "none" | "running" | "stopping"): DrainVerdict {
  if (stackState === "running") {
    // F19: wait for running tasks to finish + child tree confirmed gone
    // BEFORE installing. The stack is a whole process tree (python workers
    // writing to the data dir) — swapping the .app / running the installer
    // under it risks corrupted state.
    return { ok: false, reason: "stack-running" };
  }
  if (stackState === "stopping") return { ok: false, reason: "stack-stopping" };
  return { ok: true };
}

/** The user-facing drain-gate message. Pure. */
export function drainGateMessage(verdict: DrainVerdict): string | null {
  if (verdict.ok) return null;
  if (verdict.reason === "stack-running") {
    return "The backend is still running. Finish or stop the running tasks first — the update installs only after the backend has fully stopped.";
  }
  return "The backend is still shutting down. The update will continue once it has fully stopped.";
}

/** Compute the next check delay. Pure.
 * The FIRST check is delayed past the cold start; every subsequent check
 * runs on the flat interval regardless of wall-clock drift (a check that
 * fired late must not cascade the lateness). */
export function nextCheckDelayMs(hasCheckedAlready: boolean, policy: UpdatePolicy): number {
  return hasCheckedAlready ? policy.intervalMs : policy.firstDelayMs;
}

/** Whether auto-update is active in this process at all. Pure.
 * Dev builds must not hit the update feed (version is a placeholder);
 * packaged builds on both platforms update (win: NSIS, mac: zip — the
 * carrier difference is electron-updater's own business, D4 §5). */
export function updateEnabled(isPackaged: boolean): boolean {
  return isPackaged;
}

/** Read the app's stack state for the drain gate from main.ts-owned data.
 * Pure adapter (main.ts supplies the raw facts). */
export function stackStateFrom(
  hasHandle: boolean,
  stopInFlight: boolean,
): "none" | "running" | "stopping" {
  if (!hasHandle) return "none";
  return stopInFlight ? "stopping" : "running";
}

export interface AutoUpdaterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // allowPrerelease / channel left default: the release feed is stable-only
  // (electron-builder.yml releaseType draft + latest channel).
}

/** Wiring options for setupAutoUpdate (the thin IO layer). */
export interface SetupOptions {
  app: App;
  autoUpdater: AutoUpdaterLike;
  /** Main-process logger (goes to the shell log). */
  log: (line: string) => void;
  /** Prompt the user; resolves true when they confirmed the download. */
  prompt: (version: string) => Promise<boolean>;
  /** Notify the user of progress / completion / errors (fire-and-forget). */
  notify: (kind: "downloading" | "ready" | "error" | "drain-blocked", detail: string) => void;
  /** Facts for the drain gate, supplied by main.ts. */
  stackFacts: () => { hasHandle: boolean; stopInFlight: boolean };
  /** Stop the stack (drain gate passes only when it resolves). */
  stopStack: () => Promise<void>;
  /** Timer factories (injectable for tests; must be a matched pair). */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** Dialog/UI hook shown when the drain gate blocks install. */
  onDrainBlocked?: (message: string) => void;
  /** F15: called when the user DISMISSED the drain-blocked dialog without
   *  choosing "stop and install" (e.g. 「暂不安装」). The pending install
   *  is dropped so periodic checks resume — otherwise "blocked" silently
   *  became "never check again this session". The updater clears the flag
   *  itself; the hook exists so main.ts can log/react to the dismissal. */
  onDrainDismissed?: () => void;
  /** F15: register a callback the drain-blocked dialog calls when the user
   *  dismisses it — drops the pending install (periodic checks resume).
   *  Same plumbing pattern as registerDrainRetry: main.ts holds the
   *  reference; the updater never imports main. */
  registerDrainDismiss?: (dismiss: () => void) => void;
  /** F8: receives the re-entry hook the drain-blocked dialog calls when
   *  the user chooses "stop and install" — it reruns stopStack + the
   *  visible install for a PENDING (gate-blocked) update. Pure plumbing:
   *  main.ts holds the reference; the updater never imports main. */
  registerDrainRetry?: (retry: () => void) => void;
}

/**
 * Wire the F11 conservative update flow. Thin IO.
 *
 * Flow: (startup + interval) → checkForUpdates → [update-available] →
 * prompt (NOT auto-download) → downloadUpdate → [update-downloaded] →
 * drain gate → stopStack → quitAndInstall(false, true).
 * The non-silent quitAndInstall keeps the user's eyes on the restart —
 * "never silent" applies to the whole journey, not just the download.
 */
export function setupAutoUpdate(opts: SetupOptions): void {
  const { app, autoUpdater, log } = opts;
  const setTimeoutImpl = opts.setTimeout ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeout ?? clearTimeout;
  const policy = updatePolicy();

  // F11: never silent — both automatic knobs OFF. The only path to install
  // is the user confirming the prompt, then the drain gate, then an
  // explicit (visible) quitAndInstall.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let checkTimer: ReturnType<typeof setTimeoutImpl> | null = null;
  let hasCheckedAlready = false;
  let promptedVersion: string | null = null;
  let promptExpiresAt = 0;
  let downloadInFlight = false;
  // F8: a downloaded update that the drain gate blocked stays pending —
  // "blocked" must mean "install after the backend stops", not "never".
  // The onDrainBlocked hook offers the user that path; stopStackThenInstall
  // is the single door to the visible install for both gate-pass and
  // gate-blocked-then-drained paths.
  let pendingInstall = false;

  const scheduleNext = (): void => {
    const delay = nextCheckDelayMs(hasCheckedAlready, policy);
    checkTimer = setTimeoutImpl(runCheck, delay);
  };

  const stopStackThenInstall = (): void => {
    void opts.stopStack().then(() => {
      // Non-silent install: visible restart, per "never silent". The drain
      // gate already passed (or the user just chose to stop the backend);
      // stopStack resolves only after the child tree is confirmed gone,
      // so the swap cannot race a live python worker.
      pendingInstall = false;
      autoUpdater.quitAndInstall(false, true);
    });
  };

  // F8: the drain-blocked dialog's "stop and install" lands here — a
  // pending install exists (the gate blocked it), so rerun the same
  // stopStack → visible install sequence. Guarded: with nothing pending
  // this is a no-op (a stale dialog click must not install anything).
  opts.registerDrainRetry?.(() => {
    if (!pendingInstall) return;
    log("update: drain retry — stopping the backend, then installing");
    stopStackThenInstall();
  });

  // F15: the "not now" branch of the drain-blocked dialog. Dropping the
  // pending install is what lets runCheck stop short-circuiting — the next
  // 6h check re-finds the update and re-offers it. Without this, a single
  // "暂不安装" click froze update checks for the whole session.
  opts.registerDrainDismiss?.(() => {
    if (!pendingInstall) return;
    log("update: user dismissed the drain-blocked dialog — pending install dropped, periodic checks resume");
    pendingInstall = false;
    opts.onDrainDismissed?.();
  });

  const runCheck = (): void => {
    hasCheckedAlready = true;
    if (downloadInFlight || pendingInstall) { scheduleNext(); return; }
    autoUpdater.checkForUpdates().catch(err => {
      // A failed check is normal offline behaviour — log, never nag.
      log(`update check failed: ${String(err)}`);
    });
    scheduleNext();
  };

  autoUpdater.on("update-available", (info: unknown) => {
    const version = (info as { version?: string } | undefined)?.version ?? null;
    if (!version) return;
    if (!shouldPromptForUpdate(app.getVersion(), version)) return;
    // Respect a still-valid earlier prompt for the same version (the
    // interval re-fired while the user is still deciding).
    const samePending = promptedVersion === version && Date.now() < promptExpiresAt;
    if (samePending) return;
    promptedVersion = version;
    promptExpiresAt = Date.now() + policy.promptTtlMs;
    void opts.prompt(version).then(confirmed => {
      promptExpiresAt = 0;
      if (!confirmed) {
        log(`update ${version}: declined — will re-offer on the next check`);
        return;
      }
      if (downloadInFlight || pendingInstall) return;
      downloadInFlight = true;
      opts.notify("downloading", version);
      autoUpdater.downloadUpdate().catch(err => {
        downloadInFlight = false;
        opts.notify("error", String(err));
      });
    });
  });

  autoUpdater.on("update-not-available", () => {
    // Quiet: no notification for "you are up to date" (F11: prompt only
    // when there is something to decide).
  });

  // F14: the real electron-updater event is "update-downloaded" (exports
  // .UPDATE_DOWNLOADED in electron-updater/out/types.js). "download-complete"
  // is NOT an UpdaterEvents member — the handler never ran in production,
  // which is exactly the kind of thing a fake updater cannot catch (its
  // fire() takes any string), so the name is now pinned by the test that
  // asserts the exact UpdaterEvents set.
  autoUpdater.on("update-downloaded", () => {
    downloadInFlight = false;
    // Drain gate BEFORE install (F19 inheritance).
    const facts = opts.stackFacts();
    const verdict = drainGateVerdict(stackStateFrom(facts.hasHandle, facts.stopInFlight));
    if (!verdict.ok) {
      const msg = drainGateMessage(verdict)!;
      log(`update ready but drain gate blocked: ${verdict.reason}`);
      pendingInstall = true;
      opts.notify("drain-blocked", msg);
      // F8: "blocked" must not be a dead end. The hook (main.ts) offers
      // "stop the backend and install now". F15: if the user DISMISSES
      // that offer, onDrainDismissed drops the pending install so the
      // periodic checks (and re-prompts) resume instead of silently
      // freezing for the rest of the session.
      opts.onDrainBlocked?.(msg);
      return;
    }
    opts.notify("ready", app.getVersion());
    stopStackThenInstall();
  });

  autoUpdater.on("error", (err: unknown) => {
    log(`updater error: ${String(err)}`);
  });

  app.on("will-quit", () => {
    if (checkTimer !== null) clearTimeoutImpl(checkTimer);
  });

  // Startup check delayed past the cold start (bandwidth contention with
  // the backend's first-boot provisioning would be user-visible).
  scheduleNext();
  log(`auto-update armed (first check in ${Math.round(policy.firstDelayMs / 1000)}s, then every ${Math.round(policy.intervalMs / 3_600_000)}h; prompts only, never silent)`);
}
