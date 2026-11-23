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

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  /** A single glyph, or a small element where a glyph would be the wrong
   *  picture — the design has no icon font, and a Project is drawn with the
   *  same folder mark everywhere else in the app. Absent where the entries are
   *  two words that say all there is to say, as on an attachment card. */
  icon?: ReactNode;
  label: string;
  /** Marks the entry the screen is already on, with a ✓. For menus that are a
   *  choice among several — the landing page's project picker — rather than a
   *  list of commands. */
  checked?: boolean;
  /** A hairline above this entry, to separate a list from what acts on it. */
  separatorBefore?: boolean;
  /** Shown greyed out and inert. A command the service would refuse is better
   *  named here than answered with a 409 the reader has to interpret. */
  disabled?: boolean;
  /** A sentence about this entry alone, drawn beside it while the pointer is on
   *  it (or the keyboard is). Not the `note` below: that one is always on screen
   *  because it explains why the whole menu is inert, while this is a
   *  consequence worth one look, not a permanent line in the menu. */
  hint?: string;
  onSelect: () => void;
}

/**
 * Where a menu is open, and what it offers. The anchor is the pointer position
 * rather than the trigger's box: it works for a click and a keyboard-activated
 * button alike, and it needs no measurement of the trigger.
 */
export interface MenuState {
  /** The button the menu hangs from, when there is one. A press on it is the
   *  trigger's own business — see `leavesMenu`. */
  anchor?: HTMLElement | null;
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
export function leavesMenu(
  target: EventTarget | null,
  menu: Element | null,
  anchor?: Element | null,
): boolean {
  if (target === null) return true;
  // The trigger is not "somewhere else": pressing it again is how the same
  // menu is put away, and its click runs *after* this listener. Dismissing
  // here would only make the trigger reopen what it has just closed.
  if (anchor != null && anchor.contains(target as Node)) return false;
  if (menu === null) return true;
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
  const hintRef = useRef<HTMLDivElement>(null);
  const hintIdBase = useId();
  /** The entry whose `hint` is on screen. Only while the pointer is on it (or
   *  the keyboard is): the menu must open bare, or the consequence becomes the
   *  standing line this was meant to replace. */
  const [hinted, setHinted] = useState<number | undefined>(undefined);
  /** Where the hint goes when it would otherwise leave the window. Measured
   *  rather than assumed: it is drawn over the page, not in the menu's flow. */
  const [hintPlacement, setHintPlacement] = useState<{ above: boolean; leftward: boolean }>({
    above: false,
    leftward: false,
  });

  // A closed menu leaves no mouseleave behind — pressing an item unmounts it —
  // so the index would survive into the next menu and draw that session's hint
  // before the pointer ever arrived.
  useEffect(() => {
    setHinted(undefined);
    setHintPlacement({ above: false, leftward: false });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    // Nothing to listen to where there is no document — the same case the portal
    // below already branches on.
    if (typeof document === "undefined") return;
    const dismiss = (event: Event) => {
      if (leavesMenu(event.target, ref.current, menu.anchor)) onClose();
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
    node.style.left = `${menu.x}px`;
    node.style.top = `${menu.y}px`;
    const box = node.getBoundingClientRect();
    const overflowX = menu.x + box.width - (window.innerWidth - 8);
    const overflowY = menu.y + box.height - (window.innerHeight - 8);
    if (overflowX > 0) node.style.left = `${Math.max(8, menu.x - box.width)}px`;
    if (overflowY > 0) node.style.top = `${Math.max(8, menu.y - box.height)}px`;
    // `hinted` is in the dependencies so the reset above runs again when the
    // menu's own box has not moved: the hint is drawn over the page, and this
    // keeps a re-clamp from stacking on a previous one.
  }, [menu, hinted]);

  // The hint is absolutely positioned, so showing it cannot resize the menu —
  // and cannot slide 导出会话 or 删除 under a pointer already travelling toward
  // them. What it can do is hang off the window, which is measured here.
  useLayoutEffect(() => {
    const menuNode = ref.current;
    const hintNode = hintRef.current;
    if (!menuNode || !hintNode) return;
    const menuBox = menuNode.getBoundingClientRect();
    const hintBox = hintNode.getBoundingClientRect();
    setHintPlacement({
      above: menuBox.bottom + hintBox.height + 8 > window.innerHeight,
      leftward: menuBox.left + hintBox.width + 8 > window.innerWidth,
    });
  }, [hinted]);

  if (!menu) return null;
  const list = (
    <div className="ctx-menu" ref={ref} role="menu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((item, index) => (
        // By position: two Projects may share a name, and the label was the
        // key before this menu listed anything the user names.
        <Fragment key={index}>
          {item.separatorBefore ? <div className="ctx-divider" /> : null}
          <button
            aria-current={item.checked ? "true" : undefined}
            aria-describedby={hinted === index && item.hint !== undefined ? `${hintIdBase}-${index}` : undefined}
            aria-disabled={item.disabled ? "true" : undefined}
            className="ctx-item"
            disabled={item.disabled}
            onBlur={() => setHinted(undefined)}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            onFocus={() => setHinted(item.hint === undefined ? undefined : index)}
            onMouseEnter={() => setHinted(item.hint === undefined ? undefined : index)}
            onMouseLeave={() => setHinted(undefined)}
            role="menuitem"
            type="button"
          >
            {item.icon ? <span aria-hidden="true" className="ctx-item-icon">{item.icon}</span> : null}
            <span className="ctx-item-label">{item.label}</span>
            {item.checked ? <span aria-hidden="true" className="ctx-item-check">✓</span> : null}
          </button>
          {/* Over the page, not in the menu's flow: showing it must not resize a
              box that has already been clamped, nor move the entries below it.
              `aria-describedby` on the button is what makes it readable, since a
              tooltip role on its own announces nothing. */}
          {hinted === index && item.hint !== undefined ? (
            <div
              className={`ctx-hint${hintPlacement.above ? " is-above" : ""}${hintPlacement.leftward ? " is-leftward" : ""}`}
              id={`${hintIdBase}-${index}`}
              ref={hintRef}
              role="tooltip"
            >
              {item.hint}
            </div>
          ) : null}
        </Fragment>
      ))}
      {menu.note ? <div className="ctx-note">{menu.note}</div> : null}
    </div>
  );
  // Into the body, not beside the trigger: `position: fixed` only measures from
  // the window while no ancestor is transformed — and the welcome page's column
  // keeps a `translateY(0)` from its entrance animation. Under it the menu was
  // drawn at its coordinates *inside that column*, half a screen from the chip.
  // The tests render on the server, where there is no body to portal into.
  return typeof document === "undefined" ? list : createPortal(list, document.body);
}
