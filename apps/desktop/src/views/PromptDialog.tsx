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

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { TEXT } from "../text.js";

interface Props {
  accept: string;
  fieldLabel: string;
  eyebrow: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  title: string;
  /** A reason the value cannot be submitted, returned for a value the dialog
   *  should refuse. The dialog stays open and prints it under the field; the
   *  answer given here is also the one a server would give, so a refusal the
   *  client did not foresee still surfaces as a toast rather than silently. */
  validate?: (value: string) => string | undefined;
  value?: string;
}

/**
 * A one-field modal.
 *
 * This exists rather than `window.prompt` because Electron's renderer does not
 * implement `prompt()` at all — it is stubbed to return null — so a project
 * could never be named in the shell this front end is built for.
 *
 * It renders into `document.body` rather than beside its trigger. The backdrop
 * is `position: fixed` with its own z-index, and both only reach the whole
 * window from the root stacking context: the sidebar is a sticky column, which
 * makes it a stacking context of its own, so a modal opened from a row there
 * would otherwise be painted under the composer and the landing hero — the
 * dialog would open with the page still on top of it.
 */
export function PromptDialog({
  accept,
  eyebrow,
  fieldLabel,
  onCancel,
  onSubmit,
  placeholder,
  title,
  validate,
  value = "",
}: Props) {
  const [text, setText] = useState(value);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    // The refusal is about the value on screen. Editing it is the answer to
    // the refusal, so the line goes away with the first keystroke rather than
    // sitting there over a name that no longer has the problem.
    const refusal = validate?.(trimmed);
    setProblem(refusal);
    if (refusal === undefined) onSubmit(trimmed);
  };

  const dialog = (
    <div className="modal-backdrop" onPointerDown={onCancel}>
      <div
        aria-labelledby="prompt-title"
        className="modal-panel modal-panel-narrow"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <span className="modal-eyebrow">{eyebrow}</span>
          <h2 id="prompt-title">{title}</h2>
          <button aria-label={TEXT.menu.cancel} className="modal-close" onClick={onCancel} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">
          <label className="form-field">
            <span>{fieldLabel}</span>
            <input
              aria-invalid={problem !== undefined}
              autoFocus
              onChange={(event) => {
                setText(event.target.value);
                setProblem(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder={placeholder}
              type="text"
              value={text}
            />
            {problem === undefined ? null : (
              <small className="form-field-problem" role="alert">{problem}</small>
            )}
          </label>
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" onClick={onCancel} type="button">
            {TEXT.menu.cancel}
          </button>
          <button className="primary-button" disabled={text.trim() === ""} onClick={submit} type="button">
            {accept}
          </button>
        </footer>
      </div>
    </div>
  );

  // The tests render this tree on the server, where there is no body to portal
  // into; the dialog only appears after a click, so that path is the real one.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
