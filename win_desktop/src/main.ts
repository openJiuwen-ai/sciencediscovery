// sd-shell main process — window / stack lifecycle / menu+tray / port epochs
// + system proxy mirroring / first-run wizard (data dir → model config →
// self-check gate). Behaviour decisions: wizard steps (the model key is
// submitted once through the backend API and never persisted by the shell),
// token invisible to the user (401 → token-entry fallback page), and close
// hides to tray (real quit via tray menu — the full running-task
// confirmation drain is out of scope for this feature).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell as electronShell, Tray } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { bootstrapPackaged, needsUnpack, packagedEnv, packagedPaths, type PackagedPaths } from "./bootstrap.ts";
import { healthUrl, resolveDataDir, resolveRepoRoot, tokenFilePath, uiUrl } from "./config.ts";
import { provisioningLineToStage, STAGE_TEXTS, stackLineToStage, stageProgress } from "./loading-stage.ts";
import {
  epochFromEnv, firstFreeEpoch, healthUrlForPorts, MAX_PORT_EPOCH,
  portsForEpoch, probeHealthyEpoch, stackEnvForPorts, uiUrlForPorts, type StackPorts,
} from "./ports.ts";
import { parseRegDword, parseRegQueryValue, proxyEnvFromSystem } from "./proxy.ts";
import { COLD_BACKEND_TIMEOUT_MS, killStackTree, spawnStack, startupBudgetMs, summarizeStackFailure, waitHealthy, waitHealthyOrExited, type StackHandle } from "./stack.ts";
import { shouldRetryUiLoad, UI_LOAD_RETRY_LIMIT, uiLoadRetryDelayMs, waitForUiOrigin } from "./ui-retry.ts";
import { loadWindowState, saveWindowState } from "./window-state.ts";
import {
  effectiveDataDir, loadWizardState, needsWizard, pidAlive, saveWizardState, type WizardState,
} from "./wizard-state.ts";
import { defaultDataDir, probeDataDir } from "./wizard-data-dir.ts";
import {
  runSelfCheck,
} from "./wizard-api.ts";
import { type AgentInfo } from "./agent-ready.ts";

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
  return app.isPackaged
    ? join(dirname(app.getPath("exe")), "logs")
    : join(app.getPath("userData"), "logs");
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let stack: StackHandle | null = null;
let stackOwnedByShell = false;
/** Data dir the owned stack was spawned with (dir change → stop + respawn). */
let stackDir: string | null = null;
let quitConfirmed = false;
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
function showLoading(): void {
  if (!mainWindow) return;
  // Each loading page is a fresh progress session — reset the monotonic
  // stage guard (see pushStage).
  maxStageStepShown = 0;
  void mainWindow.loadFile(join(distDir, "loading.html"));
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

/** Read the IE/system proxy from HKCU. Best-effort: any failure → null. */
async function readSystemProxy(): Promise<{ enabled: boolean; server: string } | null> {
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
  if (await waitHealthy(endpoints.health, 1_000, fetch)) {
    log("backend already healthy; reusing running stack");
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
    process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
    process.env.SCIENCE_AGENT_LAZY_JIUWEN = "1";
    const extraEnv: NodeJS.ProcessEnv = {
      ...(dataDir ? { SCIENCE_DISCOVERY_DATA_DIR: dataDir } : {}),
      ...stackEnvForPorts(ports),
      ...loopbackGuard,
      ...(proxyEnv ?? {}),
      SCIENCE_AGENT_IN_PLACE_ENVS: "1",
      SCIENCE_AGENT_LAZY_JIUWEN: "1",
    };
    if (packaged && dataDir) {
      provisioningThisRun = needsUnpack(dataDir, packaged.resourcesPath);
      await bootstrapPackaged(packaged, dataDir, stageAwareLog);
      Object.assign(extraEnv, packagedEnv(packaged, dataDir));
    }
    pushStage("stack");
    stackErrTail.length = 0; // per-spawn failure tail
    stack = spawnStack(process.execPath, repoRoot, extraEnv, stageAwareLog);
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

// --- daily startup flow (extracted so the loading page's retry reruns it) ------

let startupProxyEnv: NodeJS.ProcessEnv | null = null;
let startupFlowInFlight = false;

async function startupFlow(proxyEnv: NodeJS.ProcessEnv | null): Promise<void> {
  // The window shows the local loading page while we probe and (if needed)
  // cold-start the stack; loadUi replaces it once healthy.
  showLoading();
  // Resolve the data dir first so the "connect" stage already reports the
  // correct step total (first run = 10 steps, daily = 8).
  const dataDir = effectiveDataDir(process.env, persistedWizard);
  provisioningThisRun = !!(packaged && dataDir && needsUnpack(dataDir, packaged.resourcesPath));
  pushStage("connect");
  const endpoints = await startupEndpoints(dataDir);
  currentEndpoints = endpoints;
  const healthy = await ensureBackend(endpoints, proxyEnv, dataDir);
  if (healthy && !quitConfirmed) {
    void loadUi(endpoints, readToken(dataDir));
    watchAgentReady(endpoints, dataDir);
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
    process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
    process.env.SCIENCE_AGENT_LAZY_JIUWEN = "1";
    const extraEnv: NodeJS.ProcessEnv = {
      SCIENCE_DISCOVERY_DATA_DIR: dataDir,
      ...stackEnvForPorts(ports),
      ...loopbackGuard,
      ...(proxyEnv ?? {}),
      SCIENCE_AGENT_IN_PLACE_ENVS: "1",
      SCIENCE_AGENT_LAZY_JIUWEN: "1",
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

  ipcMain.handle("sd-shell:wizard-check-dir", (_event, path: unknown) => probeDataDir(String(path ?? "")));

  ipcMain.handle("sd-shell:wizard-confirm-dir", async (_event, path: unknown) => {
    const clean = String(path ?? "").trim();
    if (!clean) return { ok: false, message: "路径不能为空。" };
    const check = probeDataDir(clean);
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

  ipcMain.handle("sd-shell:wizard-self-check", async () => {
    const base = wizardApiBase();
    if (!base) throw new Error("后端尚未就绪，请稍候重试。");
    return runSelfCheck(base, wizardToken(), wizardRunnerBase(), fetch);
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
      sandbox: false, // preload needs DOM storage + contextBridge; no node beyond that
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
      showLoading();
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
    showLoading();
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

const appStartAt = Date.now();
void app.whenReady().then(async () => {
  log(`[perf] app ready elapsed=${Date.now() - appStartAt}ms`);
  // Be explicit that renderer traffic follows the Windows system proxy
  // (Chromium default, stated here so no one "fixes" it to direct).
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

  // No app menu bar — production users need none of it (reload/devtools/
  // zoom are developer affordances; quitting stays on the tray). null
  // clears the menu bar entirely; the tray context menu below is
  // unaffected.
  Menu.setApplicationMenu(null);
  buildTray();
  createWindow();

  if (wizardMode) {
    wizardData = wizardState ?? { step: "data-dir" };
    registerWizardIpc(proxyEnv);
    void mainWindow?.loadFile(join(distDir, "wizard.html"));
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
  // Windows convention: stay alive in tray until the user quits from the tray.
  if (!tray) app.quit();
});

app.on("will-quit", event => {
  stopConsoleSweep();
  clearAgentWatch();
  if (stack && stackOwnedByShell) {
    event.preventDefault();
    void stack.stop().finally(() => { stack = null; app.quit(); });
  }
});
