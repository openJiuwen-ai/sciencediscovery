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
  closeTab,
  homeTab,
  initialTabState,
  patchVersion,
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

test("clicking a document that is already open focuses its tab instead of opening a second", () => {
  // The reported case: the artifact rows are clicked more than once. A second
  // tab for the same document splits the reader's place in it in two.
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, DOC);
  const again = placeDocument(first.tabs, first.activeTabId, DOC);
  assert.equal(again.reused, true);
  assert.equal(again.tabs.length, 1, "no second tab");
  assert.equal(again.activeTabId, first.activeTabId);
  assert.equal(again.tabs[0]?.content, first.tabs[0]?.content, "and nothing is read again");
});

test("an open document comes to the front from whichever tab is showing", () => {
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, DOC);
  const second = placeDocument(first.tabs, first.activeTabId, { label: "notes.md", path: "out/notes.md" });
  const back = placeDocument(second.tabs, second.activeTabId, DOC);
  assert.equal(back.reused, true);
  assert.equal(back.tabs.length, 2, "the other document is not closed");
  assert.equal(back.activeTabId, first.activeTabId, "the first document's tab takes focus");
});

test("one artifact has one tab, whichever version is clicked", () => {
  // A row is the artifact, not a version: clicking it again while the tab is on
  // an older version is a request to look at the open document, and the version
  // stays where the reader put it — the picker is what changes it.
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "a1",
    label: "trace.md",
    path: "app/trace.md",
    source: "artifact",
    versionId: "v1",
  });
  const second = placeDocument(first.tabs, first.activeTabId, {
    artifactId: "a1",
    label: "trace.md",
    path: "app/trace.md",
    source: "artifact",
    versionId: "v2",
  });
  assert.equal(second.reused, true);
  assert.equal(second.tabs.length, 1);
  assert.equal(second.tabs[0]?.versionId, "v1");
});

test("two artifacts that share a name are still two tabs", () => {
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "a1",
    label: "trace.md",
    path: "subagents/a1/trace.md",
    source: "artifact",
    versionId: "v1",
  });
  const second = placeDocument(first.tabs, first.activeTabId, {
    artifactId: "b2",
    label: "trace.md",
    path: "subagents/b2/trace.md",
    source: "artifact",
    versionId: "v2",
  });
  assert.equal(second.reused, false);
  assert.equal(second.tabs.length, 2);
});

test("a failed read is retried in the tab it failed in", () => {
  // The click that follows an error may be the retry: it refills that tab
  // rather than adding one beside it.
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, DOC);
  const failed = first.tabs.map((tab) => ({ ...tab, content: "old", error: "boom", loading: false }));
  const retried = placeDocument(failed, first.activeTabId, DOC);
  assert.equal(retried.reused, false);
  assert.equal(retried.tabs.length, 1);
  assert.equal(retried.activeTabId, first.activeTabId);
  assert.equal(retried.tabs[0]?.error, undefined);
  assert.equal(retried.tabs[0]?.content, undefined);
  assert.equal(retried.tabs[0]?.loading, true);
});

test("a file and an artifact with the same path are two different documents", () => {
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, { label: "trace.md", path: "app/trace.md", source: "file" });
  const second = placeDocument(first.tabs, first.activeTabId, {
    artifactId: "a1",
    label: "trace.md",
    path: "app/trace.md",
    source: "artifact",
    versionId: "v1",
  });
  assert.equal(second.reused, false);
  assert.equal(second.tabs.length, 2);
});

test("two documents with the same label each get a tab of their own", () => {
  // A second `trace.md` is not the first one replaced: the label repeats, so
  // the tab bar is the only place the two can be told apart.
  const first = initialTabState();
  const placed = placeDocument(first.tabs, first.activeTabId, { label: "trace.md", path: "subagents/a1/trace.md" });
  const second = placeDocument(placed.tabs, placed.activeTabId, { label: "trace.md", path: "app/trace.md" });
  assert.equal(second.tabs.length, 2);
  assert.equal(second.tabs[0]?.label, "trace.md");
  assert.equal(second.tabs[1]?.label, "trace.md");
  assert.notEqual(second.tabs[0]?.id, second.tabs[1]?.id);
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
  state = placeDocument(state.tabs, state.activeTabId, { label: "b.md", path: "b.md" });
  state = placeDocument(state.tabs, state.activeTabId, { label: "c.md", path: "c.md" });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [HOME_TAB_ID, "tab-1", "tab-2"],
  );
  // Close the middle one, then open another: the new id must skip the gap, not
  // reuse it while tab-2 is still open.
  const closed = closeTab(state.tabs, state.activeTabId, "tab-1");
  const reopened = placeDocument(closed.tabs, closed.activeTabId, { label: "d.md", path: "d.md" });
  const ids = reopened.tabs.map((tab) => tab.id);
  assert.deepEqual(ids, [HOME_TAB_ID, "tab-2", "tab-3"]);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique");
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

test("a version's answer lands only while the tab still shows that version", () => {
  const state = initialTabState();
  const placed = placeDocument(state.tabs, state.activeTabId, {
    artifactId: "a1",
    label: "trace.md",
    path: "trace.md",
    source: "artifact",
    versionId: "v2",
  });
  const stale = patchVersion(placed, placed.activeTabId, "v1", { content: "older" });
  assert.equal(stale.tabs[0]?.content, undefined, "an answer for a version the tab left is dropped");
  const fresh = patchVersion(placed, placed.activeTabId, "v2", { content: "newest", loading: false });
  assert.equal(fresh.tabs[0]?.content, "newest");
  assert.equal(fresh.tabs[0]?.loading, false);
});

test("a version's answer leaves tabs showing another version untouched", () => {
  const one = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "a1",
    label: "one.md",
    path: "one.md",
    source: "artifact",
    versionId: "v1",
  });
  const two = placeDocument(one.tabs, one.activeTabId, {
    artifactId: "a2",
    label: "two.md",
    path: "two.md",
    source: "artifact",
    versionId: "v9",
  });
  const patched = patchVersion(two, one.activeTabId, "v1", { content: "one" });
  assert.equal(patched.tabs.find((tab) => tab.id === one.activeTabId)?.content, "one");
  assert.equal(patched.tabs.find((tab) => tab.id === two.activeTabId)?.content, undefined);
  assert.equal(patched.activeTabId, two.activeTabId, "the active tab is not disturbed");
});
