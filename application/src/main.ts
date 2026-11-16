// sd-shell main process — window / stack lifecycle / menu+tray / port epochs
// + system proxy mirroring / first-run wizard (data dir → model config →
// self-check gate). Behaviour decisions: wizard steps (the model key is
// submitted once through the backend API and never persisted by the shell),
// token invisible to the user (401 → token-entry fallback page), and close
// hides to tray (real quit via tray menu — the full running-task
// confirmation drain is out of scope for this feature).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell as electronShell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join, basename } from "node:path";
import { bootstrapPackaged, needsUnpack, packagedEnv, packagedPaths, type PackagedPaths } from "./bootstrap.ts";
import { healthUrl, resolveDataDir, resolveRepoRoot, tokenFilePath, uiUrl } from "./config.ts";
import {
  darwinRoleMenu, IS_DARWIN, shellLogDirFor, shouldInstallRoleMenu, shouldQuitOnAllWindowsClosed, wantsTray,
} from "./shell-platform.ts";
import { FIRST_CHAT_WARMUP_PATH, runFirstChatWarmup } from "./first-chat-warmup.ts";
import { provisioningLineToStage, STAGE_TEXTS, stackLineToStage, stageProgress } from "./loading-stage.ts";
import {
  epochFromEnv, firstFreeEpoch, healthUrlForPorts, MAX_PORT_EPOCH,
  portsForEpoch, probeHealthyEpoch, stackEnvForPorts, uiUrlForPorts, type StackPorts,
} from "./ports.ts";
import { parseRegDword, parseRegQueryValue, parseScutilProxy, proxyEnvFromSystem, type SystemProxySettings as SystemProxySettingsT } from "./proxy.ts";
import { uninstallFootprints, type DataFootprint } from "./uninstall-data.ts";
import { COLD_BACKEND_TIMEOUT_MS, killStackTree, spawnStack, startupBudgetMs, stopExternalStack, summarizeStackFailure, waitHealthy, waitHealthyOrExited, type StackHandle } from "./stack.ts";
import { shouldRetryUiLoad, UI_LOAD_RETRY_LIMIT, uiLoadRetryDelayMs, waitForUiOrigin } from "./ui-retry.ts";
import { loadWindowState, saveWindowState } from "./window-state.ts";
import { loadExportState, saveExportState } from "./export-state.ts";
import { ExportDestinations } from "./export-tokens.ts";
import { ExportHistoryStore } from "./export-history.ts";
import {
  effectiveDataDir, loadWizardState, needsWizard, pidAlive, saveWizardState, type WizardState,
} from "./wizard-state.ts";
import { defaultDataDir, probeDataDir } from "./wizard-data-dir.ts";
import {
  runSelfCheck,
} from "./wizard-api.ts";
import { runSeatbeltProbe, seatbeltGateDecision, seatbeltErrorPageQuery, type SeatbeltVerdict } from "./sandbox-probe.ts";
import { setupAutoUpdate, updateEnabled } from "./updater.ts";
import { type AgentInfo } from "./agent-ready.ts";
// electron-updater exports a PLATFORM SINGLETON (NsisUpdater on win /
// MacUpdater on darwin) — use it as-is, never `new`. esbuild bundles this
// CJS package into the main.cjs just fine (pure JS deps: semver/js-yaml/
// fs-extra). The update feed URL comes from the app-embedded publish
// config (electron-builder.yml, B4-2) — nothing here names a URL.
import { autoUpdater } from "electron-updater";

// Bundled as CJS by esbuild: the app path is the shell root in dev (`electron .`).
const shellDir = app.getAppPath();
const distDir = join(shellDir, "dist");
// Packaged layout: <install>\resources\{backend,python,envs-template,...}.
const packagedRoot = app.isPackaged ? process.resourcesPath : null;
const packaged: PackagedPaths | null = packagedRoot ? packagedPaths(packagedRoot) : null;
const log = (line: string): void => {
  console.log(`[sd-shell] ${line}`);
  logToDisk(line);
};
// [SD-PERF instrumentation] 壳侧统一毫秒打点：`[perf]` 前缀沿用既有行格式，
// 事件名对齐 start-stack/jiuwenswarm 侧的 [SD-PERF] 命名（shell-/jw-/stack-
// 三域时间线靠 ISO 时间戳对齐）。移除打点时 git checkout 本文件即可。
const SD_PERF = (event: string, extra = ""): void => {
  log(`[perf] ${event} elapsed=${Date.now() - sdPerfT0}ms${extra ? ` ${extra}` : ""}`);
};
// 模块加载即取 T0 —— 比 appStartAt（whenReady 前一行）更早，覆盖 Electron
// 引导 + 模块 import + 单实例锁的全部耗时。
const sdPerfT0 = Date.now();
SD_PERF("module-load");
/** Fresh-machine provisioning (uv venvs + micromamba) can dwarf the 120s startup budget. */
const WIZARD_BACKEND_TIMEOUT_MS = 1_200_000;
/** Wait for JiuwenSwarm to be reachable through the adapter before loading the
 * main UI; otherwise the user can enter the app and chat fails immediately. */
const AGENT_READY_TIMEOUT_MS = 180_000;

// --- shell log file ------------------------------------------------------------
// GUI processes have no visible console — a colleague's first-run timeout was
// undiagnosable without a log. Every line through log() (incl. start-stack
// output) lands in shell.log; rotation keeps one 5MB backup.
//
// Packaged builds keep shell.log in <install>\logs — the same folder NSIS
// writes install-diagnostics.log into (build/installer.nsh), so one folder
// answers "where are the logs". Dev runs stay on userData (writing into the
// electron dist cache makes no sense). The five backend services keep their
// logs under <dataDir>\logs: those paths are baked into the payload services
// and are not redirected without touching the upstream baseline tree.

const SHELL_LOG_MAX_BYTES = 5 * 1024 * 1024;
let shellLogFile: string | null = null;

function shellLogDir(): string {
  // Platform decision lives in shell-platform.ts (D-mac-01: notarized .app
  // bundles must not write inside the bundle — logs go to ~/Library/Logs).
  return shellLogDirFor(IS_DARWIN ? "darwin" : "win32", app.isPackaged, {
    exe: app.getPath("exe"),
    userData: app.getPath("userData"),
    logs: app.getPath("logs"),
  });
}

/**
 * The install root the data-dir wizard must keep the user's data clear of, or
 * null in dev (where the shell lives in the repo and there is no install dir).
 *
 * This is the directory NSIS's uninstall tail deletes UNCONDITIONALLY
 * (build/installer.nsh customUnInstall → DeleteFastThenHelper "$INSTDIR"), even
 * with "also delete user data" left unticked. The packaged shell exe sits
 * directly in $INSTDIR, so its dirname is that directory — the same reasoning
 * shellLogDir() above already uses for <install>\logs.
 *
 * Without this the two DEFAULTS colliding (problems W16: the old
 * $LOCALAPPDATA\ScienceDiscovery install root was literally defaultDataDir())
 * would only be fixed by the rename, and a user typing the install dir into the
 * wizard would reproduce the same silent data loss.
 */
function installRootForWizard(): string | null {
  return app.isPackaged ? dirname(app.getPath("exe")) : null;
}

function ensureShellLog(): string | null {
  if (shellLogFile) return shellLogFile;
  try {
    const dir = shellLogDir();
    mkdirSync(dir, { recursive: true });
    shellLogFile = join(dir, "shell.log");
    if (existsSync(shellLogFile) && statSync(shellLogFile).size > SHELL_LOG_MAX_BYTES) {
      renameSync(shellLogFile, join(dir, "shell.log.1"));
    }
  } catch {
    shellLogFile = null; // logging must never break the app
  }
  return shellLogFile;
}

function logToDisk(line: string): void {
  try {
    const file = ensureShellLog();
    if (file) appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* console already got it */ }
}

// --- single-instance lock -------------------------------------------------------
// Two shells are not two apps: the port-epoch logic would happily shift the
// second stack onto new ports, and both stacks then contend for the
// JiuwenSwarm gateway instance lock, the runner ledger and the same data dir —
// the user ends up with two windows that are quietly different sessions.
// Standard Electron lock: the second launch exits immediately after asking
// the first instance to surface its window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log("second instance: single-instance lock not acquired; exiting so the first instance stays the only one");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      openMainWindow(); // window was closed to tray → recreate with current content
      return;
    }
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let stack: StackHandle | null = null;
let stackOwnedByShell = false;
/** Data dir the owned stack was spawned with (dir change → stop + respawn). */
let stackDir: string | null = null;
let quitConfirmed = false;
/** Stop() in flight (stack draining) — feeds the updater drain gate. */
let stackStopInFlight = false;
/** F9: a healthy backend this shell did NOT spawn (previous session's
 *  survivor, reused via ensureBackend). The drain gate must treat it as
 *  running; stopping it goes through the stack's own stop path, not a
 *  handle we hold. Cleared when the reuse probe stops finding it. */
let externalStackAlive = false;
/** F8: the updater's drain-retry hook (re-enter stopStack → visible
 *  install for a gate-blocked update), captured so the drain-blocked
 *  dialog's "stop and install" button can call it. */
let drainRetryInstall: (() => void) | null = null;
/** F15: the updater's drain-dismiss hook — drops the pending install so
 * the periodic checks resume after the user picks 「暂不安装」. */
let drainDropPending: (() => void) | null = null;
/** Endpoints of the current run; the save-token IPC handler reloads the UI. */
let currentEndpoints: Endpoints | null = null;
// --- wizard state ---
let wizardMode = false;
/** Wizard state as loaded at startup (used by token paths after the wizard). */
let persistedWizard: WizardState | null = null;
let wizardData: WizardState = { step: "data-dir" };

interface WizardBackendStatus {
  status: "idle" | "starting" | "healthy" | "failed";
  epoch: number | null;
  message?: string;
}
let wizardBackend: WizardBackendStatus = { status: "idle", epoch: null };
/** Data dir the current/last wizard ensure run targets. */
let wizardBackendDir: string | null = null;
/** Monotonic token so a superseded ensure run cannot clobber newer status. */
let wizardEnsureRun = 0;

/** Resolved connection targets for this run (epoch-shiftable). */
interface Endpoints {
  ui: string;
  health: string;
  /** Port epoch the endpoints belong to; null = explicit env URLs. */
  epoch: number | null;
}

function epochEndpoints(epoch: number): Endpoints {
  const p = portsForEpoch(epoch);
  return { ui: uiUrlForPorts(p), health: healthUrlForPorts(p), epoch };
}

