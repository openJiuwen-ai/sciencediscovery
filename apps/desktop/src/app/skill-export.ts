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

import { exportShellBridge } from "./export-bridge.js";

/**
 * Save an exported Skill package under the name the user picks.
 *
 * Inside the shell the native save dialog owns the destination and the
 * renderer only holds an opaque token, exactly as a research package export
 * does. In a plain browser there is no dialog to hand the archive to, so the
 * download falls back to the browser's own save prompt — the equivalent
 * destination choice on that platform.
 *
 * Returns false when the user cancelled the save dialog. That is not a
 * failure: nothing was written, and the pane should say nothing.
 */
export async function saveSkillPackage(name: string, bytes: ArrayBuffer): Promise<boolean> {
  const filename = `${name}.zip`;
  const bridge = exportShellBridge();
  if (bridge) {
    const destination = await bridge.saveDialog(filename);
    if (destination.canceled || destination.token === null) return false;
    await bridge.write(destination.token, bytes);
    return true;
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
