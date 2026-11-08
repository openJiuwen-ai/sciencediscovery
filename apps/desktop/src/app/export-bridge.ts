// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Shell bridge: study-package export save integration.
 *
 * The Electron preload installs `window.sdShell.exportFile`:
 *
 *   saveDialog(suggestedName) → { canceled, token } — native "save as"; the
 *                              chosen path stays in the main process
 *   write(token, data)        → { ok }              — destination-bound write
 *   showInFolder(token)       → { ok }              — reveal in the OS manager
 *   downloadsDir()            → string              — the OS downloads folder
 *
 * The renderer only ever handles the opaque token, never a filesystem path, so
 * nothing it sends can address a file the user did not pick. In a plain browser
 * none of this exists: callers fall back to a browser download, whose own save
 * prompt is the browser platform's supported equivalent of choosing a
 * destination. No Electron import, so the app keeps running outside the shell.
 */

export interface ExportSaveResult {
  canceled: boolean;
  /** Opaque destination token; null when the dialog was cancelled. */
  token: string | null;
}

export interface ExportShellBridge {
  saveDialog: (suggestedName: string) => Promise<ExportSaveResult>;
  write: (token: string, data: ArrayBuffer) => Promise<{ ok: boolean }>;
  showInFolder: (token: string) => Promise<{ ok: boolean }>;
  downloadsDir: () => Promise<string>;
}

/** The export bridge, or null when the app is not running inside the shell. */
export function exportShellBridge(): ExportShellBridge | null {
  if (typeof window === "undefined") return null;
  const shell = (window as typeof window & { sdShell?: { exportFile?: ExportShellBridge } }).sdShell;
  const bridge = shell?.exportFile;
  if (!bridge || typeof bridge.saveDialog !== "function" || typeof bridge.write !== "function") return null;
  return bridge;
}