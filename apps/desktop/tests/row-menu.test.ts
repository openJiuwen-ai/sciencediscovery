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
import { leavesMenu } from "../src/views/RowMenu.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/** Stand-ins for the menu element and one of its item buttons. `contains` is
 *  the only part of `Element` this rule asks for, so the stub is enough — and
 *  the repo has no DOM to build a real one in. */
function menuHolding(item: object): Element {
  return { contains: (node: object) => node === item } as unknown as Element;
}

describe("a pointerdown and the row menu", () => {
  it("leaves the menu up for a press on one of its own items", () => {
    // This is the difference between a working ⋯ and a dead one. React's
    // handler for the item runs at the root, so it is downstream of the
    // capture-phase listener on `document`; if that listener closed the menu
    // on the way down, the item would be unmounted before its `click` arrived
    // and 删除 / 重命名 / 归档 would do nothing at all.
    const item = {};
    assert.equal(leavesMenu(item as EventTarget, menuHolding(item)), false);
  });

  it("ends the menu for a press anywhere else", () => {
    assert.equal(leavesMenu({} as EventTarget, menuHolding({})), true);
  });

  it("leaves the menu up for a press on the button it hangs from", () => {
    // The welcome page's project chip is a toggle: its own click runs after
    // this listener, so closing on the way down would make every second press
    // reopen the menu it had just put away.
    const chip = {};
    const trigger = menuHolding(chip);
    assert.equal(leavesMenu(chip as EventTarget, menuHolding({}), trigger), false);
    assert.equal(leavesMenu({} as EventTarget, menuHolding({}), trigger), true);
  });

  it("ends the menu when there is no menu element to test against", () => {
    assert.equal(leavesMenu({} as EventTarget, null), true);
  });

  it("ends the menu when the event carries no target", () => {
    assert.equal(leavesMenu(null, menuHolding({})), true);
  });
});
