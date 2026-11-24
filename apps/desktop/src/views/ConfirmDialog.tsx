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

import { useState } from "react";

import type { ConfirmRequest } from "../app/use-workspace.js";
import { TEXT } from "../text.js";
import { useTopmostEscape } from "./use-dialog-escape.js";

/**
 * The gate in front of everything irreversible.
 *
 * The body always states the consequence — what is destroyed, what cannot be
 * undone — because a bare "are you sure?" trains people to click through,
 * which is exactly the wrong habit in front of 删除.
 */
export function ConfirmDialog({
  onDismiss,
  request,
}: {
  onDismiss: () => void;
  request: ConfirmRequest;
}) {
  const [replacement, setReplacement] = useState(request.modelReplacement?.models.length === 1 ? request.modelReplacement.models[0]?.id ?? "" : "");
  // The confirmation is the topmost dialog whenever it is up: it is the one
  // the reader opened last, and the surface behind it — settings on `window`,
  // a card on `document` — stays open until the question is answered.
  useTopmostEscape(onDismiss);

  // A confirmation that names its own context wears an eyebrow chip; one that
  // passes "" is a plain decision and shows no chip at all.
  const eyebrow = request.eyebrow ?? TEXT.menu.confirm;

  return (
    <div className="modal-backdrop" onPointerDown={onDismiss}>
      <div
        aria-labelledby="confirm-title"
        className="modal-panel modal-panel-narrow confirm-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          {eyebrow === "" ? null : <span className="modal-eyebrow">{eyebrow}</span>}
          <h2 id="confirm-title">{request.title}</h2>
          <button aria-label={TEXT.menu.cancel} className="modal-close" onClick={onDismiss} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">
          <p className={request.warning === true ? "modal-body-warning" : undefined}>
            {request.warning === true ? (
              <svg
                aria-hidden="true"
                fill="none"
                height="16"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="16"
              >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            ) : null}
            {request.body}
          </p>
          {request.modelReplacement ? <label className="form-field">
            <span>{request.modelReplacement.label}</span>
            <select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
              <option value="">{request.modelReplacement.emptyLabel}</option>
              {request.modelReplacement.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label> : null}
        </div>
        <footer className="modal-footer confirm-footer">
          <button className="secondary-button" onClick={onDismiss} type="button">
            {TEXT.menu.cancel}
          </button>
          <button
            className="primary-button"
            onClick={() => {
              // Dismiss first: the work may replace the screen underneath, and
              // a modal that outlives its own action is a trap.
              onDismiss();
              void request.onAccept(replacement || undefined);
            }}
            type="button"
          >
            {request.accept}
          </button>
        </footer>
      </div>
    </div>
  );
}
