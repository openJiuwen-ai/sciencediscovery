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

export type SkillRowAction = "delete" | "edit" | "export";

interface Props {
  /** Whether the current package may still be edited. A built-in is never
   *  offered the entry, and neither is a manager package marked read-only. */
  canEdit: boolean;
  /** A built-in is read-only but still copyable: it keeps 导出 and loses
   *  both 编辑 and 删除. */
  canDelete?: boolean;
  disabled?: boolean;
  name: string;
  onAction: (action: SkillRowAction) => void;
}

const ICON_PROPS = {
  "aria-hidden": true as const,
  fill: "none",
  height: 14,
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.8,
  viewBox: "0 0 24 24",
  width: 14,
};

/** An arrow falling into a tray: the package leaves this computer. */
const ExportGlyph = () => (
  <svg {...ICON_PROPS}>
    <path d="M12 4v10m-4-4 4 4 4-4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
  </svg>
);

const EditGlyph = () => (
  <svg {...ICON_PROPS}>
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="m17.4 3.6 2.9 2.9-7.1 7.1-3.5.7.7-3.5z" />
  </svg>
);

const DeleteGlyph = () => (
  <svg {...ICON_PROPS}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 7" />
    <path d="M10 11v5m4-5v5" />
  </svg>
);

/**
 * The actions one managed Skill offers, behind a small down chevron.
 *
 * Export, edit and delete are the three things a user can do to a package they
 * brought in, and drawing them as three buttons would make every row a toolbar
 * and push the description narrow. The entries follow the package's own state:
 * a built-in keeps only 导出 (it is copyable, not editable or deletable),
 *  and a read-only package is not offered 编辑.
 *
 * The popover is drawn in the tree rather than portalled: the card is its
 * containing block, so scrolling the pane brings it into view, and staying in
 * the tree keeps it usable where there is no document body to portal into.
 */
export function SkillRowMenu({ canDelete = true, canEdit, disabled, name, onAction }: Props) {
  const [open, setOpen] = useState(false);
  /** Whether the popover opens upwards, because the row sits too close to the
   *  bottom of the pane to show it below. */
  const [up, setUp] = useState(false);
  /** Whether a mouse is currently over the control, which is what makes the
   *  press below mean "keep the menu the hover opened". */
  const hovered = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  /** Open the menu where it fits: 删除 is the last row of a 技能 list that can
   *  run past the fold, and a menu drawn below such a row is out of view. */
  const reveal = () => {
    const rect = root.current?.getBoundingClientRect?.();
    setUp(rect !== undefined && typeof window !== "undefined" && window.innerHeight - rect.bottom < 180);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const leaves = leavesMenu(event.target, root.current);
      if (leaves) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 设置 listens on `window` for the same key; claiming it here closes the
      // menu without closing the dialog behind it.
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

  const choose = (action: SkillRowAction) => {
    setOpen(false);
    onAction(action);
  };

  const entry = (action: SkillRowAction, icon: ReactNode, label: string, danger = false) => (
    <button
      className={`skill-row-menu-item${danger ? " is-danger" : ""}`}
      onClick={() => choose(action)}
      role="menuitem"
      type="button"
    >
      <span aria-hidden="true" className="skill-row-menu-icon">{icon}</span>
      {label}
    </button>
  );

  return (
    <div
      className="skill-row-menu"
      onPointerEnter={(event) => {
        // Touch has no hover: a press is how the menu opens there.
        if (event.pointerType === "touch") return;
        hovered.current = true;
        if (!disabled) reveal();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        setOpen(false);
      }}
      ref={root}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={TEXT.settings.skills.rowMenu.actions(name)}
        className={`skill-row-menu-trigger${open ? " is-open" : ""}`}
        disabled={disabled}
        onClick={() => {
          // Hover has already opened it, so pressing must not close what the
          // pointer just revealed; keyboard and touch never hover, so there a
          // press toggles as usual.
          if (!open) reveal();
          else if (!hovered.current) setOpen(false);
        }}
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="13"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="13"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          aria-label={TEXT.settings.skills.rowMenu.actions(name)}
          className={`skill-row-menu-popover${up ? " is-up" : ""}`}
          role="menu"
        >
          {entry("export", <ExportGlyph />, TEXT.settings.skills.rowMenu.export)}
          {canEdit ? entry("edit", <EditGlyph />, TEXT.settings.skills.rowMenu.edit) : null}
          {canDelete ? <div className="skill-row-menu-divider" /> : null}
          {canDelete ? entry("delete", <DeleteGlyph />, TEXT.settings.skills.rowMenu.delete, true) : null}
        </div>
      ) : null}
    </div>
  );
}