function readTokenForDir(dir: string): string | null {
  const explicit = process.env.SD_SHELL_TOKEN?.trim();
  if (explicit) return explicit;
  try {
    const token = readFileSync(tokenFilePath(dir), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function readToken(dataDir?: string | null): string | null {
  const explicit = process.env.SD_SHELL_TOKEN?.trim();
  if (explicit) return explicit;
  const dir = dataDir ?? resolveDataDir(process.env);
  return readTokenForDir(dir);
}

function persistToken(token: string, dataDir?: string | null): boolean {
  const dir = dataDir ?? resolveDataDir(process.env);
  try {
    const file = tokenFilePath(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The SPA's locale choice, mirrored into the shell's world so the
 *  fail-closed page can follow it (review F13: that page is a file://
 *  origin while the SPA is http://127.0.0.1 — localStorage does NOT
 *  cross that boundary, so the page cannot read the SPA's own stored
 *  choice; the shell persists it here and passes it via the page query).
 *  Kept in userData (a shell-owned location), written best-effort. */
let shellLocale: "zh-CN" | "en" | null = null;

function readShellLocale(): "zh-CN" | "en" | null {
  if (shellLocale) return shellLocale;
  try {
    const raw = readFileSync(join(app.getPath("userData"), "locale"), "utf8").trim();
    shellLocale = raw === "en" ? "en" : raw === "zh-CN" ? "zh-CN" : null;
  } catch {
    shellLocale = null;
  }
  return shellLocale;
}

function writeShellLocale(locale: "zh-CN" | "en"): void {
  shellLocale = locale;
  try {
    writeFileSync(join(app.getPath("userData"), "locale"), locale, "utf8");
  } catch {
    // Best-effort mirror: the fail-closed page falls back to
    // navigator.language when this is missing.
  }
}

async function loadUi(endpoints: Endpoints, token: string | null): Promise<void> {
  if (!mainWindow) return;
  // healthy ≠ loadable — the control API's health gate
  // can pass while the ui origin (4310 adapter) has not bound its listener
  // yet, and loading in that gap showed a blank/error page for a few seconds.
  // Probe the ui origin itself first: the local loading page stays on screen
  // until the SPA is actually loadable, so the wizard → loading → model flow
  // has no dead frame between steps. A timeout still loads — the
  // did-fail-load retry remains the backstop.
  const reachable = await waitForUiOrigin(endpoints.ui, 30_000, fetch, (ms) => new Promise((r) => setTimeout(r, ms)), Date.now);
  if (!reachable) log(`loadUi: ui origin not answering within 30s; loading anyway (did-fail-load retry is the backstop)`);
  if (!mainWindow || quitConfirmed) return;
  log(`[perf] loadUi elapsed=${Date.now() - appStartAt}ms`);
  SD_PERF("loadUi-loadURL", `ui=${endpoints.ui}`);
  attachAuthFallback(endpoints);
  // Preload consumes the fragment before page JS runs.
  const target = token ? `${endpoints.ui}/#token=${encodeURIComponent(token)}` : endpoints.ui;
  void mainWindow.loadURL(target);
}

// --- JiuwenSwarm readiness watch after the UI loads --------------------------

let agentWatchTimer: ReturnType<typeof setInterval> | null = null;

// Cache the last pushed state so the renderer can pull it via invoke. The
// very first webContents.send races the renderer's
// ipcRenderer.on registration (preload registers the listener only after the
// page JS runs), so that first "ready:false" can be lost; the renderer now
// calls getJiuwenState once on mount to close the gap.
let lastJiuwenState: JiuwenState | null = null;

function clearAgentWatch(): void {
  if (agentWatchTimer) {
    clearTimeout(agentWatchTimer);
    agentWatchTimer = null;
  }
}

interface JiuwenState {
  ready: boolean;
  elapsed?: number;
  attempt?: number;
  message?: string;
}

/** Poll the adapter's /agent/info and push JiuwenSwarm state to the renderer so
 * the UI can disable chat until the cluster is actually reachable. */
function watchAgentReady(endpoints: Endpoints, dataDir: string | null): void {
  clearAgentWatch();
  const url = `${new URL(endpoints.ui).origin}/agent/info`;
  const token = readToken(dataDir);
  let attempt = 0;
  const start = Date.now();
  const send = (state: JiuwenState) => {
    lastJiuwenState = state;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("sd-shell:jiuwenswarm-state", state);
  };

  send({ ready: false, elapsed: 0, attempt: 0, message: "智能体集群正在启动中…" });

  // A fixed 3s interval kept even a long-ready cluster showing "starting"
  // for 3s+. Two-phase cadence instead: 250ms while the
  // cluster is expected to become ready any moment (covers the common
  // "UI loaded, JiuwenSwarm already up" case in well under a second), then relax to
  // 1s for cold-start tails so we do not hammer the adapter — each probe is
  // a real gateway RPC (models.list), not a cached flag.
  const poll = async () => {
    if (quitConfirmed || !mainWindow || mainWindow.isDestroyed()) {
      clearAgentWatch();
      return;
    }
    try {
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as AgentInfo;
        if (body.jiuwenswarm?.reachable) {
          SD_PERF("AGENT-READY", `watchAttempts=${attempt}`);
          // [first-message-latency] fire-and-forget MCP catalog warmup: the
          // catalog load (stdio spawn + tools/list) overlaps the ready screen
          // instead of the first chat run. Best-effort, off the critical path;
          // failures are logged only and never surface to the user.
          void runFirstChatWarmup(endpoints.ui, token).then(
            (status) => logToDisk(`[warmup] first-chat ${FIRST_CHAT_WARMUP_PATH} -> ${status}`),
            (err: unknown) => logToDisk(`[warmup] first-chat ${FIRST_CHAT_WARMUP_PATH} failed: ${String(err)}`),
          );
          send({ ready: true });
          clearAgentWatch();
          return;
        }
      }
    } catch {
      // Adapter or JiuwenSwarm still booting; keep polling.
    }
    attempt += 1;
    const elapsed = Math.round((Date.now() - start) / 1000);
    send({ ready: false, elapsed, attempt, message: "智能体集群正在启动中…" });
    agentWatchTimer = setTimeout(poll, Date.now() - start < 10_000 ? 250 : 1000);
  };
  void poll();
}

function showFallback(): void {
  if (!mainWindow) return;
  void mainWindow.loadFile(join(distDir, "fallback.html"));
}

// --- loading page ---------------------------------------------------------------

/** Show the local loading page (replaces the blank window during stack start). */
function showLoading(): Promise<void> {
  if (!mainWindow) return Promise.resolve();
  // Each loading page is a fresh progress session — reset the monotonic
  // stage guard (see pushStage).
  maxStageStepShown = 0;
  return mainWindow.loadFile(join(distDir, "loading.html"));
}

/** True while this run is provisioning (unpack + precompile) — widens the step total. */
let provisioningThisRun = false;

/** start-stack's jiuwenswarm sub-step lines (workspace init, patch verify…)
 * can arrive AFTER the api/agent lines when the workspace is slow, bouncing
 * the loading page from 10/10 back to 7/10. Within one loading session
 * stages only move forward. */
let maxStageStepShown = 0;

/** Last stderr lines from the stack this shell spawned. start-stack's
 * fail() prints its reason to stderr, so this tail is what turns a dead
 * stack into a specific failure message instead of a silent 1200s wait.
 * Cleared right before every spawnStack call. */
const stackErrTail: string[] = [];
const STACK_ERR_TAIL_MAX = 12;

/** Push a startup stage to the loading page (no-op once the UI took over).
 * `text` overrides the default stage text (live provisioning sub-progress). */
function pushStage(stage: string, text?: string): void {
  const { current, total, estimateSec } = stageProgress(stage, provisioningThisRun);
  // Monotonic guard (see maxStageStepShown): late-arriving early-stage lines
  // are dropped instead of rewinding the visible progress. current=0 means
  // "unknown stage" — let those through untouched.
  if (current > 0) {
    if (current < maxStageStepShown) return;
    maxStageStepShown = current;
  }
  mainWindow?.webContents.send("sd-shell:loading-stage", {
    stage, text: text ?? STAGE_TEXTS[stage] ?? stage,
    current, total, estimate: estimateText(estimateSec),
    // Raw seconds so the loading page can run a live countdown between
    // pushes (the formatted string above stays for logging/compat).
    estimateSec,
  });
}

/** Format the remaining-seconds estimate for the "step N/M" line. */
function estimateText(sec: number): string {
  if (sec <= 0) return "";
  if (sec < 90) return `约还需 ${sec} 秒`;
  return `约还需 ${Math.round(sec / 60)} 分钟`;
}

/**
 * Wrap a log sink so stack/bootstrap output lines both log (console) and drive
 * the loading page's stage text. Pure parsing lives in loading-stage.ts.
 */
function stageAwareLog(line: string): void {
  log(line);
  // Collect the stack's stderr tail for fast-failure messages.
  if (line.startsWith("[stack:err] ")) {
    const msg = line.slice("[stack:err] ".length).slice(0, 200); // cap runaway tracebacks in the UI
    stackErrTail.push(msg);
    if (stackErrTail.length > STACK_ERR_TAIL_MAX) stackErrTail.shift();
  }
  // Provisioning sub-progress first: its patterns are stricter than
  // stackLineToStage's "first run: precompiled bytecode" catch-all.
  const provisioning = provisioningLineToStage(line);
  if (provisioning) {
    pushStage(provisioning.stage, provisioning.text);
    return;
  }
  const stage = stackLineToStage(line);
  // stage.text enables live sub-progress (e.g. the jiuwenswarm wait-loop lines);
  // for static stack lines it is the same STAGE_TEXTS[stage] pushStage defaults to.
  if (stage) pushStage(stage.stage, stage.text);
}

// --- thin IO (decisions live in ports.ts / proxy.ts) -------------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: 500 });
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(true));
  });
}

/**
 * Bind-semantics port probe for epoch selection. The old connect probe
 * above misjudged two real-world states as "free": a TIME_WAIT leftover
 * (no listener → connect refused, yet bind fails with EADDRINUSE) and a
 * busy machine where connect hit its 500ms timeout — so the shell picked
 * epoch 0 and start-stack's own bind-based fail-fast rejected it seconds
 * later ("adapter 127.0.0.1:4310 occupied by another process", no occupant
 * name because portOccupant only finds LISTENING rows). This mirrors
 * start-stack's portAvailability exactly (scripts/lib/stack-platform.mjs):
 * a port counts as free only when we can actually listen on it, so the
 * epoch auto-shift covers TIME_WAIT leftovers, Windows reserved ranges
 * (EACCES) and live listeners alike. The wizard's crashed-spawn liveness
 * check (anyBound) still uses the connect probe on purpose: there a
 * TIME_WAIT port must NOT read as "the old spawn is alive", or recovery
 * would wait on a ghost.
 */
function isPortBindFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

/** Read the system proxy (win32: HKCU registry; darwin: scutil --proxy).
 * Best-effort: any failure → null. */
async function readSystemProxy(): Promise<SystemProxySettingsT | null> {
  if (IS_DARWIN) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile("scutil", ["--proxy"], { timeout: 5_000 }, (err, stdout) => {
          if (err) reject(err); else resolve(stdout);
        });
      });
      return parseScutilProxy(out);
    } catch {
      return null;
    }
  }
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("reg", ["query", key], { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
    const server = parseRegQueryValue(out, "ProxyServer");
    if (!server) return null;
    return { enabled: parseRegDword(parseRegQueryValue(out, "ProxyEnable")), server };
  } catch {
    return null;
  }
}

