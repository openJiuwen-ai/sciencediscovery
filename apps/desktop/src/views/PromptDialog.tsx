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

import { TEXT } from "../text.js";

interface Props {
  accept: string;
  fieldLabel: string;
  eyebrow: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  title: string;
  value?: string;
}

/**
 * A one-field modal.
 *
 * This exists rather than `window.prompt` because Electron's renderer does not
 * implement `prompt()` at all — it is stubbed to return null — so a project
 * could never be named in the shell this front end is built for.
 */
export function PromptDialog({
  accept,
  eyebrow,
  fieldLabel,
  onCancel,
  onSubmit,
  placeholder,
  title,
  value = "",
}: Props) {
  const [text, setText] = useState(value);

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
    onSubmit(trimmed);
  };

  return (
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
              autoFocus
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder={placeholder}
              type="text"
              value={text}
            />
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
}
