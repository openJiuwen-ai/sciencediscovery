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

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { claimsEscape } from "../dialog-escape.js";

export interface ListChoice {
  /** A muted suffix for an option that is listed but cannot be picked. */
  badge?: string;
  disabled?: boolean;
  label: string;
  value: string;
}

interface Props {
  /** Draws the label above the trigger. Off when the surrounding row already
   *  shows it, where a second copy would only repeat the line. */
  caption?: boolean;
  choices: ListChoice[];
  disabled?: boolean;
  /** Names the control for assistive tech, and is the caption when it is on. */
  label: string;
  onChange: (value: string) => void;
  value: string;
}

/** Space kept between the trigger and its menu, and between the menu and the
 *  edges of the window. */
const GAP = 6;
const EDGE = 12;
const MENU_MAX = 264;
/** Below this the menu is not worth opening downwards; it flips above. */
const ROOM_MIN = 140;

/**
 * A select the page draws itself.
 *
 * A native `<select>` opens a popup drawn by the OS, so it inherits none of the
 * settings surface's type, spacing or hover states — and the only way it can
 * say "another entry already uses this model" is by greying a line out. This
 * renders the trigger and the list with the app's own rows, keeps the reason
 * on the row as a badge, and still behaves like a select — click or Enter
 * opens it, arrows move, Enter picks, Escape or a click elsewhere closes.
 *
 * The list is portalled to the body and fixed to the trigger's rectangle: the
 * settings pane scrolls, and a menu positioned inside it would be clipped at
 * the pane's edge.
 */
export function ListSelect({
  caption = true,
  choices,
  disabled = false,
  label,
  onChange,
  value,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [seat, setSeat] = useState<{ left: number; top: number; width: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const chosen = choices.find((choice) => choice.value === value);

  /** Where the menu goes for a trigger at its current spot: under it, or above
   *  it when the room below is not worth opening into. */
  const place = (height: number) => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const top = below >= Math.min(height, ROOM_MIN)
      ? rect.bottom + GAP
      : Math.max(EDGE, rect.top - GAP - height);
    return { left: rect.left, top, width: rect.width };
  };

  const openMenu = () => {
    const next = place(Math.min(MENU_MAX, choices.length * 38 + 10));
    if (!next) return;
    setSeat(next);
    setActive(Math.max(0, choices.findIndex((choice) => choice.value === value)));
    setOpen(true);
  };

  const pick = (choice: ListChoice) => {
    if (choice.disabled) return;
    onChange(choice.value);
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      // The settings surface below listens for Escape on `window`; claiming the
      // key on `document` is what keeps one Escape to one layer — the list,
      // not the whole page.
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    // The menu is fixed to the viewport, so a scroll has to move it, not shut
    // it: a wheel over the list itself scrolls the list, and a wheel over the
    // settings pane takes the trigger with it. Only a trigger scrolled out of
    // sight ends the list.
    const follow = (event: Event) => {
      if (menu.current !== null && event.target instanceof Node && menu.current.contains(event.target)) {
        return;
      }
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || rect.bottom < EDGE || rect.top > window.innerHeight - EDGE) {
        setOpen(false);
        return;
      }
      const next = place(menu.current?.offsetHeight ?? Math.min(MENU_MAX, choices.length * 38 + 10));
      if (next) setSeat(next);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.focus();
  }, [open]);

  /** The next row in a direction that can actually be picked. */
  const step = (from: number, direction: number) => {
    for (let index = from + direction; index >= 0 && index < choices.length; index += direction) {
      if (!choices[index]?.disabled) return index;
    }
    return from;
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => step(current, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const choice = choices[active];
      if (choice) pick(choice);
      return;
    }
    if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className={`list-select${caption ? "" : " is-bare"}`}>
      {caption ? (
        <span className="list-select-caption" id={`${id}-caption`}>
          {label}
        </span>
      ) : null}
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={caption ? undefined : label}
        aria-labelledby={caption ? `${id}-caption ${id}-value` : undefined}
        className={`list-select-trigger${open ? " is-open" : ""}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
        ref={trigger}
        type="button"
      >
        <span className="list-select-value" id={`${id}-value`}>
          {chosen ? chosen.label : value}
        </span>
        <svg
          aria-hidden="true"
          className="list-select-chevron"
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
          width="14"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && seat
        ? createPortal(
            <div
              aria-activedescendant={`${id}-option-${active}`}
              aria-label={label}
              className="list-select-menu"
              onKeyDown={onMenuKey}
              ref={menu}
              role="listbox"
              style={{ left: seat.left, top: seat.top, width: seat.width }}
              tabIndex={-1}
            >
              {choices.map((choice, index) => (
                <div
                  aria-disabled={choice.disabled === true}
                  aria-selected={choice.value === value}
                  className={[
                    "list-select-option",
                    choice.value === value ? "is-selected" : "",
                    choice.disabled ? "is-disabled" : "",
                    index === active ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  id={`${id}-option-${index}`}
                  key={choice.value}
                  onClick={() => pick(choice)}
                  onMouseEnter={() => setActive(index)}
                  role="option"
                >
                  <span className="list-select-option-label">{choice.label}</span>
                  {choice.badge ? <small className="list-select-badge">{choice.badge}</small> : null}
                  {choice.value === value ? (
                    <svg
                      aria-hidden="true"
                      className="list-select-check"
                      fill="none"
                      height="14"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      width="14"
                    >
                      <path d="m5 12.5 4.5 4.5L19 7" />
                    </svg>
                  ) : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
