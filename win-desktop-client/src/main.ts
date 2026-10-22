// sd-shell main process — F7.2 window / F7.4 stack lifecycle / F7.5 menu+tray
// / F7.6 port epochs (审查#9) + system proxy mirroring (审查#10)
// / F8 first-run wizard (data dir → model config → self-check gate).
// Behaviour decisions: D5.1-D5.4 (wizard steps; the model key is submitted
// once through the backend API and never persisted by the shell — F8 设计笔记
// 决策 2), D5.4 (token invisible to the user; 401 → token-entry fallback
// page), D6.3-lite (close hides to tray; real quit via tray menu — the full
// running-task confirmation drain is F19, not this feature).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell as electronShell, Tray } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
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
import { loadWindowState, saveWindowState } from "./window-state.ts";
import {
  effectiveDataDir, loadWizardState, needsWizard, pidAlive, saveWizardState, type WizardState,
} from "./wizard-state.ts";
import { defaultDataDir, probeDataDir } from "./wizard-data-dir.ts";
import {
  runSelfCheck,
} from "./wizard-api.ts";

// Bundled as CJS by esbuild: the app path is the shell root in dev (`electron .`).
const shellDir = app.getAppPath();
const distDir = join(shellDir, "dist");
// F10 packaged layout: <install>\resources\{backend,python,envs-template,...}.
const packagedRoot = app.isPackaged ? process.resourcesPath : null;
const packaged: PackagedPaths | null = packagedRoot ? packagedPaths(packagedRoot) : null;
const log = (line: string): void => {
  console.log(`[sd-shell] ${line}`);
  logToDisk(line);
};
/** Fresh-machine provisioning (uv venvs + micromamba) can dwarf the F7 120s. */
const WIZARD_BACKEND_TIMEOUT_MS = 1_200_000;

// --- F10.6e2 shell log file ----------------------------------------------------
// GUI processes have no visible console — a colleague's first-run timeout was
// undiagnosable without a log. Every line through log() (incl. start-stack
// output) lands in <userData>\logs\shell.log; rotation keeps one 5MB backup.

const SHELL_LOG_MAX_BYTES = 5 * 1024 * 1024;
let shellLogFile: string | null = null;

