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

import { useEffect, useLayoutEffect, useRef } from "react";

export interface MenuItem {
  /** A single glyph; the design has no icon font. */
  icon: string;
  label: string;
  onSelect: () => void;
}

/**
 * Where a menu is open, and what it offers. The anchor is the pointer position
 * rather than the trigger's box: it works for a click and a keyboard-activated
 * button alike, and it needs no measurement of the trigger.
 */
export interface MenuState {
  items: MenuItem[];
  /** Sentence shown under the items, for a consequence the label cannot hold. */
  note?: string;
  x: number;
  y: number;
}

/**
 * Whether a pointerdown ends the menu's life.
 *
 * A press anywhere else closes it, but a press on the menu itself must not:
 * React attaches its handlers at the root, so a capture-phase listener on
 * `document` runs *before* the item's own `onClick` can be delivered, and
 * `stopPropagation` on the item cannot stop a listener that already ran. The
 * menu would unmount on the way down and every entry would be dead — delete
 * included. So the test is containment, exactly as `apps/web`'s menus do it.
 *
 * Only pointer and scroll targets reach this, and both are Nodes, so the cast
 * inside `contains` is the real shape of the argument.
 */
export function leavesMenu(target: EventTarget | null, menu: Element | null): boolean {
  if (menu === null || target === null) return true;
  return !menu.contains(target as Node);
}

/**
 * The one menu behind every ⋯ in the app.
 *
 * It flips and clamps to the viewport instead of scrolling the page: a menu
 * that opens off-screen is indistinguishable from a button that did nothing.
 */
export function RowMenu({ menu, onClose }: { menu?: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => {
      if (leavesMenu(event.target, ref.current)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Capture phase: a pointerdown that also activates something underneath
    // would otherwise leave the menu open on top of the new screen. `leavesMenu`
    // is what keeps this from eating the menu's own items.
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey);
    // A resize reports the window as its target, which is not a Node — the one
    // case that closes without asking.
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu, onClose]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!menu || !node) return;
    const box = node.getBoundingClientRect();
    const overflowX = menu.x + box.width - (window.innerWidth - 8);
    const overflowY = menu.y + box.height - (window.innerHeight - 8);
    if (overflowX > 0) node.style.left = `${Math.max(8, menu.x - box.width)}px`;
    if (overflowY > 0) node.style.top = `${Math.max(8, menu.y - box.height)}px`;
  }, [menu]);

  if (!menu) return null;
  return (
    <div className="ctx-menu" ref={ref} role="menu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((item) => (
        <button
          className="ctx-item"
          key={item.label}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          role="menuitem"
          type="button"
        >
          <span className="ctx-item-icon">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
      {menu.note ? <div className="ctx-note">{menu.note}</div> : null}
    </div>
  );
}
