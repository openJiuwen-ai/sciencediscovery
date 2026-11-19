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
 * What the search field's shortcut chip says on this platform. The handler
 * accepts Ctrl or Cmd everywhere; the chip names the one the platform's
 * keyboard actually has.
 */
export function shortcutKeyLabel(platform: string | undefined): string {
  return platform !== undefined && /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘K" : "Ctrl K";
}

/**
 * Whether Ctrl/Cmd+K must stay out of the way.
 *
 * The contract says the shortcut focuses the search from wherever the reader
 * is, so an ordinary editable field does not block it. Two surfaces still do:
 * an open dialog/menu/overlay, which owns the keyboard, and the rename field,
 * whose blur commits half-typed text.
 */
export function searchShortcutBlocked(activeElement: Element | null, overlayOpen: boolean): boolean {
  if (overlayOpen) return true;
  return activeElement !== null && activeElement.closest(".side-rename-input") !== null;
}

/** Any dialogue-like surface that owns Escape and the arrow keys. A Guide or
 *  PromptDialog declares role=dialog without aria-modal, so both are read; a
 *  row menu is an overlay too, and its own Escape must win. */
export function dialogOrOverlayOpen(document: Document): boolean {
  return document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]') !== null;
}

/** A field that owns its own arrow/escape keys (caret, selection, cancel). */
export function editableField(target: EventTarget | null): boolean {
  // Duck-typed rather than `instanceof Element`: the check runs before any
  // layout, and a test can exercise it without a DOM.
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest;
  return typeof closest === "function"
    && closest.call(target, 'input, textarea, select, [contenteditable="true"]') !== null;
}
