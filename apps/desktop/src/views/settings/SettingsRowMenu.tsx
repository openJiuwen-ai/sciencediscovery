// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { leavesMenu } from "../RowMenu.js";

export interface SettingsRowMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  href?: string;
  onSelect?: () => void;
}

/** Shared Skills/MCP chevron menu. Keep the established Skills CSS so both
 * lists have the same icons, hover treatment and destructive-action rhythm. */
export function SettingsRowMenu({ className = "", disabled, items, label }: {
  className?: string;
  disabled?: boolean;
  items: SettingsRowMenuItem[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ up: boolean; height?: number }>({ up: false });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const focusItem = useRef<"first" | "last" | undefined>(undefined);
  const id = useId();
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const reveal = () => {
    if (disabled) return;
    const rect = root.current?.getBoundingClientRect?.();
    const pane = root.current?.closest(".settings-group-detail")?.getBoundingClientRect();
    if (rect && typeof window !== "undefined" && window.innerHeight > 0) {
      const top = Math.max(8, pane?.top ?? 8);
      const bottom = Math.min(window.innerHeight - 8, pane?.bottom ?? window.innerHeight - 8);
      const below = bottom - rect.bottom;
      const above = rect.top - top;
      const needed = items.length * 36 + items.filter(item => item.separatorBefore).length * 9 + 12;
      const up = below < needed && above > below;
      setPlacement({ up, height: Math.max(60, up ? above : below) });
    }
    setOpen(true);
  };

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    if (focusItem.current) {
      const buttons = root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
      buttons?.[focusItem.current === "last" ? buttons.length - 1 : 0]?.focus();
      focusItem.current = undefined;
    }
    const dismiss = (event: Event) => { if (leavesMenu(event.target, root.current)) close(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (item: SettingsRowMenuItem) => {
    if (disabled || item.disabled) return;
    close(true);
    item.onSelect?.();
  };
  return (
    <div className={`skill-row-menu ${className}`.trim()} ref={root}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        hovered.current = true;
        reveal();
      }}
      onPointerLeave={() => { hovered.current = false; close(); }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); close(true);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            focusItem.current = event.key === "ArrowUp" || event.key === "End" ? "last" : "first";
            reveal();
          } else {
            const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
            if (!buttons.length) return;
            const current = buttons.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
              : current < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
              : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
        }
      }}>
      <button aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="menu"
        aria-label={label} className={`skill-row-menu-trigger${open ? " is-open" : ""}`}
        disabled={disabled} ref={trigger} type="button"
        onClick={() => { if (!open) reveal(); else if (!hovered.current) close(); }}>
        <svg aria-hidden="true" fill="none" height="13" stroke="currentColor" strokeLinecap="round"
          strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="13"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open ? (
        <div aria-label={label} className={`skill-row-menu-popover${placement.up ? " is-up" : ""}`}
          id={id} role="menu" style={{ maxHeight: placement.height, overflowY: "auto" }}>
          {items.map(item => (
            <div key={item.key} role="none">
              {item.separatorBefore ? <div className="skill-row-menu-divider" /> : null}
              {item.href && !disabled && !item.disabled ? (
                <a className="skill-row-menu-item" href={item.href} onClick={() => choose(item)}
                  rel="noopener noreferrer" role="menuitem" target="_blank">
                  <span aria-hidden="true" className="skill-row-menu-icon">{item.icon}</span>{item.label}
                </a>
              ) : (
                <button className={`skill-row-menu-item${item.danger ? " is-danger" : ""}`}
                  disabled={disabled || item.disabled} onClick={() => choose(item)} role="menuitem" type="button">
                  <span aria-hidden="true" className="skill-row-menu-icon">{item.icon}</span>{item.label}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