/** True when a healthy epoch's API accepts this token (⇒ same data dir). */
async function stackMatchesToken(epoch: number, token: string): Promise<boolean> {
  const apiBase = new URL(healthUrlForPorts(portsForEpoch(epoch))).origin;
  try {
    const res = await fetch(`${apiBase}/api/settings`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Find a running stack bound to our data dir (auth-verified), epoch or null. */
async function findOurStack(token: string | null): Promise<number | null> {
  if (!token) return null;
  for (let epoch = 0; epoch <= MAX_PORT_EPOCH; epoch++) {
    try {
      // The API bounds its health answer, but a degraded stack (e.g. wedged
      // runner) still needs ~2s to answer; an 800ms probe skipped it,
      // forcing a pointless respawn onto occupied ports.
      const res = await fetch(healthUrlForPorts(portsForEpoch(epoch)), {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) continue;
    } catch {
      continue; // not listening on this epoch
    }
    if (await stackMatchesToken(epoch, token)) return epoch;
    log(`epoch ${epoch} healthy but not this data dir; skipping`);
  }
  return null;
}

/**
 * One bounded /api/health probe for diagnostics. Returns a short state line
 * ("HTTP 503 {…}", "HTTP 200 {…}", "unreachable (…)") — used by the wizard
 * timeout path so field logs name the failing stage.
 */
async function probeHealthSnapshot(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const body = await res.json().catch(() => null);
    return `HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 160)}`;
  } catch (error) {
    return `unreachable (${(error as Error).name})`;
  }
}

/**
 * Endpoints for a normal (post-wizard) launch: explicit env URLs win; a
 * pinned SD_SHELL_PORT_EPOCH next; then reuse a running stack — only one
 * verified to run on OUR data dir (a stale dev stack on another dir must
 * not capture the shell). Otherwise the first fully-free epoch.
 */
async function startupEndpoints(dataDir: string | null): Promise<Endpoints> {
  if (process.env.SD_SHELL_UI_URL || process.env.SD_SHELL_HEALTH_URL) {
    return { ui: uiUrl(process.env), health: healthUrl(process.env), epoch: null };
  }
  const pinned = epochFromEnv(process.env);
  if (pinned !== null) return epochEndpoints(pinned);
  if (dataDir) {
    const ours = await findOurStack(readTokenForDir(dataDir));
    if (ours !== null) {
      log(`reusing verified running stack on port epoch ${ours}`);
      return epochEndpoints(ours);
    }
  } else {
    // Legacy dev path (no wizard state): reuse any healthy stack.
    const running = await probeHealthyEpoch(fetch);
    if (running !== null) {
      log(`reusing already-running stack on port epoch ${running}`);
      return epochEndpoints(running);
    }
  }
  // Bind semantics — see isPortBindFree. A TIME_WAIT port must read as busy
  // here or the shell hands start-stack a port the stack's own bind-based
  // fail-fast will reject.
  const free = await firstFreeEpoch(isPortBindFree);
  if (free === null) {
    log(`no free port epoch in 0..${MAX_PORT_EPOCH}; defaulting to epoch 0 and letting the stack report the conflict`);
    return epochEndpoints(0);
  }
  if (free > 0) log(`default port epoch busy; shell will start the stack on epoch ${free}`);
  return epochEndpoints(free);
}

// --- stray-console sweep (belt and suspenders) ---------------------------------
// Win11's default-terminal host gave the packaged first-run a VISIBLE console
// window for the jiuwenswarm entry python (non-deterministic — the
// byte-identical spawn stayed clean in four replications). Prevention is
// primary (spawnDetached no longer passes detached on Windows); this sweep
// is the guaranteed backstop: once the backend flow runs, any visible
// console window whose title points at one of OUR bundled pythons is
// HIDDEN (ShowWindow SW_HIDE — the process keeps running; nothing is killed).
// Packaged builds only — a developer's own terminal is never touched.
const CONSOLE_SWEEP_PS = [
  "Add-Type 'using System;using System.Runtime.InteropServices;using System.Text;",
  "public class W{public delegate bool CB(IntPtr h,IntPtr l);",
  "[DllImport(\"user32.dll\")]public static extern bool EnumWindows(CB c,IntPtr p);",
  "[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);",
  "[DllImport(\"user32.dll\")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);",
  "[DllImport(\"user32.dll\")]public static extern bool GetClassName(IntPtr h,StringBuilder s,int n);",
  "[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);}'",
  "$script:n=0",
  "[void][W]::EnumWindows({param($h,$l)",
  "if([W]::IsWindowVisible($h)){",
  "$t=New-Object System.Text.StringBuilder 512;[void][W]::GetWindowText($h,$t,512);",
  "$c=New-Object System.Text.StringBuilder 256;[void][W]::GetClassName($h,$c,256);",
  "$s=$t.ToString();$k=$c.ToString();",
  "if(($k -eq 'ConsoleWindowClass' -or $k -like 'CASCADIA*') -and $s -match 'python\\.exe' -and ($s -match 'ScienceDiscovery' -or $s -match '\\\\envs\\\\' -or $s -match 'jiuwenswarm')){[void][W]::ShowWindow($h,0);$script:n++}}",
  "$true},[IntPtr]::Zero)",
  "Write-Output $script:n",
].join("\n");

let consoleSweepTimer: NodeJS.Timeout | null = null;
let consoleSweepRounds = 0;

function sweepConsoleWindows(): void {
  if (!packaged || process.platform !== "win32") return;
  execFile(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CONSOLE_SWEEP_PS],
    { windowsHide: true, timeout: 15_000 },
    (err, stdout) => {
      // Best-effort: a failed sweep is logged and retried by the interval.
      if (err) { log(`console sweep error: ${err.message}`); return; }
      // Parse the LAST non-empty line — the delegate may emit stray pipeline
      // output before the final Write-Output.
      const lines = (stdout ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const hidden = parseInt(lines[lines.length - 1] ?? "", 10) || 0;
      if (hidden > 0) log(`console sweep: hid ${hidden} stray console window(s)`);
    },
  );
}

function startConsoleSweep(): void {
  if (!packaged || process.platform !== "win32" || consoleSweepTimer) return;
  sweepConsoleWindows();
  consoleSweepRounds = 45; // ~6 min at 8s cadence, then self-stop
  consoleSweepTimer = setInterval(() => {
    sweepConsoleWindows();
    consoleSweepRounds -= 1;
    if (consoleSweepRounds <= 0) stopConsoleSweep();
  }, 8_000);
  consoleSweepTimer.unref();
}

function stopConsoleSweep(): void {
  if (consoleSweepTimer) {
    clearInterval(consoleSweepTimer);
    consoleSweepTimer = null;
  }
}

async function ensureBackend(
  endpoints: Endpoints, proxyEnv: NodeJS.ProcessEnv | null, dataDir: string | null,
): Promise<boolean> {
  // 1s first probe — ECONNREFUSED returns instantly anyway, the poll
  // interval means a 3s budget wasted ~2s before spawning the stack.
  SD_PERF("ensureBackend-enter");
  if (await waitHealthy(endpoints.health, 1_000, fetch)) {
    log("backend already healthy; reusing running stack");
    SD_PERF("backend-reused-healthy");
    // F9: a reused stack is a LIVE backend this shell did not spawn, but
    // it is exactly what the drain gate exists for — installing an update
    // over a healthy python tree is the corruption case. Record it so
    // stackFacts reports running (the gate blocks) and stopStack can ask
    // the shared stack to stop by pid instead of "no handle → gate open".
    externalStackAlive = true;
    return true;
  }
  const repoRoot = resolveRepoRoot(process.env, shellDir, packagedRoot);
  if (!existsSync(join(repoRoot, "scripts", "start-stack.mjs"))) {
    log(`backend entry not found under ${repoRoot}`);
    // An installation problem is fatal and non-recoverable — surface it on
    // the loading page with a retry, never on the auth fallback (that page
    // is reserved for real 401s and its copy would mislead here).
    pushStage("error", `未找到后端程序（${repoRoot}）。请重新安装 ScienceDiscovery 后重试。`);
    return false;
  }
  // If our earlier spawn from this session is still booting (a previous
  // wait gave up), wait on it again instead of stacking a second stack onto
  // the same ports.
  const prior = stack !== null && stack.running() ? stack : null;
  let handle: StackHandle;
  if (!prior) {
    const ports: StackPorts = portsForEpoch(endpoints.epoch ?? 0);
    // Proxy: mirror the system proxy for the stack's outbound
    // traffic (plugin downloads, model connectivity); NO_PROXY keeps loopback
    // direct. If the shell itself inherited proxy vars but no system proxy is
    // configured, still pin the loopback bypass.
    const loopbackGuard: NodeJS.ProcessEnv = proxyEnv ? {} : {
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    };
    // Default to in-place venvs and lazy JiuwenSwarm so first/cold start
    // reaches the main UI in ~10-20s instead of minutes. Set on the current
    // process too: bootstrapPackaged reads process.env to decide the unpack
    // path, while the stack child inherits them through extraEnv.
    // [mac-desktop] W22: darwin NEVER sets IN_PLACE — any write inside the
    // .app bundle (pyvenv.cfg/.pth/__pycache__ fixes, import-time .pyc)
    // breaks the codesign seal, and the NEXT launch dies before main.cjs
    // (amfid rejects the binary, zero output). win32 keeps in-place: the
    // NSIS install dir has no seal to break.
    const inplaceEnv: NodeJS.ProcessEnv = IS_DARWIN ? {} : {
      SCIENCE_AGENT_IN_PLACE_ENVS: "1",
      SCIENCE_AGENT_LAZY_JIUWEN: "1",
    };
    Object.assign(process.env, inplaceEnv);
    const extraEnv: NodeJS.ProcessEnv = {
      ...(dataDir ? { SCIENCE_DISCOVERY_DATA_DIR: dataDir } : {}),
      ...stackEnvForPorts(ports),
      ...loopbackGuard,
      ...(proxyEnv ?? {}),
      ...inplaceEnv,
    };
    if (packaged && dataDir) {
      provisioningThisRun = needsUnpack(dataDir, packaged.resourcesPath);
      SD_PERF("bootstrapPackaged-enter", `provisioning=${provisioningThisRun}`);
      await bootstrapPackaged(packaged, dataDir, stageAwareLog);
      SD_PERF("bootstrapPackaged-done");
      Object.assign(extraEnv, packagedEnv(packaged, dataDir));
    }
    pushStage("stack");
    stackErrTail.length = 0; // per-spawn failure tail
    stack = spawnStack(process.execPath, repoRoot, extraEnv, stageAwareLog);
    SD_PERF("stack-spawned", `pid=${stack.pid ?? "?"}`);
    startConsoleSweep(); // hide any stray console window (see sweep docs)
    stackOwnedByShell = true;
    stackDir = dataDir;
    handle = stack;
  } else {
    log("previous stack spawn is still running; waiting on it again");
    handle = prior;
  }
  // Staged budget. Cold start measured 2:23 (jiuwenswarm alone 101s) vs the
  // old flat 120s that misrouted to the auth fallback; provisioning keeps
  // the wizard's 1200s. SD_SHELL_STARTUP_TIMEOUT_MS overrides for testing.
  const budgetMs = startupBudgetMs(provisioningThisRun);
  // Race the health wait against the process exiting — a dead start-stack
  // never binds the health port, so a pure poll would burn the whole budget
  // before the fallback page shows anything.
  const up = await waitHealthyOrExited(handle, endpoints.health, budgetMs, fetch);
  if (up.kind === "healthy") {
    // The health 200 moment = "backend ready" (the shell.log anchor the
    // measurement protocol keys on). waitedMs vs spawn: derived by the
    // report from the stack-spawned mark, kept here as a single anchor.
    SD_PERF("HEALTH-200", `url=${endpoints.health}`);
    return true;
  }
  if (up.kind === "exited") {
    const summary = summarizeStackFailure(up.code, stackErrTail);
    log(`backend stack exited early: ${summary}`);
    pushStage("error", `${summary} 可点击「重试」重新启动。`);
    return false;
  }
  // Budget exhausted but the stack is still booting. Do NOT open the auth
  // fallback (reserved for real 401s, its copy misleads — the token is
  // fine). Keep the stack running, tell the loading page we are still
  // waiting with a retry affordance, and keep watching in the background —
  // the UI loads itself the moment the stack turns healthy.
  log(`backend not healthy after ${Math.round(budgetMs / 1000)}s; keeping it running and watching in the background`);
  pushStage("slow", `后端启动较慢（已等 ${Math.round(budgetMs / 1000)} 秒），仍在等待；就绪后将自动进入主界面。`);
  watchBackendInBackground(endpoints, dataDir);
  return false;
}

// --- background backend watch --------------------------------------------------

let backendWatchSeq = 0;

/**
 * After a startup timeout the stack keeps booting in the background (never
 * kill it). Watch it and load the UI the moment it turns healthy — zero
 * user action. Any later watch or a manual retry supersedes earlier ones
 * (monotonic guard, same pattern as wizardEnsureRun).
 */
function watchBackendInBackground(endpoints: Endpoints, dataDir: string | null): void {
  const seq = ++backendWatchSeq;
  const watched = stack;
  void (async () => {
    const up = watched
      ? await waitHealthyOrExited(watched, endpoints.health, COLD_BACKEND_TIMEOUT_MS, fetch)
      : { kind: "timeout" as const };
    if (seq !== backendWatchSeq || quitConfirmed) return;
    if (up.kind === "healthy") {
      log("background watch: backend became healthy; loading UI");
      void loadUi(endpoints, readToken(dataDir));
      watchAgentReady(endpoints, dataDir);
      // This path reaches a healthy stack without going through startupFlow's
      // healthy branch, so arm the post-startup liveness watch here as well —
      // otherwise a later backend death still leaves the white window holding
      // the single-instance lock (#1085).
      armStackStableTimer();
      watchStackLiveness();
      return;
    }
    if (up.kind === "exited") {
      const summary = summarizeStackFailure(up.code, stackErrTail);
      log(`background watch: backend exited early: ${summary}`);
      pushStage("error", `${summary} 可点击「重试」重新启动。`);
      return;
    }
    log("background watch: backend still not healthy; showing error with retry");
    pushStage("error", "后端长时间未能就绪。可点击「重试」重新连接；若持续失败请查看日志。");
  })();
}

// --- post-startup stack liveness -------------------------------------------------
// The startup-timeout watch above only runs while the stack is still booting.
// Once the UI is up and the stack is healthy, nothing re-checked the child, so
// an API that later died (heap exhaustion, a service error) left the window on
// a dead origin while the shell still held the single-instance lock — a white
// window whose every relaunch exits as "second instance" (#1085). Watch the
// owned stack's exit and recover: one automatic restart, then surface the
// failure and release the lock so a fresh launch can take over.

let stackDeathWatchSeq = 0;
let stackRestartAttempts = 0;
const STACK_RESTART_LIMIT = 1;
/** A stack that stayed healthy this long earns a fresh restart budget — a crash
 *  long after startup is a new incident, not the auto-restart still failing. */
const STACK_STABILITY_MS = 60_000;
let stackStableTimer: ReturnType<typeof setTimeout> | null = null;

function clearStackStableTimer(): void {
  if (stackStableTimer) { clearTimeout(stackStableTimer); stackStableTimer = null; }
}

function armStackStableTimer(): void {
  clearStackStableTimer();
  stackStableTimer = setTimeout(() => { stackStableTimer = null; stackRestartAttempts = 0; }, STACK_STABILITY_MS);
}

function watchStackLiveness(): void {
  const handle = stack;
  if (!handle || !stackOwnedByShell) return;
  const seq = ++stackDeathWatchSeq;
  void handle.exited.then((code) => {
    if (seq !== stackDeathWatchSeq || quitConfirmed || stack !== handle) return;
    log(`stack exited unexpectedly while the window was open (exit ${code ?? "unknown"}); recovering`);
    void recoverStackAfterDeath(code);
  });
}

async function recoverStackAfterDeath(code: number | null): Promise<void> {
  clearStackStableTimer();
  if (stackRestartAttempts >= STACK_RESTART_LIMIT || quitConfirmed) {
    await surfaceBackendDead(code);
    return;
  }
  stackRestartAttempts += 1;
  log(`auto-restarting the backend (attempt ${stackRestartAttempts}/${STACK_RESTART_LIMIT})`);
  if (startupFlowInFlight) return;
  startupFlowInFlight = true;
  backendWatchSeq += 1;    // supersede any startup-timeout watch
  stackDeathWatchSeq += 1; // the restart arms its own fresh watch
  await startupFlow(startupProxyEnv).finally(() => { startupFlowInFlight = false; });
  // A restart that left no live stack means the crash reproduces on boot — do
  // not loop. Surface it and release the lock for a fresh launch instead.
  if (!quitConfirmed && !(stack && stackOwnedByShell && stack.running())) await surfaceBackendDead(code);
}

async function surfaceBackendDead(code: number | null): Promise<void> {
  log("backend recovery failed; surfacing the error and releasing the single-instance lock");
  const summary = summarizeStackFailure(code, stackErrTail);
  // showLoading starts an async loadFile; wait for the fresh loading page to
  // register its listener before pushing the error, or the stage is sent to
  // the outgoing document and dropped — leaving no failure reason or retry.
  try {
    await showLoading();
  } catch {
    // loadFile rejects if the loading page itself fails to load; still push
    // the stage and release the lock below.
  }
  pushStage("error", `后端服务已停止，自动重启未能恢复。${summary} 请关闭本窗口后重新启动 ScienceDiscovery，或打开日志查看原因。`);
  // The window is stuck on a dead origin; let a fresh launch acquire the lock
  // instead of being told it is a second instance.
  app.releaseSingleInstanceLock();
}

// --- daily startup flow (extracted so the loading page's retry reruns it) ------

let startupProxyEnv: NodeJS.ProcessEnv | null = null;
let startupFlowInFlight = false;

async function startupFlow(proxyEnv: NodeJS.ProcessEnv | null): Promise<void> {
  SD_PERF("startupFlow-enter");
  // The window shows the local loading page while we probe and (if needed)
  // cold-start the stack; loadUi replaces it once healthy.
  void showLoading();
  // B2-2 / review F1: the fail-closed Seatbelt gate runs in the MAIN
  // process before anything else. The SPA's wizard boot step never runs in
  // the packaged flow (preload marks the shell wizard done, so the SPA
  // opens at model config), so the SPA-side check alone could never stop a
  // failed verdict from reaching the main UI. Here the verdict is
  // load-bearing: "failed" replaces the whole session with the error page
  // and never loads the SPA (upstream red line). Non-darwin hosts
  // short-circuit to not-applicable inside the probe without spawning.
  const gate = seatbeltGateDecision(
    await runSeatbeltProbe(process.platform, (cmd, args) => spawn(cmd, args)),
  );
  if (gate.action === "block") {
    log(`seatbelt gate FAILED: ${gate.reason}`);
    // F13: the page is a file:// origin — it cannot read the SPA's
    // localStorage (http://127.0.0.1), so the shell hands the persisted
    // locale through the query; the page still falls back to
    // navigator.language when we never got one.
    await mainWindow?.loadFile(join(distDir, gate.page), { search: seatbeltErrorPageQuery(gate, readShellLocale()) });
    return;
  }
  SD_PERF("seatbelt-gate-passed");
  // Resolve the data dir first so the "connect" stage already reports the
  // correct step total (first run = 10 steps, daily = 8).
  const dataDir = effectiveDataDir(process.env, persistedWizard);
  provisioningThisRun = !!(packaged && dataDir && needsUnpack(dataDir, packaged.resourcesPath));
  pushStage("connect");
  const endpoints = await startupEndpoints(dataDir);
  SD_PERF("startupEndpoints-done", `epoch=${endpoints.epoch ?? "env"} ui=${endpoints.ui}`);
  currentEndpoints = endpoints;
  const healthy = await ensureBackend(endpoints, proxyEnv, dataDir);
  SD_PERF("ensureBackend-done", `healthy=${healthy}`);
  if (healthy && !quitConfirmed) {
    void loadUi(endpoints, readToken(dataDir));
    watchAgentReady(endpoints, dataDir);
    armStackStableTimer();
    watchStackLiveness();
    if (Notification.isSupported()) {
      new Notification({ title: "ScienceDiscovery", body: "后端已就绪" }).show();
    }
  }
  // An unhealthy backend no longer opens the auth fallback. That page is
  // reserved for real 401s (attachAuthFallback). The failure modes are
  // already surfaced on the loading page by ensureBackend: "slow" keeps
  // watching in the background and "error" offers a retry.
}

ipcMain.handle("sd-shell:retry-backend", () => {
  if (startupFlowInFlight || wizardMode) return;
  startupFlowInFlight = true;
  backendWatchSeq += 1; // a manual retry supersedes any background watch
  stackRestartAttempts = 0; // a manual retry is a fresh recovery budget
  clearStackStableTimer();
  log("retry requested from the loading page");
  void startupFlow(startupProxyEnv).finally(() => { startupFlowInFlight = false; });
});

// The renderer pulls the current JiuwenSwarm state once on mount because
// the first webContents.send races its listener registration.
ipcMain.handle("sd-shell:jiuwenswarm-get-state", () => lastJiuwenState);

// --- wizard backend orchestration ----------------------------------------------

/**
 * Ensure a stack bound to `dataDir` is running for the wizard's model step.
 * Resolution order: explicit dev URLs (assume provided) → reuse a healthy
 * stack whose API accepts this data dir's token (crash resume) → wait for a
 * recorded spawn that is still alive → spawn fresh on the first free epoch.
 */
async function startWizardBackend(dataDir: string, proxyEnv: NodeJS.ProcessEnv | null): Promise<void> {
  if (wizardBackendDir === dataDir
    && (wizardBackend.status === "starting" || wizardBackend.status === "healthy")) return;

  if (process.env.SD_SHELL_UI_URL || process.env.SD_SHELL_HEALTH_URL) {
    currentEndpoints = { ui: uiUrl(process.env), health: healthUrl(process.env), epoch: null };
    wizardBackendDir = dataDir;
    wizardBackend = { status: "healthy", epoch: null };
    return;
  }

  const run = ++wizardEnsureRun;
  wizardBackendDir = dataDir;
  wizardBackend = { status: "starting", epoch: null };
  const settle = (status: WizardBackendStatus["status"], epoch: number | null, message?: string): void => {
    if (run !== wizardEnsureRun) return; // superseded by a newer ensure run
    wizardBackend = { status, epoch, ...(message ? { message } : {}) };
  };

  try {
    // 1. A healthy stack on our data dir (token-verified) → reuse.
    const token = readTokenForDir(dataDir);
    const ours = await findOurStack(token);
    if (ours !== null) {
      currentEndpoints = epochEndpoints(ours);
      settle("healthy", ours);
      log(`wizard: reusing running stack on epoch ${ours} (verified same data dir)`);
      return;
    }

    // 2. Previous spawn still alive (shell crashed mid-provision): wait for it
    //    instead of double-spawning onto the same data dir. Bound the wait by
    //    checking the epoch's ports are actually bound (guards against pid reuse).
    if (pidAlive(wizardData.stackPid) && wizardData.epoch !== undefined) {
      const p = portsForEpoch(wizardData.epoch);
      // The full port set (memory-graph/evolve included) makes the liveness
      // signal stronger against pid reuse.
      const anyBound = !(await isPortFree(p.publicPort))
        || !(await isPortFree(p.runnerPort))
        || !(await isPortFree(p.legacyPort))
        || !(await isPortFree(p.memoryGraphPort))
        || !(await isPortFree(p.evolvePort));
      if (anyBound) {
        currentEndpoints = epochEndpoints(wizardData.epoch);
        log(`wizard: waiting for recorded spawn (pid ${wizardData.stackPid}, epoch ${wizardData.epoch})`);
        if (await waitHealthy(healthUrlForPorts(p), WIZARD_BACKEND_TIMEOUT_MS, fetch)) {
          settle("healthy", wizardData.epoch);
          return;
        }
        log("wizard: recorded spawn never became healthy; respawning");
        // Reap the spawn we gave up on — it runs on OUR data dir (recorded
        // by a previous run of this app), so leaving it alive leaks its
        // epoch ports and data-dir locks into every later session.
        const stalePid = wizardData.stackPid;
        if (stalePid) await killStackTree(stalePid, log);
      }
    }

    // 3. Stop a stack we own (failed leftover, or the dir changed via the wizard's back button).
    if (stack && stackOwnedByShell) {
      const old = stack;
      stack = null;
      stackOwnedByShell = false;
      stackDir = null;
      log("wizard: stopping previously owned stack before ensuring a fresh one");
      void old.stop();
    }

    // 4. Spawn fresh.
    const repoRoot = resolveRepoRoot(process.env, shellDir, packagedRoot);
    if (!existsSync(join(repoRoot, "scripts", "start-stack.mjs"))) {
      settle("failed", null, `未找到后端入口：${join(repoRoot, "scripts", "start-stack.mjs")}`);
      return;
    }
    // Bind semantics (isPortBindFree) — same reasoning as startupEndpoints;
    // the wizard's fresh spawn must not get a TIME_WAIT port.
    const free = await firstFreeEpoch(isPortBindFree);
    const epoch = free ?? 0;
    const ports = portsForEpoch(epoch);
    const loopbackGuard: NodeJS.ProcessEnv = proxyEnv ? {} : {
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    };
    // Default to in-place venvs and lazy JiuwenSwarm so first/cold start
    // reaches the main UI in ~10-20s instead of minutes. Set on the current
    // process too: bootstrapPackaged reads process.env to decide the unpack
    // path, while the stack child inherits them through extraEnv.
    // [mac-desktop] W22: darwin NEVER sets IN_PLACE (bundle writes break the
    // codesign seal — see the comment at the other spawn site above).
    const inplaceEnv: NodeJS.ProcessEnv = IS_DARWIN ? {} : {
      SCIENCE_AGENT_IN_PLACE_ENVS: "1",
      SCIENCE_AGENT_LAZY_JIUWEN: "1",
    };
    Object.assign(process.env, inplaceEnv);
    const extraEnv: NodeJS.ProcessEnv = {
      SCIENCE_DISCOVERY_DATA_DIR: dataDir,
      ...stackEnvForPorts(ports),
      ...loopbackGuard,
      ...(proxyEnv ?? {}),
      ...inplaceEnv,
    };
    if (packaged) {
      provisioningThisRun = needsUnpack(dataDir, packaged.resourcesPath);
      await bootstrapPackaged(packaged, dataDir, stageAwareLog);
      Object.assign(extraEnv, packagedEnv(packaged, dataDir));
    }
    stackErrTail.length = 0; // per-spawn failure tail
    const handle = spawnStack(process.execPath, repoRoot, extraEnv, stageAwareLog);
    startConsoleSweep(); // hide any stray console window (see sweep docs)
    stack = handle;
    stackOwnedByShell = true;
    stackDir = dataDir;
    wizardData = { ...wizardData, epoch, stackPid: handle.pid ?? undefined };
    saveWizardState(app.getPath("userData"), wizardData);
    currentEndpoints = epochEndpoints(epoch);
    // Fail fast when the stack process dies. Previously the wizard polled
    // the health port for the full 1200s budget while start-stack had
    // already fail-fasted (observed: 654s frozen on "step 8" with zero
    // feedback). The stderr tail names the failing step.
    const up = await waitHealthyOrExited(handle, healthUrlForPorts(ports), WIZARD_BACKEND_TIMEOUT_MS, fetch);
    if (up.kind === "healthy") {
      settle("healthy", epoch);
      log(`wizard: backend healthy on epoch ${epoch}`);
      return;
    }
    if (up.kind === "exited") {
      log("wizard: stack process exited before becoming healthy; failing fast");
      settle(
        "failed",
        epoch,
        `${summarizeStackFailure(up.code, stackErrTail)}。可点「重试」；若反复失败请打开日志查看卡在哪个服务。`,
      );
      return;
    }
    // Do NOT stop the stack on timeout — on slow disks first-run provisioning
    // legitimately outgrows the budget, and killing it forces a full redo.
    // Leave it running: the retry button adopts it via findOurStack
    // (token-verified) the moment it turns healthy; step 3 below still
    // replaces it if it is genuinely wedged.
    log("wizard: backend did not become healthy in time; leaving it running for the retry to adopt");
    // The API answers /api/health fast even while degraded (bounded
    // component checks), so one final snapshot names the state for field
    // debugging — "starting" vs "unreachable" vs a component-level answer,
    // no data-dir api.log needed.
    const snapshot = await probeHealthSnapshot(healthUrlForPorts(ports));
    log(`wizard: final health probe: ${snapshot}`);
    settle(
      "failed",
      epoch,
      "后端未在预期时间内就绪——首次环境准备在慢速磁盘上可能需要 15-20 分钟，它仍在后台继续准备。"
      + "请稍候几分钟再点\"重试\"（会自动接管已准备好的环境）；若反复失败请打开日志查看卡在哪个服务。"
      + (snapshot ? `最后探测：${snapshot}` : ""),
    );
  } catch (err) {
    settle("failed", null, String((err as Error)?.message ?? err));
  }
}

/** API base for wizard calls: the UI origin (adapter forwards /api/* to the
 * control API — works in both stack modes; the browser does the same). */
function wizardApiBase(): string | null {
  if (!currentEndpoints) return null;
  return new URL(currentEndpoints.ui).origin;
}

/** Runner health base for the self-check; null when unknown (explicit URLs). */
function wizardRunnerBase(): string | null {
  if (!currentEndpoints) return null;
  if (currentEndpoints.epoch !== null) {
    return `http://127.0.0.1:${4311 + currentEndpoints.epoch}`;
  }
  return process.env.SD_SHELL_RUNNER_URL ?? null;
}

function wizardToken(): string {
  return readToken(wizardData.dataDir ?? null) ?? "";
}

function registerWizardIpc(proxyEnv: NodeJS.ProcessEnv | null): void {
  const userData = app.getPath("userData");

  ipcMain.handle("sd-shell:wizard-get-state", () => ({
    step: wizardData.step,
    dataDir: wizardData.dataDir ?? null,
    defaultDataDir: defaultDataDir(process.env),
  }));

  ipcMain.handle("sd-shell:wizard-browse-dir", async () => {
    if (!mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });

  ipcMain.handle("sd-shell:wizard-check-dir",
    (_event, path: unknown) => probeDataDir(String(path ?? ""), installRootForWizard()));

  ipcMain.handle("sd-shell:wizard-confirm-dir", async (_event, path: unknown) => {
    const clean = String(path ?? "").trim();
    if (!clean) return { ok: false, message: "路径不能为空。" };
    const check = probeDataDir(clean, installRootForWizard());
    if (!check.ok) return { ok: false, message: check.reason ?? "目录不可用。" };
    // Wizard half-takeover: confirming the data dir is all the shell wizard
    // still owns — the SPA takes over model config and boot waiting from
    // here. Mark the wizard done and hand the window to the normal startup
    // flow (loading page → ensureBackend → loadUi + watchAgentReady);
    // ensureBackend spawns the stack for this fresh data dir itself, so no
    // startWizardBackend here (that would race the flow's own spawn into a
    // double stack).
    wizardData = { step: "done", dataDir: clean, completedAt: new Date().toISOString() };
    saveWizardState(userData, wizardData);
    // Without this sync, startupFlow read the stale in-memory persistedWizard
    // (null on first run) → effectiveDataDir=null → the stack spawned on the
    // install-tree default dir while loadUi injected a token read from yet
    // another dir → every API call 401'd into the token fallback page on the
    // FIRST run of a fresh install (fine after a restart, which re-loaded the
    // persisted state). wizard-finish/skip-model already had this sync;
    // confirm-dir took over the "done" transition later and missed it.
    persistedWizard = wizardData;
    wizardMode = false;
    startupProxyEnv = proxyEnv;
    startupFlowInFlight = true;
    void Promise.resolve(startupFlow(proxyEnv)).finally(() => { startupFlowInFlight = false; });
    return { ok: true, takeover: true };
  });

  ipcMain.handle("sd-shell:wizard-backend-status", () => wizardBackend);

  // One-click access to the shell log (first-run failures were
  // undiagnosable without it). Opens <install>\logs in packaged builds —
  // shell.log and install-diagnostics.log live there together.
  // Service logs stay under <dataDir>\logs.
  ipcMain.handle("sd-shell:wizard-open-logs", async () => {
    const dir = shellLogDir();
    mkdirSync(dir, { recursive: true });
    // openPath failures are silent (returns an error string instead of
    // throwing), which once left a tester with zero feedback after clicking
    // the open-logs button. Surface them: the message names the folder so
    // the tester can still reach it by hand.
    const err = await electronShell.openPath(dir);
    if (err) {
      log(`open logs folder FAILED: ${dir} (${err})`);
      dialog.showErrorBox(
        "打开日志失败",
        `无法打开日志目录：\n${dir}\n\n${err}\n\n可手动打开上述路径查看 shell.log 与 install-diagnostics.log。`,
      );
      return dir;
    }
    logToDisk(`logs folder opened: ${dir} (service logs: ${join(effectiveDataDir(process.env, wizardData) ?? "?", "logs")})`);
    return dir;
  });

  ipcMain.handle("sd-shell:wizard-backend-retry", (_event, path: unknown) => {
    const dir = String(path ?? wizardData.dataDir ?? "").trim();
    if (!dir) return { ok: false };
    if (wizardBackend.status === "starting") return { ok: true }; // already ensuring
    void startWizardBackend(dir, proxyEnv);
    return { ok: true };
  });

  // B2-2: the Seatbelt verdict is computed once per session and cached —
  // retrying the self-check does not change whether the OS can compile a
  // sandbox profile, and re-probing would only re-run a deterministic spawn.
  // Windows short-circuits inside runSeatbeltProbe (not-applicable) without
  // spawning anything.
  let seatbeltVerdict: SeatbeltVerdict | null = null;
  ipcMain.handle("sd-shell:wizard-self-check", async () => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    if (seatbeltVerdict === null) {
      seatbeltVerdict = await runSeatbeltProbe(process.platform, (cmd, args) => spawn(cmd, args));
    }
    return runSelfCheck(base, wizardToken(), wizardRunnerBase(), fetch, seatbeltVerdict);
  });

  // Optional model configuration after backend self-check passes.
  // The wizard page presents a simplified model-connect form and saves the
  // configured provider/model through the same backend endpoints the main
  // UI uses, so the setting is immediately available in the main app.
  ipcMain.handle("sd-shell:wizard-list-provider-presets", async () => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const res = await fetch(`${base}/api/providers`, {
      headers: { authorization: `Bearer ${wizardToken()}` },
    });
    if (!res.ok) throw new Error("无法获取模型提供商列表");
    return res.json();
  });

  ipcMain.handle("sd-shell:wizard-preview-provider-models", async (_event, body: unknown) => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const res = await fetch(`${base}/api/providers/preview-models`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${wizardToken()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`获取模型列表失败：${text || res.statusText}`);
    }
    return res.json();
  });

  ipcMain.handle("sd-shell:wizard-create-provider", async (_event, body: unknown) => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const res = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${wizardToken()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`创建模型提供商失败：${text || res.statusText}`);
    }
    return res.json();
  });

  ipcMain.handle("sd-shell:wizard-update-provider", async (_event, providerId: unknown, body: unknown) => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const id = String(providerId ?? "");
    const res = await fetch(`${base}/api/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${wizardToken()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`更新模型提供商失败：${text || res.statusText}`);
    }
    return res.json();
  });

  ipcMain.handle("sd-shell:wizard-add-provider-model", async (_event, providerId: unknown, body: unknown) => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const id = String(providerId ?? "");
    const res = await fetch(`${base}/api/providers/${encodeURIComponent(id)}/models`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${wizardToken()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`添加模型失败：${text || res.statusText}`);
    }
    return res.json();
  });

  ipcMain.handle("sd-shell:wizard-test-model", async (_event, modelId: unknown) => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const id = String(modelId ?? "");
    const res = await fetch(`${base}/api/models/${encodeURIComponent(id)}/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${wizardToken()}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`测试模型失败：${text || res.statusText}`);
    }
    return res.json();
  });

  ipcMain.handle("sd-shell:wizard-set-default-model", async (_event, modelId: unknown) => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    const id = String(modelId ?? "");
    const getRes = await fetch(`${base}/api/settings`, { headers: { authorization: `Bearer ${wizardToken()}` } });
    let overrides: Record<string, unknown> = {};
    if (getRes.ok) {
      const settings = await getRes.json() as { overrides?: Record<string, unknown> };
      overrides = settings.overrides ?? {};
    }
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${wizardToken()}` },
      body: JSON.stringify({ ...overrides, modelId: id }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`设置默认模型失败：${text || res.statusText}`);
    }
    return res.json();
  });

  /** Skip model configuration and complete the wizard. */
  ipcMain.handle("sd-shell:wizard-skip-model", () => {
    wizardData = { step: "done", dataDir: wizardData.dataDir, completedAt: new Date().toISOString() };
    saveWizardState(userData, wizardData);
    persistedWizard = wizardData;
    wizardMode = false;
    if (currentEndpoints) {
      void loadUi(currentEndpoints, readToken(wizardData.dataDir ?? null));
      // The wizard paths loaded the UI without ever starting the
      // JiuwenSwarm readiness watch, so the renderer never received a state
      // and the composer stayed disabled forever (the "starting" card never
      // cleared).
      watchAgentReady(currentEndpoints, wizardData.dataDir ?? null);
    }
  });

  ipcMain.handle("sd-shell:wizard-finish", () => {
    wizardData = { step: "done", dataDir: wizardData.dataDir, completedAt: new Date().toISOString() };
    saveWizardState(userData, wizardData);
    persistedWizard = wizardData;
    wizardMode = false;
    if (currentEndpoints) {
      void loadUi(currentEndpoints, readToken(wizardData.dataDir ?? null));
      // See wizard-skip-model above.
      watchAgentReady(currentEndpoints, wizardData.dataDir ?? null);
    }
  });
}

// --- window / menu / tray --------------------------------------------------------

function createWindow(): void {
  const state = loadWindowState(app.getPath("userData"));
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    title: "ScienceDiscovery",
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: join(distDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The sandboxed preload keeps full access to contextBridge/ipcRenderer
      // and the DOM storage it needs; it imports nothing else, so the
      // renderer runs with zero Node reach of any kind.
      sandbox: true,
    },
  });
  // Renderer console errors → shell.log. An e2e run caught a renderer crash
  // (null deref in enterStep2 froze the wizard) while every backend log
  // looked healthy — off the dev machine that failure mode is invisible in
  // the three-file diagnostic kit. Capture console warnings/errors,
  // renderer crashes, and load failures.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) { // 0 verbose, 1 info, 2 warning, 3 error
      logToDisk(`[renderer:${level === 3 ? "error" : "warn"}] ${message} (${sourceId}:${line})`);
    }
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    logToDisk(`[renderer:gone] reason=${details.reason} exitCode=${details.exitCode ?? ""}`);
  });
  // First-run race: the health gate watches the control API (4410), but the
  // ui origin (4310 adapter) binds several seconds later on cold machines —
  // the first loadURL died with ERR_CONNECTION_REFUSED and the window sat
  // on the dead error page until a manual reload. Retry the same URL (token
  // fragment included) until the adapter binds or the budget runs out; then
  // fall back to the loading page, which offers a manual retry.
  let uiLoadRetries = 0;
  mainWindow.webContents.on("did-finish-load", () => { uiLoadRetries = 0; });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    logToDisk(`[renderer:load-fail] ${code} ${desc} ${url}`);
    if (!currentEndpoints || !shouldRetryUiLoad(code, url, isMainFrame === true, currentEndpoints.ui)) return;
    if (uiLoadRetries >= UI_LOAD_RETRY_LIMIT) {
      logToDisk(`[renderer:load-fail] ui origin still refusing after ${uiLoadRetries} retries; back to loading page`);
      void showLoading();
      pushStage("error", "界面服务未能就绪。可点击「重试」重新连接；若持续失败请查看日志。");
      return;
    }
    uiLoadRetries += 1;
    const waitMs = uiLoadRetryDelayMs(uiLoadRetries);
    logToDisk(`[renderer:load-fail] ui origin not up yet; retry #${uiLoadRetries} in ${waitMs}ms`);
    setTimeout(() => {
      if (!mainWindow || quitConfirmed) return;
      void mainWindow.loadURL(url);
    }, waitMs);
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.on("close", event => {
    if (!quitConfirmed && tray) {
      // Hide to tray; full running-task confirmation is out of scope here.
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    const [width, height] = mainWindow?.getSize() ?? [state.width, state.height];
    const [x, y] = mainWindow?.getPosition() ?? [state.x, state.y];
    saveWindowState(app.getPath("userData"), {
      width, height, x, y, maximized: mainWindow?.isMaximized() === true,
    });
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

/**
 * Auth fallback: a 401 from the API means the token is wrong/expired. The
 * web app calls /api/* on ITS OWN origin (relative fetch, auth.ts:56) — the
 * UI origin — so watch both it and the control-API origin (watching only
 * the health origin missed renderer-origin 401s).
 */
function attachAuthFallback(endpoints: Endpoints): void {
  if (!mainWindow) return;
  const origins = [new URL(endpoints.ui).origin, new URL(endpoints.health).origin];
  const urls = origins.map(origin => `${origin}/*`);
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls }, (details, callback) => {
    if (details.statusCode === 401 && !details.url.includes("/health")) {
      log(`401 from ${details.url}; switching to token fallback page`);
      showFallback();
    }
    callback({ responseHeaders: details.responseHeaders });
  });
}

function buildTray(): void {
  // darwin: no system-tray culture (top-level v1 decision) — quitting and
  // window management live in the Dock + application menu. Guard INSIDE the
  // builder so no future call site can resurrect the tray on darwin.
  if (!wantsTray(IS_DARWIN ? "darwin" : "win32")) return;
  // Real icon from the bundled dist/icon.png (build.mjs copies
  // build/icon-256.png there; electron-builder packs dist/ into the asar).
  // Windows auto-scales for the tray; the old inline 16x16 blue square was
  // invisible on dark taskbars ("no icon when minimized").
  const img = nativeImage.createFromPath(join(distDir, "icon.png"));
  if (!img.isEmpty()) {
    tray = new Tray(img);
  } else {
    // Defensive fallback (icon missing from an unexpected layout): the
    // former placeholder so the tray still works at all.
    tray = new Tray(nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4nGNgGAWDHjAyMDAw/P//nxGXAkZGxv+45BhwaUZXhE0jIz5T8LmMEZ8p+ACG5v///zPCTAYAAP//j7oD8F2L0jgAAAAASUVORK5CYII=",
    ));
  }
  tray.setToolTip("ScienceDiscovery");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 ScienceDiscovery", click: () => openMainWindow() },
    { type: "separator" },
    { label: "退出（并停止后端）", click: () => { quitConfirmed = true; app.quit(); } },
  ]));
  tray.on("click", () => openMainWindow());
}

