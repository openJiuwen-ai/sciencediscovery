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
 * The row menu's `hint`, mounted rather than reasoned about: it is drawn only
 * while the entry is under the pointer, it is announced to a screen reader, and
 * — the case a unit test on `archiveActionFor` cannot reach — it does not
 * survive into the next menu.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";
import { RowMenu, type MenuState } from "../src/views/RowMenu.js";

// The renderer is the only part of React here; without this, `act` warns that
// the environment is not set up for it on every mount.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HINT = "归档会停掉它在运行的科研内核。";

function menu(over: Partial<MenuState> = {}): MenuState {
  return {
    items: [
      { label: "重命名", onSelect: () => {} },
      { hint: HINT, label: "归档", onSelect: () => {} },
      { label: "删除", onSelect: () => {} },
    ],
    x: 20,
    y: 20,
    ...over,
  };
}

/**
 * One mounted `RowMenu` whose `menu` the test replaces, which is what the
 * sidebar does: it renders a single `RowMenu` and swaps the `menu` it is given.
 * A harness holding the menu in its own `useState` would hide the case — a
 * fresh mount starts with fresh state and could never carry the stale index.
 */
function Harness({ menu: current }: { menu?: MenuState }) {
  return createElement(RowMenu, { menu: current, onClose: () => {} });
}

function items(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => typeof node.type === "string" && node.type === "button" && node.props.role === "menuitem",
  );
}

function itemNamed(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = items(renderer).find((node) =>
    node.findAll((child) => typeof child.type === "string" && child.type === "span")
      .some((span) => span.children.includes(label)));
  assert.ok(found, `the ${label} entry is in the menu`);
  return found;
}

function hintNodes(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.props.role === "tooltip");
}

async function mount(current: MenuState): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, { menu: current }));
  });
  assert.ok(renderer);
  return renderer;
}

test("the hint is drawn only while its entry is under the pointer", async () => {
  const renderer = await mount(menu());
  // A menu that opened already carrying the sentence would be the standing line
  // this replaced.
  assert.equal(hintNodes(renderer).length, 0, "the menu opens bare");

  const archive = itemNamed(renderer, "归档");
  await act(async () => { archive.props.onMouseEnter(); });
  assert.equal(hintNodes(renderer).length, 1, "the sentence appears on the entry");
  assert.equal(hintNodes(renderer)[0]?.children[0], HINT);

  // And it is readable: a tooltip role alone announces nothing without this.
  assert.equal(
    itemNamed(renderer, "归档").props["aria-describedby"],
    hintNodes(renderer)[0]?.props.id,
    "the entry points at the sentence it belongs to",
  );

  await act(async () => { itemNamed(renderer, "归档").props.onMouseLeave(); });
  assert.equal(hintNodes(renderer).length, 0, "and it goes when the pointer leaves");
  assert.equal(itemNamed(renderer, "归档").props["aria-describedby"], undefined);
});

test("pressing 归档 does not leave its hint behind for the next menu", async () => {
  // Pressing an entry unmounts the menu, so no `mouseleave` is ever delivered and
  // the index stayed behind: the next ⋯ opened with the sentence already showing
  // under 归档. That is the same standing line, from the other direction.
  const renderer = await mount(menu());
  await act(async () => { itemNamed(renderer, "归档").props.onMouseEnter(); });
  assert.equal(hintNodes(renderer).length, 1);

  // The press runs the entry, and the sidebar puts the menu away.
  await act(async () => { itemNamed(renderer, "归档").props.onClick(); });
  await act(async () => {
    renderer.update(createElement(Harness, { menu: undefined }));
  });
  assert.equal(renderer.toJSON(), null, "the menu is gone");

  // The same mounted component, a second menu — another Session's ⋯.
  await act(async () => {
    renderer.update(createElement(Harness, { menu: menu({ x: 40, y: 60 }) }));
  });
  assert.equal(hintNodes(renderer).length, 0, "the new menu opens bare");
});

test("an entry with no hint never draws one, and does not claim one", async () => {
  const renderer = await mount(menu());
  const rename = itemNamed(renderer, "重命名");
  await act(async () => { rename.props.onMouseEnter(); });
  assert.equal(hintNodes(renderer).length, 0);
  assert.equal(itemNamed(renderer, "重命名").props["aria-describedby"], undefined);
});
