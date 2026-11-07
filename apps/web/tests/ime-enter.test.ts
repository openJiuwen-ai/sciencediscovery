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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { commitsOnEnter } from "../src/ime-enter.js";

/** What a listener receives, reduced to the fields this rule reads. React puts
 *  the composition flag on `nativeEvent`; a bare KeyboardEvent also has it at
 *  the top level. */
function keydown(fields: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing: boolean };
} = {}) {
  return { key: "Enter", ...fields };
}

describe("Enter while an IME is composing a candidate", () => {
  it("does not send the half-typed message from the composer", () => {
    // The message is still "蛋白": Enter is confirming the candidate, so the
    // composer must not turn it into a send (it would arrive as 蛋白, not the
    // "蛋白质" the user is still choosing).
    const event = keydown({ isComposing: true, keyCode: 13, nativeEvent: { isComposing: true } });
    assert.equal(commitsOnEnter(event), false);
  });

  it("does not let the skill palette take that Enter as its selection", () => {
    // The palette runs first and shares this rule: otherwise the candidate
    // Enter picks a skill and the draft is rewritten mid-word.
    const event = keydown({ isComposing: true, keyCode: 13, nativeEvent: { isComposing: true } });
    assert.equal(commitsOnEnter(event), false);
  });

  it("does not commit a sidebar rename", () => {
    assert.equal(commitsOnEnter(keydown({ isComposing: true, nativeEvent: { isComposing: true } })), false);
  });

  it("does not accept a dialog", () => {
    assert.equal(commitsOnEnter(keydown({ isComposing: true, nativeEvent: { isComposing: true } })), false);
  });

  it("does not trust a synthetic event that only repeats the flag on the native one", () => {
    // Some React events leave `isComposing` undefined and only the native
    // KeyboardEvent knows; the rule must read that shape too.
    assert.equal(commitsOnEnter(keydown({ isComposing: undefined, nativeEvent: { isComposing: true } })), false);
  });

  it("treats the 229 Enter some IMEs report as composition", () => {
    // On Windows the confirming Enter can arrive with keyCode 229 and no
    // isComposing at all.
    assert.equal(commitsOnEnter(keydown({ isComposing: false, keyCode: 229 })), false);
  });
});

describe("Enter once the candidate has been accepted", () => {
  it("sends the composer message as before", () => {
    assert.equal(commitsOnEnter(keydown({ isComposing: false, keyCode: 13 })), true);
  });

  it("still commits the sidebar rename and the dialog", () => {
    assert.equal(commitsOnEnter(keydown({ isComposing: false })), true);
  });

  it("leaves Shift+Enter to the composer's own newline rule", () => {
    // This rule answers only "is the Enter the user's"; the composer still
    // requires `!shiftKey` before it sends.
    assert.equal(commitsOnEnter(keydown({ shiftKey: true, isComposing: false })), true);
  });

  it("ignores keys that are not Enter", () => {
    assert.equal(commitsOnEnter(keydown({ key: "a" })), false);
    assert.equal(commitsOnEnter(keydown({ key: "Escape" })), false);
    assert.equal(commitsOnEnter(keydown({ key: "Tab" })), false);
  });
});