function ensureShellLog(): string | null {
  if (shellLogFile) return shellLogFile;
  try {
    const dir = join(app.getPath("userData"), "logs");
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
// --- F8 wizard state ---
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

/** Resolved connection targets for this run (F7.6: epoch-shiftable). */
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

function loadUi(endpoints: Endpoints, token: string | null): void {
  if (!mainWindow) return;
  attachAuthFallback(endpoints);
  // Preload consumes the fragment before page JS runs (D5.4).
  const target = token ? `${endpoints.ui}/#token=${encodeURIComponent(token)}` : endpoints.ui;
  void mainWindow.loadURL(target);
}

function showFallback(): void {
  if (!mainWindow) return;
  void mainWindow.loadFile(join(distDir, "fallback.html"));
}

// --- F10.6e loading page -------------------------------------------------------

/** Show the local loading page (replaces the blank window during stack start). */
function showLoading(): void {
  if (!mainWindow) return;
  void mainWindow.loadFile(join(distDir, "loading.html"));
}

/** True while this run is provisioning (unpack + precompile) — widens the step total. */
let provisioningThisRun = false;

/** F10.6l: last stderr lines from the stack this shell spawned. start-stack's
 * fail() prints its reason to stderr, so this tail is what turns a dead
 * stack into a specific failure message instead of a silent 1200s wait.
 * Cleared right before every spawnStack call. */
const stackErrTail: string[] = [];
const STACK_ERR_TAIL_MAX = 12;

/** Push a startup stage to the loading page (no-op once the UI took over).
 * `text` overrides the default stage text (live provisioning sub-progress). */
function pushStage(stage: string, text?: string): void {
  const { current, total, estimateSec } = stageProgress(stage, provisioningThisRun);
  mainWindow?.webContents.send("sd-shell:loading-stage", {
    stage, text: text ?? STAGE_TEXTS[stage] ?? stage,
    current, total, estimate: estimateText(estimateSec),
    // W9: raw seconds so the loading page can run a live countdown between
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
  // F10.6l: collect the stack's stderr tail for fast-failure messages.
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

// --- F7.6 thin IO (decisions live in ports.ts / proxy.ts) -------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: 500 });
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(true));
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
      // F10.6p: the API bounds its health answer, but a degraded stack (e.g.
      // wedged runner) still needs ~2s to answer; an 800ms probe skipped it,
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
 * F10.6p: one bounded /api/health probe for diagnostics. Returns a short
 * state line ("HTTP 503 {…}", "HTTP 200 {…}", "unreachable (…)") — used by
 * the wizard timeout path so field logs name the failing stage.
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
 * Endpoints for a normal (post-wizard) launch (F7.6 审查#9): explicit env URLs
 * win; a pinned SD_SHELL_PORT_EPOCH next; then reuse a running stack — after
 * F8, only one verified to run on OUR data dir (a stale dev stack on another
 * dir must not capture the shell). Otherwise the first fully-free epoch.
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
    // Legacy dev path (no wizard state): reuse any healthy stack (F7 behavior).
    const running = await probeHealthyEpoch(fetch);
    if (running !== null) {
      log(`reusing already-running stack on port epoch ${running}`);
      return epochEndpoints(running);
    }
  }
  const free = await firstFreeEpoch(isPortFree);
  if (free === null) {
    log(`no free port epoch in 0..${MAX_PORT_EPOCH}; defaulting to epoch 0 and letting the stack report the conflict`);
    return epochEndpoints(0);
  }
  if (free > 0) log(`default port epoch busy; shell will start the stack on epoch ${free}`);
  return epochEndpoints(free);
}

// --- F10.6u: stray-console sweep (belt and suspenders) ------------------------
// Win11's default-terminal host gave the packaged first-run a VISIBLE console
// window for the jw entry python (field 2026-10-19; non-deterministic — the
// byte-identical spawn stayed clean in four replications). Prevention is L1
// (spawnDetached no longer passes detached on Windows); this sweep is the
// guaranteed backstop the user asked for: once the backend flow runs, any
// visible console window whose title points at one of OUR bundled pythons is
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
  // F10.6a: 1s first probe — ECONNREFUSED returns instantly anyway, the poll
  // interval means a 3s budget wasted ~2s before spawning the stack.
  if (await waitHealthy(endpoints.health, 1_000, fetch)) {
    log("backend already healthy; reusing running stack");
    return true;
  }
  const repoRoot = resolveRepoRoot(process.env, shellDir, packagedRoot);
  if (!existsSync(join(repoRoot, "scripts", "start-stack.mjs"))) {
    log(`backend entry not found under ${repoRoot}`);
    // W2: an installation problem is fatal and non-recoverable — surface it
    // on the loading page with a retry, never on the auth fallback (that
    // page is reserved for real 401s and its copy would mislead here).
    pushStage("error", `未找到后端程序（${repoRoot}）。请重新安装 ScienceDiscovery 后重试。`);
    return false;
  }
  // W3: if our earlier spawn from this session is still booting (a previous
  // wait gave up), wait on it again instead of stacking a second stack onto
  // the same ports.
  const prior = stack !== null && stack.running() ? stack : null;
  let handle: StackHandle;
  if (!prior) {
    const ports: StackPorts = portsForEpoch(endpoints.epoch ?? 0);
    // Proxy (审查#10): mirror the system proxy for the stack's outbound
    // traffic (plugin downloads, model connectivity); NO_PROXY keeps loopback
    // direct. If the shell itself inherited proxy vars but no system proxy is
    // configured, still pin the loopback bypass.
    const loopbackGuard: NodeJS.ProcessEnv = proxyEnv ? {} : {
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    };
    const extraEnv: NodeJS.ProcessEnv = {
      ...(dataDir ? { SCIENCE_DISCOVERY_DATA_DIR: dataDir } : {}),
      ...stackEnvForPorts(ports),
      ...loopbackGuard,
      ...(proxyEnv ?? {}),
    };
    if (packaged && dataDir) {
      provisioningThisRun = needsUnpack(dataDir, packaged.resourcesPath);
      await bootstrapPackaged(packaged, dataDir, stageAwareLog);
      Object.assign(extraEnv, packagedEnv(packaged, dataDir));
    }
    pushStage("stack");
    stackErrTail.length = 0; // F10.6l: per-spawn failure tail
    stack = spawnStack(process.execPath, repoRoot, extraEnv, stageAwareLog);
    startConsoleSweep(); // F10.6u: hide any stray console window (see sweep docs)
    stackOwnedByShell = true;
    stackDir = dataDir;
    handle = stack;
  } else {
    log("previous stack spawn is still running; waiting on it again");
    handle = prior;
  }
  // W1: staged budget. Cold start measured 2:23 (jw alone 101s) vs the old
  // flat 120s that misrouted to the auth fallback; provisioning keeps the
  // wizard's 1200s. SD_SHELL_STARTUP_TIMEOUT_MS overrides for testing.
  const budgetMs = startupBudgetMs(provisioningThisRun);
  // F10.6l: race the health wait against the process exiting — a dead
  // start-stack never binds the health port, so a pure poll would burn the
  // whole budget before the fallback page shows anything.
  const up = await waitHealthyOrExited(handle, endpoints.health, budgetMs, fetch);
  if (up.kind === "healthy") return true;
  if (up.kind === "exited") {
    const summary = summarizeStackFailure(up.code, stackErrTail);
    log(`backend stack exited early: ${summary}`);
    pushStage("error", `${summary} 可点击「重试」重新启动。`);
    return false;
  }
  // W1/W2/W3: budget exhausted but the stack is still booting. Do NOT open
  // the auth fallback (W2: reserved for real 401s, its copy misleads — the
  // token is fine). Keep the stack running, tell the loading page we are
  // still waiting with a retry affordance (W4), and keep watching in the
  // background — the UI loads itself the moment the stack turns healthy.
  log(`backend not healthy after ${Math.round(budgetMs / 1000)}s; keeping it running and watching in the background`);
  pushStage("slow", `后端启动较慢（已等 ${Math.round(budgetMs / 1000)} 秒），仍在等待；就绪后将自动进入主界面。`);
  watchBackendInBackground(endpoints, dataDir);
  return false;
}

// --- W3: background backend watch ---------------------------------------------

let backendWatchSeq = 0;

/**
 * After a startup timeout the stack keeps booting in the background
 * (F10.6e2 semantics: never kill it). Watch it and load the UI the moment it
 * turns healthy — zero user action. Any later watch or a manual retry
 * supersedes earlier ones (monotonic guard, same pattern as wizardEnsureRun).
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
      loadUi(endpoints, readToken(dataDir));
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

// --- W4: daily startup flow (extracted so the loading page's retry reruns it) ---

let startupProxyEnv: NodeJS.ProcessEnv | null = null;
let startupFlowInFlight = false;

async function startupFlow(proxyEnv: NodeJS.ProcessEnv | null): Promise<void> {
  // F10.6e: the window shows the local loading page while we probe and
  // (if needed) cold-start the stack; loadUi replaces it once healthy.
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
    loadUi(endpoints, readToken(dataDir));
    if (Notification.isSupported()) {
      new Notification({ title: "ScienceDiscovery", body: "后端已就绪" }).show();
    }
  }
  // W2: an unhealthy backend no longer opens the auth fallback. That page is
  // reserved for real 401s (attachAuthFallback). The failure modes are
  // already surfaced on the loading page by ensureBackend: "slow" keeps
  // watching in the background (W3) and "error" offers a retry.
}

ipcMain.handle("sd-shell:retry-backend", () => {
  if (startupFlowInFlight || wizardMode) return;
  startupFlowInFlight = true;
  backendWatchSeq += 1; // W3: a manual retry supersedes any background watch
  log("retry requested from the loading page");
  void startupFlow(startupProxyEnv).finally(() => { startupFlowInFlight = false; });
});

// --- F8 wizard backend orchestration ------------------------------------------

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
      // F10.6q: the full port set (memory-graph/evolve included) makes the
      // liveness signal stronger against pid reuse.
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
        // F10.6p: reap the spawn we gave up on — it runs on OUR data dir
        // (recorded by a previous run of this app), so leaving it alive leaks
        // its epoch ports and data-dir locks into every later session.
        const stalePid = wizardData.stackPid;
        if (stalePid) await killStackTree(stalePid, log);
      }
    }

    // 3. Stop a stack we own (failed leftover, or the dir changed via 上一步).
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
    const free = await firstFreeEpoch(isPortFree);
    const epoch = free ?? 0;
    const ports = portsForEpoch(epoch);
    const loopbackGuard: NodeJS.ProcessEnv = proxyEnv ? {} : {
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    };
    const extraEnv: NodeJS.ProcessEnv = {
      SCIENCE_DISCOVERY_DATA_DIR: dataDir,
      ...stackEnvForPorts(ports),
      ...loopbackGuard,
      ...(proxyEnv ?? {}),
    };
    if (packaged) {
      provisioningThisRun = needsUnpack(dataDir, packaged.resourcesPath);
      await bootstrapPackaged(packaged, dataDir, stageAwareLog);
      Object.assign(extraEnv, packagedEnv(packaged, dataDir));
    }
    stackErrTail.length = 0; // F10.6l: per-spawn failure tail
    const handle = spawnStack(process.execPath, repoRoot, extraEnv, stageAwareLog);
    startConsoleSweep(); // F10.6u: hide any stray console window (see sweep docs)
    stack = handle;
    stackOwnedByShell = true;
    stackDir = dataDir;
    wizardData = { ...wizardData, epoch, stackPid: handle.pid ?? undefined };
    saveWizardState(app.getPath("userData"), wizardData);
    currentEndpoints = epochEndpoints(epoch);
    // F10.6l: fail fast when the stack process dies. Previously the wizard
    // polled the health port for the full 1200s budget while start-stack had
    // already fail-fasted (field + local acid test 2026-10-17: 654s frozen
    // "step 8" with zero feedback). The stderr tail names the failing step.
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
    // F10.6e2: do NOT stop the stack on timeout — on slow disks first-run
    // provisioning legitimately outgrows the budget, and killing it forces a
    // full redo. Leave it running: the retry button adopts it via findOurStack
    // (token-verified) the moment it turns healthy; step 3 below still replaces
    // it if it is genuinely wedged.
    log("wizard: backend did not become healthy in time; leaving it running for the retry to adopt");
    // F10.6p: the API answers /api/health fast even while degraded (bounded
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
    const prevDir = wizardData.dataDir;
    // F10.8: the model-config step is gone — confirming the data dir moves
    // straight into the boot/self-check phase.
    wizardData = { step: "starting", dataDir: clean };
    saveWizardState(userData, wizardData);
    if (prevDir !== clean || wizardBackend.status === "idle" || wizardBackend.status === "failed") {
      void startWizardBackend(clean, proxyEnv);
    }
    return { ok: true };
  });

  ipcMain.handle("sd-shell:wizard-backend-status", () => wizardBackend);

  // F10.6e2: one-click access to the shell log (first-run failures were
  // undiagnosable without it). Service logs stay under <dataDir>\logs.
  ipcMain.handle("sd-shell:wizard-open-logs", () => {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    logToDisk(`logs folder opened: ${dir} (service logs: ${join(effectiveDataDir(process.env, wizardData) ?? "?", "logs")})`);
    void electronShell.openPath(dir);
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

  // F8.2: optional model configuration after backend self-check passes.
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
    if (currentEndpoints) loadUi(currentEndpoints, readToken(wizardData.dataDir ?? null));
  });

  ipcMain.handle("sd-shell:wizard-finish", () => {
    wizardData = { step: "done", dataDir: wizardData.dataDir, completedAt: new Date().toISOString() };
    saveWizardState(userData, wizardData);
    persistedWizard = wizardData;
    wizardMode = false;
    if (currentEndpoints) loadUi(currentEndpoints, readToken(wizardData.dataDir ?? null));
  });
}

// --- window / menu / tray (F7.2/F7.5) ------------------------------------------

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
  // F10.6i: renderer console errors → shell.log. The dist6 e2e caught a
  // renderer crash (null deref in enterStep2 froze the wizard) while every
  // backend log looked healthy — off the dev machine that failure mode is
  // invisible in the three-file diagnostic kit. Capture console warnings/
  // errors, renderer crashes, and load failures.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) { // 0 verbose, 1 info, 2 warning, 3 error
      logToDisk(`[renderer:${level === 3 ? "error" : "warn"}] ${message} (${sourceId}:${line})`);
    }
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    logToDisk(`[renderer:gone] reason=${details.reason} exitCode=${details.exitCode ?? ""}`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logToDisk(`[renderer:load-fail] ${code} ${desc} ${url}`);
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.on("close", event => {
    if (!quitConfirmed && tray) {
      // D6.3-lite (F7 scope): hide to tray. Full running-task confirmation is F19.
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
 * D5.4 fallback: a 401 from the API means the token is wrong/expired. The web
 * app calls /api/* on ITS OWN origin (relative fetch, auth.ts:56) — the UI
 * origin — so watch both it and the control-API origin (F8 drive-by fix: F7
 * only watched the health origin and missed renderer-origin 401s).
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

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "关于 ScienceDiscovery", click: () => { log(`sd-shell ${app.getVersion()} (Electron ${process.versions.electron})`); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray(): void {
  // F10.6f: real icon from the bundled dist/icon.png (build.mjs copies
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
    loadUi(currentEndpoints, readToken(effectiveDataDir(process.env, persistedWizard)));
  } else {
    // No endpoints yet (window closed during startup): the whenReady flow is
    // still working — show the loading page until it loads the UI or fallback.
    showLoading();
  }
}

ipcMain.handle("sd-shell:save-token", async (_event, token: string) => {
  const clean = String(token ?? "").trim();
  if (!clean) return false;
  persistToken(clean, effectiveDataDir(process.env, persistedWizard));
  if (currentEndpoints) loadUi(currentEndpoints, clean);
  return true;
});

void app.whenReady().then(async () => {
  // 审查#10: be explicit that renderer traffic follows the Windows system
  // proxy (Chromium default, stated here so no one "fixes" it to direct).
  void session.defaultSession.setProxy({ mode: "system" }).catch(() => { /* keep default */ });

  const systemProxy = await readSystemProxy();
  const proxyEnv = proxyEnvFromSystem(systemProxy);
  if (proxyEnv) log(`system proxy active; mirroring ${proxyEnv.HTTPS_PROXY} to the stack (loopback bypassed)`);

  // F8 gate: unfinished (or missing) wizard state → run the wizard instead of
  // loading the UI. The wizard configures the very things the stack needs
  // (data dir), so it must not depend on the backend being up.
  const wizardState = loadWizardState(app.getPath("userData"));
  persistedWizard = wizardState;
  wizardMode = needsWizard(wizardState);

  buildMenu();
  buildTray();
  createWindow();

  if (wizardMode) {
    wizardData = wizardState ?? { step: "data-dir" };
    registerWizardIpc(proxyEnv);
    void mainWindow?.loadFile(join(distDir, "wizard.html"));
  } else {
    // F10.6e/W4: the window shows the local loading page while we probe and
    // (if needed) cold-start the stack; loadUi replaces it once healthy.
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
  stopConsoleSweep(); // F10.6u
  if (stack && stackOwnedByShell) {
    event.preventDefault();
    void stack.stop().finally(() => { stack = null; app.quit(); });
  }
});
