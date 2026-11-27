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

import { placeFlyout } from "../src/views/flyout-placement.js";

/** The panel geometry measured from the desktop entry at 1024×720 (#1487). */
const PANEL = { bottom: 499, left: 407, right: 727, top: 224 };
const DESKTOP = { height: 720, width: 1024 };

test("a card that fits on the panel's right stays there", () => {
  // 727 + 4 = 731; 731 + 280 = 1011 <= 1024 - 8 = 1016, the preferred side.
  assert.equal(placeFlyout(PANEL, { height: 140, width: 280 }, DESKTOP, "top").left, 731);
});

test("审查档位 flips to the panel's left at 1024 and 960", () => {
  // 731 + 300 = 1031 > 1016: the right edge cannot hold the card.
  assert.equal(placeFlyout(PANEL, { height: 140, width: 300 }, DESKTOP, "top").left, 103);
  // 407 - 4 - 300 = 103, well inside the window and entirely left of the rows.
  assert.equal(placeFlyout(PANEL, { height: 140, width: 300 }, { height: 720, width: 960 }, "top").left, 103);
});

test("专家 flips at 960 and 1024 instead of running past the right edge", () => {
  // 407 - 4 - 380 = 23: inside the window, and right of its left margin.
  assert.equal(placeFlyout(PANEL, { height: 209, width: 380 }, { height: 720, width: 960 }, "bottom").left, 23);
  assert.equal(placeFlyout(PANEL, { height: 209, width: 380 }, DESKTOP, "bottom").left, 23);
});

test("a card too wide for either side is clamped inside the window", () => {
  // A panel near the window's left edge leaves no room to flip into. The
  // clamp is the last resort, and it never leaves the 8px margin.
  const placement = placeFlyout(
    { bottom: 300, left: 120, right: 440, top: 100 },
    { height: 200, width: 380 },
    { height: 720, width: 800 },
    "top",
  );
  assert.equal(placement.left, 8);
  // A panel at the right edge cannot even hold its own left side.
  const rightEdge = placeFlyout(
    { bottom: 300, left: 1022, right: 1024, top: 100 },
    { height: 200, width: 380 },
    DESKTOP,
    "top",
  );
  assert.equal(rightEdge.left, 1024 - 8 - 380);
});

test("the card is anchored by the panel edge the caller names", () => {
  const top = placeFlyout(PANEL, { height: 140, width: 300 }, DESKTOP, "top");
  const bottom = placeFlyout(PANEL, { height: 209, width: 380 }, DESKTOP, "bottom");
  assert.equal(top.top, 224);
  // 499 - 209 = 290: the catalog's bottom edge stays on the panel's.
  assert.equal(bottom.top, 290);
});

test("a card taller than the window still starts inside it", () => {
  const placement = placeFlyout(PANEL, { height: 900, width: 300 }, DESKTOP, "bottom");
  assert.equal(placement.top, 8);
});