/** Show (or recreate) the main window with the current content. */
function openMainWindow(): void {
  if (BrowserWindow.getAllWindows().length > 0) {
    mainWindow?.show();
    mainWindow?.focus();
    return;
  }
  createWindow();
  if (wizardMode) {
    void mainWindow?.loadFile(join(distDir, "wizard.html"));
  } else if (currentEndpoints) {
    const dataDir = effectiveDataDir(process.env, persistedWizard);
    void loadUi(currentEndpoints, readToken(dataDir));
    // See wizard-skip-model; window recreation went through loadUi without
    // the readiness watch too.
    watchAgentReady(currentEndpoints, dataDir);
  } else {
    // No endpoints yet (window closed during startup): the whenReady flow is
    // still working — show the loading page until it loads the UI or fallback.
    void showLoading();
  }
}

ipcMain.handle("sd-shell:save-token", async (_event, token: string) => {
  const clean = String(token ?? "").trim();
  if (!clean) return false;
  const dataDir = effectiveDataDir(process.env, persistedWizard);
  persistToken(clean, dataDir);
  if (currentEndpoints) {
    void loadUi(currentEndpoints, clean);
    // See wizard-skip-model; the fallback reconnect path also loaded the UI
    // without the readiness watch.
    watchAgentReady(currentEndpoints, dataDir);
  }
  return true;
});

