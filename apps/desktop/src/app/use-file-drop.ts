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

import { useEffect, useRef, useState } from "react";

import { carriesFiles } from "./upload.js";

/**
 * Take a file drop anywhere in the window, and report whether one is hovering.
 *
 * The listeners are on `window` rather than on a drop target because the drop
 * target is the whole application: a user dragging a file has one intention and
 * should not have to find a rectangle for it. That is also why this is a hook
 * and not a component — there is no element to attach it to.
 *
 * The counter is the load-bearing part. `dragenter`/`dragleave` fire for every
 * element the pointer crosses on the way in, so a boolean would be cleared by
 * the leave of a child the pointer moved from, and the overlay would flicker
 * while the drag is still well inside the window. Only the transition from zero
 * to non-zero means "a drag arrived", and only back to zero means "it left".
 *
 * Both handlers are installed unconditionally, even while `enabled` is false,
 * so the browser's own "open the file" navigation is still suppressed: dropping
 * a file on a page that has no handler would otherwise replace the app.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  // The listener is installed once, so it cannot close over a changing prop.
  const latest = useRef({ enabled, onFiles });
  latest.current = { enabled, onFiles };

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles([...(event.dataTransfer?.types ?? [])])) return;
      depth.current += 1;
      if (latest.current.enabled) setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (transfer === null || !carriesFiles([...transfer.types])) return;
      // Without this the browser refuses the drop and opens the file instead.
      event.preventDefault();
      if (latest.current.enabled) transfer.dropEffect = "copy";
    };
    // Deliberately unchecked: a `dragleave` whose `types` came back empty would
    // leave the counter stuck above zero and the overlay on screen forever. A
    // drag that carries no files never incremented it, so decrementing is free.
    const onDragLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      reset();
      if (latest.current.enabled) latest.current.onFiles(files);
    };
    // Bind each handler once and keep its own unbind, so the four listeners
    // cannot drift apart between mounting and cleanup.
    const bind = <K extends keyof WindowEventMap>(
      type: K,
      handler: (event: WindowEventMap[K]) => void,
    ) => {
      window.addEventListener(type, handler);
      return () => window.removeEventListener(type, handler);
    };
    const unbind = [
      bind("dragenter", onDragEnter),
      bind("dragover", onDragOver),
      bind("dragleave", onDragLeave),
      bind("drop", onDrop),
    ];
    return () => {
      for (const off of unbind) off();
    };
  }, []);

  return dragging;
}
