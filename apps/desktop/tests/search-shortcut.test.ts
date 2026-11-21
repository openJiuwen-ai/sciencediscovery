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

// #1251: the pure rules behind Ctrl/Cmd+K and the document-level key routing.
// The browser-level behaviour (focus really stays behind a dialog) is in
// e2e/sidebar-search.spec.ts.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  dialogOrOverlayOpen,
  editableField,
  searchShortcutBlocked,
  shortcutKeyLabel,
} from "../src/app/search-shortcut.js";

function element(matches: string[]): Element {
  return {
    closest: (selector: string) => (matches.some((match) => selector.includes(match)) ? {} : null),
  } as unknown as Element;
}

function documentWith(found: unknown): Document {
  return { querySelector: () => found } as unknown as Document;
}

test("the shortcut chip names the platform's modifier", () => {
  assert.equal(shortcutKeyLabel("MacIntel"), "⌘K");
  assert.equal(shortcutKeyLabel("iPhone"), "⌘K");
  assert.equal(shortcutKeyLabel("Win32"), "Ctrl K");
  assert.equal(shortcutKeyLabel("Linux x86_64"), "Ctrl K");
  assert.equal(shortcutKeyLabel(undefined), "Ctrl K");
});

test("Ctrl/Cmd+K stays out of dialogs and rename, but not ordinary fields", () => {
  const rename = element([".side-rename-input", "input"]);
  const composer = element(["textarea"]);
  const search = element([]);
  const footer = element(["button"]);

  assert.equal(searchShortcutBlocked(null, true), true);
  assert.equal(searchShortcutBlocked(rename, false), true);
  // The contract asks the shortcut to focus search from anywhere, so the
  // composer must not block it; the document Arrow/Escape guard is separate.
  assert.equal(searchShortcutBlocked(composer, false), false);
  assert.equal(searchShortcutBlocked(search, false), false);
  assert.equal(searchShortcutBlocked(footer, false), false);
  assert.equal(searchShortcutBlocked(null, false), false);
});

test("any role=dialog owns the keyboard, with or without aria-modal", () => {
  assert.equal(dialogOrOverlayOpen(documentWith({})), true);
  assert.equal(dialogOrOverlayOpen(documentWith(null)), false);
});

test("editable fields keep their own arrows and Escape", () => {
  assert.equal(editableField(element(["input"])), true);
  assert.equal(editableField(element(["textarea"])), true);
  assert.equal(editableField(element(["button"])), false);
  assert.equal(editableField(null), false);
});
