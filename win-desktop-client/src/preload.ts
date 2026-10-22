// Preload (F7.3): runs before the SD web app on 127.0.0.1:4310 and injects the
// local access token into the page origin's storage — the "完全无感" flow of D5.4
// (preload injection replaces the plain URL-fragment flow: the write happens
// here, in preload, and the fragment is stripped before any page JS runs).
//
// The main process loads the UI as http://127.0.0.1:4310/#token=<token>. This
// script moves it into localStorage under the web app's own TOKEN_STORAGE_KEY
// ("sciencediscovery-token", apps/web/src/browser-storage.ts) so every API call
// carries it as Bearer, then strips the fragment exactly like the app's loader.
//
// It also exposes window.sdShell for the shell's own pages:
//   - saveToken (F7.3 token-entry fallback page)
//   - wizard (F8 first-run wizard; all backend HTTP stays in the main process,
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
  /** F10.6e2: open <userData>\logs (shell.log lives there). */
  openLogs: (): Promise<string> => ipcRenderer.invoke("sd-shell:wizard-open-logs"),
  retryBackend: (path: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sd-shell:wizard-backend-retry", path),
  selfCheck: (): Promise<unknown> => ipcRenderer.invoke("sd-shell:wizard-self-check"),
  // F8.2: optional model configuration step (simplified connect form).
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
  /** Fallback page: persist a user-provided token, then reconnect. */
  saveToken: (token: string): Promise<boolean> => ipcRenderer.invoke("sd-shell:save-token", token),
  /** F10.6e loading page: live startup stage pushed by the main process. */
  onLoadingStage: (callback: (stage: {
    stage: string;
    text: string;
    /** 1-based step number and total steps ("step 3/8"). */
    current: number;
    total: number;
    /** Pre-formatted remaining-time hint, e.g. "约还需 2 分钟" ("" when unknown). */
    estimate: string;
    /** W9: raw remaining seconds (0 when unknown) for the page's live countdown. */
    estimateSec: number;
  }) => void): void => {
    ipcRenderer.on("sd-shell:loading-stage", (_event, value) => callback(value));
  },
  /** W4 loading page: rerun the backend startup flow (slow/error states). */
  retryBackend: (): Promise<void> => ipcRenderer.invoke("sd-shell:retry-backend"),
  /** First-run wizard (F8). */
  wizard,
});