// F13: the SPA reports its locale choice so the fail-closed page (a
// different origin) can follow it. The shell mirrors it into userData —
// the page itself can never read the SPA's localStorage across origins.
ipcMain.handle("sd-shell:report-locale", (_event, locale: unknown) => {
  if (locale === "zh-CN" || locale === "en") writeShellLocale(locale);
  return true;
});

// --- study-package export: native save dialog + destination-bound save --------
// The renderer never learns a filesystem path: the dialog issues an opaque
// token, the main process keeps the path, and every write/reveal resolves that
// token. A renderer that sends a path of its own choosing is rejected, so the
// sandbox/contextIsolation of the window is not bypassed. The dialog remembers
// the last chosen directory across restarts via export-state.json.
let lastExportDir: string | null = null;
let lastExportDirLoaded = false;
const exportDestinations = new ExportDestinations();
/** The durable list of finished exports. Read lazily: a corrupt or unreadable
 *  history must not stop the shell from starting, and `loadExportHistory`
 *  already reads a broken file as empty. */
let exportHistoryStore: ExportHistoryStore | null = null;

function exportHistory(): ExportHistoryStore {
  if (!exportHistoryStore) exportHistoryStore = new ExportHistoryStore(app.getPath("userData"));
  return exportHistoryStore;
}

