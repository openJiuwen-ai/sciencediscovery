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
  DOC_MIN_WIDTH,
  LIST_DEFAULT_WIDTH,
  LIST_MIN_WIDTH,
  LIST_NUDGE_STEP,
  initialSplit,
  isListClosed,
  listWidth,
  nudgeSplit,
  splitFromDrag,
} from "../src/app/panel-split.js";

const PANEL = 720;
const open = { docClosed: false, list: LIST_DEFAULT_WIDTH };

test("a fresh split gives the list its default and the document the rest", () => {
  const split = initialSplit();
  assert.equal(split.docClosed, false);
  assert.equal(split.list, LIST_DEFAULT_WIDTH);
  assert.equal(listWidth(split, PANEL), LIST_DEFAULT_WIDTH);
  assert.equal(isListClosed(split), false);
});

test("dragging the divider moves the list with the pointer", () => {
  assert.equal(listWidth(splitFromDrag(PANEL, open, 60), PANEL), 300);
  assert.equal(listWidth(splitFromDrag(PANEL, open, -40), PANEL), 200);
});

test("the delta is measured from the start, so an overshoot does not accumulate", () => {
  // Out to the right past the bound and back: the divider picks the pointer up
  // where it left it rather than having lost the distance.
  const overshot = splitFromDrag(PANEL, open, 10_000);
  assert.equal(overshot.docClosed, true);
  assert.equal(listWidth(splitFromDrag(PANEL, open, 60), PANEL), 300);
});

test("a near-empty list closes instead of becoming a sliver of rows", () => {
  const closed = splitFromDrag(PANEL, open, -(LIST_DEFAULT_WIDTH - LIST_MIN_WIDTH));
  assert.equal(closed.list, 0);
  assert.equal(isListClosed(closed), true);
  assert.equal(closed.docClosed, false);
  assert.equal(listWidth(closed, PANEL), 0);
});

test("dragging right until the document is too narrow closes the document", () => {
  const closed = splitFromDrag(PANEL, open, PANEL - DOC_MIN_WIDTH - LIST_DEFAULT_WIDTH);
  assert.equal(closed.docClosed, true);
  assert.equal(listWidth(closed, PANEL), PANEL, "the list takes the panel");
  assert.equal(isListClosed(closed), false);
});

test("a closed list reopens by dragging right", () => {
  const reopened = splitFromDrag(PANEL, { docClosed: false, list: 0 }, LIST_MIN_WIDTH + 40);
  assert.equal(reopened.docClosed, false);
  assert.equal(reopened.list, LIST_MIN_WIDTH + 40);
});

test("a closed document reopens by dragging left", () => {
  // The document column comes back only once the pointer has travelled far
  // enough to give it its minimum again — the same distance that closed it.
  assert.equal(splitFromDrag(PANEL, { docClosed: true, list: PANEL }, -40).docClosed, true);
  const reopened = splitFromDrag(PANEL, { docClosed: true, list: PANEL }, -DOC_MIN_WIDTH - 40);
  assert.equal(reopened.docClosed, false);
  assert.equal(reopened.list, PANEL - DOC_MIN_WIDTH - 40);
});

test("a list wider than the panel leaves the document its minimum", () => {
  // The panel is resizable after the divider was placed; the list must not
  // crowd the document out of a column it never promised to close.
  assert.equal(listWidth({ docClosed: false, list: 600 }, 700), 700 - DOC_MIN_WIDTH);
});

test("the keyboard moves the divider by one step and closes at the ends", () => {
  const moved = nudgeSplit(PANEL, open, LIST_NUDGE_STEP);
  assert.equal(moved.list, LIST_DEFAULT_WIDTH + LIST_NUDGE_STEP);
  const closed = nudgeSplit(PANEL, { docClosed: false, list: LIST_MIN_WIDTH }, -LIST_NUDGE_STEP);
  assert.equal(closed.list, 0);
  // Still closed when pushed further left; a drag cannot reach a negative width.
  assert.equal(nudgeSplit(PANEL, { docClosed: false, list: 0 }, -LIST_NUDGE_STEP).list, 0);
});

test("one key press is enough to bring a closed column back", () => {
  // From the keyboard there is no pointer position to show progress towards the
  // snap point, so the first press has to produce a visible list.
  const reopened = nudgeSplit(PANEL, { docClosed: false, list: 0 }, LIST_NUDGE_STEP);
  assert.equal(reopened.docClosed, false);
  assert.equal(reopened.list, LIST_MIN_WIDTH + LIST_NUDGE_STEP);
  const doc = nudgeSplit(PANEL, { docClosed: true, list: PANEL }, -LIST_NUDGE_STEP);
  assert.equal(doc.docClosed, false);
  assert.equal(doc.list, PANEL - DOC_MIN_WIDTH - LIST_NUDGE_STEP);
});

test("the keyboard closes the document at the same edge the drag does", () => {
  const closed = nudgeSplit(PANEL, { docClosed: false, list: PANEL - DOC_MIN_WIDTH - 8 }, LIST_NUDGE_STEP);
  assert.equal(closed.docClosed, true);
  assert.equal(listWidth(closed, PANEL), PANEL);
});
