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

import { TEXT } from "../text.js";
import { exportShellBridge } from "./export-bridge.js";

/** The browser save picker, where the platform has one. Chromium exposes it
 *  on a secure origin; Firefox and Safari do not, and fall back to a normal
 *  download. Only the declarations this file calls are named, so no DOM lib
 *  upgrade is needed to use it. */
interface BrowserFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ accept: Record<string, string[]>; description?: string }>;
  }) => Promise<{
    createWritable: () => Promise<{
      close: () => Promise<void>;
      write: (data: Blob) => Promise<void>;
    }>;
  }>;
}

/**
 * Save an exported Skill package under the name and directory the user picks.
 *
 * Inside the shell the native save dialog owns the destination and the
 * renderer only holds an opaque token, exactly as a research package export
 * does. A plain browser has no such bridge; where the File System Access API
 * exists it opens its own "save as" dialog, so the reader still chooses a
 * directory. A browser without that API falls back to its download manager.
 *
 * Returns false when the user cancelled the save dialog. That is not a
 * failure: nothing was written, and the pane should say nothing.
 */
export async function saveSkillPackage(name: string, bytes: ArrayBuffer): Promise<boolean> {
  const filename = `${name}.zip`;
  const dialog = TEXT.settings.skills.exportDialog;
  const bridge = exportShellBridge();
  if (bridge) {
    const destination = await bridge.saveDialog(filename, {
      buttonLabel: dialog.buttonLabel,
      filters: [{ extensions: ["zip"], name: dialog.filterName }],
      title: dialog.title,
    });
    if (destination.canceled || destination.token === null) return false;
    await bridge.write(destination.token, bytes);
    return true;
  }

  const picker = (window as BrowserFilePickerWindow).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker.call(window, {
        suggestedName: filename,
        types: [{ accept: { "application/zip": [".zip"] }, description: dialog.filterName }],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([bytes], { type: "application/zip" }));
      await writable.close();
      return true;
    } catch (reason) {
      // Cancelling the picker is the same answer as cancelling the shell's
      // dialog. A permission or platform refusal is not, and falls through to
      // the download below.
      if (reason instanceof DOMException && reason.name === "AbortError") return false;
    }
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