function exportFileExists(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Async so a package on a slow network share cannot block the main process —
 *  which supervises the whole stack — while the list is read. */
async function exportFileExistsAsync(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** The list the renderer gets: no filesystem path it could hand back to a write,
 *  only the folder name for display plus whether the file is still there. */
async function exportHistoryRows() {
  return Promise.all(exportHistory().list().map(async (row) => ({
    bytes: row.bytes,
    directory: dirname(row.path),
    exists: await exportFileExistsAsync(row.path),
    filename: row.filename,
    id: row.id,
    ...(row.level ? { level: row.level } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    savedAt: row.savedAt,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.sessionTitle ? { sessionTitle: row.sessionTitle } : {}),
    token: row.token,
  })));
}

function defaultExportDir(): string {
  if (!lastExportDirLoaded) {
    lastExportDirLoaded = true;
    lastExportDir = loadExportState(app.getPath("userData"))?.lastExportDir ?? null;
  }
  if (lastExportDir) return lastExportDir;
  try { return app.getPath("downloads"); } catch { return app.getPath("home"); }
}

ipcMain.handle("sd-shell:export-save-dialog", async (_event, args: unknown) => {
  const { suggestedName } = (args ?? {}) as { suggestedName?: unknown };
  const name = typeof suggestedName === "string" && suggestedName.trim()
    ? suggestedName.trim()
    : "research.sdresearch";
  if (!mainWindow) return { canceled: true, token: null };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出研究包",
    defaultPath: join(defaultExportDir(), name),
    buttonLabel: "保存",
    filters: [{ name: "ScienceDiscovery 研究包", extensions: ["sdresearch"] }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (result.canceled || !result.filePath) return { canceled: true, token: null };
  lastExportDir = dirname(result.filePath);
  saveExportState(app.getPath("userData"), { lastExportDir });
  const token = exportDestinations.issue(randomUUID(), result.filePath);
  return { canceled: false, token };
});

ipcMain.handle("sd-shell:export-write", async (_event, args: unknown) => {
  const { token, data, meta } = (args ?? {}) as { token?: unknown; data?: unknown; meta?: unknown };
  const destination = typeof token === "string" ? exportDestinations.resolve(token) : undefined;
  // No token, or one this process never issued → refuse. There is no code path
  // where the renderer supplies a path.
  if (!destination) throw new Error("保存位置无效，请重新选择。");
  let bytes: Uint8Array | null = null;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  if (!bytes) throw new Error("导出数据无效。");
  writeFileSync(destination.path, bytes);
  exportDestinations.markWritten(token as string);
  // Recorded only after the write succeeded: a canceled or failed save leaves
  // no row, and a re-save of the same task keeps the same row (its id).
  const details = (meta ?? {}) as {
    level?: unknown; projectId?: unknown; recordId?: unknown;
    sessionId?: unknown; sessionTitle?: unknown;
  };
  const recordId = typeof details.recordId === "string" && details.recordId.trim()
    ? details.recordId.trim()
    : token as string;
  const level = details.level === "necessary" || details.level === "complete" ? details.level : undefined;
  try {
    exportHistory().record({
      bytes: bytes.byteLength,
      filename: basename(destination.path),
      id: recordId,
      ...(level ? { level } : {}),
      path: destination.path,
      ...(typeof details.projectId === "string" ? { projectId: details.projectId } : {}),
      savedAt: new Date().toISOString(),
      ...(typeof details.sessionId === "string" ? { sessionId: details.sessionId } : {}),
      ...(typeof details.sessionTitle === "string" ? { sessionTitle: details.sessionTitle } : {}),
      token: token as string,
    });
  } catch (error) {
    // The package is already on disk: a history row that cannot be persisted
    // must not turn a successful save into 保存失败. The row is simply absent,
    // and the shell log says why.
    log(`[export] history row not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true };
});

ipcMain.handle("sd-shell:export-show-in-folder", async (_event, token: unknown) => {
  const destination = typeof token === "string" ? exportDestinations.resolve(token) : undefined;
  if (!destination) return { ok: false };
  electronShell.showItemInFolder(destination.path);
  return { ok: true };
});

ipcMain.handle("sd-shell:export-downloads-dir", () => {
  try { return app.getPath("downloads"); } catch { return app.getPath("home"); }
});

// --- durable export history (issue #1154): the list survives a restart --------
// A finished export is remembered with its token, so 打开文件位置 still works
// after the app restarts and a package cannot be lost with the dialog that made
// it. Only a stat is taken on read; the file itself is never moved or copied.
ipcMain.handle("sd-shell:export-history-list", () => exportHistoryRows());

ipcMain.handle("sd-shell:export-history-reveal", async (_event, token: unknown) => {
  if (typeof token !== "string") return { missing: true, ok: false };
  // Resolved from the persisted row, so a token from a previous run works; the
  // per-run map stays the fallback for a row that was written this session.
  const row = exportHistory().byToken(token);
  const destination = row?.path ?? exportDestinations.resolve(token)?.path;
  if (!destination) return { missing: true, ok: false };
  // A moved or deleted file must be reported rather than revealed as a no-op.
  if (!exportFileExists(destination)) return { missing: true, ok: false };
  electronShell.showItemInFolder(destination);
  return { missing: false, ok: true };
});

ipcMain.handle("sd-shell:export-history-forget", async (_event, id: unknown) => {
  if (typeof id !== "string" || !id.trim()) return { ok: false };
  const row = exportHistory().list().find((entry) => entry.id === id);
  if (!row) return { ok: false };
  exportDestinations.forget(row.token);
  return { ok: exportHistory().forget(id) };
});

const appStartAt = Date.now();
void app.whenReady().then(async () => {
  // Second instance that failed to take the lock: it called app.quit() at
  // module load; never start windows/stack in a process that is leaving.
  if (!gotSingleInstanceLock) return;
  SD_PERF("app-ready", `sinceModuleLoad=${Date.now() - sdPerfT0}ms`);
  // Be explicit that renderer traffic follows the OS system proxy
  // (Chromium default, stated here so no one "fixes" it to direct; the
  // system source differs per platform — registry on win32, scutil on
  // darwin — but Chromium's "system" mode means the same thing).
  void session.defaultSession.setProxy({ mode: "system" }).catch(() => { /* keep default */ });

  const systemProxy = await readSystemProxy();
  const proxyEnv = proxyEnvFromSystem(systemProxy);
  if (proxyEnv) log(`system proxy active; mirroring ${proxyEnv.HTTPS_PROXY} to the stack (loopback bypassed)`);

  // Gate: unfinished (or missing) wizard state → run the wizard instead of
  // loading the UI. The wizard configures the very things the stack needs
  // (data dir), so it must not depend on the backend being up.
  let wizardState = loadWizardState(app.getPath("userData"));
  // Wizard half-takeover: a state parked at "starting"/"model" by a
  // pre-takeover build means the data dir was already chosen — the SPA owns
  // everything after that point now, so normalize straight to "done" and let
  // the normal startup flow run instead of reopening the wizard at a dead
  // step (its step-2/3 UI would poll a backend nobody starts).
  if (wizardState && (wizardState.step === "starting" || wizardState.step === "model")) {
    wizardState = {
      ...wizardState,
      step: "done",
      completedAt: wizardState.completedAt ?? new Date().toISOString(),
    };
    saveWizardState(app.getPath("userData"), wizardState);
    log("wizard: normalized pre-takeover state to done and handing off to the SPA flow");
  }
  persistedWizard = wizardState;
  wizardMode = needsWizard(wizardState);

  // --- Uninstall & data-cleanup dialog (darwin-only menu entry) ------------
  // D4 §8: mac has no uninstaller UI (drag-to-trash is the platform
  // convention), but "drag removes only the .app, data stays" deserves an
  // in-app place to be *told* — and deep-clean needed a discoverable entry
  // that does not depend on an external FAQ site. Scope matches the NSIS
  // "also delete user data" checkbox exactly (main data dir + Library
  // scatter); the dialog never deletes without TWO explicit confirmations.
  const showUninstallDialog = (): void => {
    const dataDir = effectiveDataDir(process.env, persistedWizard);
    // Review F3: pass the RUNTIME Electron paths — the packaged userData /
    // logs dirs are named after productName (ScienceDiscovery), not the
    // dev-mode package name; computing them here keeps the dialog's list
    // aligned with what actually exists on disk.
    const footprints = uninstallFootprints(
      dataDir,
      app.getPath("home"),
      IS_DARWIN ? "darwin" : "win32",
      { userDataDir: app.getPath("userData"), logsDir: app.getPath("logs") },
    );
    const lines = footprints.map(f => `• ${f.label}\n  ${f.path ?? "（未知位置——数据目录未配置）"}`);
    const detail = [
      "卸载（拖废纸篓）只会移除应用本体，以上用户数据默认保留。",
      "",
      "如需在卸载前彻底清理，可点「删除全部用户数据」——",
      "该操作不可恢复，删除后所有会话、密钥与设置将丢失。",
      "",
      "「打开数据目录」可在删除前查看这些位置的实际内容。",
    ].join("\n");
    void dialog.showMessageBox({
      type: "info",
      title: "卸载与数据清理",
      message: "卸载 ScienceDiscovery",
      detail: `${lines.join("\n\n")}\n\n${detail}`,
      buttons: ["打开数据目录", "删除全部用户数据…", "关闭"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        const target = dataDir ?? app.getPath("home");
        logToDisk(`uninstall dialog: opening data dir ${target}`);
        void electronShell.openPath(target);
        return;
      }
      if (response !== 1) return;
      // First confirmation: name the exact scope with sizes where known.
      const scopeList = footprints.map(f => `• ${f.path ?? f.label}`).join("\n");
      void dialog.showMessageBox({
        type: "warning",
        title: "删除全部用户数据",
        message: "确认删除以下全部数据？",
        detail: `${scopeList}\n\n此操作不可恢复。删除后应用将回到首次启动状态。`,
        buttons: ["取消", "仍要删除"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).then(({ response: r2 }) => {
        if (r2 !== 1) return;
        // Second confirmation: typed-in-the-face severity framing.
        void dialog.showMessageBox({
          type: "warning",
          title: "最后确认",
          message: "真的要删除全部用户数据吗？",
          detail: "将立即删除所有会话、模型密钥、运行环境与设置。\n点击「删除并退出」后应用会退出，数据被永久移除。",
          buttons: ["取消", "删除并退出"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        }).then(({ response: r3 }) => {
          if (r3 !== 1) return;
          logToDisk(`uninstall dialog: deep-clean confirmed, removing ${footprints.length} footprint(s)`);
          // F10: stop the backend tree FIRST — a live python worker holds
          // open files / locks inside the data dir, and on win32 a running
          // backend makes rmSync fail outright. Reuse the updater's
          // drain-gate stop semantics (owned handle OR reused external
          // stack); only after the tree is confirmed gone delete anything.
          const stopEverything = async (): Promise<void> => {
            const s = stack;
            if (s && stackOwnedByShell) {
              stack = null;
              stackStopInFlight = true;
              try { await s.stop(); } finally { stackStopInFlight = false; }
            }
            if (externalStackAlive) {
              const healthPort = parseInt(new URL(currentEndpoints?.health ?? "http://127.0.0.1:4410/api/health").port || "4410", 10);
              stackStopInFlight = true;
              try { await stopExternalStack(healthPort, log); }
              finally { stackStopInFlight = false; externalStackAlive = false; }
            }
          };
          void stopEverything().then(() => {
            const failures: string[] = [];
            for (const f of footprints) {
              if (!f.path) continue;
              try {
                if (existsSync(f.path)) rmSync(f.path, { recursive: true, force: true });
                logToDisk(`uninstall dialog: removed ${f.path}`);
              } catch (err) {
                logToDisk(`uninstall dialog: FAILED to remove ${f.path}: ${String(err)}`);
                failures.push(f.path);
              }
            }
            // F10: a failed footprint delete is NOT silent — the user asked
            // for a destructive operation and must learn it did not fully
            // happen; the app stays up so they can close whatever holds the
            // files and retry, instead of quitting and leaving them under
            // the false impression everything is gone.
            if (failures.length > 0) {
              logToDisk(`uninstall dialog: ${failures.length} footprint(s) failed — NOT quitting, showing the failure dialog`);
              const failureBox = {
                type: "error" as const,
                title: "删除未完成",
                message: `有 ${failures.length} 项数据未能删除：`,
                detail: `${failures.join("\n")}\n\n可能有程序仍在占用这些文件（例如正在运行的后端）。请关闭相关程序后重试，或手动删除。`,
                buttons: ["确定"],
                noLink: true,
              };
              void (mainWindow
                ? dialog.showMessageBox(mainWindow, failureBox)
                : dialog.showMessageBox(failureBox));
              return;
            }
            app.quit();
          });
        });
      });
    });
  };

  // win32: no app menu bar — production users need none of it (reload/
  // devtools/zoom are developer affordances; quitting stays on the tray).
  // null clears the menu bar entirely; the tray context menu below is
  // unaffected.
  // darwin: a minimal role menu is mandatory (Cmd+Q/Cmd+W bindings,
  // clipboard key equivalents, "bring all to front"); viewMenu (reload/
  // devtools) is dev-only, same developer-affordance call as win32.
  if (shouldInstallRoleMenu(IS_DARWIN ? "darwin" : "win32")) {
    const spec = darwinRoleMenu(!app.isPackaged);
    const entry = (e: { role?: string; separator?: boolean }): Electron.MenuItemConstructorOptions =>
      e.separator === true
        ? { type: "separator" }
        : e.role === "__sd_uninstall_data__"
          ? {
              label: "卸载与数据清理…",
              click: () => showUninstallDialog(),
            }
          : { role: e.role as Electron.MenuItemConstructorOptions["role"] };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { ...spec.appMenu, submenu: spec.appMenu.submenu.map(entry) },
      { ...spec.editMenu, submenu: spec.editMenu.submenu.map(entry) },
      ...(spec.viewMenu ? [{ ...spec.viewMenu, submenu: spec.viewMenu.submenu.map(entry) }] : []),
      { ...spec.windowMenu, submenu: spec.windowMenu.submenu.map(entry) },
      ...(spec.helpMenu ? [{ label: spec.helpMenu.label, submenu: spec.helpMenu.submenu.map(entry) }] : []),
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  buildTray();
  createWindow();
  SD_PERF("window-created");

  // Auto-update (B4-3, F11 conservative policy — D4 §5): armed only in
  // packaged builds; the update-source URL comes from the publish section
  // embedded by electron-builder (B4-2's yml block is the frozen truth).
  // Dev builds never hit the feed.
  if (updateEnabled(app.isPackaged)) {
    setupAutoUpdate({
      app,
      autoUpdater,
      log,
      prompt: async version => {
        const answer = await dialog.showMessageBox({
          type: "info",
          title: "ScienceDiscovery 更新",
          message: `新版本 ${version} 可用`,
          detail: "下载并安装更新？你可以稍后再装——检查会定期重新提醒。",
          buttons: ["下载并安装", "暂不更新"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return answer.response === 0;
      },
      notify: (kind, detail) => {
        log(`update: ${kind} ${detail}`);
        if (Notification.isSupported() && mainWindow) {
          const body = kind === "downloading" ? `正在下载新版本 ${detail}…`
            : kind === "ready" ? "更新已就绪，即将重启安装"
            : kind === "drain-blocked" ? detail
            : `更新失败：${detail}`;
          new Notification({ title: "ScienceDiscovery 更新", body }).show();
        }
      },
      stackFacts: () => ({
        // F9: a reused (not spawned) backend is just as live — the drain
        // gate must block on it too, or the update swaps the .app under a
        // python tree this shell merely adopted.
        hasHandle: stack !== null || externalStackAlive,
        stopInFlight: stackStopInFlight,
      }),
      stopStack: async () => {
        const s = stack;
        if (s && stackOwnedByShell) {
          stack = null;
          stackStopInFlight = true;
          try { await s.stop(); } finally { stackStopInFlight = false; }
          return;
        }
        if (externalStackAlive) {
          // F9: the stack survived a previous shell (crash / force-quit) and
          // this session reused it. Stop it by pid so the install cannot
          // race a live python tree. The flag clears optimistically; a
          // still-healthy backend on the next start just re-marks it.
          const healthPort = parseInt(new URL(currentEndpoints?.health ?? "http://127.0.0.1:4410/api/health").port || "4410", 10);
          stackStopInFlight = true;
          try { await stopExternalStack(healthPort, log); }
          finally { stackStopInFlight = false; externalStackAlive = false; }
        }
      },
      // F8: "drain gate blocked" must not be a dead end — offer the stop-
      // and-install path. Confirmed → stopStack resolves after the tree is
      // gone → the updater's pending install fires (visible restart).
      // F15: 「暂不安装」 → dropPending so the 6h checks resume (the
      // update re-offers next check) instead of freezing the session.
      onDrainBlocked: (message) => {
        void dialog.showMessageBox(mainWindow!, {
          type: "warning",
          title: "ScienceDiscovery 更新",
          message: message,
          detail: "选择「停止并安装」将停止后端进程并立即重启安装更新；选「暂不安装」将在下次检查时再次提醒。",
          buttons: ["暂不安装", "停止并安装"],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        }).then(({ response }) => {
          if (response === 1) {
            log("update: user chose stop-and-install from the drain-blocked dialog");
            drainRetryInstall?.();
          } else {
            log("update: user deferred the install from the drain-blocked dialog");
            drainDropPending?.();
          }
        });
      },
      registerDrainRetry: (retry) => { drainRetryInstall = retry; },
      registerDrainDismiss: (dismiss) => { drainDropPending = dismiss; },
    });
  }

  if (wizardMode) {
    wizardData = wizardState ?? { step: "data-dir" };
    registerWizardIpc(proxyEnv);
    void mainWindow?.loadFile(join(distDir, "wizard.html"));
    SD_PERF("wizard-mode-enter");
  } else {
    // The window shows the local loading page while we probe and (if needed)
    // cold-start the stack; loadUi replaces it once healthy.
    // Extracted into startupFlow so the loading page's retry button reruns
    // the exact same flow.
    startupProxyEnv = proxyEnv;
    startupFlowInFlight = true;
    await startupFlow(proxyEnv).finally(() => { startupFlowInFlight = false; });
  }

  app.on("activate", () => openMainWindow());
});

app.on("window-all-closed", () => {
  // win32 convention: stay alive in tray until the user quits from the
  // tray. darwin: stay alive too — Dock icon + backend keep running; the
  // activate handler recreates the window (decision in shell-platform.ts).
  if (shouldQuitOnAllWindowsClosed(IS_DARWIN ? "darwin" : "win32", tray !== null)) app.quit();
});

app.on("will-quit", event => {
  stopConsoleSweep();
  clearAgentWatch();
  stackDeathWatchSeq += 1; // quitting stops the owned stack on purpose, not a crash
  clearStackStableTimer();
  if (stack && stackOwnedByShell) {
    event.preventDefault();
    stackStopInFlight = true;
    void stack.stop().finally(() => { stack = null; stackStopInFlight = false; app.quit(); });
  }
});
