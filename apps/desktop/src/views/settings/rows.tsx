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
export function Group({ children, heading }: { children: ReactNode; heading?: string }) {
  return (
    <section className="settings-section">
      {heading ? <h3>{heading}</h3> : null}
      {children}
    </section>
  );
}

/**
 * One label-and-control line.
 *
 * The hint is a sibling of the title rather than part of it so that a long
 * explanation wraps on its own line instead of squeezing the control.
 */
export function Row({
  children,
  hint,
  title,
  tone,
}: {
  children: ReactNode;
  hint?: string;
  title: string;
  /** `stack` puts the control on its own line, for inputs too wide to sit beside their label. */
  tone?: "stack";
}) {
  return (
    <div className={`settings-row${tone === "stack" ? " is-stack" : ""}`}>
      <div className="row-title">
        <div>
          <strong>{title}</strong>
          {hint ? <small>{hint}</small> : null}
        </div>
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

/** An on/off control. `role="switch"` because it is one, and it carries the
 *  target's name so the button is not announced as a bare "开". */
export function Switch({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
  value: boolean;
}) {
  return (
    <button
      aria-checked={value}
      aria-label={label}
      className={`switch${value ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!value)}
      role="switch"
      type="button"
    >
      <span className="switch-knob" />
    </button>
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
 * The one loading/error frame every page shares.
 *
 * A failed read renders the reason and a retry rather than an empty page: on a
 * settings screen an empty list is a claim about the server's state, and it is
 * the wrong claim when the request is what failed.
 *
 * Both stand-in states come back inside a section so that a page is never an
 * unlabelled blank while it fetches — the heading the user just clicked is
 * still on screen when the answer arrives underneath it.
 */
export function LoadGate<T>({
  children,
  loaded,
}: {
  children: (value: T) => ReactNode;
  loaded: Loaded<T>;
}) {
  if (loaded.error) {
    return (
      <section className="settings-section">
        <div className="settings-empty is-error">
          <p>{loaded.error}</p>
          <button className="secondary-button" onClick={loaded.reload} type="button">
            {TEXT.settings.retry}
          </button>
        </div>
      </section>
    );
  }
  if (loaded.value === undefined) {
    return (
      <section className="settings-section">
        <p className="settings-empty">{TEXT.settings.loading}</p>
      </section>
    );
  }
  return <>{children(loaded.value)}</>;
}
