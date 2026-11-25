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

import { useEffect, useRef, useState, type ReactNode } from "react";

import { TEXT } from "../../text.js";
import { leavesMenu } from "../RowMenu.js";

/** The three ways a Skill arrives. Picking one is a navigation: the pane
 *  under the header is replaced, so the choice is a value, not a callback
 *  with a boolean. */
export type SkillAddChoice = "create" | "git" | "upload";

interface Entry {
  choice: SkillAddChoice;
  icon: ReactNode;
  label: string;
}

const ICON_PROPS = {
  "aria-hidden": true as const,
  fill: "none",
  height: 16,
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.7,
  viewBox: "0 0 24 24",
  width: 16,
};

/** An arrow rising out of a tray: the file leaves this computer. */
const UploadGlyph = () => (
  <svg {...ICON_PROPS}>
    <path d="M12 15V4m-4 4 4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
  </svg>
);

/** Two pads joined by a branch, the mark GitHub draws for a repository. */
const GitGlyph = () => (
  <svg {...ICON_PROPS}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="8" r="2.2" />
    <path d="M6 8.2v7.6M8.2 6h4.8a2.8 2.8 0 0 1 2.8 2.8V8" />
  </svg>
);

/** A sheet and a pen: the package is written here, not brought in. */
const WriteGlyph = () => (
  <svg {...ICON_PROPS}>
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="m17.4 3.6 2.9 2.9-7.1 7.1-3.5.7.7-3.5z" />
  </svg>
);

/** Built per render: the labels go through TEXT, which follows the language. */
function entries(): Entry[] {
  const menu = TEXT.settings.skills.addMenu;
  return [
    { choice: "upload", icon: <UploadGlyph />, label: menu.upload },
    { choice: "git", icon: <GitGlyph />, label: menu.git },
    { choice: "create", icon: <WriteGlyph />, label: menu.scratch },
  ];
}

/**
 * 技能's one add control.
 *
 * It is a menu rather than three buttons because the three sources answer one
 * question — where does this package come from? — and the list's header has
 * room for one press. Each entry names its source and says in a second line
 * what that source means; the labels alone (`Upload skills`, `Import from
 * GitHub`) do not tell a reader who has never imported one where a ZIP goes.
 *
 * The popover is drawn inside the header rather than portalled: it hangs off
 * a header that never scrolls away from the pane's top, so there is nothing
 * for a portal to fix, and staying in the tree keeps it testable without a
 * document body.
 */
export function SkillAddMenu({ onChoose }: { onChoose: (choice: SkillAddChoice) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (leavesMenu(event.target, root.current)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The settings surface listens on `window` for the same key; claiming it
      // here is what closes the menu without closing 设置 behind it.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="skill-add-menu" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="pill-button is-dark skill-add-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {TEXT.settings.skills.addMenu.label}
        <svg
          aria-hidden="true"
          className={`skill-add-chev${open ? " is-open" : ""}`}
          fill="none"
          height="11"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="11"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div aria-label={TEXT.settings.skills.addMenu.label} className="skill-add-popover" role="menu">
          {entries().map((entry) => (
            <button
              className="skill-add-item"
              key={entry.choice}
              onClick={() => {
                setOpen(false);
                onChoose(entry.choice);
              }}
              role="menuitem"
              type="button"
            >
              <span aria-hidden="true" className="skill-add-icon">{entry.icon}</span>
              <strong>{entry.label}</strong>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
