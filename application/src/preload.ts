// Preload: runs before the SD web app on 127.0.0.1:4310 and injects the
// local access token into the page origin's storage — a fully invisible
// token flow (preload injection replaces the plain URL-fragment flow: the
// write happens here, in preload, and the fragment is stripped before any
// page JS runs).
//
// The main process loads the UI as http://127.0.0.1:4310/#token=<token>. This
// script moves it into localStorage under the web app's own TOKEN_STORAGE_KEY
// ("sciencediscovery-token", apps/web/src/browser-storage.ts) so every API call
// carries it as Bearer, then strips the fragment exactly like the app's loader.
//
// It also exposes window.sdShell for the shell's own pages:
//   - saveToken (token-entry fallback page)
//   - wizard (first-run wizard; all backend HTTP stays in the main process,
//     so the model key never touches renderer storage or a file:// origin)

import { contextBridge, ipcRenderer } from "electron";

const TOKEN_KEY = "sciencediscovery-token";

function injectFromUrl(): boolean {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token")?.trim();
  if (!token) return false;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return false;
  }
  fragment.delete("token");
  const url = new URL(window.location.href);
  url.hash = fragment.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

const injected = injectFromUrl();

const wizard = {
  getState: (): Promise<{
    step: "data-dir" | "starting" | "model" | "done";
    dataDir: string | null;
    defaultDataDir: string;
  }> => ipcRenderer.invoke("sd-shell:wizard-get-state"),
  browseDir: (): Promise<string | null> => ipcRenderer.invoke("sd-shell:wizard-browse-dir"),
  checkDir: (path: string): Promise<unknown> => ipcRenderer.invoke("sd-shell:wizard-check-dir", path),
  confirmDir: (path: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("sd-shell:wizard-confirm-dir", path),
  backendStatus: (): Promise<{ status: "idle" | "starting" | "healthy" | "failed"; epoch: number | null; message?: string }> =>
    ipcRenderer.invoke("sd-shell:wizard-backend-status"),
  /** Open the shell's logs folder (shell.log lives there). */
  openLogs: (): Promise<string> => ipcRenderer.invoke("sd-shell:wizard-open-logs"),
  retryBackend: (path: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:wizard-backend-retry", path),
  selfCheck: (): Promise<unknown> => ipcRenderer.invoke("sd-shell:wizard-self-check"),
  // Optional model configuration step (simplified connect form).
  listProviderPresets: (): Promise<{ presets: unknown[]; providers: unknown[] }> =>
    ipcRenderer.invoke("sd-shell:wizard-list-provider-presets"),
  previewProviderModels: (body: unknown): Promise<{ models: unknown[] }> =>
    ipcRenderer.invoke("sd-shell:wizard-preview-provider-models", body),
  createProvider: (body: unknown): Promise<unknown> =>
    ipcRenderer.invoke("sd-shell:wizard-create-provider", body),
  updateProvider: (providerId: string, body: unknown): Promise<unknown> =>
    ipcRenderer.invoke("sd-shell:wizard-update-provider", providerId, body),
  addProviderModel: (providerId: string, body: unknown): Promise<unknown> =>
    ipcRenderer.invoke("sd-shell:wizard-add-provider-model", providerId, body),
  testModel: (modelId: string): Promise<unknown> =>
    ipcRenderer.invoke("sd-shell:wizard-test-model", modelId),
  setDefaultModel: (modelId: string): Promise<unknown> =>
    ipcRenderer.invoke("sd-shell:wizard-set-default-model", modelId),
  skipModel: (): Promise<void> => ipcRenderer.invoke("sd-shell:wizard-skip-model"),
  finish: (): Promise<void> => ipcRenderer.invoke("sd-shell:wizard-finish"),
};

/** Study-package export helpers: native save dialog, destination-bound write,
 *  "open file location" and the OS downloads directory. The main process keeps
 *  the chosen path and hands the renderer an opaque token, so the renderer can
 *  never name a file of its own choosing.
 *
 *  `write` also carries the export's own metadata (which task, which session,
 *  which profile): the main process records the finished export in the durable
 *  history, so the row keeps the token that can still reveal it after a
 *  restart.
 *
 *  The stream* channels write the same archive chunk by chunk, so a multi-GiB
 *  package is never held as one ArrayBuffer; `streamEnd` carries the same
 *  metadata and records the same history row. */
const exportFile = {
  saveDialog: (
    suggestedName: string,
    options?: {
      buttonLabel?: string;
      filters?: Array<{ extensions: string[]; name: string }>;
      title?: string;
    },
  ): Promise<{ canceled: boolean; token: string | null }> =>
    ipcRenderer.invoke("sd-shell:export-save-dialog", { options, suggestedName }),
  write: (token: string, data: ArrayBuffer, meta?: {
    recordId?: string;
    projectId?: string;
    sessionId?: string;
    sessionTitle?: string;
    level?: "necessary" | "complete";
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-write", { token, data, meta }),
  streamBegin: (token: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-stream-begin", token),
  streamChunk: (token: string, data: ArrayBuffer): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-stream-chunk", { token, data }),
  streamEnd: (token: string, meta?: {
    recordId?: string;
    projectId?: string;
    sessionId?: string;
    sessionTitle?: string;
    level?: "necessary" | "complete";
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-stream-end", { token, meta }),
  streamAbort: (token: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-stream-abort", token),
  showInFolder: (token: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-show-in-folder", token),
  downloadsDir: (): Promise<string> => ipcRenderer.invoke("sd-shell:export-downloads-dir"),
};

/** The account session's storage, kept by the main process behind safeStorage.
 *  Synchronous to match the Storage interface `packages/account-session` uses;
 *  a read/write only happens on sign-in and rotation. */
const accountSessionStorage = {
  getItem: (key: string): string | null => {
    const value: unknown = ipcRenderer.sendSync("sd-shell:account-session-read", key);
    return typeof value === "string" ? value : null;
  },
  setItem: (key: string, value: string): void => {
    ipcRenderer.sendSync("sd-shell:account-session-write", key, value);
  },
  removeItem: (key: string): void => {
    ipcRenderer.sendSync("sd-shell:account-session-remove", key);
  },
};

/** HUAWEI sign-in through the system browser. The main process starts a
 *  one-shot loopback server and returns its callback URL; the renderer builds
 *  the account-service sign-in URL with it as `returnUrl` and asks the shell to
 *  open it in the default browser. The ticket comes back as an IPC event.
 *  A plain browser has no bridge: the SPA keeps its in-page navigation. */
const accountSignIn = {
  begin: (): Promise<{ callbackUrl: string }> => ipcRenderer.invoke("sd-shell:account-signin-begin"),
  open: (url: string): Promise<void> => ipcRenderer.invoke("sd-shell:account-signin-open", url),
  cancel: (): Promise<void> => ipcRenderer.invoke("sd-shell:account-signin-cancel"),
  onResult: (callback: (result: { ticket?: string; error?: string }) => void): (() => void) => {
    const listener = (_event: unknown, value: { ticket?: string; error?: string }) => callback(value);
    ipcRenderer.on("sd-shell:account-signin-result", listener);
    return () => ipcRenderer.removeListener("sd-shell:account-signin-result", listener);
  },
};

/** The durable list of finished exports (#1154). Rows carry no filesystem path
 *  the renderer could use for a write: the folder is for display, the token is
 *  the only handle it may hand back. */
const exportHistory = {
  list: (): Promise<Array<{
    bytes: number;
    directory: string;
    exists: boolean;
    filename: string;
    id: string;
    level?: "necessary" | "complete";
    projectId?: string;
    savedAt: string;
    sessionId?: string;
    sessionTitle?: string;
    token: string;
  }>> => ipcRenderer.invoke("sd-shell:export-history-list"),
  reveal: (token: string): Promise<{ missing: boolean; ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-history-reveal", token),
  forget: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:export-history-forget", id),
};

contextBridge.exposeInMainWorld("sdShell", {
  tokenInjected: injected,
  /** Platform tag for the shell's own pages ("win32" | "darwin" | "linux"),
   *  so Windows-specific copy (antivirus hints, MAX_PATH advice) can be
   *  swapped without UA sniffing. Truth comes from the main process's world,
   *  not the renderer. */
  platform: process.platform,
  /** Takeover: the shell wizard (data directory) and the startup flow
   *  always complete before any SPA is loaded in this app — loadUi happens
   *  only after the stack is healthy, which only happens after the data-dir
   *  confirm. So the SPA's own wizard can open straight at model
   *  configuration instead of re-asking workspace/boot. A plain browser has
   *  no shell → the SPA keeps its full three-step flow. */
  wizardIntroDone: true,
  /** Fallback page: persist a user-provided token, then reconnect. */
  saveToken: (token: string): Promise<boolean> => ipcRenderer.invoke("sd-shell:save-token", token),
  /** The SPA reports its locale choice so the shell can hand it to the
   *  fail-closed page (a different origin that cannot read the SPA's
   *  localStorage — F13). Best-effort: no return value the SPA needs. */
  reportLocale: (locale: "zh-CN" | "en"): void => {
    try { void ipcRenderer.invoke("sd-shell:report-locale", locale); } catch { /* cosmetic mirror */ }
  },
  /** Loading page: live startup stage pushed by the main process. */
  onLoadingStage: (callback: (stage: {
    stage: string;
    text: string;
    /** 1-based step number and total steps ("step 3/8"). */
    current: number;
    total: number;
    /** Pre-formatted remaining-time hint, e.g. "about 2 min left" ("" when unknown). */
    estimate: string;
    /** Raw remaining seconds (0 when unknown) for the page's live countdown. */
    estimateSec: number;
  }) => void): void => {
    ipcRenderer.on("sd-shell:loading-stage", (_event, value) => callback(value));
  },
  /** Loading page: rerun the backend startup flow (slow/error states). */
  retryBackend: (): Promise<void> => ipcRenderer.invoke("sd-shell:retry-backend"),
  /** Receive JiuwenSwarm readiness/progress updates after the main UI
   *  loads, so the app can disable chat until the cluster is actually
   *  ready. Returns an unsubscribe function so an unmounted listener can
   *  take its ipcRenderer listener back down. */
  onJiuwenState: (callback: (state: {
    ready: boolean;
    elapsed?: number;
    attempt?: number;
    message?: string;
  }) => void): (() => void) => {
    const listener = (_event: unknown, value: {
      ready: boolean;
      elapsed?: number;
      attempt?: number;
      message?: string;
    }) => callback(value);
    ipcRenderer.on("sd-shell:jiuwenswarm-state", listener);
    return () => ipcRenderer.removeListener("sd-shell:jiuwenswarm-state", listener);
  },
  /** Pull the current state once on mount — the
   *  first push races the renderer's listener registration and can be lost. */
  getJiuwenState: (): Promise<{
    ready: boolean;
    elapsed?: number;
    attempt?: number;
    message?: string;
  } | null> => ipcRenderer.invoke("sd-shell:jiuwenswarm-get-state"),
  /** Account session storage, encrypted by the main process (safeStorage). */
  accountSessionStorage,
  /** HUAWEI sign-in through the system browser (one-shot loopback callback). */
  accountSignIn,
  /** First-run wizard. */
  wizard,
  /** Study-package export helpers (undefined outside the shell). */
  exportFile,
  /** Finished exports, kept across restarts (#1154). */
  exportHistory,
  /** [mac-direct] 设置 › 连接 › 沙箱网络 reads/writes the installation-level opt-in for
   *  direct candidate execution. Only a darwin shell answers `available: true`
   * (Windows hard-sets the env flag it implies, a plain browser has no shell),
   * so the settings row renders only where the answer says it exists. The
   * write replies with the re-read persisted value — a failed write shows up
   * as the toggle bouncing back rather than a stale switch. */
  directExecution: {
    get: (): Promise<{ available: boolean; enabled: boolean }> =>
      ipcRenderer.invoke("sd-shell:direct-execution-get"),
    set: (enabled: boolean): Promise<{ available: boolean; enabled: boolean }> =>
      ipcRenderer.invoke("sd-shell:direct-execution-set", enabled),
  },
  /** [U5c] This session's sandbox probe verdict, read by the settings row's
   *  status line — the one place sandbox health is surfaced (owner decision
   *  2026-11-23: the boot neither blocks nor mentions the sandbox). Replies
   *  `{ kind: "failed", reason, diagnostics }` when the probe failed (the
   *  session then runs unsandboxed, and the per-run confirmation stays armed
   *  for evolution candidates), or `{ kind: "ok" | "not-applicable" }`.
   *  A plain browser has no bridge at all. Pull on demand: the verdict is
   *  decided once in whenReady and never changes while the app runs. */
  seatbeltStatus: (): Promise<
    | { kind: "ok"; platform: "darwin"; directActive: boolean; modeKnown: boolean }
    | {
      kind: "failed";
      platform: "darwin";
      reason: string;
      diagnostics: string[];
      detail: { failCode: "spawn-error" | "signal" | "exit-code"; signal?: string; exitCode?: number; spawnError?: string };
      directActive: boolean;
      modeKnown: boolean;
    }
    | null
  > => ipcRenderer.invoke("sd-shell:seatbelt-status-get"),
  // [U5c] The U4 seatbeltOptIn bridge (error-page authorize-and-relaunch)
  // is retired with the Seatbelt gate itself, and the U5 ready-page banner
  // is retired with the wizard's seatbelt fields: sandbox health shows in
  // 设置 › 连接 › 沙箱网络's status row alone. The settings switch above remains the
  // one installation-level entrance.
});
