// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { TEXT } from "../../../text.js";

export type SpecialistSource = "all" | "mine" | "official";

export function SpecialistGlyph({ kind }: { kind: "search" | "back" | "try" | "delete" | "more" }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {kind === "search" ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>
      : kind === "back" ? <path d="m14 5-7 7 7 7" />
        : kind === "try" ? <><path d="M20 11v-1a8 8 0 0 0-16 0v9l4-3h4" /><path d="M17 12v8m-4-4h8" /></>
          : kind === "delete" ? <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" /></>
            : <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>}
  </svg>;
}

export function SpecialistMark({ name, small = false }: { name: string; small?: boolean }) {
  const colours = ["blue", "green", "purple", "pink", "orange"];
  const code = Array.from(name).reduce((n, char) => n + (char.codePointAt(0) ?? 0), 0);
  return <span aria-hidden="true" className={`specialist-mark is-${colours[code % colours.length]}${small ? " is-small" : ""}`}>{Array.from(name.trim())[0]?.toUpperCase() ?? "S"}</span>;
}

export function SpecialistSourceTabs({ value, onChange, counts, labels = TEXT.settings.system.specialists }: {
  value: SpecialistSource; onChange: (value: SpecialistSource) => void; counts?: Record<SpecialistSource, number>;
  labels?: Record<SpecialistSource, string> & { sourceFilter: string };
}) {
  return <div className="specialist-source-tabs" role="tablist" aria-label={labels.sourceFilter}>
    {(["all", "mine", "official"] as const).map(source => <button type="button" role="tab" aria-selected={value === source} key={source} onClick={() => onChange(source)}>
      {labels[source]}{counts ? `（${counts[source]}）` : ""}
    </button>)}
  </div>;
}

export function SpecialistSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="specialist-search"><SpecialistGlyph kind="search" /><input aria-label={TEXT.settings.system.specialists.search} placeholder={TEXT.settings.system.specialists.search} value={value} onChange={event => onChange(event.target.value)} type="search" /></label>;
}

/** Click-opened only, with explicit outside/Escape dismissal and viewport-aware placement. */
export function SpecialistActions({ name, enabled, canDelete, busy, onTry, onDelete }: {
  name: string; enabled: boolean; canDelete: boolean; busy: boolean; onTry: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); root.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const labels = TEXT.settings.system.specialists;
  return <div className="specialist-actions" ref={root}>
    <button className="specialist-more" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={TEXT.settings.skills.rowMenu.actions(name)} disabled={busy} onClick={() => {
      const box = root.current?.getBoundingClientRect();
      setUp(box !== undefined && window.innerHeight - box.bottom < 160);
      setOpen(value => !value);
    }}><SpecialistGlyph kind="more" /></button>
    {open ? <div role="menu" aria-label={TEXT.settings.skills.rowMenu.actions(name)} className={`specialist-action-menu${up ? " is-up" : ""}`}>
      <button type="button" role="menuitem" disabled={!enabled || busy} title={!enabled ? labels.tryDisabled : undefined} onClick={() => { setOpen(false); onTry(); }}><SpecialistGlyph kind="try" />{labels.try}</button>
      {canDelete ? <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={() => { setOpen(false); onDelete(); }}><SpecialistGlyph kind="delete" />{TEXT.menu.delete}</button> : null}
    </div> : null}
  </div>;
}
