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
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_CHAT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SIDEBAR_WIDTH,
  clampPanelWidth,
  panelWidthFromDrag,
  storedPanelWidth,
} from "../src/app/panel-width.js";

test("the panel's edge follows the pointer, and the panel is on the right", () => {
  // Dragging the edge left widens the panel: the edge is what moves, not the
  // width. Getting this backwards makes the panel run away from the cursor.
  assert.equal(panelWidthFromDrag(360, 1000, 960), 400);
  assert.equal(panelWidthFromDrag(360, 1000, 1040), 320);
  assert.equal(panelWidthFromDrag(360, 1000, 1000), 360);
});

test("a drag that runs past a bound comes back where the pointer is", () => {
  // The floor is applied afterwards, so pulling the pointer far past it and
  // returning has to land on the same width — not on a panel that has to be
  // dragged back by the whole overshoot first.
  const overshot = panelWidthFromDrag(300, 1000, 1400);
  assert.ok(overshot < PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(overshot, 1600), PANEL_MIN_WIDTH);
  assert.equal(panelWidthFromDrag(300, 1000, 900), 400);
});

test("the width stays between the two bounds", () => {
  // A window wide enough for the panel's own maximum, so the ceiling being
  // tested is the panel's rather than the window's.
  assert.equal(clampPanelWidth(120, 2400), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(2000, 2400), PANEL_MAX_WIDTH);
  assert.equal(clampPanelWidth(500, 2400), 500);
});

test("a window too narrow to hold both columns keeps the panel usable", () => {
  // Below the sidebar plus a readable transcript there is no width that fits;
  // the panel keeps its floor and the media query hides it entirely.
  const viewport = PANEL_SIDEBAR_WIDTH + PANEL_MIN_CHAT_WIDTH - 20;
  // What the arithmetic would allow is less than the panel's own floor, and the
  // floor is what survives: a panel squeezed to 100px shows nothing.
  assert.equal(clampPanelWidth(PANEL_MAX_WIDTH, viewport), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(PANEL_DEFAULT_WIDTH, PANEL_SIDEBAR_WIDTH), PANEL_MIN_WIDTH);
});

test("the ceiling leaves the transcript its minimum", () => {
  // Wide enough that the window's ceiling is above the panel's floor, so the
  // arithmetic below is the one the panel actually receives.
  const viewport = 1600;
  const ceiling = clampPanelWidth(PANEL_MAX_WIDTH, viewport);
  assert.equal(ceiling, viewport - PANEL_SIDEBAR_WIDTH - PANEL_MIN_CHAT_WIDTH);
  // The sidebar is not reflowed, so the panel is the column that gives way.
  assert.equal(ceiling + PANEL_SIDEBAR_WIDTH + PANEL_MIN_CHAT_WIDTH, viewport);
});

test("a stored width is only trusted as far as its type", () => {
  assert.equal(storedPanelWidth(480), 480);
  // A value from an older shape, or one that never parsed, is the same as no
  // value at all — the default beats a guess.
  assert.equal(storedPanelWidth("480"), PANEL_DEFAULT_WIDTH);
  assert.equal(storedPanelWidth(undefined), PANEL_DEFAULT_WIDTH);
  assert.equal(storedPanelWidth(null), PANEL_DEFAULT_WIDTH);
  assert.equal(storedPanelWidth(Number.NaN), PANEL_DEFAULT_WIDTH);
});
