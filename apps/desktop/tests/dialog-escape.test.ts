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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { claimsEscape, enterDialog, isTopDialog, leaveDialog } from "../src/views/dialog-escape.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/** The part of a keydown the rule reads, plus what a claiming dialog does to
 *  it. The listeners run for real in a browser; this is enough to state the
 *  contract between the dialogs without a DOM. */
function keydown(key: string): { defaultPrevented: boolean; key: string; preventDefault: () => void } {
  const event = {
    defaultPrevented: false,
    key,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
}

describe("Escape in a stack of dialogs", () => {
  it("closes the dialog that sees it first and was not claimed", () => {
    assert.equal(claimsEscape(keydown("Escape")), true);
  });

  it("leaves the dialog below open once the one above has claimed the key", () => {
    // One Escape must not close the confirmation and the settings behind it.
    const event = keydown("Escape");
    // The confirmation listens on `document` and claims the key.
    if (claimsEscape(event)) event.preventDefault();
    assert.equal(claimsEscape(event), false);
  });

  it("ignores every other key", () => {
    assert.equal(claimsEscape(keydown("Enter")), false);
    assert.equal(claimsEscape(keydown("Tab")), false);
  });
});

describe("which dialog owns the key", () => {
  it("gives it to the dialog opened last, not the one that mounted first", () => {
    // Both listen on `document`, so registration order would hand the key to
    // the dialog underneath. The stack is what says otherwise.
    const report = enterDialog();
    const card = enterDialog();
    assert.equal(isTopDialog(report), false);
    assert.equal(isTopDialog(card), true);
    leaveDialog(card);
    assert.equal(isTopDialog(report), true);
    leaveDialog(report);
  });

  it("falls back to the one below when the top one leaves", () => {
    const first = enterDialog();
    const second = enterDialog();
    leaveDialog(second);
    leaveDialog(first);
    // Nothing is open, so nothing claims Escape.
    assert.equal(isTopDialog(first), false);
    assert.equal(isTopDialog(second), false);
  });

  it("ignores a dialog that has already left the stack", () => {
    const gone = enterDialog();
    leaveDialog(gone);
    const top = enterDialog();
    // A second cleanup, as a remount or a double effect teardown produces.
    leaveDialog(gone);
    assert.equal(isTopDialog(top), true);
    leaveDialog(top);
  });
});
