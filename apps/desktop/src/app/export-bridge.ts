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
 *   streamBegin/streamChunk/streamEnd/streamAbort   — the same destination,
 *                              written chunk by chunk so a multi-GiB archive is
 *                              never held in one buffer on either side
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

/** What the save dialog shows. A research package and a Skill ZIP are
 *  different files, so the caller names its own title and filter; without
 *  this the dialog offered the research filter for a `.zip`. */
export interface ExportSaveOptions {
  buttonLabel?: string;
  filters?: Array<{ extensions: string[]; name: string }>;
  title?: string;
}

export interface ExportShellBridge {
  saveDialog: (suggestedName: string, options?: ExportSaveOptions) => Promise<ExportSaveResult>;
  write: (token: string, data: ArrayBuffer, meta?: ExportWriteMeta) => Promise<{ ok: boolean }>;
  /** Streaming write (a 5 GiB archive must not arrive as one ArrayBuffer).
   *  Missing on an older shell: callers fall back to `write`. */
  streamBegin?: (token: string) => Promise<{ ok: boolean }>;
  streamChunk?: (token: string, data: ArrayBuffer) => Promise<{ ok: boolean }>;
  streamEnd?: (token: string, meta?: ExportWriteMeta) => Promise<{ ok: boolean }>;
  streamAbort?: (token: string) => Promise<{ ok: boolean }>;
  showInFolder: (token: string) => Promise<{ ok: boolean }>;
  downloadsDir: () => Promise<string>;
}

/** What the shell records with a finished write: which export task it was, the
 *  session it came from, and the package profile. The shell keeps the path; the
 *  renderer only says what the row is about. */
export interface ExportWriteMeta {
  recordId?: string;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  level?: "necessary" | "complete";
}

/** One row of the shell's durable export history. `directory` and `exists` are
 *  for display only — the row's only handle is `token`. */
export interface ExportHistoryRow {
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
}

export interface ExportHistoryBridge {
  list: () => Promise<ExportHistoryRow[]>;
  reveal: (token: string) => Promise<{ missing: boolean; ok: boolean }>;
  forget: (id: string) => Promise<{ ok: boolean }>;
}

/** The export bridge, or null when the app is not running inside the shell. */
export function exportShellBridge(): ExportShellBridge | null {
  if (typeof window === "undefined") return null;
  const shell = (window as typeof window & { sdShell?: { exportFile?: ExportShellBridge } }).sdShell;
  const bridge = shell?.exportFile;
  if (!bridge || typeof bridge.saveDialog !== "function" || typeof bridge.write !== "function") return null;
  return bridge;
}

/** True when the shell exposes the streaming write (older shells do not). */
export function canStreamExport(bridge: ExportShellBridge): boolean {
  return typeof bridge.streamBegin === "function"
    && typeof bridge.streamChunk === "function"
    && typeof bridge.streamEnd === "function";
}

/**
 * Forward an archive body to the shell chunk by chunk.
 *
 * The shell keeps the destination open for the length of the transfer, writes
 * each chunk as it arrives, and only marks the destination written at `streamEnd`.
 * A failure anywhere aborts, which deletes the partial archive rather than
 * leaving a truncated file that the next attempt would treat as complete.
 */
export async function writeExportStream(
  bridge: ExportShellBridge,
  token: string,
  body: ReadableStream<Uint8Array>,
  meta?: ExportWriteMeta,
): Promise<void> {
  if (!canStreamExport(bridge)) throw new Error("The shell does not support streaming saves.");
  await bridge.streamBegin!(token);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      // A view can sit inside a larger buffer; slice so only its own bytes cross
      // the IPC boundary.
      const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
      await bridge.streamChunk!(token, chunk);
    }
    await bridge.streamEnd!(token, meta);
  } catch (reason) {
    // Cancelling the body also ends the server's write: the sync GET route streams into
    // the response, so an abandoned reader would leave it producing an archive nobody
    // consumes (#1216 F3).
    await reader.cancel().catch(() => undefined);
    await bridge.streamAbort!(token).catch(() => undefined);
    throw reason;
  } finally {
    reader.releaseLock();
  }
}

/** The durable export history, or null outside the shell (a browser keeps no
 *  export history: it has no token to reveal, and nothing was saved by the
 *  product rather than by the browser's own download manager). */
export function exportHistoryBridge(): ExportHistoryBridge | null {
  if (typeof window === "undefined") return null;
  const shell = (window as typeof window & { sdShell?: { exportHistory?: ExportHistoryBridge } }).sdShell;
  const bridge = shell?.exportHistory;
  if (!bridge || typeof bridge.list !== "function" || typeof bridge.forget !== "function") return null;
  return bridge;
}