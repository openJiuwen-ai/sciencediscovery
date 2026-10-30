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

contextBridge.exposeInMainWorld("sdShell", {
  tokenInjected: injected,
  /** Takeover: the shell wizard (data directory) and the startup flow
   *  always complete before any SPA is loaded in this app — loadUi happens
   *  only after the stack is healthy, which only happens after the data-dir
   *  confirm. So the SPA's own wizard can open straight at model
   *  configuration instead of re-asking workspace/boot. A plain browser has
   *  no shell → the SPA keeps its full three-step flow. */
  wizardIntroDone: true,
  /** Fallback page: persist a user-provided token, then reconnect. */
  saveToken: (token: string): Promise<boolean> => ipcRenderer.invoke("sd-shell:save-token", token),
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
  /** First-run wizard. */
  wizard,
});
