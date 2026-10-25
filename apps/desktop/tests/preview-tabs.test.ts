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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  HOME_TAB_ID,
  addTab,
  closeTab,
  homeTab,
  initialTabState,
  placeDocument,
  type PreviewSlot,
} from "../src/app/preview-tabs.js";

const DOC = { label: "figure.png", path: "out/figure.png" };

test("a fresh panel is one home tab titled 新标签页", () => {
  const state = initialTabState();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeTabId, HOME_TAB_ID);
  assert.equal(state.tabs[0]?.home, true);
});

test("the first document replaces the home tab in place", () => {
  const state = initialTabState();
  const placed = placeDocument(state.tabs, state.activeTabId, DOC);
  assert.equal(placed.tabs.length, 1, "no second tab for the common case");
  assert.equal(placed.activeTabId, HOME_TAB_ID, "the tab keeps its identity");
  assert.equal(placed.tabs[0]?.home, false);
  assert.equal(placed.tabs[0]?.label, DOC.label);
  assert.equal(placed.tabs[0]?.loading, true);
  assert.equal(placed.tabs[0]?.content, undefined);
});

test("a second document opens its own tab and takes focus", () => {
  const first = initialTabState();
  const placed = placeDocument(first.tabs, first.activeTabId, DOC);
  const second = placeDocument(placed.tabs, placed.activeTabId, { label: "notes.md", path: "out/notes.md" });
  assert.equal(second.tabs.length, 2);
  assert.equal(second.tabs[0]?.label, DOC.label, "the first document is left alone");
  assert.equal(second.tabs[1]?.label, "notes.md");
  assert.equal(second.activeTabId, second.tabs[1]?.id);
});

test("a document opened from a background tab becomes a new tab, not a replacement", () => {
  // The home tab is still open but is not the active one; overwriting it here
  // would throw away the panel's overview while the user is looking elsewhere.
  const tabs: PreviewSlot[] = [homeTab(), { home: false, id: "tab-1", label: "a.md", loading: false, path: "a.md" }];
  const placed = placeDocument(tabs, "tab-1", DOC);
  assert.equal(placed.tabs.length, 3);
  assert.equal(placed.tabs[0]?.home, true, "the home tab survives untouched");
  assert.equal(placed.activeTabId, "tab-2");
});

test("a replaced tab does not keep the previous document's content or error", () => {
  const stale: PreviewSlot = { content: "old", error: "boom", home: true, id: HOME_TAB_ID, label: "", loading: false, path: "" };
  const placed = placeDocument([stale], HOME_TAB_ID, DOC);
  assert.equal(placed.tabs[0]?.content, undefined);
  assert.equal(placed.tabs[0]?.error, undefined);
});

test("tab ids stay unique when a closed number is handed out again", () => {
  let state = initialTabState();
  // The document that replaces the home tab keeps its id, so numbering starts
  // at tab-1 for the next one.
  state = placeDocument(state.tabs, state.activeTabId, DOC);
  state = addTab(state.tabs);
  state = addTab(state.tabs);
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [HOME_TAB_ID, "tab-1", "tab-2"],
  );
  // Close the middle one, then add: the new id must skip the gap, not reuse it
  // while tab-2 is still open.
  const closed = closeTab(state.tabs, state.activeTabId, "tab-1");
  const reopened = addTab(closed.tabs);
  const ids = reopened.tabs.map((tab) => tab.id);
  assert.deepEqual(ids, [HOME_TAB_ID, "tab-2", "tab-3"]);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique");
});

test("the plus button opens an empty tab and focuses it", () => {
  const state = initialTabState();
  const opened = addTab(state.tabs);
  assert.equal(opened.tabs.length, 2);
  assert.equal(opened.tabs[1]?.home, true);
  assert.equal(opened.activeTabId, opened.tabs[1]?.id);
});

test("closing a background tab leaves the active one where it was", () => {
  const tabs: PreviewSlot[] = [
    homeTab(),
    { home: false, id: "tab-1", label: "a.md", loading: false, path: "a.md" },
    { home: false, id: "tab-2", label: "b.md", loading: false, path: "b.md" },
  ];
  const result = closeTab(tabs, "tab-2", "tab-1");
  assert.equal(result.activeTabId, "tab-2");
  assert.equal(result.collapse, false);
  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    [HOME_TAB_ID, "tab-2"],
  );
});

test("closing the active tab falls back to its left neighbour", () => {
  const tabs: PreviewSlot[] = [
    homeTab(),
    { home: false, id: "tab-1", label: "a.md", loading: false, path: "a.md" },
    { home: false, id: "tab-2", label: "b.md", loading: false, path: "b.md" },
  ];
  const result = closeTab(tabs, "tab-2", "tab-2");
  assert.equal(result.activeTabId, "tab-1");
});

test("closing the leftmost tab falls forward rather than to nothing", () => {
  const tabs: PreviewSlot[] = [homeTab(), { home: false, id: "tab-1", label: "a.md", loading: false, path: "a.md" }];
  const result = closeTab(tabs, HOME_TAB_ID, HOME_TAB_ID);
  assert.equal(result.activeTabId, "tab-1");
  assert.equal(result.collapse, false);
});

test("closing the last tab asks for the panel to collapse and leaves no empty tab", () => {
  const state = initialTabState();
  const result = closeTab(state.tabs, state.activeTabId, HOME_TAB_ID);
  assert.equal(result.collapse, true);
  assert.equal(result.tabs.length, 1, "the panel is never left with zero tabs");
  assert.equal(result.tabs[0]?.home, true, "and reopening it starts clean");
  assert.equal(result.activeTabId, result.tabs[0]?.id);
});

test("closing an id that is not open changes nothing", () => {
  const state = initialTabState();
  const result = closeTab(state.tabs, state.activeTabId, "tab-99");
  assert.equal(result.collapse, false);
  assert.equal(result.tabs.length, 1);
});

test("the home tab is not reachable twice: a new home tab gets a fresh id", () => {
  const home = homeTab();
  const opened = addTab([home]);
  assert.notEqual(opened.tabs[1]?.id, HOME_TAB_ID);
});
