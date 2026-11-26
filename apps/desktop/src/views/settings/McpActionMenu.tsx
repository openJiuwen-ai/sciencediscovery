// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useId, useRef, useState } from "react";
import { TEXT } from "../../text.js";
import { leavesMenu } from "../RowMenu.js";

export function McpActionMenu({ name, busy, onTry, tryDisabled, onEdit, onDelete }: {
  name: string; busy: boolean; onTry: () => void; tryDisabled?: boolean; onEdit?: () => void; onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const last = useRef(false);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (busy) setOpen(false); }, [busy]);
  useEffect(() => {
    if (!open) return;
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
    items?.[last.current ? items.length - 1 : 0]?.focus();
    const outside = (event: Event) => { if (leavesMenu(event.target, root.current)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  const actions = [
    { label: TEXT.settings.system.mcp.tryIt, action: onTry, disabled: tryDisabled, path: "M7 4h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4V7a3 3 0 0 1 3-3Zm1 6h8m-4-4v8" },
    ...(onEdit ? [{ label: TEXT.settings.edit, action: onEdit, disabled: false, path: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" }] : []),
    ...(onDelete ? [{ label: TEXT.menu.delete, action: onDelete, disabled: false, path: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" }] : []),
  ];
  return <div className="mcp-action-menu" ref={root}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || busy) return;
      event.preventDefault();
      if (!open) { last.current = event.key === "ArrowUp" || event.key === "End"; setOpen(true); return; }
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : current < 0 ? event.key === "ArrowUp" ? items.length - 1 : 0
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <button aria-label={TEXT.settings.system.mcp.more(name)} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} className="mcp-more-button" type="button" disabled={busy} ref={trigger}
      onClick={() => {
        if (busy) {
          return;
        }
        last.current = false;
        setOpen((value) => !value);
      }}><span aria-hidden="true">⋮</span></button>
    {open ? <div id={id} role="menu" aria-label={TEXT.settings.system.mcp.more(name)} className="mcp-action-popover">
      {actions.map(({ label, action, disabled, path }) => <button key={label} role="menuitem" type="button" disabled={disabled || busy}
        title={disabled ? TEXT.settings.system.mcp.tryUnavailable : undefined}
        className={label === TEXT.menu.delete ? "is-danger" : undefined}
        onClick={() => {
          if (busy || disabled) {
            return;
          }
          close();
          action();
        }}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>{label}</button>)}
      {tryDisabled ? <small>{TEXT.settings.system.mcp.tryUnavailable}</small> : null}
    </div> : null}
  </div>;
}
