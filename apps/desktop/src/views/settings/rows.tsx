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

import type { ReactNode } from "react";

import type { Loaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";

/** A titled block inside one settings page. Every page is a stack of these.
 *  The heading is the whole introduction: a sentence under it described the
 *  section to someone already looking at it, and every page opened with one. */
export function Group({ children, heading, actions }: {
  children: ReactNode; heading?: string; actions?: ReactNode;
}) {
  return (
    <section className="settings-section">
      {actions ? <div className="settings-list-heading">
        {heading ? <h3>{heading}</h3> : null}
        <div className="row-inline-control">{actions}</div>
      </div> : heading ? <h3>{heading}</h3> : null}
      {children}
    </section>
  );
}

/**
 * One label-and-control line.
 *
 * The hint is a sibling of the title rather than part of it so that a long
 * explanation wraps on its own line instead of squeezing the control. A note
 * is a third, full-width line under both: a sentence about the row is read
 * across the row, and its length must never decide how wide the control is.
 */
export function Row({
  children,
  hint,
  note,
  title,
  tone,
}: {
  children: ReactNode;
  hint?: string;
  note?: ReactNode;
  title: string;
  /** `stack` puts the control on its own line, for inputs too wide to sit beside their label.
   *  `status` lays the row out as label-left + indicator-right, vertically
   *  centred — for a status dot that belongs beside its text, never under it
   *  (a 10px dot on a full-width control line reads as a stray mark). */
  tone?: "stack" | "status";
}) {
  return (
    <div className={`settings-row${tone === "stack" ? " is-stack" : tone === "status" ? " is-status" : ""}${note ? " has-note" : ""}`}>
      <div className="row-title">
        <div>
          <strong>{title}</strong>
          {hint ? <small>{hint}</small> : null}
        </div>
      </div>
      <div className="row-control">{children}</div>
      {note ? <div className="row-note-line">{note}</div> : null}
    </div>
  );
}

/** An on/off control. `role="switch"` because it is one, and it carries the
 *  target's name so the button is not announced as a bare "开". */
export function Switch({
  disabled,
  label,
  onChange,
  small,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
  /** The detail header's 32×16 variant, as the handoff draws it. */
  small?: boolean;
  value: boolean;
}) {
  return (
    <button
      aria-checked={value}
      aria-label={label}
      className={`switch${value ? " is-on" : ""}${small ? " is-small" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!value)}
      role="switch"
      type="button"
    >
      <span className="switch-knob" />
    </button>
  );
}

const BULK_GLYPH = {
  "aria-hidden": true as const,
  fill: "none",
  height: 14,
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 2.4,
  viewBox: "0 0 24 24",
  width: 14,
};

/** A play mark inside a ring: the rows go on. */
const PlayGlyph = () => (
  <svg {...BULK_GLYPH}>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M9 8 15.9 12 9 16Z" fill="currentColor" stroke="none" />
  </svg>
);

/** The power mark: the rows go off. */
const PowerGlyph = () => (
  <svg {...BULK_GLYPH}>
    <path d="M6.5 4.6a9.2 9.2 0 1 0 11 0" />
    <path d="M12 4v6.8" />
  </svg>
);

/**
 * The two writes that act on a whole list: every row on, every row off.
 *
 * 技能, MCP 服务器 and 专家 all present a list of switches, and a user who
 * wants none of them should not have to press each one. The buttons sit above
 * the list and say what they will do to it; the page decides what "all" means,
 * because only the page knows which of its rows have a switch of their own.
 *
 * They are drawn as one segmented control rather than two loose links: the
 * pair is a single choice about the list below — on or off — and a border
 * around them says so before either is read. `toolbar` is the handoff's other
 * drawing of the same pair: bare labels with a leading glyph, sized to stand
 * in a page's toolbar beside its filters instead of on a line of their own.
 */
export function BulkToggles({
  busy,
  onAll,
  variant = "segmented",
}: {
  busy?: boolean;
  onAll: (enabled: boolean) => void;
  variant?: "segmented" | "toolbar";
}) {
  const inline = variant === "toolbar";
  return (
    <div className={`settings-bulk${inline ? " is-toolbar" : ""}`}>
      <button className="bulk-button" disabled={busy} onClick={() => onAll(true)} type="button">
        {inline ? <PlayGlyph /> : null}
        {TEXT.settings.enableAll}
      </button>
      <button className="bulk-button" disabled={busy} onClick={() => onAll(false)} type="button">
        {inline ? <PowerGlyph /> : null}
        {TEXT.settings.disableAll}
      </button>
    </div>
  );
}

/** A select whose options are plain strings; used where the value is already
 *  the wire format and translating it would only add a mapping to maintain. */
export function Select({
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (next: string) => void;
  options: { label: string; value: string }[];
  value: string;
}) {
  return (
    <select
      aria-label={label}
      className="field-select scale-select"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Mutually exclusive choices, for the two- or three-way switches. */
export function Pills({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (next: string) => void;
  options: { label: string; title?: string; value: string }[];
  value: string;
}) {
  return (
    <div aria-label={label} className="seg-pills" role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={option.value === value ? "active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Tag({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`settings-tag${tone ? ` is-${tone}` : ""}`}>{children}</span>;
}

/**
 * A page's layout while its first read is in flight.
 *
 * This is the cache-miss frame only: a revisit paints the remembered answer
 * instead. It draws the blocks the loaded page will draw, at the same sizes,
 * so the answer lands without moving what is already on screen. The label is
 * the one thing a screen reader announces; the blocks themselves carry no
 * information and are hidden from it.
 */
export function SkeletonRegion({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="settings-skeleton" role="status">
      {children}
    </div>
  );
}

/** One stand-in block inside a `SkeletonRegion`. Shape classes decide its size. */
export function SkeletonBlock({ className }: { className?: string }) {
  return <span aria-hidden="true" className={`settings-skeleton-block${className ? ` ${className}` : ""}`} />;
}

/**
 * The one loading/error frame every page shares.
 *
 * A failed read renders the reason and a retry rather than an empty page: on a
 * settings screen an empty list is a claim about the server's state, and it is
 * the wrong claim when the request is what failed.
 *
 * Both stand-in states come back inside a section so that a page is never an
 * unlabelled blank while it fetches — the heading the user just clicked is
 * still on screen when the answer arrives underneath it. A page with a shape
 * of its own passes `skeleton`, which replaces the single loading line only on
 * the cache-miss path; a remembered answer is drawn by `children` as before.
 */
export function LoadGate<T>({
  children,
  loaded,
  skeleton,
}: {
  children: (value: T) => ReactNode;
  loaded: Loaded<T>;
  /** First-paint stand-in for a page whose loading state has a layout shape. */
  skeleton?: ReactNode;
}) {
  if (loaded.error) {
    const failure = (
      <section className="settings-section">
        <div className="settings-empty is-error">
          <p>{loaded.error}</p>
          <button className="secondary-button" onClick={loaded.reload} type="button">
            {TEXT.settings.retry}
          </button>
        </div>
      </section>
    );
    // A pane opened from its last answer keeps that answer when the refresh
    // fails: a stale list under a visible failure is more useful than an empty
    // page, and the retry sits right there. Without a value there is nothing
    // to keep, so the failure is the whole page, exactly as before.
    if (loaded.value === undefined) return failure;
    return (
      <>
        {failure}
        {children(loaded.value)}
      </>
    );
  }
  if (loaded.value === undefined) {
    if (skeleton !== undefined) return <>{skeleton}</>;
    return (
      <section className="settings-section">
        <p className="settings-empty">{TEXT.settings.loading}</p>
      </section>
    );
  }
  return <>{children(loaded.value)}</>;
}
