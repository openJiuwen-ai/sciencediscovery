// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useId, useRef, useState } from "react";

import { TEXT } from "../../text.js";
import { leavesMenu } from "../RowMenu.js";

export function McpImportMenu({ disabled, onChoose }: {
  disabled: boolean;
  onChoose: (source: "paste" | "file") => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusLast = useRef(false);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[focusLast.current ? items.length - 1 : 0]?.focus();
    const dismiss = (event: Event) => {
      if (leavesMenu(event.target, root.current)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  return (
    <div
      className="mcp-import-menu"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); close();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            focusLast.current = event.key === "ArrowUp" || event.key === "End";
            setOpen(true);
          } else {
            const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }
      }}
      ref={root}
    >
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        className="secondary-button mcp-import-trigger"
        disabled={disabled}
        onClick={() => { focusLast.current = false; setOpen((value) => !value); }}
        ref={trigger}
        type="button"
      >
        {TEXT.settings.system.mcp.importServers}<span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div aria-label={TEXT.settings.system.mcp.importServers} className="mcp-import-popover" id={id} role="menu">
          {(["paste", "file"] as const).map((source) => (
            <button
              key={source}
              onClick={() => { close(); onChoose(source); }}
              role="menuitem"
              type="button"
            >
              {source === "paste" ? TEXT.settings.system.mcp.importPaste : TEXT.settings.system.mcp.importFile}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
